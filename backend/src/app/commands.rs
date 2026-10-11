//! The two app-level commands: version reporting and frontend error logging.
/// Forward an unhandled frontend error to stderr, so `tauri dev` (and release
/// logs) show what broke instead of a webview failing silently.
#[tauri::command]
pub fn log_frontend_error(message: String, context: Option<String>) {
    match context.filter(|context| !context.is_empty()) {
        Some(context) => eprintln!("[frontend] {message}\n{context}"),
        None => eprintln!("[frontend] {message}"),
    }
}

#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
