//! Tauri-managed state for the agent bridge.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use super::bridge::AgentHandle;

pub struct PielyState {
    /// the one shared agent process (None until first use / after it died)
    pub(super) agent: Mutex<Option<Arc<AgentHandle>>>,
    /// request id of the active interactive `login` (for prompt answers)
    pub(super) login_id: Mutex<Option<u64>>,
    /// caller-supplied stream id -> agent request id, so `piely_cancel_stream`
    /// can abort one stream without touching the streams of other windows.
    pub(super) streams: Mutex<HashMap<String, u64>>,
}

impl Default for PielyState {
    fn default() -> Self {
        Self {
            agent: Mutex::new(None),
            login_id: Mutex::new(None),
            streams: Mutex::new(HashMap::new()),
        }
    }
}
