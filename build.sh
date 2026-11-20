#!/usr/bin/env bash
# Build Piely (Tauri 2 desktop app + pi sidecar + whisper.cpp local STT).
# Usage: ./build.sh [build|dev]   (default: build release bundles)
set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-build}"

echo "==> Installing frontend + Rust dependencies"
npm --prefix frontend install

echo "==> Installing pi sidecar dependencies (pi-ai)"
(cd piely-agent && npm install)

SIDECAR="piely-agent/bin/piely-agent"

# Release bundles ship the compiled sidecar, so building one needs bun. Saying
# so here beats shipping a bundle whose logins fail later.
if [ "$MODE" != "dev" ] && ! command -v bun >/dev/null 2>&1 && [ ! -f "$SIDECAR" ]; then
  echo "ERROR: release bundles ship a compiled pi sidecar, and bun is not installed." >&2
  echo "       Install bun (https://bun.sh), or use ./build.sh dev (runs agent.mjs)." >&2
  exit 1
fi

# The sidecar checks itself (see piely-agent/README.md): a binary built without
# the bundled OAuth flows only fails at the first login, with an error that says
# nothing about rebuilding. Whatever is about to be bundled has to pass here.
verify_sidecar() {
  [ -f "$SIDECAR" ] || return 0
  if ! "$SIDECAR" --selfcheck >/dev/null 2>&1; then
    echo "ERROR: $SIDECAR fails its self check and must not be bundled:" >&2
    "$SIDECAR" --selfcheck 2>&1 | tail -n 5 >&2 || true
    echo "       Install bun (https://bun.sh) and re-run: it recompiles the sidecar." >&2
    exit 1
  fi
  echo "==> pi sidecar self check passed"
}

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
  # Bundle to a single file first: bun 1.3.x --compile of the multi-module
  # pi-ai graph produces an executable that segfaults at startup (embedded
  # graph corruption); compiling the bundle avoids it.
  bun build piely-agent/agent.mjs --target=bun --outfile /tmp/piely-agent.bundle.mjs
  bun build --compile /tmp/piely-agent.bundle.mjs --outfile piely-agent/bin/piely-agent
  # tauri bundles this as a resource under the plain name; bun appends .exe on Windows
  if [ -f piely-agent/bin/piely-agent.exe ]; then mv piely-agent/bin/piely-agent.exe piely-agent/bin/piely-agent; fi
  echo "==> Compiled pi sidecar (bun)"
else
  echo "==> bun not found: keeping the existing sidecar build"
  [ -f "$SIDECAR" ] && echo "    WARNING: $SIDECAR is from an earlier build (checked below)."
fi

verify_sidecar

# Stage sidecars for bundling (externalBin naming: <name>-<target-triple>)
if command -v rustc >/dev/null 2>&1; then
  mkdir -p backend/binaries
  TRIPLE=$(rustc -vV | sed -n 's/^host: //p')
  if [ -f whisper.cpp/build/bin/whisper-cli ]; then
    cp whisper.cpp/build/bin/whisper-cli "backend/binaries/whisper-cli-$TRIPLE"
    echo "==> Staged whisper-cli-$TRIPLE for bundling"
  fi

fi

if [ "$MODE" = "dev" ]; then
  echo "==> Starting development build"
  npm run tauri dev
else
  echo "==> Building release bundles"
  npm run tauri build
fi
