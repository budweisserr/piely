# Piely

A privacy-first, local-first AI assistant: a translucent always-on-top overlay with **Ask** and **Listen** modes, plus a dashboard for chats, meetings, files, prompts, and settings. Built with Tauri 2, React, and Rust. LLM responses are powered by [pi](https://github.com/earendil-works/pi).

## Requirements

- Node.js >= 22.19
- Rust (stable) + [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS
- CMake + C/C++ compiler (for whisper.cpp local STT)

## Build

```bash
./build.sh        # release bundles
./build.sh dev    # development mode
```

Both run `npm install` in `frontend/` + `piely-agent/`, build whisper.cpp, and
then drive the Tauri CLI from the repository root (that is where it finds
`backend/`).

## Test

```bash
npm test                                 # frontend + sidecar (delegates to both)
npm --prefix frontend test               # frontend only
npm --prefix piely-agent test            # sidecar only
(cd backend && cargo test)               # Rust units
node piely-agent/agent.mjs --selfcheck   # sidecar self check
```

Tests live in `frontend/test/` and `backend/test/`, mirroring the source tree.
Rust source files pull theirs in with `#[cfg(test)] #[path = "…"] mod tests;` at
the bottom, so no source file contains test code.

## Documentation

Everything else — first-launch setup, Ask/Listen modes, AI providers, speech to text, settings, shortcuts, privacy, troubleshooting — lives in the [wiki](https://github.com/budweisserr/piely/wiki).

## Repository layout

```text
frontend/                React + Vite
  src/lib/ai/            answering a turn: system prompt, pi stream, curl providers, agent loop
  src/lib/chat/          message ids and timings, history -> model messages, attachments
  src/lib/curl/          curl templates, response paths, validation
  src/lib/database/      SQLite: conversations, messages, system prompts
  src/lib/{files,speech,storage,tools}/
  src/hooks/{chat,speech,providers,system}/
  src/pages/             one folder per screen
  test/                  the same paths, one file per module under test
backend/                 Tauri 2 / Rust (the crate is `backend/`)
  src/app/               lifecycle: builder wiring, setup hook, macOS panel
  src/window/            overlay + dashboard windows (factory, layout, commands)
  src/shortcuts/         global shortcuts (registry, actions, move window, plugin)
  src/capture/           screenshots and the selection overlay
  src/speech/            local whisper + system audio capture (VAD/continuous)
  src/agent/             the piely-agent sidecar bridge (process, bridge, commands)
  src/tools/             computer-use tools, policy + one file per tool
  src/db/                migrations
  test/                  the same paths under src/ (pulled in by #[path])
piely-agent/             Node sidecar, speaks NDJSON over stdio (see its README)
  test/agent.test.mjs    drives agent.mjs
  test/lib/…             one file per lib module
package.json             root scripts: `tauri`, `dev`, `build`, `test`
```

The Tauri CLI is started from the repository root; it finds the crate by looking
for `tauri.conf.json` in a subfolder, and runs `npm run dev` / `npm run build`
here, which the root scripts forward to `frontend/`.

Files are named after the job they do. Where a file implements a known pattern
the name says so: `*_factory` builds things (a window, a process), `*_processor`
consumes a stream (the two audio capture loops, the content scanner), `*_state`
is Tauri-managed state, `*_commands` is the Tauri command surface, and
`*.storage` / `*.store` is persistence.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — contributions (including AI-assisted ones) are welcome.

## License

GPL-3.0 — see [LICENSE](LICENSE).
