//! Where the discovery tools look when the model does not name a directory.
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use super::limits::MAX_SCAN_DEPTH;
use super::sensitive_paths::is_sensitive_target;

/// The default roots, plus the directory the model asked for.
///
/// A directory that is not on this machine must not fail the whole call: models
/// behind a sandboxed API (Codex passes `/home/oai/share/Documents`) believe the
/// user's files live somewhere else. Search the usual folders instead and say
/// so in the answer, so the model can still help.
pub(super) fn resolve_roots(
    defaults: Vec<(PathBuf, usize)>,
    requested: Option<String>,
) -> Result<(Vec<(PathBuf, usize)>, Option<String>), String> {
    let Some(dir) = requested else {
        return Ok((defaults, None));
    };
    let path = PathBuf::from(&dir);
    if path.is_dir() {
        // The model picks this path, so it can name ~/.ssh directly: a search
        // inside a credential folder would read keys into the provider's
        // context with no confirmation.
        if is_sensitive_target(&path) {
            return Err(format!(
                "refusing to search {}: it is a hidden or credential folder",
                dir
            ));
        }
        return Ok((vec![(path, MAX_SCAN_DEPTH)], None));
    }
    Ok((
        defaults,
        Some(format!(
            "{} is not on this machine, so the usual folders were searched instead",
            dir
        )),
    ))
}

/// Same for a single directory (list_directory): fall back to `default`.
pub(super) fn resolve_dir(
    default: PathBuf,
    requested: Option<String>,
) -> Result<(PathBuf, Option<String>), String> {
    let Some(dir) = requested else {
        return Ok((default, None));
    };
    let path = PathBuf::from(&dir);
    if path.is_dir() {
        if is_sensitive_target(&path) {
            return Err(format!(
                "refusing to list {}: it is a hidden or credential folder",
                dir
            ));
        }
        return Ok((path, None));
    }
    let note = format!(
        "{} is not on this machine, so {} was listed instead",
        dir,
        default.display()
    );
    Ok((default, Some(note)))
}

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

#[cfg(test)]
#[path = "../../test/tools/search_scope.rs"]
mod tests;
