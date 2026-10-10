//! Every bound the tools run under, in one place: how deep and how wide
//! discovery may walk, and how much a content search may read.
pub(super) const DEFAULT_FIND_LIMIT: usize = 20;
pub(super) const MAX_FIND_LIMIT: usize = 50;
pub(super) const MAX_SCAN_DEPTH: usize = 6;
pub(super) const MAX_SCAN_DIRS: usize = 4000;
pub(super) const DEFAULT_PREVIEW_BYTES: usize = 8192;
pub(super) const MAX_PREVIEW_BYTES: usize = 65_536;
pub(super) const MAX_APP_RESULTS: usize = 200;

// Content search bounds. A "what mentions X" query has to read files, so the
// budget is deliberately explicit: this must stay a few seconds, never a
// full-disk scan.
pub(super) const DEFAULT_CONTENT_LIMIT: usize = 10;
pub(super) const MAX_CONTENT_LIMIT: usize = 30;
pub(super) const MAX_CONTENT_FILES: usize = 3000;
pub(super) const MAX_CONTENT_BYTES: u64 = 48 * 1024 * 1024;
pub(super) const MAX_CONTENT_FILE_BYTES: u64 = 1024 * 1024;
pub(super) const MAX_SNIPPETS_PER_FILE: usize = 3;
pub(super) const MAX_SNIPPET_CHARS: usize = 200;

pub(super) const DEFAULT_DIR_ENTRIES: usize = 200;
pub(super) const MAX_DIR_DEPTH: usize = 3;

/// Directories that are large, machine-owned, or hidden by convention.
pub(super) const SKIP_DIRS: &[&str] = &[
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
];

pub(super) const IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "tiff", "ico", "heic",
];
