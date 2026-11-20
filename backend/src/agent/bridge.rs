//! The request/reply bridge to the sidecar: one reader task resolves pending
//! commands by id, forwards streamed deltas to the caller that started them,
//! and keeps a slow-but-alive answer from being mistaken for a hung one.
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

use super::process_factory::spawn_agent;
use super::progress::ProgressClock;
use super::state::PielyState;

/// How long a command may make no progress before it is abandoned. A streamed
/// answer resets this clock on every chunk, so a slow model is not cut off —
/// only a silent one.
const AGENT_IDLE_TIMEOUT: Duration = Duration::from_secs(120);

/// One NDJSON frame from the sidecar. A runaway line would otherwise be read
/// into memory in full before anyone notices it is not valid JSON.
const MAX_AGENT_FRAME_BYTES: usize = 8 * 1024 * 1024;

/// One in-flight command: the reply channel plus the optional stream channel
/// used to forward `chunk` / `tool_call` messages for that command only.
struct InFlight {
    reply: oneshot::Sender<Result<Value, String>>,
    events: Option<Channel<Value>>,
    /// Marked by the reader task on every streamed event (chunk / tool_call /
    /// progress): what keeps a slow-but-alive answer from being cut off.
    progress: Arc<Mutex<ProgressClock>>,
}

pub(super) struct AgentHandle {
    /// Held for the sidecar's lifetime: kill_on_drop means dropping this
    /// Child terminates the agent, so it must not be read — only kept.
    #[allow(dead_code)]
    child: Child,
    /// stdin is write-serialized; the agent reads one JSON line at a time.
    stdin: AsyncMutex<ChildStdin>,
    /// in-flight requests by id -> reply sender + stream channel. The reader
    /// task resolves these with the first non-event message for that id
    /// (providers/models/done) or an error.
    pending: Mutex<HashMap<u64, InFlight>>,
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
            .map(|(_, in_flight)| in_flight.reply)
            .collect();
        for tx in pendings {
            let _ = tx.send(Err(message.to_string()));
        }
    }
}
/// Get the shared agent, spawning it on first use or after it died.
fn ensure_agent(app: &AppHandle) -> Result<Arc<AgentHandle>, String> {
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

    // Reader task: forward prompt/notify events to the frontend, forward
    // stream deltas through the caller's stream channel, and resolve pending
    // requests by id. When stdout closes the agent is gone.
    let reader_app = app.clone();
    let reader_agent = agent.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.len() > MAX_AGENT_FRAME_BYTES {
                eprintln!(
                    "[agent] dropping a {} byte frame (limit {})",
                    line.len(),
                    MAX_AGENT_FRAME_BYTES
                );
                continue;
            }
            let msg: Value = match serde_json::from_str(&line) {
                Ok(m) => m,
                Err(_) => continue,
            };
            match msg["type"].as_str() {
                Some("chunk") | Some("tool_call") | Some("progress") => {
                    // Only the caller that started this stream gets these,
                    // tagged by request id. `progress` has no UI text: it just
                    // tells the idle timeout the answer is still coming.
                    let Some(id) = msg["id"].as_u64() else { continue };
                    let channel = reader_agent
                        .pending
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .get(&id)
                        .and_then(|in_flight| {
                            in_flight
                                .progress
                                .lock()
                                .unwrap_or_else(|p| p.into_inner())
                                .mark(Instant::now());
                            in_flight.events.clone()
                        });
                    if let Some(channel) = channel {
                        let _ = channel.send(msg.clone());
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
                        let in_flight = reader_agent
                            .pending
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .remove(&id);
                        if let Some(in_flight) = in_flight {
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
                            let _ = in_flight.reply.send(result);
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
/// `events` is the per-invocation stream channel for commands that stream.
/// `stream_id` registers the caller's own id for `piely_cancel_stream`.
pub(super) async fn request(
    app: &AppHandle,
    mut msg: Value,
    events: Option<Channel<Value>>,
    stream_id: Option<&str>,
) -> Result<Value, String> {
    let agent = ensure_agent(app)?;
    let id = agent.next_id.fetch_add(1, Ordering::Relaxed);
    msg["id"] = Value::from(id);
    let (tx, rx) = oneshot::channel();
    let progress = Arc::new(Mutex::new(ProgressClock::started(
        AGENT_IDLE_TIMEOUT,
        Instant::now(),
    )));
    agent
        .pending
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(
            id,
            InFlight {
                reply: tx,
                events,
                progress: progress.clone(),
            },
        );
    if let Some(stream_id) = stream_id {
        app.state::<PielyState>()
            .streams
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(stream_id.to_string(), id);
    }
    let forget_stream = || {
        if let Some(stream_id) = stream_id {
            app.state::<PielyState>()
                .streams
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(stream_id);
        }
    };
    if let Err(e) = agent.send(&msg).await {
        agent
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&id);
        forget_stream();
        agent.alive.store(false, Ordering::Release);
        return Err(e);
    }
    // A live-but-silent agent (a stalled provider call) must not keep the UI
    // waiting forever. Streamed chunks count as progress, so a long answer is
    // not cut off; only `AGENT_IDLE_TIMEOUT` without a single event is.
    let give_up = |agent: &Arc<AgentHandle>| {
        agent
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&id);
        forget_stream();
        Err(format!(
            "Agent sent nothing for {} seconds",
            AGENT_IDLE_TIMEOUT.as_secs()
        ))
    };
    let mut rx = rx;
    loop {
        let remaining = progress
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remaining(Instant::now());
        let Some(remaining) = remaining else {
            return give_up(&agent);
        };
        match tokio::time::timeout(remaining, &mut rx).await {
            Ok(Ok(Ok(v))) => {
                forget_stream();
                return Ok(v);
            }
            Ok(Ok(Err(e))) => {
                forget_stream();
                return Err(e);
            }
            Ok(Err(_)) => {
                forget_stream();
                return Err("Agent exited unexpectedly".to_string());
            }
            // Either the command made progress (wait again with a fresh
            // window) or it has now been silent for the whole timeout (the
            // next iteration gives up).
            Err(_) => continue,
        }
    }
}

/// Stops a running login and unblocks the call waiting on it. Closing the
/// dialog only clears frontend state; without this the flow keeps polling and
/// holds the provider's callback port.
pub(super) async fn cancel_active_login(state: &PielyState) -> Result<(), String> {
    let Some(id) = state
        .login_id
        .lock()
        .map_err(|_| "Login state poisoned".to_string())?
        .take()
    else {
        return Ok(());
    };

    let agent = state
        .agent
        .lock()
        .map_err(|_| "Agent state poisoned".to_string())?
        .clone();
    let Some(agent) = agent else {
        return Ok(());
    };

    let cancel_id = agent.next_id.fetch_add(1, Ordering::Relaxed);
    agent
        .send(&serde_json::json!({ "id": cancel_id, "cmd": "cancel_login" }))
        .await?;

    if let Some(in_flight) = agent
        .pending
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(&id)
    {
        let _ = in_flight
            .reply
            .send(Ok(serde_json::json!({ "cancelled": true })));
    }

    Ok(())
}

/// Starts a login. The reader task forwards prompts and notifications to the
/// frontend; answers come back through [`answer_login`].
///
/// No deadline: the user may be in a browser for minutes. Closing the dialog
/// cancels the flow instead.
pub(super) async fn login(
    app: &AppHandle,
    state: &PielyState,
    provider: String,
    auth_type: Option<String>,
) -> Result<(), String> {
    // A new login supersedes an abandoned one: the user may have closed the
    // previous dialog, and its flow would still be holding the callback port.
    cancel_active_login(state).await?;

    let agent = ensure_agent(app)?;
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
        .insert(
            id,
            InFlight {
                reply: tx,
                events: None,
                progress: Arc::new(Mutex::new(ProgressClock::started(
                    AGENT_IDLE_TIMEOUT,
                    Instant::now(),
                ))),
            },
        );
    // Remember the id before the command is sent: answers reply to the login's
    // prompts by it, and a cancel arriving with the first prompt must find it.
    // Cleared by the reader on done/error.
    *state
        .login_id
        .lock()
        .map_err(|_| "Login state poisoned".to_string())? = Some(id);
    if let Err(e) = agent.send(&msg).await {
        agent
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&id);
        *state
            .login_id
            .lock()
            .map_err(|_| "Login state poisoned".to_string())? = None;
        agent.alive.store(false, Ordering::Release);
        return Err(e);
    }
    match rx.await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("Agent exited unexpectedly".to_string()),
    }
}

/// Sends the user's answer for the active login prompt to the sidecar.
pub(super) async fn answer_login(state: &PielyState, value: String) -> Result<(), String> {
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

/// Stops one stream, by the id its caller passed in. The frontend cancelling
/// only stops its own loop; the sidecar would keep generating and billing.
pub(super) async fn cancel_stream(state: &PielyState, stream_id: &str) -> Result<(), String> {
    let id = state
        .streams
        .lock()
        .map_err(|_| "Stream state poisoned".to_string())?
        .remove(stream_id);
    let Some(id) = id else {
        return Ok(()); // already finished
    };

    let agent = state
        .agent
        .lock()
        .map_err(|_| "Agent state poisoned".to_string())?
        .clone();
    let Some(agent) = agent else {
        return Ok(());
    };
    if !agent.alive.load(Ordering::Acquire) {
        return Ok(());
    }

    // A fresh id: the cancel must not resolve the stream's own pending entry;
    // it is the aborted stream that settles with an error, by itself.
    let cancel_id = agent.next_id.fetch_add(1, Ordering::Relaxed);
    agent
        .send(&serde_json::json!({
            "id": cancel_id,
            "cmd": "cancel_stream",
            "streamId": id
        }))
        .await
}
