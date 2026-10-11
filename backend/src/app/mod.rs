//! App-level commands, the setup hook, and the macOS panel. `lib.rs` keeps
//! only the builder and its plugin list.
mod commands;
#[cfg(target_os = "macos")]
mod macos_panel;
mod setup;

pub use commands::*;
pub use setup::setup;
