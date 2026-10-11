//! `search_files_content`: find a file by what is inside it. The only tool that
//! reads contents, so the budget is explicit and the walk runs on a blocking
//! thread. Documents (PDF, office) are unpacked; other binaries are counted as
//! skipped, not ignored.
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use super::document_text::{extract_text, is_document};
use super::file_metadata::modified_ms;
use super::limits::{
    DEFAULT_CONTENT_LIMIT, MAX_CONTENT_BYTES, MAX_CONTENT_FILES, MAX_CONTENT_FILE_BYTES,
    MAX_CONTENT_LIMIT, MAX_DOCUMENTS_EXTRACTED, MAX_DOCUMENT_BYTES, MAX_QUERY_CHARS,
    MAX_QUERY_TERMS, MAX_SEARCH_SECONDS, MAX_SNIPPETS_PER_FILE, MAX_SNIPPET_CHARS, SKIP_DIRS,
};
use super::search_scope::{resolve_roots, search_roots};
use super::sensitive_paths::is_sensitive_path;

// --- content search -------------------------------------------------------------

#[derive(Debug, Serialize)]
struct ContentMatch {
    path: String,
    name: String,
    size: u64,
    modified_ms: u64,
    /// How many of the query's terms appear somewhere in the file.
    terms_matched: usize,
    /// How often the terms appear in total.
    match_count: usize,
    /// Short excerpts, "L<line>: <text>", for judging relevance.
    snippets: Vec<String>,
}

/// The terms a query is matched by: whitespace separated, lowercased.
/// A multi-word query means "all of these appear in the file", which is what a
/// user means when they describe what a document is about instead of its name.
fn query_terms(query: &str) -> Vec<String> {
    query
        .chars()
        .take(MAX_QUERY_CHARS)
        .collect::<String>()
        .split_whitespace()
        .take(MAX_QUERY_TERMS)
        .map(str::to_lowercase)
        .filter(|term| !term.is_empty())
        .collect()
}

#[derive(Default, Debug)]
struct TextScan {
    terms_matched: usize,
    occurrences: usize,
    snippets: Vec<String>,
}

/// Scans one file's text for the terms. Pure, so the matching and the ranking
/// inputs can be tested without touching the filesystem.
fn scan_text(text: &str, terms: &[String]) -> TextScan {
    let mut scan = TextScan::default();
    let mut seen = vec![false; terms.len()];

    // Lowercase once for the whole file instead of allocating per line; the two
    // iterators stay aligned because lowercasing does not change newlines.
    let lowered = text.to_lowercase();
    for (index, (line, lower_line)) in text.lines().zip(lowered.lines()).enumerate() {
        let mut line_hits = 0;
        for (term_index, term) in terms.iter().enumerate() {
            let hits = lower_line.matches(term.as_str()).count();
            if hits > 0 {
                seen[term_index] = true;
                line_hits += hits;
            }
        }
        if line_hits == 0 {
            continue;
        }

        scan.occurrences += line_hits;
        if scan.snippets.len() < MAX_SNIPPETS_PER_FILE {
            let snippet: String = line.trim().chars().take(MAX_SNIPPET_CHARS).collect();
            scan.snippets.push(format!("L{}: {}", index + 1, snippet));
        }
    }

    scan.terms_matched = seen.iter().filter(|hit| **hit).count();
    scan
}

/// True when the bytes look like text a model can read: no NUL byte and valid
/// UTF-8. Keeps binaries (and most PDFs) out of the snippets.
fn looks_like_text(bytes: &[u8]) -> bool {
    !bytes.contains(&0) && std::str::from_utf8(bytes).is_ok()
}

fn normalize_extensions(raw: &Option<Vec<String>>) -> Vec<String> {
    raw.as_ref()
        .map(|list| {
            list.iter()
                .map(|ext| ext.trim_start_matches('.').to_lowercase())
                .filter(|ext| !ext.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn extension_allowed(path: &Path, extensions: &[String]) -> bool {
    if extensions.is_empty() {
        return true;
    }
    let ext = path
        .extension()
        .map_or(String::new(), |e| e.to_string_lossy().to_lowercase());
    extensions.iter().any(|wanted| *wanted == ext)
}

/// For "I need the document about X" when the name is unknown. Reads text
/// files only; the skipped binaries are reported back.
#[tauri::command]
pub async fn tools_search_files_content(
    app: AppHandle,
    query: String,
    directory: Option<String>,
    extensions: Option<Vec<String>>,
    limit: Option<usize>,
) -> Result<serde_json::Value, String> {
    let query = query.trim().to_string();
    let terms = query_terms(&query);
    if terms.is_empty() {
        return Err("query is required".to_string());
    }
    let limit = limit
        .unwrap_or(DEFAULT_CONTENT_LIMIT)
        .clamp(1, MAX_CONTENT_LIMIT);
    let extensions = normalize_extensions(&extensions);

    let (roots, note) = resolve_roots(search_roots(&app), directory)?;

    tauri::async_runtime::spawn_blocking(move || {
        let outcome = search_for_content(&roots, &terms, &extensions, limit);

        Ok(serde_json::json!({
            "query": query,
            "note": note,
            "terms": terms,
            "files_scanned": outcome.files_scanned,
            "documents_read": outcome.documents_read,
            "skipped_binary": outcome.skipped_binary,
            "truncated": outcome.truncated,
            "count": outcome.matches.len(),
            "results": outcome.matches,
        }))
    })
    .await
    .map_err(|e| format!("Content search failed: {}", e))?
}

/// Result of one content search over a set of roots.
#[derive(Debug, Default)]
struct ContentSearchOutcome {
    matches: Vec<ContentMatch>,
    files_scanned: usize,
    /// PDFs and office files whose text was read (see document_text).
    documents_read: usize,
    /// Files with no readable text: images, archives, scanned PDFs.
    skipped_binary: usize,
    truncated: bool,
}

/// Walks the roots and reads files, bounded by the limits above. Separate from
/// the command so the traversal, filtering and ranking can be tested on real
/// files without a Tauri handle.
fn search_for_content(
    roots: &[(PathBuf, usize)],
    terms: &[String],
    extensions: &[String],
    limit: usize,
) -> ContentSearchOutcome {
    let mut outcome = ContentSearchOutcome::default();
    let mut bytes_scanned = 0u64;
    let mut documents_extracted = 0usize;
    let hit_capacity = limit * 5;
    let started = std::time::Instant::now();

    'roots: for (root, depth) in roots {
        let mut stack = vec![(root.clone(), *depth)];
        while let Some((dir, remaining)) = stack.pop() {
            if outcome.files_scanned >= MAX_CONTENT_FILES
                || bytes_scanned >= MAX_CONTENT_BYTES
                || started.elapsed().as_secs() >= MAX_SEARCH_SECONDS
            {
                outcome.truncated = true;
                break 'roots;
            }
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') {
                    continue;
                }
                // Same policy the reading tools use: no keys, tokens or .env
                // files, whether or not the user was asked first.
                if is_sensitive_path(&entry.path()) {
                    continue;
                }
                let Ok(file_type) = entry.file_type() else {
                    continue;
                };
                if file_type.is_dir() {
                    if SKIP_DIRS.contains(name.as_str()) || remaining == 0 {
                        continue;
                    }
                    stack.push((entry.path(), remaining - 1));
                    continue;
                }
                if !file_type.is_file() || !extension_allowed(&entry.path(), extensions) {
                    continue;
                }
                let Ok(meta) = entry.metadata() else {
                    continue;
                };
                // A document is a zip of XML or a PDF, so it is allowed to be
                // bigger than a text file and costs extraction instead of a read.
                let document = is_document(&entry.path());
                let size_cap = if document {
                    MAX_DOCUMENT_BYTES
                } else {
                    MAX_CONTENT_FILE_BYTES
                };
                if meta.len() == 0 || meta.len() > size_cap {
                    continue;
                }
                if document && documents_extracted >= MAX_DOCUMENTS_EXTRACTED {
                    outcome.truncated = true;
                    continue;
                }

                outcome.files_scanned += 1;

                let text = if document {
                    documents_extracted += 1;
                    match extract_text(&entry.path()) {
                        Some(text) => {
                            outcome.documents_read += 1;
                            text
                        }
                        None => {
                            outcome.skipped_binary += 1;
                            continue;
                        }
                    }
                } else {
                    let Ok(bytes) = std::fs::read(entry.path()) else {
                        continue;
                    };
                    if !looks_like_text(&bytes) {
                        outcome.skipped_binary += 1;
                        continue;
                    }
                    String::from_utf8_lossy(&bytes).into_owned()
                };
                bytes_scanned += text.len() as u64;

                let scan = scan_text(&text, terms);
                if scan.terms_matched == 0 {
                    continue;
                }
                outcome.matches.push(ContentMatch {
                    path: entry.path().to_string_lossy().into_owned(),
                    name,
                    size: meta.len(),
                    modified_ms: modified_ms(&meta),
                    terms_matched: scan.terms_matched,
                    match_count: scan.occurrences,
                    snippets: scan.snippets,
                });
                if outcome.matches.len() >= hit_capacity {
                    outcome.truncated = true;
                    break 'roots;
                }
            }
        }
    }

    // Most query terms first, then the most mentions, then the newest.
    outcome.matches.sort_by(|a, b| {
        b.terms_matched
            .cmp(&a.terms_matched)
            .then(b.match_count.cmp(&a.match_count))
            .then(b.modified_ms.cmp(&a.modified_ms))
    });
    outcome.matches.truncate(limit);
    outcome
}

#[cfg(test)]
#[path = "../../test/tools/content_search.rs"]
mod tests;
