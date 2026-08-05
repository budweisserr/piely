#!/usr/bin/env bash
# Build Piely (Tauri 2 desktop app + pi sidecar + whisper.cpp local STT).
# Usage: ./build.sh [build|dev]   (default: build release bundles)
set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-build}"

echo "==> Installing frontend + Rust dependencies"
npm install

echo "==> Installing pi sidecar dependencies (pi-ai)"
(cd piely-agent && npm install)

echo "==> Building whisper.cpp (local STT)"
cmake -S whisper.cpp -B whisper.cpp/build \
  -DCMAKE_BUILD_TYPE=Release \
  -DWHISPER_BUILD_EXAMPLES=ON \
  -DWHISPER_BUILD_TESTS=OFF
cmake --build whisper.cpp/build --config Release -j"$(nproc 2>/dev/null || echo 2)"

WHISPER_MODEL="whisper.cpp/models/ggml-base.bin"
if [ ! -f "$WHISPER_MODEL" ]; then
  echo "==> Downloading Whisper base model (~75 MB) to $WHISPER_MODEL"
  (cd whisper.cpp/models && bash download-ggml-model.sh base)
fi

if [ "$MODE" = "dev" ]; then
  echo "==> Starting development build"
  npm run tauri dev
else
  echo "==> Building release bundles"
  npm run tauri build
fi
