//! Text out of the documents people actually keep their work in: Office and ODF
//! files (a zip of XML) and PDFs. Content search and `read_file` share this, so
//! "find the lab about X" also works on .docx and .pdf, not only on .txt.
use std::io::Read;
use std::path::Path;

use super::limits::{
    MAX_DOCUMENT_BYTES, MAX_DOCUMENT_CHARS, MAX_DOCUMENT_PART_BYTES, MAX_DOCUMENT_PARTS,
    MAX_PDF_BYTES,
};

/// Formats `extract_text` understands. Scanned (image-only) PDFs hold no text.
const DOCUMENT_EXTS: &[&str] = &[
    "docx", "docm", "dotx", "xlsx", "xlsm", "xltx", "pptx", "pptm", "odt", "ods", "odp", "epub",
    "pdf",
];

/// Tags that end a line of text, by local name (after the namespace): Word,
/// PowerPoint and ODF all call a paragraph `p`, spreadsheets call a row `row`.
const BREAK_TAGS: &[&str] = &["p", "br", "row", "tr", "li", "h", "line-break"];
/// Tags whose content is one cell of a row.
const TAB_TAGS: &[&str] = &["c", "cell", "tab"];

fn extension(path: &Path) -> String {
    path.extension()
        .map_or(String::new(), |e| e.to_string_lossy().to_lowercase())
}

/// True for a file whose text needs unpacking (see `extract_text`).
pub(super) fn is_document(path: &Path) -> bool {
    DOCUMENT_EXTS.contains(&extension(path).as_str())
}

/// The text of one document, or None when there is nothing to read. Never fails
/// the caller: an unreadable document is a document with nothing to match.
pub(super) fn extract_text(path: &Path) -> Option<String> {
    // Only regular files: opening a FIFO waits for a writer, and a device node
    // can stream forever, either of which would hang the search.
    let size = std::fs::metadata(path).ok().filter(|meta| meta.is_file())?.len();

    let text = match extension(path).as_str() {
        "pdf" => extract_pdf(path, size),
        _ => extract_zip(path, size),
    };
    text.filter(|text| !text.trim().is_empty())
}

/// A PDF is parsed for real: font encodings decide what the bytes mean, so
/// scanning the raw file would only produce noise (and Cyrillic mojibake).
fn extract_pdf(path: &Path, size: u64) -> Option<String> {
    if size > MAX_PDF_BYTES {
        return None;
    }
    // The parser is third party and a malformed PDF can make it panic; one bad
    // file must not take the whole search down with it.
    std::panic::catch_unwind(|| pdf_extract::extract_text(path))
        .ok()
        .and_then(Result::ok)
        .map(|text| text.chars().take(MAX_DOCUMENT_CHARS).collect())
}

/// Office/ODF files are zip archives; the text sits in a few XML members.
fn extract_zip(path: &Path, size: u64) -> Option<String> {
    if size > MAX_DOCUMENT_BYTES {
        return None;
    }
    let file = std::fs::File::open(path).ok()?;
    let mut archive = zip::ZipArchive::new(file).ok()?;
    let ext = extension(path);

    let names: Vec<String> = (0..archive.len())
        .filter_map(|index| archive.by_index(index).ok().map(|f| f.name().to_owned()))
        .filter(|name| is_text_member(&ext, name))
        .take(MAX_DOCUMENT_PARTS)
        .collect();

    let mut out = String::new();
    for name in names {
        let Ok(mut member) = archive.by_name(&name) else {
            continue;
        };
        // Read only the head of one member: a huge sheet must not stall the walk.
        let mut xml = String::new();
        if member
            .by_ref()
            .take(MAX_DOCUMENT_PART_BYTES)
            .read_to_string(&mut xml)
            .is_err()
        {
            continue;
        }
        out.push_str(&xml_to_text(&xml));
        out.push('\n');
        if out.chars().count() >= MAX_DOCUMENT_CHARS {
            break;
        }
    }
    Some(out.chars().take(MAX_DOCUMENT_CHARS).collect())
}

/// Which archive members hold the text of this format.
fn is_text_member(ext: &str, name: &str) -> bool {
    match ext {
        "docx" | "docm" | "dotx" => name == "word/document.xml",
        "xlsx" | "xlsm" | "xltx" => {
            name == "xl/sharedStrings.xml"
                || (name.starts_with("xl/worksheets/") && name.ends_with(".xml"))
        }
        "pptx" | "pptm" => name.starts_with("ppt/slides/slide") && name.ends_with(".xml"),
        "odt" | "ods" | "odp" => name == "content.xml",
        "epub" => name.ends_with(".xhtml") || name.ends_with(".html") || name.ends_with(".htm"),
        _ => false,
    }
}

/// Strips XML, keeping paragraph and cell boundaries. A real parser is not
/// needed for this: the text of a document is its text, attributes and all.
fn xml_to_text(xml: &str) -> String {
    let mut out = String::with_capacity(xml.len() / 2);
    let mut rest = xml;
    while let Some(start) = rest.find('<') {
        push_entities(&mut out, &rest[..start]);
        let Some(end) = rest[start..].find('>') else {
            break;
        };
        match local_name(&rest[start + 1..start + end]) {
            Some(tag) if BREAK_TAGS.iter().any(|break_tag| tag.eq_ignore_ascii_case(break_tag)) => {
                out.push('\n')
            }
            Some(tag) if TAB_TAGS.iter().any(|tab_tag| tag.eq_ignore_ascii_case(tab_tag)) => {
                out.push('\t')
            }
            _ => {}
        }
        rest = &rest[start + end + 1..];
    }
    push_entities(&mut out, rest);
    tidy(out)
}

/// The name of a tag without its namespace and attributes, or None for
/// closing, comment and processing tags.
fn local_name(tag: &str) -> Option<&str> {
    let tag = tag.trim();
    if tag.starts_with('/') || tag.starts_with('!') || tag.starts_with('?') {
        return None;
    }
    // A self-closing tag keeps its slash inside the tag: <w:tab/> is a tab.
    let name = tag.split_whitespace().next()?;
    Some(name.strip_suffix('/').unwrap_or(name).rsplit(':').next()?)
}

/// Appends text, decoding the XML entities that carry characters.
fn push_entities(out: &mut String, raw: &str) {
    let mut rest = raw;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let entity = rest[at + 1..].find(';').filter(|end| *end <= 12);
        let Some(end) = entity else {
            out.push('&');
            rest = &rest[at + 1..];
            continue;
        };
        let name = &rest[at + 1..at + 1 + end];
        match name {
            "amp" => out.push('&'),
            "lt" => out.push('<'),
            "gt" => out.push('>'),
            "quot" => out.push('"'),
            "apos" => out.push('\''),
            "nbsp" => out.push(' '),
            _ => match name
                .strip_prefix('#')
                .and_then(|digits| match digits.strip_prefix(['x', 'X']) {
                    Some(hex) => u32::from_str_radix(hex, 16).ok(),
                    None => digits.parse::<u32>().ok(),
                })
                .and_then(char::from_u32)
            {
                Some(character) => out.push(character),
                None => out.push_str(&rest[at..at + end + 2]),
            },
        }
        rest = &rest[at + end + 2..];
    }
    out.push_str(rest);
}

/// Drops empty lines and trailing spaces, so snippets read like sentences.
fn tidy(text: String) -> String {
    let mut out = String::with_capacity(text.len());
    let mut blanks = 0;
    for line in text.lines() {
        let line = line.trim_end();
        if line.trim().is_empty() {
            blanks += 1;
            if blanks > 1 {
                continue;
            }
        } else {
            blanks = 0;
        }
        out.push_str(line);
        out.push('\n');
    }
    out.trim().to_string()
}

#[cfg(test)]
#[path = "../../test/tools/document_text.rs"]
mod tests;
