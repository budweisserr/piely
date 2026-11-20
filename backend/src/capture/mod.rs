//! Screenshots: the one-click full-screen capture and the drag-a-region
//! overlay, one window per monitor.
mod capture_state;
mod full_screen;
mod overlay_windows;
mod selection_crop;

pub use capture_state::CaptureState;
pub use full_screen::*;
pub use overlay_windows::*;
pub use selection_crop::*;
