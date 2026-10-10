//! Speech to text: `system_audio` captures what the machine plays,
//! `local_whisper` transcribes on-device.
mod local_whisper;
pub mod system_audio;

pub use local_whisper::*;
