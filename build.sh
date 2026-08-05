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

WHISPER_MODEL="whisper.cpp/models/ggml-tiny.bin"
if [ ! -f "$WHISPER_MODEL" ]; then
  echo "==> Downloading Whisper tiny model (~75 MB) to $WHISPER_MODEL"
  (cd whisper.cpp/models && bash download-ggml-model.sh tiny)
fi

# Compile the pi sidecar into a single self-contained binary (no Node needed).
# Fallback at runtime: node + agent.mjs.
if command -v bun >/dev/null 2>&1; then
  mkdir -p piely-agent/bin
  bun build --compile piely-agent/agent.mjs --outfile piely-agent/bin/piely-agent
  echo "==> Compiled pi sidecar (bun)"
fi

# Stage sidecars for bundling (externalBin naming: <name>-<target-triple>)
if command -v rustc >/dev/null 2>&1; then
  mkdir -p src-tauri/binaries
  TRIPLE=$(rustc -vV | sed -n 's/^host: //p')
  if [ -f whisper.cpp/build/bin/whisper-cli ]; then
    cp whisper.cpp/build/bin/whisper-cli "src-tauri/binaries/whisper-cli-$TRIPLE"
    echo "==> Staged whisper-cli-$TRIPLE for bundling"
  fi
  if [ -f piely-agent/bin/piely-agent ]; then
    cp piely-agent/bin/piely-agent "src-tauri/binaries/piely-agent-$TRIPLE"
    echo "==> Staged piely-agent-$TRIPLE for bundling"
  fi
fi

if [ "$MODE" = "dev" ]; then
  echo "==> Starting development build"
  npm run tauri dev
else
  echo "==> Building release bundles"
  npm run tauri build
fi
