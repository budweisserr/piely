//! The capture commands. One task at a time, kept in [`AudioState`]; which loop
//! it runs depends on the mode.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;

use super::audio_state::AudioState;
use super::continuous_processor::run_continuous_capture;
use super::vad_config::VadConfig;
use super::vad_processor::run_vad_capture;
use super::{AudioDevice, SpeakerInput};

#[tauri::command]
pub async fn start_system_audio_capture(
    app: AppHandle,
    vad_config: Option<VadConfig>,
    device_id: Option<String>,
) -> Result<(), String> {
    let state = app.state::<AudioState>();

    // The task slot is held for the whole start: two concurrent starts would
    // otherwise both pass the check and run two capture loops.
    let mut task_slot = state
        .stream_task
        .lock()
        .map_err(|e| format!("Failed to acquire lock: {}", e))?;

    if task_slot.is_some() {
        eprintln!("[audio] Capture already running");
        return Err("Capture already running".to_string());
    }

    // Update VAD config if provided
    if let Some(config) = vad_config {
        let mut vad_cfg = state
            .vad_config
            .lock()
            .map_err(|e| format!("Failed to acquire VAD config lock: {}", e))?;
        *vad_cfg = config.sanitized();
    }
    let vad_config = state
        .vad_config
        .lock()
        .map_err(|e| format!("Failed to read VAD config: {}", e))?
        .clone();

    let input = SpeakerInput::new_with_device(device_id).map_err(|e| {
        eprintln!("[audio] Failed to create speaker input: {}", e);
        format!("Failed to access system audio: {}", e)
    })?;

    let stream = input.stream();
    let sr = stream.sample_rate();

    // Validate sample rate
    if !(8000..=96000).contains(&sr) {
        eprintln!("[audio] Invalid sample rate: {}", sr);
        return Err(format!(
            "Invalid sample rate: {}. Expected 8000-96000 Hz",
            sr
        ));
    }

    // A fresh stop flag per capture: a restart must never clear the flag a
    // still-running loop is watching, or that loop would never stop.
    let stop = Arc::new(AtomicBool::new(false));
    *state
        .stop_requested
        .lock()
        .map_err(|e| format!("Failed to store stop flag: {}", e))? = Some(stop.clone());

    let app_clone = app.clone();
    let stop_for_task = stop.clone();
    let task = tokio::spawn(async move {
        if vad_config.enabled {
            run_vad_capture(app_clone.clone(), stream, sr, vad_config, stop.clone()).await;
        } else {
            run_continuous_capture(app_clone.clone(), stream, sr, vad_config, stop).await;
        }

        // Task exit clears the slot so a new capture can start, and clears the
        // stop flag only if it is still this capture's flag.
        let state = app_clone.state::<AudioState>();
        if let Ok(mut guard) = state.stream_task.lock() {
            *guard = None;
        };
        // Bound to a local so the guard is dropped before `state` is.
        let current_flag = state.stop_requested.lock();
        if let Ok(mut flag) = current_flag {
            if flag
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &stop_for_task))
            {
                *flag = None;
            }
        }
    });

    *task_slot = Some(task);

    Ok(())
}
#[tauri::command]
pub async fn stop_system_audio_capture(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AudioState>();

    // Ask the capture loop to finish; it exits cooperatively (flushing the
    // current continuous recording) so nothing is cut mid-encode.
    let stop = state
        .stop_requested
        .lock()
        .map_err(|e| format!("Failed to acquire stop flag: {}", e))?
        .clone();
    if let Some(stop) = stop {
        stop.store(true, Ordering::Release);
    }

    let task = state
        .stream_task
        .lock()
        .map_err(|e| format!("Failed to acquire task lock: {}", e))?
        .take();

    if let Some(task) = task {
        let abort = task.abort_handle();
        let finished = tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .is_ok();
        if !finished {
            // Stream stalled (device gone): force stop rather than hang forever
            abort.abort();
        }
    }

    Ok(())
}

/// Manual stop for continuous recording: end the current take and send it.
#[tauri::command]
pub async fn manual_stop_continuous(app: AppHandle) -> Result<(), String> {
    let stop = app
        .state::<AudioState>()
        .stop_requested
        .lock()
        .map_err(|e| format!("Failed to acquire stop flag: {}", e))?
        .clone();
    if let Some(stop) = stop {
        stop.store(true, Ordering::Release);
    }
    Ok(())
}

#[tauri::command]
pub fn check_system_audio_access(_app: AppHandle) -> Result<bool, String> {
    match SpeakerInput::new() {
        Ok(_) => Ok(true),
        Err(e) => {
            eprintln!("[audio] System audio access check failed: {}", e);
            Ok(false)
        }
    }
}

#[tauri::command]
pub async fn request_system_audio_access(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        app.shell()
            .command("open")
            .args(["x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture"])
            .spawn()
            .map_err(|e| {
                eprintln!("[audio] Failed to open system preferences: {}", e);
                e.to_string()
            })?;
    }
    #[cfg(target_os = "windows")]
    {
        app.shell()
            .command("ms-settings:sound")
            .spawn()
            .map_err(|e| {
                eprintln!("[audio] Failed to open sound settings: {}", e);
                e.to_string()
            })?;
    }
    #[cfg(target_os = "linux")]
    {
        let pavu_opened = app.shell().command("pavucontrol").spawn().is_ok();
        if !pavu_opened {
            let gnome_opened = app
                .shell()
                .command("gnome-control-center")
                .args(["sound"])
                .spawn()
                .is_ok();
            if !gnome_opened {
                eprintln!("[audio] Failed to open audio settings on Linux");
            }
        }
    }

    Ok(())
}

// VAD Configuration Management
#[tauri::command]
pub async fn update_vad_config(app: AppHandle, config: VadConfig) -> Result<(), String> {
    // Validate config
    if config.sensitivity_rms < 0.0 || config.sensitivity_rms > 1.0 {
        return Err("Invalid sensitivity_rms: must be 0.0-1.0".to_string());
    }
    if config.max_recording_duration_secs > 600 {
        return Err("Invalid max_recording_duration_secs: must be <= 600 (10 minutes)".to_string());
    }

    let state = app.state::<AudioState>();
    // Everything else is clamped: the loop must never receive a hop size of 0
    // or a chunk count that would allocate gigabytes.
    *state
        .vad_config
        .lock()
        .map_err(|e| format!("Failed to update VAD config: {}", e))? = config.sanitized();

    Ok(())
}

#[tauri::command]
pub fn get_input_devices() -> Result<Vec<AudioDevice>, String> {
    super::list_input_devices().map_err(|e| {
        eprintln!("[audio] Failed to get input devices: {}", e);
        format!("Failed to get input devices: {}", e)
    })
}

#[tauri::command]
pub fn get_output_devices() -> Result<Vec<AudioDevice>, String> {
    super::list_output_devices().map_err(|e| {
        eprintln!("[audio] Failed to get output devices: {e}");
        format!("Failed to get output devices: {e}")
    })
}
