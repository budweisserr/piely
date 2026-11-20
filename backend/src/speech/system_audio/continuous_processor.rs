//! Continuous capture (VAD disabled): record until stopped or the time limit,
//! then emit the whole take as one base64 wav.
use futures_util::StreamExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use super::audio_dsp::{apply_noise_gate, normalize_audio_level};
use super::vad_config::VadConfig;
use super::wav_encoder::samples_to_wav_b64;

// Continuous capture (VAD disabled)
pub(super) async fn run_continuous_capture(
    app: AppHandle,
    stream: impl StreamExt<Item = f32> + Unpin,
    sr: u32,
    config: VadConfig,
    stop: Arc<AtomicBool>,
) {
    let mut stream = stream;
    let max_samples = (sr as u64 * config.max_recording_duration_secs) as usize;

    // Grow into the take instead of reserving it up front: reserving the whole
    // maximum (hours at 48 kHz, if the config asked for it) is hundreds of MB
    // before a single sample arrives.
    let mut audio_buffer = Vec::with_capacity((sr as usize * 60).min(max_samples));
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
            () = tokio::time::sleep(tokio::time::Duration::from_millis(10)) => {
            }
        }
    }

    // Process and emit audio
    if audio_buffer.is_empty() {
        eprintln!("[audio] No audio captured in continuous mode");
        let _ = app.emit("audio-encoding-error", "No audio recorded");
    } else {
        // Apply noise gate
        let cleaned_audio = apply_noise_gate(&audio_buffer, config.noise_gate_threshold);
        let cleaned_audio = normalize_audio_level(&cleaned_audio, 0.1);

        match samples_to_wav_b64(sr, &cleaned_audio) {
            Ok(b64) => {
                let _ = app.emit("speech-detected", b64);
            }
            Err(e) => {
                eprintln!("[audio] Failed to encode continuous audio: {e}");
                let _ = app.emit("audio-encoding-error", e);
            }
        }
    }

    let _ = app.emit("continuous-recording-stopped", ());
}
