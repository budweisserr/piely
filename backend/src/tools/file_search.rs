//! `find_files`: match names under the search roots. The walk uses an explicit
//! stack (no recursion to blow up), never follows symlinks, and is capped.
use serde::Serialize;
use std::path::Path;
use tauri::AppHandle;

use super::file_metadata::modified_ms;
use super::limits::{DEFAULT_FIND_LIMIT, MAX_FIND_LIMIT, MAX_SCAN_DIRS, SKIP_DIRS};
use super::search_scope::{resolve_roots, search_roots};
use super::sensitive_paths::is_sensitive_path;

#[derive(Serialize)]
struct FileHit {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified_ms: u64,
    #[serde(skip)]
    score: u32,
}

/// The scoring itself, on already-lowercased input: a walk calls this once per
/// visited entry, so the query must not be lowered again for each of them.
fn score_name(name: &str, query: &str) -> Option<u32> {
    if query.is_empty() {
        return Some(0);
    }
    if name == query {
        return Some(1);
    }
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    if stem == query {
        return Some(2);
    }
    if name.starts_with(&query) {
        return Some(3);
    }
    if name.contains(&query) {
        return Some(4);
    }
    // Fuzzy: the query characters appear in order somewhere in the name.
    let mut chars = name.chars();
    if query.chars().all(|c| chars.any(|n| n == c)) {
        return Some(5);
    }
    None
}

#[tauri::command]
pub async fn tools_find_files(
    app: AppHandle,
    query: String,
    directory: Option<String>,
    limit: Option<usize>,
) -> Result<serde_json::Value, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("query is required".to_string());
    }
    let limit = limit
        .unwrap_or(DEFAULT_FIND_LIMIT)
        .clamp(1, MAX_FIND_LIMIT);

    let (roots, note) = resolve_roots(search_roots(&app), directory)?;

    // The walk reads real directories and can take seconds on a cold cache or a
    // network mount; it must not run on an async runtime worker thread.
    let query = query.to_lowercase();
    let response = tauri::async_runtime::spawn_blocking(move || {
        let mut hits: Vec<FileHit> = Vec::new();
        let mut scanned = 0usize;
        for (root, depth) in roots {
            walk(&root, depth, &query, &mut hits, &mut scanned, limit * 5);
        }

        hits.sort_by(|a, b| {
            a.score
                .cmp(&b.score)
                .then(b.modified_ms.cmp(&a.modified_ms))
                .then(a.name.cmp(&b.name))
        });
        hits.truncate(limit);

        serde_json::json!({
            "query": query,
            "note": note,
            "count": hits.len(),
            "results": hits,
        })
    })
    .await
    .map_err(|e| format!("File search failed: {}", e))?;

    Ok(response)
}

/// Depth-bounded, non-following directory walk (explicit stack: no recursion
/// limit, no symlink loops).
fn walk(
    root: &Path,
    depth: usize,
    query: &str, // already lowercased
    
    hits: &mut Vec<FileHit>,
    scanned: &mut usize,
    hit_capacity: usize,
) {
    let mut stack = vec![(root.to_path_buf(), depth)];
    while let Some((dir, remaining)) = stack.pop() {
        if *scanned >= MAX_SCAN_DIRS || hits.len() >= hit_capacity {
            return;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            *scanned += 1;
            if *scanned >= MAX_SCAN_DIRS || hits.len() >= hit_capacity {
                return;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || is_sensitive_path(&entry.path()) {
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let is_dir = file_type.is_dir();
            if is_dir && SKIP_DIRS.contains(name.as_str()) {
                continue;
            }
            if let Some(score) = score_name(&name.to_lowercase(), query) {
                let meta = entry.metadata().ok();
                hits.push(FileHit {
                    name: name.clone(),
                    path: entry.path().to_string_lossy().into_owned(),
                    is_dir,
                    size: meta.as_ref().map_or(0, std::fs::Metadata::len),
                    modified_ms: meta.as_ref().map_or(0, modified_ms),
                    score,
                });
            }
            // Never descend into symlinks: loops and out-of-scope targets.
            if is_dir && remaining > 0 && !file_type.is_symlink() {
                stack.push((entry.path(), remaining - 1));
            }
        }
    }
}

#[cfg(test)]
#[path = "../../test/tools/file_search.rs"]
mod tests;
