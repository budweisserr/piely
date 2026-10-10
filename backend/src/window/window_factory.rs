//! Constructing the app's windows: the overlay (`main`, declared in
//! tauri.conf.json) is positioned at startup, the dashboard is created on
//! demand and hidden instead of destroyed when it is closed.
use tauri::{App, Manager};

use super::webview_permissions::enable_media_streams;
use super::window_layout::{position_window_top_center, TOP_OFFSET};

/// Sets up the main window with custom positioning
pub fn setup_main_window(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    // Try different possible window labels
    let window = app
        .get_webview_window("main")
        .or_else(|| app.get_webview_window("piely"))
        .or_else(|| {
            // Get the first window if specific labels don't work
            app.webview_windows().values().next().cloned()
        })
        .ok_or("No window found")?;

    enable_media_streams(&window);
    position_window_top_center(&window, TOP_OFFSET)?;


    Ok(())
}
