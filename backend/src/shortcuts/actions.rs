//! What each shortcut does. Most actions only emit an event; the frontend owns
//! the behaviour (record, screenshot, listen).
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, Runtime};

#[cfg(target_os = "macos")]
use tauri_nspanel::ManagerExt;

use crate::window::toggle_dashboard_window;

use super::move_window::handle_move_window;
#[cfg(target_os = "windows")]
use super::state::WindowVisibility;

/// Routes one registered action id to its handler.
///
/// Custom ids (anything not in the match) are emitted into the webview.
pub fn handle_shortcut_action<R: Runtime>(app: &AppHandle<R>, action_id: &str) {
    match action_id {
        "toggle_dashboard" => handle_toggle_dashboard(app),
        "toggle_window" => handle_toggle_window(app),
        "focus_input" => handle_focus_input(app),
        "move_window_up" => handle_move_window(app, "up"),
        "move_window_down" => handle_move_window(app, "down"),
        "move_window_left" => handle_move_window(app, "left"),
        "move_window_right" => handle_move_window(app, "right"),
        "audio_recording" => handle_audio_shortcut(app),
        "screenshot" => handle_screenshot_shortcut(app),
        "system_audio" => handle_system_audio_shortcut(app),
        custom_action => {
            // Emit custom action event for frontend to handle
            if let Some(window) = app.get_webview_window("main") {
                if let Err(e) = window.emit(
                    "custom-shortcut-triggered",
                    json!({ "action": custom_action }),
                ) {
                    eprintln!("Failed to emit custom shortcut event: {}", e);
                }
            }
        }
    }
}

/// Handle show/hide of the overlay window (Windows keeps its own flag).
fn handle_toggle_window<R: Runtime>(app: &AppHandle<R>) {
    // Get the main window
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    #[cfg(target_os = "windows")]
    {
        let state = app.state::<WindowVisibility>();
        let mut is_hidden = state.is_hidden.lock().unwrap();
        *is_hidden = !*is_hidden;

        if let Err(e) = window.emit("toggle-window-visibility", *is_hidden) {
            eprintln!("Failed to emit toggle-window-visibility event: {}", e);
        }

        if !*is_hidden {
            if let Err(e) = window.show() {
                eprintln!("Failed to show window: {}", e);
            }
            if let Err(e) = window.set_focus() {
                eprintln!("Failed to focus window: {}", e);
            }
            if let Err(e) = window.emit("focus-text-input", json!({})) {
                eprintln!("Failed to emit focus-text-input event: {}", e);
            }
        }
        return;
    }

    #[cfg(not(target_os = "windows"))]
    match window.is_visible() {
        Ok(true) => {
            #[cfg(target_os = "macos")]
            {
                let panel = app.get_webview_window("main").unwrap();
                let _ = panel.hide();
            }
            // Window is visible, hide it and handle app icon based on user settings
            if let Err(e) = window.hide() {
                eprintln!("Failed to hide window: {}", e);
            }
        }
        Ok(false) => {
            // Window is hidden, show it and handle app icon based on user settings
            if let Err(e) = window.show() {
                eprintln!("Failed to show window: {}", e);
            }

            if let Err(e) = window.set_focus() {
                eprintln!("Failed to focus window: {}", e);
            }

            #[cfg(target_os = "macos")]
            {
                let panel = app.get_webview_panel("main").unwrap();
                panel.show();
            }
            // Emit event to focus text input
            let _ = window.emit("focus-text-input", json!({}));
        }
        Err(e) => {
            eprintln!("Failed to check window visibility: {}", e);
        }
    }
}

/// Handle audio shortcut
fn handle_audio_shortcut<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        // Ensure window is visible
        if matches!(window.is_visible(), Ok(false)) {
            if let Err(_e) = window.show() {
                return;
            }
            if let Err(e) = window.set_focus() {
                eprintln!("Failed to focus window: {e}");
            }
        }

        // Emit event to start audio recording
        if let Err(e) = window.emit("start-audio-recording", json!({})) {
            eprintln!("Failed to emit audio recording event: {e}");
        }
    }
}

/// Handle screenshot shortcut
fn handle_screenshot_shortcut<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        // Emit event to trigger screenshot - frontend will determine auto/manual mode
        if let Err(e) = window.emit("trigger-screenshot", json!({})) {
            eprintln!("Failed to emit screenshot event: {e}");
        }
    }
}

/// Handle system audio shortcut
fn handle_system_audio_shortcut<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        // Ensure window is visible
        if matches!(window.is_visible(), Ok(false)) {
            if let Err(e) = window.show() {
                eprintln!("Failed to show window: {e}");
                return;
            }
            if let Err(e) = window.set_focus() {
                eprintln!("Failed to focus window: {e}");
            }
        }

        // Emit event to toggle system audio capture - frontend will determine current state
        if let Err(e) = window.emit("toggle-system-audio", json!({})) {
            eprintln!("Failed to emit system audio event: {e}");
        }
    }
}

/// Handle toggle dashboard shortcut
fn handle_toggle_dashboard<R: Runtime>(app: &AppHandle<R>) {
    // Same path as the `toggle_dashboard` command: one place decides show/hide.
    if let Err(e) = toggle_dashboard_window(app) {
        eprintln!("Failed to toggle dashboard window: {e}");
    }
}

/// Handle focus input shortcut
fn handle_focus_input<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        // Ensure window is visible
        if matches!(window.is_visible(), Ok(false)) {
            let _ = window.show();
        }

        let _ = window.set_focus();
        let _ = window.emit("focus-text-input", json!({}));
    }
}

/// Tauri command to exit the application
#[tauri::command]
pub fn exit_app(app_handle: tauri::AppHandle) {
    app_handle.exit(0);
}
