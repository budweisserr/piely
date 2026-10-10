//! `read_file`: a short preview of one file, or a folder listing. Asks the user
//! first (the preview goes to the provider) and refuses credentials.
use serde::Serialize;
use std::path::PathBuf;

use super::limits::{DEFAULT_PREVIEW_BYTES, IMAGE_EXTS, MAX_PREVIEW_BYTES};
use super::sensitive_paths::is_sensitive_target;

#[derive(Serialize)]
struct Preview {
    kind: String,
    name: String,
    path: String,
    size: u64,
    truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    entries: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[tauri::command]
pub async fn tools_read_file(
    path: String,
    max_bytes: Option<usize>,
) -> Result<serde_json::Value, String> {
    let path = PathBuf::from(&path);
    if is_sensitive_target(&path) {
        return Err(format!(
            "refusing to read a credentials or key file: {}",
            path.display()
        ));
    }
    let meta = std::fs::metadata(&path).map_err(|e| format!("cannot read {}: {}", path.display(), e))?;    let name = path
        .file_name()
        .map_or_else(String::new, |n| n.to_string_lossy().into_owned());

    if meta.is_dir() {
        let mut entries: Vec<String> = std::fs::read_dir(&path)
            .map_err(|e| format!("cannot list {}: {}", path.display(), e))?
            .flatten()
            .map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                if entry.file_type().is_ok_and(|t| t.is_dir()) {
                    format!("{}/", name)
                } else {
                    name
                }
            })
            .collect();
        entries.sort();
        entries.truncate(100);
        return Ok(serde_json::to_value(Preview {
            kind: "directory".to_string(),
            name,
            path: path.to_string_lossy().into_owned(),
            size: 0,
            truncated: false,
            text: None,
            entries: Some(entries),
            message: None,
        })
        .map_err(|e| e.to_string())?);
    }

    let ext = path
        .extension()
        .map_or(String::new(), |e| e.to_string_lossy().to_lowercase());
    if IMAGE_EXTS.contains(&ext.as_str()) {
        return Ok(serde_json::to_value(Preview {
            kind: "image".to_string(),
            name,
            path: path.to_string_lossy().into_owned(),
            size: meta.len(),
            truncated: false,
            text: None,
            entries: None,
            message: Some("Image file: no text preview available.".to_string()),
        })
        .map_err(|e| e.to_string())?);
    }

    let max_bytes = max_bytes
        .unwrap_or(DEFAULT_PREVIEW_BYTES)
        .clamp(256, MAX_PREVIEW_BYTES);
    let bytes = std::fs::read(&path).map_err(|e| format!("cannot read {}: {}", path.display(), e))?;
    let truncated = bytes.len() > max_bytes;
    let head = &bytes[..bytes.len().min(max_bytes)];

    let binary = head.iter().any(|b| *b == 0) || std::str::from_utf8(head).is_err();
    if binary {
        return Ok(serde_json::to_value(Preview {
            kind: "binary".to_string(),
            name,
            path: path.to_string_lossy().into_owned(),
            size: meta.len(),
            truncated,
            text: None,
            entries: None,
            message: Some("Binary file: no text preview available.".to_string()),
        })
        .map_err(|e| e.to_string())?);
    }

    let text = String::from_utf8_lossy(head).into_owned();
    Ok(serde_json::to_value(Preview {
        kind: "text".to_string(),
        name,
        path: path.to_string_lossy().into_owned(),
        size: meta.len(),
        truncated,
        text: Some(text),
        entries: None,
        message: None,
    })
    .map_err(|e| e.to_string())?)
}
