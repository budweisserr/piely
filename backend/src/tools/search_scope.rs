//! Where the discovery tools look when the model does not name a directory.
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use super::limits::MAX_SCAN_DEPTH;

/// Roots searched when the model does not name a directory. Desktop/Documents/
/// Downloads are searched deeply; the home directory itself only shallowly.
pub(super) fn search_roots(app: &AppHandle) -> Vec<(PathBuf, usize)> {
    let mut roots = Vec::new();
    let Ok(home) = app.path().home_dir() else {
        return roots;
    };
    for name in ["Desktop", "Documents", "Downloads"] {
        let dir = home.join(name);
        if dir.is_dir() {
            roots.push((dir, MAX_SCAN_DEPTH));
        }
    }
    if home.is_dir() {
        roots.push((home, 2));
    }
    roots
}
