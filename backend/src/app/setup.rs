//! The `setup` hook: everything that must happen once the app exists — window
//! placement, the dashboard pre-create, autostart, and the shortcut plugin.
use tauri::Manager;

/// Runs on startup. Kept separate from `app::run` so the builder stays a plain
/// list of plugins and commands.
pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {

    // Run hidden: no Dock icon / Cmd-Tab entry so nobody sees the app running.
    // The frontend settings toggle can still opt back in (set_app_icon_visibility).
    #[cfg(target_os = "macos")]
    if let Err(e) = app
        .handle()
        .set_activation_policy(tauri::ActivationPolicy::Accessory)
    {
        eprintln!("Failed to set activation policy: {e}");
    }

    // Setup main window positioning
    crate::window::setup_main_window(app).expect("Failed to setup main window");
    #[cfg(target_os = "macos")]
    super::macos_panel::init(app.app_handle());
    let app_handle = app.handle();
    if app_handle.get_webview_window("dashboard").is_none() {
        if let Err(e) = crate::window::create_dashboard_window(app_handle) {
            eprintln!("Failed to pre-create dashboard window on startup: {e}");
        }
    }

    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::MacosLauncher;

        #[allow(deprecated, unexpected_cfgs)]
        if let Err(e) = app.handle().plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![]),
        )) {
            eprintln!("Failed to initialize autostart plugin: {e}");
        }
    }

    // The global shortcut plugin (and its handler) belongs to the shortcuts
    // module; here we only install it.
    app.handle()
        .plugin(crate::shortcuts::global_shortcut_plugin())
        .expect("Failed to initialize global shortcut plugin");
    if let Err(e) = crate::shortcuts::setup_global_shortcuts(app.handle()) {
        eprintln!("Failed to setup global shortcuts: {e}");
    }
    Ok(())
}
