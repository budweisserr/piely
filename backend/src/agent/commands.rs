//! The Tauri commands the frontend calls. Thin by design: every one of them
//! hands a request to the bridge and shapes the reply for JS.
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use super::bridge::{answer_login, cancel_active_login, cancel_stream, login, request};
use super::state::PielyState;

/// Shape of a finished stream: the assistant text plus the structured turn
/// (assistant content blocks and stop reason) the caller needs to continue a
/// tool-calling loop.
fn stream_result(msg: &Value) -> String {
    serde_json::json!({
        "message": msg.get("message").cloned().unwrap_or(Value::String(String::new())),
        "assistant": msg.get("assistant").cloned().unwrap_or(Value::Null),
        "stopReason": msg
            .get("stopReason")
            .cloned()
            .unwrap_or(Value::String("stop".to_string())),
    })
    .to_string()
}

#[tauri::command]
pub async fn piely_list_providers(app: AppHandle) -> Result<Value, String> {
    let msg = request(&app, serde_json::json!({ "cmd": "list" }), None, None).await?;
    Ok(msg.get("providers").cloned().unwrap_or(Value::Null))
}

#[tauri::command]
pub async fn piely_get_models(app: AppHandle, provider: String) -> Result<Value, String> {
    let msg = request(
        &app,
        serde_json::json!({ "cmd": "models", "provider": provider }),
        None,
        None,
    )
    .await?;
    Ok(msg.get("models").cloned().unwrap_or(Value::Null))
}

#[tauri::command]
pub async fn piely_logout(app: AppHandle, provider: String) -> Result<(), String> {
    request(
        &app,
        serde_json::json!({ "cmd": "logout", "provider": provider }),
        None,
        None,
    )
    .await?;
    Ok(())
}

/// Cancel the interactive login, if any. Called when the login dialog closes.
#[tauri::command]
pub async fn piely_login_cancel(state: State<'_, PielyState>) -> Result<(), String> {
    cancel_active_login(&state).await
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
    login(&app, &state, provider, auth_type).await
}

/// Send the user's answer for the active login prompt to the sidecar.
#[tauri::command]
pub async fn piely_login_answer(
    state: State<'_, PielyState>,
    value: String,
) -> Result<(), String> {
    answer_login(&state, value).await
}

/// Stops one running stream (see `bridge::cancel_stream`).
#[tauri::command]
pub async fn piely_cancel_stream(app: AppHandle, stream_id: String) -> Result<(), String> {
    let state = app.state::<PielyState>();
    cancel_stream(&state, &stream_id).await
}

/// Streams one LLM turn. Deltas go to `on_event`, which belongs to this call
/// only, so concurrent streams in other windows cannot mix. Returns the final
/// turn as `{message, assistant, stopReason}`. `stream_id` is the caller's own
/// id, used by `piely_cancel_stream`.
#[tauri::command]
pub async fn piely_chat_stream(
    app: AppHandle,
    provider: String,
    model: String,
    system_prompt: Option<String>,
    messages: String,
    tools: Option<String>,
    stream_id: Option<String>,
    on_event: Channel<Value>,
) -> Result<String, String> {
    let mut payload = serde_json::json!({
        "cmd": "stream",
        "provider": provider,
        "model": model,
        "systemPrompt": system_prompt,
        "messages": serde_json::from_str::<Value>(&messages)
            .map_err(|e| format!("Invalid messages payload: {}", e))?
    });
    if let Some(tools) = tools {
        payload["tools"] = serde_json::from_str::<Value>(&tools)
            .map_err(|e| format!("Invalid tools payload: {}", e))?;
    }
    let msg = request(&app, payload, Some(on_event), stream_id.as_deref()).await?;
    Ok(stream_result(&msg))
}
