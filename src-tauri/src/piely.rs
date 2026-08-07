// Piely agent bridge: runs ONE long-lived piely-agent sidecar (pi-ai) and
// forwards its NDJSON protocol to/from the frontend. The sidecar owns pi's
// provider login (OAuth + api keys), credential storage, and LLM streaming.
//
// All commands (list/models/login/logout/stream) are multiplexed over the same
// process by request id, so the agent lives "under the hood" of Piely instead
// of being launched as a fresh `node agent.mjs` command per call. If it dies,
// pending requests fail and the next command respawns it.
use serde_json::Value;
use std::collections::HashMap;
use std::env;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

struct AgentHandle {
    /// Held for the sidecar's lifetime: kill_on_drop means dropping this
    /// Child terminates the agent, so it must not be read — only kept.
    #[allow(dead_code)]
    child: Child,
    /// stdin is write-serialized; the agent reads one JSON line at a time.
    stdin: AsyncMutex<ChildStdin>,
    /// in-flight requests by id -> reply sender. The reader task resolves
    /// these with the first non-event message for that id (providers/models/
    /// done) or an error.
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    alive: AtomicBool,
    next_id: AtomicU64,
}

impl AgentHandle {
    /// Write one JSON line to the agent. The request id is embedded in `msg`.
    async fn send(&self, msg: &Value) -> Result<(), String> {
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(format!("{}\n", msg).as_bytes())
            .await
            .map_err(|e| format!("Failed to write to agent: {}", e))
    }

    fn fail_pending(&self, message: &str) {
        let pendings: Vec<_> = self
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .drain()
            .map(|(_, tx)| tx)
            .collect();
        for tx in pendings {
            let _ = tx.send(Err(message.to_string()));
        }
    }
}

pub struct PielyState {
    /// the one shared agent process (None until first use / after it died)
    agent: Mutex<Option<Arc<AgentHandle>>>,
    /// request id of the active interactive `login` (for prompt answers)
    login_id: Mutex<Option<u64>>,
}

impl Default for PielyState {
    fn default() -> Self {
        Self {
            agent: Mutex::new(None),
            login_id: Mutex::new(None),
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

/// Resolve the pi sidecar as (program, args-before-auth-file):
/// 1. PIELY_AGENT_PATH override (compiled binary, or .mjs/.js script run with node)
/// 2. bundled sidecar next to the app executable (externalBin)
/// 3. dev-compiled binary (piely-agent/bin)
/// 4. agent.mjs with node
fn agent_command() -> Result<(String, Vec<String>), String> {
    if let Ok(path) = env::var("PIELY_AGENT_PATH") {
        if path.ends_with(".mjs") || path.ends_with(".js") {
            let node = env::var("PIELY_NODE_BIN").unwrap_or_else(|_| "node".to_string());
            return Ok((node, vec![path]));
        }
        return Ok((path, vec![]));
    }
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    {
        let name = if cfg!(windows) { "piely-agent.exe" } else { "piely-agent" };
        let bundled = dir.join(name);
        if bundled.exists() {
            return Ok((bundled.to_string_lossy().into_owned(), vec![]));
        }
    }
    let dev_bin = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../piely-agent/bin/piely-agent");
    if dev_bin.exists() {
        return Ok((dev_bin.to_string_lossy().into_owned(), vec![]));
    }
    let node = env::var("PIELY_NODE_BIN").unwrap_or_else(|_| "node".to_string());
    Ok((node, vec![agent_path()?.to_string_lossy().into_owned()]))
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

fn spawn_agent(app: &AppHandle) -> Result<(Child, ChildStdin, ChildStdout), String> {
    let (program, args) = agent_command()?;
    let mut cmd = Command::new(program);
    cmd.args(args)
        .arg("--auth-file")
        .arg(auth_file(app)?)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    cmd.kill_on_drop(true); // never leave an orphaned sidecar
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: never pop a console window for the sidecar.
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start piely agent (node + pi-ai required): {}", e))?;
    let stdin = child.stdin.take().ok_or_else(|| "No agent stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "No agent stdout".to_string())?;
    Ok((child, stdin, stdout))
}

/// Get the shared agent, spawning it on first use or after it died.
async fn ensure_agent(app: &AppHandle) -> Result<Arc<AgentHandle>, String> {
    let state = app.state::<PielyState>();
    let mut guard = state
        .agent
        .lock()
        .map_err(|_| "Agent state poisoned".to_string())?;
    if let Some(agent) = guard.as_ref() {
        if agent.alive.load(Ordering::Acquire) {
            return Ok(agent.clone());
        }
    }

    let (child, stdin, stdout) = spawn_agent(app)?;
    let agent = Arc::new(AgentHandle {
        child,
        stdin: AsyncMutex::new(stdin),
        pending: Mutex::new(HashMap::new()),
        alive: AtomicBool::new(true),
        next_id: AtomicU64::new(1),
    });
    *guard = Some(agent.clone());
    drop(guard);

    // Reader task: forward prompt/notify/chunk events to the frontend and
    // resolve pending requests by id. When stdout closes the agent is gone.
    let reader_app = app.clone();
    let reader_agent = agent.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let msg: Value = match serde_json::from_str(&line) {
                Ok(m) => m,
                Err(_) => continue,
            };
            match msg["type"].as_str() {
                Some("chunk") => {
                    if let Some(text) = msg["text"].as_str() {
                        let _ = reader_app.emit("chat_stream_chunk", text);
                    }
                }
                Some("prompt") => {
                    let _ = reader_app
                        .emit("piely_login_prompt", msg.get("prompt").cloned().unwrap_or(Value::Null));
                }
                Some("notify") => {
                    let _ = reader_app
                        .emit("piely_login_notify", msg.get("event").cloned().unwrap_or(Value::Null));
                }
                _ => {
                    let result = match msg["type"].as_str() {
                        Some("error") => Err(msg["message"]
                            .as_str()
                            .unwrap_or("Agent error")
                            .to_string()),
                        _ => Ok(msg.clone()),
                    };
                    if let Some(id) = msg["id"].as_u64() {
                        if let Some(tx) = reader_agent
                            .pending
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .remove(&id)
                        {
                            // login finished (done/error): drop the stored id
                            let state = reader_app.state::<PielyState>();
                            let mut login_id = state
                                .login_id
                                .lock()
                                .unwrap_or_else(|p| p.into_inner());
                            if *login_id == Some(id) {
                                *login_id = None;
                            }
                            drop(login_id);
                            let _ = tx.send(result);
                        }
                        // stream finished: only stream `done` carries a message.
                        if msg["type"] == "done" && msg.get("message").is_some() {
                            let _ = reader_app.emit(
                                "chat_stream_complete",
                                msg["message"].clone(),
                            );
                        }
                    }
                }
            }
        }
        reader_agent.alive.store(false, Ordering::Release);
        reader_agent.fail_pending("Agent exited unexpectedly");
        let state = reader_app.state::<PielyState>();
        *state
            .login_id
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = None;
    });

    Ok(agent)
}

/// Send one command and await its reply (first non-event message with the id).
async fn request(app: &AppHandle, mut msg: Value) -> Result<Value, String> {
    let agent = ensure_agent(app).await?;
    let id = agent.next_id.fetch_add(1, Ordering::Relaxed);
    msg["id"] = Value::from(id);
    let (tx, rx) = oneshot::channel();
    agent
        .pending
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(id, tx);
    if let Err(e) = agent.send(&msg).await {
        agent
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&id);
        agent.alive.store(false, Ordering::Release);
        return Err(e);
    }
    match rx.await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("Agent exited unexpectedly".to_string()),
    }
}

#[tauri::command]
pub async fn piely_list_providers(app: AppHandle) -> Result<Value, String> {
    let msg = request(&app, serde_json::json!({ "cmd": "list" })).await?;
    Ok(msg.get("providers").cloned().unwrap_or(Value::Null))
}

#[tauri::command]
pub async fn piely_get_models(app: AppHandle, provider: String) -> Result<Value, String> {
    let msg = request(
        &app,
        serde_json::json!({ "cmd": "models", "provider": provider }),
    )
    .await?;
    Ok(msg.get("models").cloned().unwrap_or(Value::Null))
}

#[tauri::command]
pub async fn piely_logout(app: AppHandle, provider: String) -> Result<(), String> {
    request(
        &app,
        serde_json::json!({ "cmd": "logout", "provider": provider }),
    )
    .await?;
    Ok(())
}

/// Start an interactive login on the shared agent. Prompts/notifications are
/// forwarded to the frontend as `piely_login_prompt` / `piely_login_notify`
/// events; answers come back through `piely_login_answer`.
#[tauri::command]
pub async fn piely_login(
    app: AppHandle,
    state: State<'_, PielyState>,
    provider: String,
    auth_type: Option<String>,
) -> Result<(), String> {
    let agent = ensure_agent(&app).await?;
    let id = agent.next_id.fetch_add(1, Ordering::Relaxed);
    let msg = serde_json::json!({
        "id": id,
        "cmd": "login",
        "provider": provider,
        "type": auth_type.unwrap_or_else(|| "oauth".to_string())
    });
    let (tx, rx) = oneshot::channel();
    agent
        .pending
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(id, tx);
    if let Err(e) = agent.send(&msg).await {
        agent
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&id);
        agent.alive.store(false, Ordering::Release);
        return Err(e);
    }
    // Remember the id so piely_login_answer can reply to the login's prompts
    // while it is still in flight; cleared by the reader on done/error.
    *state
        .login_id
        .lock()
        .map_err(|_| "Login state poisoned".to_string())? = Some(id);
    match rx.await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("Agent exited unexpectedly".to_string()),
    }
}

/// Send the user's answer for the active login prompt to the sidecar.
#[tauri::command]
pub async fn piely_login_answer(
    state: State<'_, PielyState>,
    value: String,
) -> Result<(), String> {
    let agent = state
        .agent
        .lock()
        .map_err(|_| "Agent state poisoned".to_string())?
        .clone()
        .ok_or_else(|| "Agent process not running".to_string())?;
    let id = state
        .login_id
        .lock()
        .map_err(|_| "Login state poisoned".to_string())?
        .ok_or_else(|| "No active login".to_string())?;
    agent
        .send(&serde_json::json!({ "id": id, "type": "answer", "value": value }))
        .await
}

/// Stream an LLM completion through pi. The reader task emits
/// `chat_stream_chunk` per delta; this returns the full text once the agent
/// reports `done`, mirroring the old chat endpoint so the frontend polling
/// loop is unchanged.
#[tauri::command]
pub async fn piely_chat_stream(
    app: AppHandle,
    provider: String,
    model: String,
    system_prompt: Option<String>,
    messages: String,
) -> Result<String, String> {
    let msg = request(
        &app,
        serde_json::json!({
            "cmd": "stream",
            "provider": provider,
            "model": model,
            "systemPrompt": system_prompt,
            "messages": serde_json::from_str::<Value>(&messages)
                .map_err(|e| format!("Invalid messages payload: {}", e))?
        }),
    )
    .await?;
    Ok(msg
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .to_string())
}
