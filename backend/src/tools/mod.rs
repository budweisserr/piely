//! The tools the model can call: find, read and write files, list apps, open
//! things. Discovery is read-only; everything that touches the machine asks the
//! user first. One file per tool, with `limits` and `sensitive_paths` holding
//! the shared policy.
mod content_search;
mod directory_listing;
mod document_text;
mod file_metadata;
mod file_search;
mod installed_apps;
mod limits;
mod open_targets;
mod read_file;
mod search_scope;
mod sensitive_paths;
mod write_file;

pub use content_search::*;
pub use directory_listing::*;
pub use file_search::*;
pub use installed_apps::*;
pub use open_targets::*;
pub use read_file::*;
pub use write_file::*;
