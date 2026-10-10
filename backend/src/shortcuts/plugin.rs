//! The global-shortcut plugin and its one handler: look the key up in
//! [`RegisteredShortcuts`], then run the action (press starts a window move,
//! release stops it).
use tauri::plugin::TauriPlugin;
use tauri::{Manager, Runtime};

use super::{handle_shortcut_action, RegisteredShortcuts};

/// The plugin the app installs at startup. Registered shortcuts are stored in
/// [`RegisteredShortcuts`] and can be changed at runtime with `update_shortcuts`.
pub fn global_shortcut_plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(move |app, shortcut, event| {
            use tauri_plugin_global_shortcut::ShortcutState;

            let action_id = {
                let state = app.state::<RegisteredShortcuts>();
                let registered = match state.shortcuts.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => {
                        eprintln!("Mutex poisoned in handler, recovering...");
                        poisoned.into_inner()
                    }
                };

                registered
                    .iter()
                    .find_map(|(action_id, s)| (s == shortcut).then(|| action_id.clone()))
            };

            if let Some(action_id) = action_id {
                match event.state() {
                    ShortcutState::Pressed => {
                        if let Some(direction) = action_id.strip_prefix("move_window_") {
                            super::start_move_window(app, direction);
                        } else {
                            handle_shortcut_action(app, &action_id);
                        }
                    }
                    ShortcutState::Released => {
                        if let Some(direction) = action_id.strip_prefix("move_window_") {
                            super::stop_move_window(app, direction);
                        }
                    }
                }
            }
        })
        .build()
}
