//! `list_apps`: what is installed, per operating system, plus the name
//! resolution `open_app` uses. It never guesses: near matches come back for the
//! model to choose from.
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use super::limits::MAX_APP_RESULTS;

/// One installed application. Read by `open_app`, which is a sibling module.
#[derive(Debug, Serialize)]
pub(super) struct AppEntry {
    pub(super) name: String,
    pub(super) id: String,
    pub(super) path: String,
}

/// Installed applications for the current OS. macOS reads .app bundles, Linux
/// reads .desktop entries, Windows reads Start Menu shortcuts and Program Files.
#[tauri::command]
pub async fn tools_list_apps(
    app: AppHandle,
    query: Option<String>,
) -> Result<serde_json::Value, String> {
    // Reads several application directories; keep it off the async runtime.
    let apps = tauri::async_runtime::spawn_blocking(move || {
        let mut apps = list_apps(&app);
        if let Some(query) = query.map(|q| q.trim().to_lowercase()).filter(|q| !q.is_empty()) {
            apps.retain(|a| a.name.to_lowercase().contains(&query));
        }
        let mut seen = HashSet::new();
        apps.retain(|a| seen.insert(a.id.clone()));
        apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        apps.truncate(MAX_APP_RESULTS);
        apps
    })
    .await
    .map_err(|e| format!("Listing applications failed: {}", e))?;

    Ok(serde_json::json!({ "count": apps.len(), "results": apps }))
}
pub(super) fn list_apps(app: &AppHandle) -> Vec<AppEntry> {
    let mut apps = Vec::new();
    #[cfg(target_os = "macos")]
    {
        let mut dirs = vec![
            PathBuf::from("/Applications"),
            PathBuf::from("/System/Applications"),
        ];
        if let Ok(home) = app.path().home_dir() {
            dirs.push(home.join("Applications"));
        }
        for dir in dirs {
            collect_bundles(&dir, &mut apps, 2);
        }
    }
    #[cfg(target_os = "linux")]
    {
        let mut dirs = vec![
            PathBuf::from("/usr/share/applications"),
            PathBuf::from("/usr/local/share/applications"),
        ];
        if let Ok(home) = app.path().home_dir() {
            dirs.push(home.join(".local/share/applications"));
        }
        for dir in dirs {
            collect_desktop_entries(&dir, &mut apps);
        }
    }
    #[cfg(target_os = "windows")]
    {
        for var in ["ProgramData", "APPDATA"] {
            if let Ok(base) = std::env::var(var) {
                let start_menu = PathBuf::from(base).join("Microsoft\\Windows\\Start Menu\\Programs");
                collect_shortcuts(&start_menu, &mut apps, 4);
            }
        }
        for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Ok(base) = std::env::var(var) {
                collect_programs(&PathBuf::from(base).join("Programs"), &mut apps);
                collect_programs(&PathBuf::from(&base), &mut apps);
            }
        }
    }
    let _ = app;
    apps
}

#[cfg(target_os = "macos")]
fn collect_bundles(dir: &Path, apps: &mut Vec<AppEntry>, depth: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() && name.ends_with(".app") {
            apps.push(AppEntry {
                name: name.trim_end_matches(".app").to_string(),
                id: path.to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
            });
        } else if depth > 0 && path.is_dir() && !name.starts_with('.') {
            collect_bundles(&path, apps, depth - 1);
        }
    }
}

#[cfg(target_os = "linux")]
fn collect_desktop_entries(dir: &Path, apps: &mut Vec<AppEntry>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("desktop") {
            continue;
        }
        let Ok(contents) = std::fs::read_to_string(&path) else {
            continue;
        };
        let mut name = None;
        let mut exec = None;
        let mut hidden = false;
        let mut is_application = false;
        for line in contents.lines() {
            if let Some(value) = line.strip_prefix("Name=") {
                name.get_or_insert_with(|| value.trim().to_string());
            } else if let Some(value) = line.strip_prefix("Exec=") {
                exec.get_or_insert_with(|| value.trim().to_string());
            } else if line.trim() == "NoDisplay=true" || line.trim() == "Hidden=true" {
                hidden = true;
            } else if line.trim() == "Type=Application" {
                is_application = true;
            }
        }
        if hidden || !is_application {
            continue;
        }
        if let (Some(name), Some(exec)) = (name, exec) {
            apps.push(AppEntry {
                name,
                id: exec,
                path: path.to_string_lossy().into_owned(),
            });
        }
    }
}

#[cfg(target_os = "windows")]
fn collect_shortcuts(dir: &Path, apps: &mut Vec<AppEntry>, depth: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.extension().and_then(|e| e.to_str()) == Some("lnk") {
            apps.push(AppEntry {
                name: name.trim_end_matches(".lnk").to_string(),
                id: path.to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
            });
        } else if depth > 0 && path.is_dir() {
            collect_shortcuts(&path, apps, depth - 1);
        }
    }
}

#[cfg(target_os = "windows")]
fn collect_programs(dir: &Path, apps: &mut Vec<AppEntry>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            apps.push(AppEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                id: path.to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
            });
        }
    }
}

/// Resolves an app from a name, id or path, exact matches only. A substring
/// match would launch "Visual Studio Code" for "Code", and the user approves
/// the name the model asked for. Near matches are returned to choose from.
pub(super) fn resolve_app<'a>(apps: &'a [AppEntry], wanted: &str) -> Result<&'a AppEntry, String> {
    let trimmed = wanted.trim();
    let needle = trimmed.to_lowercase();

    if let Some(found) = apps.iter().find(|a| a.id == trimmed || a.path == trimmed) {
        return Ok(found);
    }
    if let Some(found) = apps
        .iter()
        .find(|a| a.name.to_lowercase() == needle)
    {
        return Ok(found);
    }

    let mut near: Vec<&str> = apps
        .iter()
        .filter(|a| a.name.to_lowercase().contains(&needle))
        .map(|a| a.name.as_str())
        .collect();
    near.truncate(5);
    if near.is_empty() {
        Err(format!(
            "no installed application named '{}'. Call list_apps to see what is installed.",
            trimmed
        ))
    } else {
        Err(format!(
            "no application named '{}'. Did you mean: {}?",
            trimmed,
            near.join(", ")
        ))
    }
}

#[cfg(test)]
#[path = "../../test/tools/installed_apps.rs"]
mod tests;
