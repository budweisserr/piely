// Piely AI Speech Detection, and capture system audio (speaker output) as a stream of f32 samples.
use crate::speaker::{AudioDevice, SpeakerInput};
use anyhow::Result;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use futures_util::StreamExt;
use hound::{WavSpec, WavWriter};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::ShellExt;

// VAD Configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VadConfig {
    pub enabled: bool,
    pub hop_size: usize,
    pub sensitivity_rms: f32,
    pub peak_threshold: f32,
    pub silence_chunks: usize,
    pub min_speech_chunks: usize,
    pub pre_speech_chunks: usize,
    pub noise_gate_threshold: f32,
    pub max_recording_duration_secs: u64,
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            hop_size: 1024,
            sensitivity_rms: 0.012, // Much less sensitive - only real speech
            peak_threshold: 0.035,  // Higher threshold - filters clicks/noise
            silence_chunks: 120,    // ~2.5s of silence before stopping (at 48kHz)
            min_speech_chunks: 4,   // ~85ms of clear speech - keeps "yes"/"okay"
            pre_speech_chunks: 12,  // ~0.27s - enough to catch word start
            noise_gate_threshold: 0.003, // Stronger noise filtering
            max_recording_duration_secs: 180, // 3 minutes default
        }
    }
}

#[tauri::command]
pub async fn start_system_audio_capture(
    app: AppHandle,
    vad_config: Option<VadConfig>,
    device_id: Option<String>,
) -> Result<(), String> {
    let state = app.state::<crate::AudioState>();

    // Check if already capturing (atomic check)
    {
        let guard = state
            .stream_task
            .lock()
            .map_err(|e| format!("Failed to acquire lock: {}", e))?;

        if guard.is_some() {
            eprintln!("[audio] Capture already running");
            return Err("Capture already running".to_string());
        }
    }

    // Update VAD config if provided
    if let Some(config) = vad_config {
        let mut vad_cfg = state
            .vad_config
            .lock()
            .map_err(|e| format!("Failed to acquire VAD config lock: {}", e))?;
        *vad_cfg = config;
    }

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

    let stop = state.stop_requested.clone();
    stop.store(false, Ordering::Release);

    let app_clone = app.clone();
    let vad_config = state
        .vad_config
        .lock()
        .map_err(|e| format!("Failed to read VAD config: {}", e))?
        .clone();

    let state_clone = app.state::<crate::AudioState>();
    let task = tokio::spawn(async move {
        if vad_config.enabled {
            run_vad_capture(app_clone.clone(), stream, sr, vad_config, stop.clone()).await;
        } else {
            run_continuous_capture(app_clone.clone(), stream, sr, vad_config, stop).await;
        }

        // Task exit clears the slot so a new capture can start
        let state = app_clone.state::<crate::AudioState>();
        if let Ok(mut guard) = state.stream_task.lock() {
            *guard = None;
        };
    });

    *state_clone
        .stream_task
        .lock()
        .map_err(|e| format!("Failed to store task: {}", e))? = Some(task);

    Ok(())
}

// VAD-enabled capture - OPTIMIZED for real-time speech detection
async fn run_vad_capture(
    app: AppHandle,
    stream: impl StreamExt<Item = f32> + Unpin,
    sr: u32,
    config: VadConfig,
    stop: Arc<AtomicBool>,
) {
    let mut stream = stream;
    let mut buffer: VecDeque<f32> = VecDeque::new();

    // The chunk-count knobs (silence/min/pre) were tuned at 48 kHz; rescale by
    // the actual sample rate so the real-time behavior (silence before cut,
    // pre-roll, minimum speech) is the same on any device rate (16k-96k).
    const REF_SR: u32 = 48000;
    let scale = sr as f32 / REF_SR as f32;
    let silence_chunk_limit =
        ((config.silence_chunks as f32) * scale).round().max(1.0) as usize;
    let min_speech_chunk_limit =
        ((config.min_speech_chunks as f32) * scale).round().max(1.0) as usize;
    let pre_chunk_capacity =
        ((config.pre_speech_chunks as f32) * scale).round().max(1.0) as usize;
    let pre_target = pre_chunk_capacity * config.hop_size;

    // Energy below this is real silence. Chunks between here and the speech
    // threshold are breaths/pauses: they must hold the utterance open, not
    // end it (a mid-thought breath is not the end of a sentence).
    let quiet_threshold = config.noise_gate_threshold * 1.5;

    let mut pre_speech: VecDeque<f32> = VecDeque::with_capacity(pre_target);
    let mut speech_buffer = Vec::new();
    let mut in_speech = false;
    let mut silence_chunks = 0;
    let mut speech_chunks = 0;
    let max_samples = sr as usize * config.max_recording_duration_secs as usize; // safety cap per utterance

    loop {
        if stop.load(Ordering::Acquire) {
            break;
        }
        let Some(sample) = stream.next().await else {
            break;
        };
        buffer.push_back(sample);

        // Process in fixed chunks for VAD analysis
        while buffer.len() >= config.hop_size {
            let mut mono = Vec::with_capacity(config.hop_size);
            for _ in 0..config.hop_size {
                if let Some(v) = buffer.pop_front() {
                    mono.push(v);
                }
            }

            // Apply noise gate BEFORE VAD (critical for accuracy)
            let mono = apply_noise_gate(&mono, config.noise_gate_threshold);

            let (rms, peak) = calculate_audio_metrics(&mono);
            let is_speech = rms > config.sensitivity_rms || peak > config.peak_threshold;

            if is_speech {
                if !in_speech {
                    // Speech START detected
                    in_speech = true;
                    speech_chunks = 0;

                    // Include pre-speech buffer for natural sound
                    speech_buffer.extend(pre_speech.drain(..));

                    let _ = app.emit("speech-start", ());
                }

                speech_chunks += 1;
                speech_buffer.extend_from_slice(&mono);
                silence_chunks = 0; // Reset silence counter on any speech

                // Safety cap: force emit if exceeds 120s
                if speech_buffer.len() > max_samples {
                    let normalized_buffer = normalize_audio_level(&speech_buffer, 0.1);
                    if let Ok(b64) = samples_to_wav_b64(sr, &normalized_buffer) {
                        let _ = app.emit("speech-detected", b64);
                    }
                    speech_buffer.clear();
                    in_speech = false;
                    speech_chunks = 0;
                }
            } else {
                // Not speech: only real silence counts toward ending the
                // utterance; a breath/pause between the quiet and speech
                // thresholds keeps it open.
                let is_quiet = rms < quiet_threshold && peak < quiet_threshold;

                if in_speech {
                    // Keep collecting breaths AND silence so a continuation
                    // stays in the same utterance; only real silence advances
                    // the stop counter.
                    speech_buffer.extend_from_slice(&mono);
                    if is_quiet {
                        silence_chunks += 1;
                    }

                    // Check if silence duration exceeds threshold
                    if silence_chunks >= silence_chunk_limit {
                        // Verify minimum speech duration
                        if speech_chunks >= min_speech_chunk_limit && !speech_buffer.is_empty()
                        {
                            // Trim trailing silence (keep ~0.35s for a natural
                            // ending so soft word tails aren't cut off)
                            let silence_duration_samples = silence_chunks * config.hop_size;
                            let keep_silence_samples = (sr as usize * 35) / 100; // 0.35s
                            let trim_amount =
                                silence_duration_samples.saturating_sub(keep_silence_samples);

                            if speech_buffer.len() > trim_amount {
                                speech_buffer.truncate(speech_buffer.len() - trim_amount);
                            }

                            // Emit complete speech segment
                            let normalized_buffer = normalize_audio_level(&speech_buffer, 0.1);
                            if let Ok(b64) = samples_to_wav_b64(sr, &normalized_buffer) {
                                let _ = app.emit("speech-detected", b64);
                            } else {
                                eprintln!("[audio] Failed to encode speech to WAV");
                                let _ = app.emit("audio-encoding-error", "Failed to encode speech");
                            }
                        } else {
                            let _ = app.emit(
                                "speech-discarded",
                                "Audio too short (likely background noise)",
                            );
                        }

                        // Reset for next speech detection
                        speech_buffer.clear();
                        in_speech = false;
                        silence_chunks = 0;
                        speech_chunks = 0;
                    }
                } else {
                    // Not in speech yet - maintain rolling pre-speech buffer
                    pre_speech.extend(mono.into_iter());

                    // Trim excess (maintain fixed size)
                    while pre_speech.len() > pre_target {
                        pre_speech.pop_front();
                    }

                    // Reclaim capacity only after a burst outgrew the pre-roll
                    // window (shrink_to_fit on every fill would reallocate hot)
                    if pre_speech.capacity() > pre_target * 2 {
                        pre_speech.shrink_to_fit();
                    }
                }
            }
        }
    }
}

// Continuous capture (VAD disabled)
async fn run_continuous_capture(
    app: AppHandle,
    stream: impl StreamExt<Item = f32> + Unpin,
    sr: u32,
    config: VadConfig,
    stop: Arc<AtomicBool>,
) {
    let mut stream = stream;
    let max_samples = (sr as u64 * config.max_recording_duration_secs) as usize;

    // Pre-allocate buffer to prevent reallocations
    let mut audio_buffer = Vec::with_capacity(max_samples);
    let start_time = Instant::now();
    let max_duration = Duration::from_secs(config.max_recording_duration_secs);

    // Emit recording started
    let _ = app.emit(
        "continuous-recording-start",
        config.max_recording_duration_secs,
    );

    // Accumulate audio; the shared stop flag ends the recording (set by
    // manual_stop_continuous or stop_system_audio_capture).
    loop {
        if stop.load(Ordering::Acquire) {
            break;
        }

        tokio::select! {
            sample_opt = stream.next() => {
                let Some(sample) = sample_opt else {
                    eprintln!("[audio] Audio stream ended unexpectedly");
                    break;
                };

                audio_buffer.push(sample);

                let elapsed = start_time.elapsed();

                // Emit progress every second
                if audio_buffer.len() % (sr as usize) == 0 {
                    let _ = app.emit("recording-progress", elapsed.as_secs());
                }

                // Check size/time limit (safety)
                if audio_buffer.len() >= max_samples || elapsed >= max_duration {
                    break;
                }
            }
            _ = tokio::time::sleep(tokio::time::Duration::from_millis(10)) => {
            }
        }
    }

    // Process and emit audio
    if !audio_buffer.is_empty() {
        // Apply noise gate
        let cleaned_audio = apply_noise_gate(&audio_buffer, config.noise_gate_threshold);
        let cleaned_audio = normalize_audio_level(&cleaned_audio, 0.1);

        match samples_to_wav_b64(sr, &cleaned_audio) {
            Ok(b64) => {
                let _ = app.emit("speech-detected", b64);
            }
            Err(e) => {
                eprintln!("[audio] Failed to encode continuous audio: {}", e);
                let _ = app.emit("audio-encoding-error", e);
            }
        }
    } else {
        eprintln!("[audio] No audio captured in continuous mode");
        let _ = app.emit("audio-encoding-error", "No audio recorded");
    }

    let _ = app.emit("continuous-recording-stopped", ());
}

// Apply noise gate
fn apply_noise_gate(samples: &[f32], threshold: f32) -> Vec<f32> {
    const KNEE_RATIO: f32 = 3.0; // Compression ratio for soft knee

    samples
        .iter()
        .map(|&s| {
            let abs = s.abs();
            if abs < threshold {
                s * (abs / threshold).powf(1.0 / KNEE_RATIO)
            } else {
                s
            }
        })
        .collect()
}

// Calculate RMS and peak (optimized)
fn calculate_audio_metrics(chunk: &[f32]) -> (f32, f32) {
    let mut sumsq = 0.0f32;
    let mut peak = 0.0f32;

    for &v in chunk {
        let a = v.abs();
        peak = peak.max(a);
        sumsq += v * v;
    }

    let rms = (sumsq / chunk.len() as f32).sqrt();
    (rms, peak)
}

fn normalize_audio_level(samples: &[f32], target_rms: f32) -> Vec<f32> {
    if samples.is_empty() {
        return Vec::new();
    }

    let sum_squares: f32 = samples.iter().map(|&s| s * s).sum();
    let current_rms = (sum_squares / samples.len() as f32).sqrt();

    if current_rms < 0.001 {
        return samples.to_vec();
    }

    let gain = (target_rms / current_rms).min(10.0);

    samples
        .iter()
        .map(|&s| {
            let amplified = s * gain;
            if amplified.abs() > 1.0 {
                amplified.signum() * (1.0 - (-amplified.abs()).exp())
            } else {
                amplified
            }
        })
        .collect()
}

// Convert samples to WAV base64 (with proper error handling)
fn samples_to_wav_b64(sample_rate: u32, mono_f32: &[f32]) -> Result<String, String> {
    // Validate sample rate
    if !(8000..=96000).contains(&sample_rate) {
        eprintln!("[audio] Invalid sample rate: {}", sample_rate);
        return Err(format!(
            "Invalid sample rate: {}. Expected 8000-96000 Hz",
            sample_rate
        ));
    }

    // Validate buffer
    if mono_f32.is_empty() {
        return Err("Empty audio buffer".to_string());
    }

    let mut cursor = Cursor::new(Vec::new());
    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let mut writer = WavWriter::new(&mut cursor, spec).map_err(|e| {
        eprintln!("[audio] Failed to create WAV writer: {}", e);
        e.to_string()
    })?;

    for &s in mono_f32 {
        let clamped = s.clamp(-1.0, 1.0);
        let sample_i16 = (clamped * i16::MAX as f32) as i16;
        writer.write_sample(sample_i16).map_err(|e| e.to_string())?;
    }

    writer.finalize().map_err(|e| e.to_string())?;

    Ok(B64.encode(cursor.into_inner()))
}

#[tauri::command]
pub async fn stop_system_audio_capture(app: AppHandle) -> Result<(), String> {
    let state = app.state::<crate::AudioState>();

    // Ask the capture loop to finish; it exits cooperatively (flushing the
    // current continuous recording) so nothing is cut mid-encode.
    state.stop_requested.store(true, Ordering::Release);

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
    app.state::<crate::AudioState>()
        .stop_requested
        .store(true, Ordering::Release);
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
        let commands = ["pavucontrol", "gnome-control-center sound"];
        let mut opened = false;

        for cmd in &commands {
            if app.shell().command(cmd).spawn().is_ok() {
                opened = true;
                break;
            }
        }

        if !opened {
            eprintln!("[audio] Failed to open audio settings on Linux");
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
    if config.max_recording_duration_secs > 3600 {
        return Err("Invalid max_recording_duration_secs: must be <= 3600 (1 hour)".to_string());
    }

    let state = app.state::<crate::AudioState>();
    *state
        .vad_config
        .lock()
        .map_err(|e| format!("Failed to update VAD config: {}", e))? = config;

    Ok(())
}

#[tauri::command]
pub fn get_input_devices() -> Result<Vec<AudioDevice>, String> {
    crate::speaker::list_input_devices().map_err(|e| {
        eprintln!("[audio] Failed to get input devices: {}", e);
        format!("Failed to get input devices: {}", e)
    })
}

#[tauri::command]
pub fn get_output_devices() -> Result<Vec<AudioDevice>, String> {
    crate::speaker::list_output_devices().map_err(|e| {
        eprintln!("[audio] Failed to get output devices: {}", e);
        format!("Failed to get output devices: {}", e)
    })
}
