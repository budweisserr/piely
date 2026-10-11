//! The piely-agent sidecar bridge: one long-lived process, all commands
//! multiplexed by request id. If it dies, pending requests fail and the next
//! command starts it again.
mod bridge;
mod commands;
mod process_factory;
mod progress;
mod state;

pub use commands::*;
pub use state::PielyState;
