//! Voice-activity capture: samples in, one `speech-detected` wav per finished
//! utterance. Tracks the noise floor, keeps a pre-roll buffer, and requires both
//! enough loud frames and a long enough voiced span, so a knock is not speech.
use futures_util::StreamExt;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

use super::audio_dsp::{apply_noise_gate, calculate_audio_metrics, normalize_audio_level};
use super::vad_config::{VadConfig, MAX_PRE_ROLL_SECS};
use super::wav_encoder::samples_to_wav_b64;

// Adaptive noise floor: speech must stand out at least this much above the
// tracked background, or a loud room (fan, music, traffic) triggers VAD.
const NOISE_FLOOR_RATIO: f32 = 2.0;
// Chunks below this multiple of the floor count as real silence.
const NOISE_FLOOR_HOLD: f32 = 1.5;
// EMA rate for floor updates (slow: ~4s to track a changing room).
const NOISE_FLOOR_EMA: f32 = 0.005;
// VAD-enabled capture - OPTIMIZED for real-time speech detection
pub(super) async fn run_vad_capture(
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
    let min_voiced_chunk_limit =
        ((config.min_voiced_chunks as f32) * scale).round().max(1.0) as usize;
    let pre_chunk_capacity =
        ((config.pre_speech_chunks as f32) * scale).round().max(1.0) as usize;
    // Cap the pre-roll by time, not by chunk count: the config value is
    // user-supplied and must never size this buffer on its own.
    let pre_target = (pre_chunk_capacity * config.hop_size)
        .min(sr as usize * MAX_PRE_ROLL_SECS);

    let mut pre_speech: VecDeque<f32> = VecDeque::with_capacity(pre_target);
    let mut speech_buffer = Vec::new();
    let mut in_speech = false;
    let mut silence_chunks = 0;
    let mut speech_chunks = 0;
    let mut chunk_index = 0; // chunk position inside the current utterance
    let mut first_loud_chunk = 0;
    let mut last_loud_chunk = 0;
    let mut noise_floor_rms = 1e-4; // adaptive background estimate, quiet rooms only
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

            // Adaptive sensitivity: require speech to stand out above the
            // tracked background noise floor, so a loud room doesn't turn
            // everything into "speech" and quiet speech isn't lost.
            let effective_sensitivity =
                config.sensitivity_rms.max(noise_floor_rms * NOISE_FLOOR_RATIO);
            // Below this is real silence. Between here and the speech
            // threshold are breaths, which keep the utterance open instead of
            // ending it.
            let quiet_threshold =
                (config.noise_gate_threshold * 1.5).max(noise_floor_rms * NOISE_FLOOR_HOLD);

            let is_speech = rms > effective_sensitivity || peak > config.peak_threshold;

            if is_speech {
                if in_speech {
                    last_loud_chunk = chunk_index;
                } else {
                    // Speech START detected
                    in_speech = true;
                    speech_chunks = 0;
                    chunk_index = 0;
                    first_loud_chunk = 0;
                    last_loud_chunk = 0;

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
                        // A click is loud but lasts a few chunks, so both a
                        // loud-frame count and a voiced span are required.
                        let voiced_span = last_loud_chunk - first_loud_chunk + 1;
                        if speech_chunks >= min_speech_chunk_limit
                            && voiced_span >= min_voiced_chunk_limit
                            && !speech_buffer.is_empty()
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
                                "Audio too short or not speech (likely background noise)",
                            );
                        }

                        // Reset for next speech detection
                        speech_buffer.clear();
                        in_speech = false;
                        silence_chunks = 0;
                        speech_chunks = 0;
                    }
                } else {
                    // Not in speech yet - maintain rolling pre-speech buffer.
                    // Quiet chunks also update the noise floor (slow EMA) so
                    // the adaptive sensitivity tracks the environment.
                    if rms < quiet_threshold {
                        noise_floor_rms += NOISE_FLOOR_EMA * (rms - noise_floor_rms);
                    }

                    pre_speech.extend(mono);

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

            chunk_index += 1;
        }
    }
}
