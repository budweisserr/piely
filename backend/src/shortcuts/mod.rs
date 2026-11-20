//! Global shortcuts. `registry` applies the frontend's config, `actions` runs
//! what each shortcut means, `move_window` is hold-to-move, and `plugin` is the
//! one handler every key press goes through.
mod actions;
mod move_window;
mod plugin;
mod registry;
mod state;

pub use actions::*;
pub use move_window::*;
pub use plugin::global_shortcut_plugin;
pub use registry::*;
pub use state::{MoveWindowState, RegisteredShortcuts, WindowVisibility};
