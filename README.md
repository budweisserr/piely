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

## Documentation

Everything else — first-launch setup, Ask/Listen modes, AI providers, speech to text, settings, shortcuts, privacy, troubleshooting — lives in the [wiki](https://github.com/budweisserr/piely/wiki).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — contributions (including AI-assisted ones) are welcome.

## License

GPL-3.0 — see [LICENSE](LICENSE).
