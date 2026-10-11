//! `write_file`: create or replace one text file with content the model wrote.
//! Asks the user first, refuses credentials and dot-directories, and never
//! touches existing files unless the caller asked to overwrite them. The write
//! itself runs on a blocking thread: opening a FIFO for writing would wait for
//! a reader and stall the async runtime.
use std::path::PathBuf;

use super::document_text::is_document;
use super::limits::MAX_WRITE_BYTES;
use super::sensitive_paths::{is_sensitive_path, is_sensitive_target};

#[tauri::command]
pub async fn tools_write_file(
    path: String,
    content: String,
    overwrite: Option<bool>,
) -> Result<serde_json::Value, String> {
    let path = PathBuf::from(path.trim());
    if path.as_os_str().is_empty() {
        return Err("path is required".to_string());
    }
    if !path.is_absolute() {
        return Err(format!(
            "path must be absolute, got {}",
            path.display()
        ));
    }
    if is_sensitive_target(&path) {
        return Err(format!(
            "refusing to write to a credentials or hidden path: {}",
            path.display()
        ));
    }
    // Writing plain bytes into a .docx would leave a file Word cannot open:
    // this tool only ever produces text.
    if is_document(&path) {
        return Err(format!(
            "refusing to write {} as plain text: it is a PDF or office document. Write a new .txt or .md file instead.",
            path.display()
        ));
    }
    if content.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "content is too large: {} bytes (maximum {})",
            content.len(),
            MAX_WRITE_BYTES
        ));
    }

    let existed = path.exists();
    if existed {
        if path.is_dir() {
            return Err(format!("{} is a directory", path.display()));
        }
        // A symlink is not the file the user confirmed: the bytes would land
        // on its target, wherever that points.
        if std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err(format!(
                "refusing to write {}: it is a symlink, so the write would land on its target",
                path.display()
            ));
        }
        // A FIFO or device node is not a text file: writing to one blocks (no
        // reader) or talks to hardware.
        if !path.is_file() {
            return Err(format!(
                "refusing to write {}: it is not a regular file",
                path.display()
            ));
        }
        if overwrite != Some(true) {
            return Err(format!(
                "{} already exists; pass overwrite: true to replace it",
                path.display()
            ));
        }
    }

    // Creating folders, resolving symlinks and writing: all of it off the
    // runtime, so a slow or blocked write cannot stall other commands.
    tauri::async_runtime::spawn_blocking(move || {
        let parent = path
            .parent()
            .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {}", parent.display(), e))?;

        // A symlinked folder could smuggle the write into a hidden directory:
        // the check above only saw the path as written, not where it lands.
        let real_parent = std::fs::canonicalize(parent)
            .map_err(|e| format!("cannot resolve {}: {}", parent.display(), e))?;
        if is_sensitive_path(&real_parent) {
            return Err(format!(
                "refusing to write inside a credentials or hidden folder: {}",
                real_parent.display()
            ));
        }

        std::fs::write(&path, content.as_bytes())
            .map_err(|e| format!("cannot write {}: {}", path.display(), e))?;

        Ok(serde_json::json!({
            "path": path.to_string_lossy(),
            "bytes": content.len(),
            "created": !existed,
        }))
    })
    .await
    .map_err(|e| format!("Writing the file failed: {}", e))?
}

#[cfg(test)]
#[path = "../../test/tools/write_file.rs"]
mod tests;
