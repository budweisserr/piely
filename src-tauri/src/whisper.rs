// Local speech-to-text via whisper.cpp (submodule). Runs the whisper-cli
// binary on a temp wav and parses its JSON output.
use base64::{engine::general_purpose, Engine as _};
use serde_json::Value;
use std::env;
use std::path::PathBuf;
use std::process::Command;
use uuid::Uuid;

fn whisper_cli_path() -> PathBuf {
    if let Ok(path) = env::var("WHISPER_CLI_PATH") {
        return PathBuf::from(path);
    }
    // bundled sidecar (externalBin): next to the app executable
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    {
        let name = if cfg!(windows) { "whisper-cli.exe" } else { "whisper-cli" };
        let bundled = dir.join(name);
        if bundled.exists() {
            return bundled;
        }
    }
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../whisper.cpp/build/bin/whisper-cli");
    if dev_path.exists() {
        return dev_path;
    }
    PathBuf::from("whisper-cli") // fallback: anything on PATH
}

fn default_model_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../whisper.cpp/models/ggml-tiny.bin")
}

/// Transcribe a wav (base64) with local whisper.cpp.
/// `model_path` is the ggml .bin file; empty = default (ggml-tiny.bin).
#[tauri::command]
pub async fn local_transcribe(
    audio_base64: String,
    model_path: Option<String>,
) -> Result<String, String> {
    let trimmed = audio_base64.trim();
    let b64 = trimmed.split(',').last().unwrap_or(trimmed);
    let bytes = general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("Failed to decode audio: {}", e))?;

    let tmp_wav = std::env::temp_dir().join(format!("piely-{}.wav", Uuid::new_v4()));
    std::fs::write(&tmp_wav, &bytes)
        .map_err(|e| format!("Failed to write temp audio: {}", e))?;
    let tmp_json = tmp_wav.with_extension("wav.json");

    let model = model_path
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(default_model_path);
    if !model.exists() {
        return Err(format!(
            "Whisper model not found: {}. Run ./build.sh to download it.",
            model.display()
        ));
    }

    let model_arg = model.to_string_lossy().into_owned();
    let wav_arg = tmp_wav.to_string_lossy().into_owned();
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .to_string();

    // whisper-cli is a blocking subprocess; run it off the async runtime.
    let result = tauri::async_runtime::spawn_blocking(move || {
        Command::new(whisper_cli_path())
            // -t: use all cores (whisper.cpp defaults to 4); -fa: flash attention
            // (Metal/CUDA speedup, safe fallback elsewhere)
            .args([
                "-m",
                model_arg.as_str(),
                "-f",
                wav_arg.as_str(),
                "-oj",
                "-nt",
                "-np",
                "-t",
                threads.as_str(),
                "-fa",
            ])
            .output()
    })
    .await
    .map_err(|e| format!("Whisper task panicked: {}", e))?;

    let transcript: Result<String, String> = match result {
        Ok(output) if output.status.success() => {
            let json_text = std::fs::read_to_string(&tmp_json)
                .map_err(|e| format!("Failed to read whisper output: {}", e))?;
            let json: Value = serde_json::from_str(&json_text)
                .map_err(|e| format!("Failed to parse whisper output: {}", e))?;
            let texts: Vec<String> = json
                .get("transcription")
                .and_then(|t| t.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|seg| seg.get("text").and_then(|t| t.as_str()))
                        .map(String::from)
                        .collect()
                })
                .unwrap_or_default();
            Ok(texts.join(" ").trim().to_string())
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!(
                "Whisper failed ({}): {}",
                output.status,
                stderr.lines().last().unwrap_or("unknown error")
            ))
        }
        Err(e) => Err(format!("Failed to run whisper: {}", e)),
    };

    let _ = std::fs::remove_file(&tmp_wav);
    let _ = std::fs::remove_file(&tmp_json);

    transcript
}
