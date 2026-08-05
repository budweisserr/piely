// Piely agent bridge: spawns the piely-agent Node sidecar (pi-ai) and forwards
// its NDJSON protocol to/from the frontend. The sidecar owns pi's provider
// login (OAuth + api keys), credential storage, and LLM streaming.
use serde_json::Value;
use std::env;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};

pub struct PielyState {
    /// stdin of the active interactive `login` sidecar process (one at a time)
    pub login_stdin: Mutex<Option<ChildStdin>>,
}

impl Default for PielyState {
    fn default() -> Self {
        Self {
            login_stdin: Mutex::new(None),
        }
    }
}

fn agent_path() -> Result<PathBuf, String> {
    if let Ok(path) = env::var("PIELY_AGENT_PATH") {
        return Ok(PathBuf::from(path));
    }
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../piely-agent/agent.mjs");
    if dev_path.exists() {
        return Ok(dev_path);
    }
    Err("piely-agent/agent.mjs not found. Set PIELY_AGENT_PATH or install the agent.".to_string())
}

fn auth_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create app data directory: {}", e))?;
    Ok(dir.join("piely-auth.json"))
}

fn spawn_agent(app: &AppHandle) -> Result<Child, String> {
    let node = env::var("PIELY_NODE_BIN").unwrap_or_else(|_| "node".to_string());
    Command::new(node)
        .arg(agent_path()?)
        .arg("--auth-file")
        .arg(auth_file(app)?)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Failed to start piely agent (node + pi-ai required): {}", e))
}

async fn send_line(stdin: &mut Option<ChildStdin>, value: &Value) -> Result<(), String> {
    let stdin = stdin
        .as_mut()
        .ok_or_else(|| "Agent process not running".to_string())?;
    stdin
        .write_all(format!("{}\n", value).as_bytes())
        .await
        .map_err(|e| format!("Failed to write to agent: {}", e))
}

/// Kill the child and wait, so a dropped command never leaves an orphaned node.
struct ChildGuard(Option<Child>);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.start_kill();
        }
    }
}

async fn run_simple(app: &AppHandle, cmd: &str, provider: Option<&str>) -> Result<Value, String> {
    let mut child = spawn_agent(app)?;
    let _guard = ChildGuard(Some(child.try_clone().map_err(|e| e.to_string())?));
    let stdout = child.stdout.take().ok_or_else(|| "No agent stdout".to_string())?;
    let mut stdin = child.stdin.take();

    let mut request = serde_json::json!({ "id": 1, "cmd": cmd });
    if let Some(provider) = provider {
        request["provider"] = Value::String(provider.to_string());
    }
    send_line(&mut stdin, &request).await?;
    drop(stdin);

    let mut lines = BufReader::new(stdout).lines();
    let mut result = Value::Null;
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        let msg: Value = serde_json::from_str(&line).map_err(|_| "Invalid agent output".to_string())?;
        match msg["type"].as_str() {
            Some("providers") | Some("models") => result = msg.clone(),
            Some("done") => return Ok(result),
            Some("error") => {
                return Err(msg["message"].as_str().unwrap_or("Agent error").to_string())
            }
            _ => {}
        }
    }
    Err("Agent exited unexpectedly".to_string())
}

#[tauri::command]
pub async fn piely_list_providers(app: AppHandle) -> Result<Value, String> {
    run_simple(&app, "list", None)
        .await
        .map(|v| v.get("providers").cloned().unwrap_or(Value::Null))
}

#[tauri::command]
pub async fn piely_get_models(app: AppHandle, provider: String) -> Result<Value, String> {
    run_simple(&app, "models", Some(&provider))
        .await
        .map(|v| v.get("models").cloned().unwrap_or(Value::Null))
}

#[tauri::command]
pub async fn piely_logout(app: AppHandle, provider: String) -> Result<(), String> {
    run_simple(&app, "logout", Some(&provider)).await?;
    Ok(())
}

/// Start an interactive login. Prompts/notifications are forwarded to the
/// frontend as `piely_login_prompt` / `piely_login_notify` events; answers
/// come back through `piely_login_answer`.
#[tauri::command]
pub async fn piely_login(
    app: AppHandle,
    state: State<'_, PielyState>,
    provider: String,
    auth_type: Option<String>,
) -> Result<(), String> {
    let mut child = spawn_agent(&app)?;
    let stdout = child.stdout.take().ok_or_else(|| "No agent stdout".to_string())?;
    let mut stdin = child.stdin.take();

    let request = serde_json::json!({
        "id": 1,
        "cmd": "login",
        "provider": provider,
        "type": auth_type.unwrap_or_else(|| "oauth".to_string())
    });
    send_line(&mut stdin, &request).await?;

    {
        let mut guard = state
            .login_stdin
            .lock()
            .map_err(|_| "Login state poisoned".to_string())?;
        if let Some(previous) = guard.take() {
            drop(previous); // close any previous login's stdin
        }
        *guard = stdin; // hand stdin to piely_login_answer for prompt replies
    }

    let mut lines = BufReader::new(stdout).lines();
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        let msg: Value = serde_json::from_str(&line).map_err(|_| "Invalid agent output".to_string())?;
        match msg["type"].as_str() {
            Some("prompt") => {
                let _ = app.emit("piely_login_prompt", msg.get("prompt").cloned().unwrap_or(Value::Null));
            }
            Some("notify") => {
                let _ = app.emit("piely_login_notify", msg.get("event").cloned().unwrap_or(Value::Null));
            }
            Some("done") => {
                let mut guard = state.login_stdin.lock().map_err(|_| "Login state poisoned".to_string())?;
                guard.take();
                return Ok(());
            }
            Some("error") => {
                let mut guard = state.login_stdin.lock().map_err(|_| "Login state poisoned".to_string())?;
                guard.take();
                return Err(msg["message"].as_str().unwrap_or("Login failed").to_string());
            }
            _ => {}
        }
    }
    let mut guard = state.login_stdin.lock().map_err(|_| "Login state poisoned".to_string())?;
    guard.take();
    Err("Agent exited unexpectedly".to_string())
}

/// Send the user's answer for the active login prompt to the sidecar.
#[tauri::command]
pub async fn piely_login_answer(
    state: State<'_, PielyState>,
    value: String,
) -> Result<(), String> {
    let mut stdin = state
        .login_stdin
        .lock()
        .map_err(|_| "Login state poisoned".to_string())?
        .take();
    let result = send_line(
        &mut stdin,
        &serde_json::json!({ "id": 1, "type": "answer", "value": value }),
    )
    .await;
    *state
        .login_stdin
        .lock()
        .map_err(|_| "Login state poisoned".to_string())? = stdin;
    result
}

/// Stream an LLM completion through pi. Emits `chat_stream_chunk` per delta
/// and `chat_stream_complete` when finished, mirroring the old chat endpoint
/// so the frontend polling loop is unchanged.
#[tauri::command]
pub async fn piely_chat_stream(
    app: AppHandle,
    provider: String,
    model: String,
    system_prompt: Option<String>,
    messages: String,
) -> Result<String, String> {
    let mut child = spawn_agent(&app)?;
    let _guard = ChildGuard(Some(child.try_clone().map_err(|e| e.to_string())?));
    let stdout = child.stdout.take().ok_or_else(|| "No agent stdout".to_string())?;
    let mut stdin = child.stdin.take();

    let request = serde_json::json!({
        "id": 1,
        "cmd": "stream",
        "provider": provider,
        "model": model,
        "systemPrompt": system_prompt,
        "messages": serde_json::from_str::<Value>(&messages)
            .map_err(|e| format!("Invalid messages payload: {}", e))?
    });
    send_line(&mut stdin, &request).await?;
    drop(stdin);

    let mut full_response = String::new();
    let mut lines = BufReader::new(stdout).lines();
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        let msg: Value = serde_json::from_str(&line).map_err(|_| "Invalid agent output".to_string())?;
        match msg["type"].as_str() {
            Some("chunk") => {
                if let Some(text) = msg["text"].as_str() {
                    full_response.push_str(text);
                    let _ = app.emit("chat_stream_chunk", text);
                }
            }
            Some("done") => {
                let _ = app.emit("chat_stream_complete", &full_response);
                return Ok(full_response);
            }
            Some("error") => {
                return Err(msg["message"].as_str().unwrap_or("Stream failed").to_string());
            }
            _ => {}
        }
    }
    Err("Agent exited unexpectedly".to_string())
}
