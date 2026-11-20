use super::*;

#[test]
fn test_calculate_audio_metrics() {
    let samples = [0.0, 0.5, -0.5, 0.0];
    let (rms, peak) = calculate_audio_metrics(&samples);
    assert!((peak - 0.5).abs() < 1e-5);
    assert!((rms - (0.5 * 0.5 * 2.0 / 4.0_f32).sqrt()).abs() < 1e-5);
}
#[test]
fn test_apply_noise_gate() {
    let samples = [0.001, 0.05, -0.002];
    let gated = apply_noise_gate(&samples, 0.01);
    assert_eq!(gated.len(), samples.len());
    assert!(gated[0].abs() < 0.001); // attenuated
    assert_eq!(gated[1], 0.05); // passed through above threshold
}
#[test]
fn test_normalize_audio_level() {
    let samples = [0.01, -0.01, 0.01, -0.01];
    let normalized = normalize_audio_level(&samples, 0.1);
    assert_eq!(normalized.len(), samples.len());
    let (norm_rms, _) = calculate_audio_metrics(&normalized);
    assert!(norm_rms > 0.05);
}
