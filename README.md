# Piely

A privacy-first, local-first AI assistant: a translucent overlay with **Ask**
and **Listen** modes, plus a dashboard for chats, meetings, files, prompts,
and settings. Built with Tauri 2, React, and Rust.

## LLM powered by pi

LLM responses are powered by [pi](https://github.com/earendil-works/pi), the
open-source coding agent. Piely embeds pi's unified LLM API
(`@earendil-works/pi-ai`) as a sidecar (`piely-agent/`) and exposes pi's
provider login + model catalog in the **Dashboard**: log in with an OAuth
subscription (Anthropic Claude, ChatGPT/Codex, GitHub Copilot, OpenRouter) or
an API key (OpenAI, Google, Groq, Mistral, xAI, DeepSeek, ...), pick a model,
and every chat, screenshot, and auto-response streams through pi.

The pi coding agent source is pinned as a git submodule at [`pi/`](pi)
(`packages/agent`, `packages/ai`, `packages/client`). Credentials are stored
in the app data directory (`piely-auth.json`), one credential per provider.

Alternatively, connect any LLM or speech-to-text provider through a curl
template (settings → Dev Space).

## Requirements

- Node.js >= 22.19 (for the pi-ai sidecar and the frontend toolchain)
- Rust (stable) with the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
  for your OS (Linux: webkit2gtk-4.1, libappindicator, etc.)
- CMake + C/C++ compiler (for whisper.cpp, the local speech-to-text engine)
- macOS: Xcode command line tools; Windows: MSVC build tools

## Build

```bash
# Build release bundles (.dmg/.msi/.exe/.deb/.rpm/.AppImage)
./build.sh

# Run in development
./build.sh dev
```

The script installs dependencies (frontend + pi sidecar), builds whisper.cpp,
downloads the Whisper `base` model (~75 MB) if missing, and runs the Tauri
build. Equivalent manual steps:

```bash
npm install
cd piely-agent && npm install && cd ..

# whisper.cpp local STT
cmake -S whisper.cpp -B whisper.cpp/build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF
cmake --build whisper.cpp/build --config Release -j
(cd whisper.cpp/models && bash download-ggml-model.sh tiny)

npm run tauri dev      # development
npm run tauri build    # release bundles
```

### Local speech-to-text (whisper.cpp)

Pick **Local Whisper (whisper.cpp)** as your STT provider (Dev Space or the
first-launch wizard) and all voice input is transcribed on-device — no data
leaves your machine. The default model is `whisper.cpp/models/ggml-tiny.bin`
(the smallest and fastest, downloaded by `build.sh`); set the provider's
`MODEL_PATH` variable to use a different ggml model, or point
`WHISPER_CLI_PATH` at your own whisper-cli binary.

Optional environment variables:

| Variable          | Purpose                                          |
| ----------------- | ------------------------------------------------ |
| `PIELY_NODE_BIN`  | Node binary for the pi sidecar (default `node`)  |
| `PIELY_AGENT_PATH`| Path to `piely-agent/agent.mjs` if not alongside |

The updater plugin is configured without endpoints; point
`src-tauri/tauri.conf.json` → `plugins.updater.endpoints` at your own update
server to enable self-updates.

## Documentation

The full documentation lives in the [GitHub wiki](https://github.com/budweisserr/piely/wiki):
getting started, Ask/Listen modes, AI providers, speech to text, settings,
shortcuts, privacy, and troubleshooting.

## Project layout

- `src/` — React frontend
- `src-tauri/` — Rust backend (window, capture, audio, shortcuts, pi bridge)
- `piely-agent/` — Node sidecar wrapping `@earendil-works/pi-ai`
- `pi/` — pi coding agent source (submodule)

## License

GPL-3.0 — see [LICENSE](LICENSE).
