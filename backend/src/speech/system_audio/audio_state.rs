//! Tauri-managed audio capture state: at most one running task, the VAD config
//! the frontend last sent, and the cooperative stop flag that task watches.
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tokio::task::JoinHandle;

use super::vad_config::VadConfig;

#[derive(Default)]
pub struct AudioState {
    pub(super) stream_task: Mutex<Option<JoinHandle<()>>>,
    pub(super) vad_config: Mutex<VadConfig>,
    /// Stop flag of the running capture, if any. A fresh flag is created for
    /// every capture (cooperative, see `commands`).
    pub(super) stop_requested: Mutex<Option<Arc<AtomicBool>>>,
}
