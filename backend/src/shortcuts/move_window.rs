//! Continuous window movement: holding the shortcut moves the overlay at a
//! steady 16 ms tick until the key is released.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Manager, Runtime};
use tokio::time::{sleep, Duration};

use super::state::{MoveWindowState, MoveWindowTask};

pub fn start_move_window<R: Runtime>(app: &AppHandle<R>, direction: &str) {
    let state = app.state::<MoveWindowState>();
    let mut tasks = match state.tasks.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };

    if tasks.contains_key(direction) {
        return;
    }

    let stop_flag: MoveWindowTask = Arc::new(AtomicBool::new(false));
    let flag_clone = stop_flag.clone();
    let dir = direction.to_string();
    let app_handle = app.clone();

    tauri::async_runtime::spawn(async move {
        let interval = Duration::from_millis(16);
        while !flag_clone.load(Ordering::Relaxed) {
            handle_move_window(&app_handle, &dir);
            sleep(interval).await;
        }
    });

    tasks.insert(direction.to_string(), stop_flag);
}

pub fn stop_move_window<R: Runtime>(app: &AppHandle<R>, direction: &str) {
    let state = app.state::<MoveWindowState>();
    let mut tasks = match state.tasks.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };

    if let Some(flag) = tasks.remove(direction) {
        flag.store(true, Ordering::Relaxed);
    }
}

pub fn stop_all_move_windows<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<MoveWindowState>();
    let mut tasks = match state.tasks.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };

    for (_direction, flag) in tasks.drain() {
        flag.store(true, Ordering::Relaxed);
    }
}

/// Handle app toggle (hide/show) with input focus and app icon management
pub(super) fn handle_move_window<R: Runtime>(app: &AppHandle<R>, direction: &str) {
    if let Some(window) = app.get_webview_window("main") {
        match window.outer_position() {
            Ok(current_pos) => {
                let step = 12;
                let (new_x, new_y) = match direction {
                    "up" => (current_pos.x, current_pos.y - step),
                    "down" => (current_pos.x, current_pos.y + step),
                    "left" => (current_pos.x - step, current_pos.y),
                    "right" => (current_pos.x + step, current_pos.y),
                    _ => {
                        eprintln!("Invalid direction: {}", direction);
                        return;
                    }
                };

                if let Err(e) =
                    window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                        x: new_x,
                        y: new_y,
                    }))
                {
                    eprintln!("Failed to set window position: {}", e);
                }
            }
            Err(e) => {
                eprintln!("Failed to get window position: {}", e);
            }
        }
    } else {
        eprintln!("Main window not found");
    }
}

#[cfg(test)]
#[path = "../../test/shortcuts/move_window.rs"]
mod tests;
