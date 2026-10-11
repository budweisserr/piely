//! The overlay and dashboard windows: factory builds them, `dashboard` owns
//! the dashboard's hide-on-close, `window_layout` places them, and
//! `webview_permissions` grants the microphone on Linux.
mod dashboard;
mod webview_permissions;
mod window_commands;
mod window_factory;
mod window_layout;

pub use dashboard::*;
pub use window_commands::*;
pub use window_factory::setup_main_window;
