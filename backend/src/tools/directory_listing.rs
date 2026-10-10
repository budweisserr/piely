//! `list_directory`: a small map of a folder, for when the model has no idea
//! where to look. Skips the same directories as the search tools.
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use super::file_metadata::modified_ms;
use super::limits::{DEFAULT_DIR_ENTRIES, MAX_DIR_DEPTH, SKIP_DIRS};

// --- directory map ---------------------------------------------------------------

#[derive(Serialize)]
struct DirEntryInfo {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified_ms: u64,
}

/// Collects a bounded slice of the tree, skipping the same hidden and
/// machine-owned directories the search tools skip, so the map and the search
/// see the same world.
fn collect_dir(dir: &Path, depth: usize, out: &mut Vec<DirEntryInfo>, capacity: usize) {
    if depth == 0 || out.len() >= capacity {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= capacity {
            return;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let is_dir = file_type.is_dir();
        let meta = entry.metadata().ok();
        out.push(DirEntryInfo {
            name,
            path: entry.path().to_string_lossy().into_owned(),
            is_dir,
            size: meta.as_ref().map_or(0, std::fs::Metadata::len),
            modified_ms: meta.as_ref().map_or(0, modified_ms),
        });
        if is_dir && !file_type.is_symlink() {
            collect_dir(&entry.path(), depth - 1, out, capacity);
        }
    }
}

/// A small map of a folder, for when the model has no idea where to look.
#[tauri::command]
pub async fn tools_list_directory(
    app: AppHandle,
    path: Option<String>,
    depth: Option<usize>,
) -> Result<serde_json::Value, String> {
    let root = match path {
        Some(dir) => {
            let path = PathBuf::from(&dir);
            if !path.is_dir() {
                return Err(format!("not a directory: {}", dir));
            }
            path
        }
        None => app
            .path()
            .home_dir()
            .map_err(|e| format!("Failed to locate home directory: {}", e))?,
    };
    let depth = depth.unwrap_or(1).clamp(1, MAX_DIR_DEPTH);

    // Same reason as find_files: this walks a real directory tree.
    tauri::async_runtime::spawn_blocking(move || {
        let mut entries = Vec::new();
        collect_dir(&root, depth, &mut entries, DEFAULT_DIR_ENTRIES * 10);
        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        let truncated = entries.len() > DEFAULT_DIR_ENTRIES;
        entries.truncate(DEFAULT_DIR_ENTRIES);

        serde_json::json!({
            "path": root.to_string_lossy(),
            "depth": depth,
            "truncated": truncated,
            "count": entries.len(),
            "entries": entries,
        })
    })
    .await
    .map_err(|e| format!("Listing the directory failed: {}", e))
}
