//! `open_file` / `open_app`: hand something to the OS. Both run only after the
//! user confirmed. On Linux, `.desktop` entries go through their Exec line.
use std::path::{Path, PathBuf};
#[cfg(target_os = "linux")]
use std::process::Command;
use tauri::AppHandle;

use super::installed_apps::{list_apps, resolve_app};

/// Open a file, folder or app bundle with the OS default handler. Only called
/// after the user confirms the action in the UI.
#[tauri::command]
pub async fn tools_open_path(path: String) -> Result<(), String> {
    let path = PathBuf::from(&path);
    if !path.exists() {
        return Err(format!("path does not exist: {}", path.display()));
    }
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| e.to_string())
}

/// Launch an installed app by name, id (as returned by `tools_list_apps`) or
/// path. Linux .desktop entries are launched through their Exec line; other
/// platforms open the target with the OS shell.
#[tauri::command]
pub async fn tools_open_app(app: AppHandle, name: String) -> Result<(), String> {
    let wanted = name.trim();
    if wanted.is_empty() {
        return Err("name is required".to_string());
    }

    let apps = list_apps(&app);
    // A path outside the app list is opened directly (open_file handles files).
    let path = match resolve_app(&apps, wanted) {
        Ok(found) => found.path.clone(),
        Err(error) => {
            if Path::new(wanted).exists() {
                wanted.to_string()
            } else {
                return Err(error);
            }
        }
    };

    #[cfg(target_os = "linux")]
    if path.ends_with(".desktop") {
        return launch_desktop_entry(Path::new(&path));
    }
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| e.to_string())
}

/// Launch a .desktop entry via its Exec line. Field codes (%U, %f, ...) are
/// dropped; Exec is split on whitespace, so quoted paths with spaces are not
/// supported (rare for the apps we surface).
#[cfg(target_os = "linux")]
fn launch_desktop_entry(path: &Path) -> Result<(), String> {
    let contents =
        std::fs::read_to_string(path).map_err(|e| format!("cannot read {}: {}", path.display(), e))?;
    let exec = contents
        .lines()
        .find_map(|line| line.strip_prefix("Exec=").map(str::trim))
        .ok_or_else(|| format!("no Exec= line in {}", path.display()))?;
    let mut parts = exec
        .split_whitespace()
        .filter(|part| !part.starts_with('%'))
        .map(str::to_string);
    let program = parts.next().ok_or_else(|| "empty Exec=".to_string())?;
    let mut child = Command::new(&program)
        .args(parts)
        .spawn()
        .map_err(|e| format!("failed to launch {}: {}", program, e))?;
    // Reap on a detached thread: `spawn` alone leaves a zombie behind until
    // the app exits.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}
