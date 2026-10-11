use super::*;

#[test]
fn test_vad_config_defaults() {
    let config = VadConfig::default();
    assert!(config.enabled);
    assert_eq!(config.hop_size, 1024);
    assert!(config.sensitivity_rms > 0.0);
    assert_eq!(config.min_speech_chunks, 8);
    assert_eq!(config.min_voiced_chunks, 12);
}
#[test]
fn test_vad_config_sanitized_clamps_loop_and_allocation_hazards() {
    // hop_size 0 would spin the capture loop forever; a huge pre-speech
    // count would try to preallocate gigabytes.
    let config = VadConfig {
        hop_size: 0,
        pre_speech_chunks: 1_000_000,
        max_recording_duration_secs: 100_000,
        silence_chunks: 0,
        ..VadConfig::default()
    }
    .sanitized();

    assert!(config.hop_size >= 64, "hop_size: {}", config.hop_size);
    assert!(
        config.pre_speech_chunks <= 500,
        "pre_speech_chunks: {}",
        config.pre_speech_chunks
    );
    assert!(
        config.max_recording_duration_secs <= 600,
        "max seconds: {}",
        config.max_recording_duration_secs
    );
    assert!(config.silence_chunks >= 1);
}
#[test]
fn test_vad_config_sanitized_keeps_sane_values() {
    let config = VadConfig::default().sanitized();
    assert_eq!(config.hop_size, VadConfig::default().hop_size);
    assert_eq!(
        config.pre_speech_chunks,
        VadConfig::default().pre_speech_chunks
    );
    assert_eq!(
        config.max_recording_duration_secs,
        VadConfig::default().max_recording_duration_secs
    );
}
