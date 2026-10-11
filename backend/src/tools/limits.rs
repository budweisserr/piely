//! Every bound the tools run under, in one place: how deep and how wide
//! discovery may walk, and how much a content search may read.
use std::collections::HashSet;
use std::sync::LazyLock;

pub(super) const DEFAULT_FIND_LIMIT: usize = 20;
pub(super) const MAX_FIND_LIMIT: usize = 50;
pub(super) const MAX_SCAN_DEPTH: usize = 6;
pub(super) const MAX_SCAN_DIRS: usize = 4000;
pub(super) const DEFAULT_PREVIEW_BYTES: usize = 8192;
pub(super) const MAX_PREVIEW_BYTES: usize = 65_536;

/// One written file may not exceed this. The content crosses the IPC boundary
/// and gets confirmed by the user, so it must stay a document, not a disk image.
pub(super) const MAX_WRITE_BYTES: usize = 1024 * 1024;
pub(super) const MAX_APP_RESULTS: usize = 200;

// Content search bounds. A "what mentions X" query has to read files, so the
// budget is deliberately explicit: this must stay a few seconds, never a
// full-disk scan.
pub(super) const DEFAULT_CONTENT_LIMIT: usize = 10;
pub(super) const MAX_CONTENT_LIMIT: usize = 30;
pub(super) const MAX_CONTENT_FILES: usize = 3000;
pub(super) const MAX_CONTENT_BYTES: u64 = 48 * 1024 * 1024;
pub(super) const MAX_CONTENT_FILE_BYTES: u64 = 1024 * 1024;
/// Documents are zips of XML or PDFs: bigger than a text file, and unpacking one
/// is real work, so the count is budgeted too (see content_search).
pub(super) const MAX_DOCUMENT_BYTES: u64 = 8 * 1024 * 1024;
pub(super) const MAX_DOCUMENT_PART_BYTES: u64 = 2 * 1024 * 1024;
pub(super) const MAX_DOCUMENT_CHARS: usize = 200_000;
/// An archive can hold thousands of matching members (an EPUB of one-liners);
/// reading them all would turn one file into minutes of work.
pub(super) const MAX_DOCUMENT_PARTS: usize = 200;
pub(super) const MAX_DOCUMENTS_EXTRACTED: usize = 100;
/// A PDF is parsed page by page and has no cheap upper bound on time, so it is
/// allowed to be smaller than an office file (which is just XML in a zip).
pub(super) const MAX_PDF_BYTES: u64 = 4 * 1024 * 1024;
/// Wall-clock budget for one content search: a crafted document can make the
/// parser crawl, and a tool call must always answer.
pub(super) const MAX_SEARCH_SECONDS: u64 = 20;
/// Queries are typed by a person: cap them so a huge one cannot turn into a
/// quadratic amount of matching work.
pub(super) const MAX_QUERY_CHARS: usize = 300;
pub(super) const MAX_QUERY_TERMS: usize = 12;
pub(super) const MAX_SNIPPETS_PER_FILE: usize = 3;
pub(super) const MAX_SNIPPET_CHARS: usize = 200;

pub(super) const DEFAULT_DIR_ENTRIES: usize = 200;
pub(super) const MAX_DIR_DEPTH: usize = 3;

/// Directories that are large, machine-owned, or hidden by convention. A set
/// because every walked directory entry is checked against it.
pub(super) static SKIP_DIRS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    HashSet::from([
        "node_modules",
        ".git",
        ".cache",
        ".npm",
        ".cargo",
        ".rustup",
        "target",
        "__pycache__",
        ".venv",
            "venv",
        "Library",
        "AppData",
        "Applications",
    ])
});

pub(super) const IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "tiff", "ico", "heic",
];
