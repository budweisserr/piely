//! The state the shortcut system keeps: which accelerators are registered, the
//! move-the-window tasks, and the (Windows-only) hide/show flag.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri_plugin_global_shortcut::Shortcut;

// State for window visibility
pub struct WindowVisibility {
    #[allow(dead_code)]
    pub is_hidden: Mutex<bool>,
}

// State for registered shortcuts: action_id -> parsed shortcut
pub struct RegisteredShortcuts {
    pub shortcuts: Mutex<HashMap<String, Shortcut>>,
}

impl Default for RegisteredShortcuts {
    fn default() -> Self {
        Self {
            shortcuts: Mutex::new(HashMap::new()),
        }
    }
}

pub(crate) type MoveWindowTask = Arc<AtomicBool>;

pub struct MoveWindowState {
    pub(super) tasks: Mutex<HashMap<String, MoveWindowTask>>,
}

impl Default for MoveWindowState {
    fn default() -> Self {
        Self {
            tasks: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShortcutBinding {
    pub action: String,
    pub key: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShortcutsConfig {
    pub bindings: HashMap<String, ShortcutBinding>,
}

