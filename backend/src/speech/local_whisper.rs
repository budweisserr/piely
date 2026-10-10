//! On-device transcription: write the audio to a temp wav, run the bundled
//! `whisper-cli`, read its JSON back.
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
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../whisper.cpp/build/bin/whisper-cli");
    if dev_path.exists() {
        return dev_path;
    }
    PathBuf::from("whisper-cli") // fallback: anything on PATH
}

fn default_model_path() -> PathBuf {
    // A model next to the app executable is where a bundle would ship one.
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    {
        for candidate in ["ggml-tiny.bin", "models/ggml-tiny.bin"] {
            let bundled = dir.join(candidate);
            if bundled.exists() {
                return bundled;
            }
        }
    }
    // Development: build.sh downloads the model into the whisper.cpp submodule.
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../whisper.cpp/models/ggml-tiny.bin")
}

/// The temporary wav/json pair for one transcription. Removal happens on drop,
/// so error paths (missing model, unparsable output) cannot leave files behind
/// in the temp directory.
struct TempAudioFiles {
    wav: PathBuf,
    json: PathBuf,
}

impl TempAudioFiles {
    fn new() -> Self {
        let wav = std::env::temp_dir().join(format!("piely-{}.wav", Uuid::new_v4()));
        let json = wav.with_extension("wav.json");
        Self { wav, json }
    }
}

impl Drop for TempAudioFiles {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.wav);
        let _ = std::fs::remove_file(&self.json);
    }
}

/// Transcribe a wav (base64) with local whisper.cpp.
/// `model_path` is the ggml .bin file; empty = default (ggml-tiny.bin).
#[tauri::command]
pub async fn local_transcribe(
    audio_base64: String,
    model_path: Option<String>,
) -> Result<String, String> {
    let trimmed = audio_base64.trim();
    let b64 = trimmed.split(',').next_back().unwrap_or(trimmed);
    let bytes = general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("Failed to decode audio: {}", e))?;

    let temp = TempAudioFiles::new();
    std::fs::write(&temp.wav, &bytes)
        .map_err(|e| format!("Failed to write temp audio: {}", e))?;

    let model = model_path
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(default_model_path);
    if !model.exists() {
        return Err(format!(
            "Whisper model not found: {}. Download a ggml model (for example \
             ggml-tiny.bin from https://huggingface.co/ggerganov/whisper.cpp) and set \
             the speech-to-text provider's MODEL_PATH to it.",
            model.display()
        ));
    }

    let model_arg = model.to_string_lossy().into_owned();
    let wav_arg = temp.wav.to_string_lossy().into_owned();
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .to_string();

    // whisper-cli is a blocking subprocess; run it off the async runtime.
    let result = tauri::async_runtime::spawn_blocking(move || {
        Command::new(whisper_cli_path())
            // -l auto detects the language (the default is "en", which garbles
            // other languages). -t uses all cores and -fa turns on flash
            // attention, which falls back safely where it is unsupported.
            .args([
                "-m",
                model_arg.as_str(),
                "-f",
                wav_arg.as_str(),
                "-l",
                "auto",
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
            let json_text = std::fs::read_to_string(&temp.json)
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

    transcript
}
