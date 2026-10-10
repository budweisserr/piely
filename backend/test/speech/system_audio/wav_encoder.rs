use super::*;

#[test]
fn test_samples_to_wav_b64() {
    let samples = vec![0.0f32; 16000];
    let res = samples_to_wav_b64(16000, &samples);
    assert!(res.is_ok());
    let b64 = res.unwrap();
    assert!(!b64.is_empty());
}
