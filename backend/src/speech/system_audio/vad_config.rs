//! The VAD settings as the frontend sends them. They come from localStorage,
//! so every value is clamped before the capture loop sees it.
use serde::{Deserialize, Serialize};

/// Longest pre-roll (in seconds of audio) the rolling buffer may hold,
/// regardless of what the config asks for.
pub(super) const MAX_PRE_ROLL_SECS: usize = 5;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VadConfig {
    pub enabled: bool,
    pub hop_size: usize,
    pub sensitivity_rms: f32,
    pub peak_threshold: f32,
    pub silence_chunks: usize,
    pub min_speech_chunks: usize,
    // Chunks between the first and last loud frame must span at least this
    // many chunks: a click/knock/ding is loud but short-lived, and a handful
    // of scattered taps fails the loud-frame count below.
    #[serde(default = "default_min_voiced_chunks")]
    pub min_voiced_chunks: usize,
    pub pre_speech_chunks: usize,
    pub noise_gate_threshold: f32,
    pub max_recording_duration_secs: u64,
}

// Backward-compatible default for configs saved before this knob existed.
fn default_min_voiced_chunks() -> usize {
    12
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            hop_size: 1024,
            sensitivity_rms: 0.012, // Much less sensitive - only real speech
            peak_threshold: 0.035,  // Higher threshold - filters clicks/noise
            silence_chunks: 120,    // ~2.5s of silence before stopping (at 48kHz)
            min_speech_chunks: 8,   // ~170ms of loud frames - keeps "yes"/"okay", drops blips
            min_voiced_chunks: 12,  // ~256ms first->last loud frame - kills clicks/knocks/ding
            pre_speech_chunks: 12,  // ~0.27s - enough to catch word start
            noise_gate_threshold: 0.003, // Stronger noise filtering
            max_recording_duration_secs: 180, // 3 minutes default
        }
    }
}

/// Longest pre-roll (in seconds of audio) the rolling buffer may hold,
/// regardless of what the config asks for.
impl VadConfig {
    /// Keeps every value in a range the loop can run with: `hop_size: 0` would
    /// spin it forever, a huge `pre_speech_chunks` would allocate gigabytes.
    pub(super) fn sanitized(mut self) -> Self {
        self.hop_size = self.hop_size.clamp(64, 8192);
        self.sensitivity_rms = self.sensitivity_rms.clamp(0.0, 1.0);
        self.peak_threshold = self.peak_threshold.clamp(0.0, 1.0);
        self.noise_gate_threshold = self.noise_gate_threshold.clamp(0.0, 1.0);
        self.silence_chunks = self.silence_chunks.clamp(1, 100_000);
        self.min_speech_chunks = self.min_speech_chunks.clamp(1, 100_000);
        self.min_voiced_chunks = self.min_voiced_chunks.clamp(1, 100_000);
        self.pre_speech_chunks = self.pre_speech_chunks.clamp(1, 500);
        self.max_recording_duration_secs = self.max_recording_duration_secs.clamp(1, 600);
        self
    }
}

#[cfg(test)]
#[path = "../../../test/speech/system_audio/vad_config.rs"]
mod tests;
