//! The state the screenshot tools share: the images captured from every
//! monitor while the selection overlay is up, and whether an overlay is live.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

#[derive(Debug, Serialize, Deserialize)]
pub struct SelectionCoords {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// One captured monitor, as PNG: raw RGBA for four 4K screens would be ~130 MB
/// while the overlay is open, and the crop only needs one of them.
#[derive(Debug, Clone)]
pub struct MonitorInfo {
    pub png: Vec<u8>,
}

// Store captured images from all monitors temporarily for cropping
pub struct CaptureState {
    pub captured_monitors: Arc<Mutex<HashMap<usize, MonitorInfo>>>,
    pub overlay_active: Arc<AtomicBool>,
}

impl Default for CaptureState {
    fn default() -> Self {
        Self {
            captured_monitors: Arc::default(),
            overlay_active: Arc::new(AtomicBool::new(false)),
        }
    }
}

