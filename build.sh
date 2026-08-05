#!/usr/bin/env bash
# Build Piely (Tauri 2 desktop app + pi sidecar).
# Usage: ./build.sh [build|dev]   (default: build release bundles)
set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-build}"

echo "==> Installing frontend + Rust dependencies"
npm install

echo "==> Installing pi sidecar dependencies (pi-ai)"
(cd piely-agent && npm install)

if [ "$MODE" = "dev" ]; then
  echo "==> Starting development build"
  npm run tauri dev
else
  echo "==> Building release bundles"
  npm run tauri build
fi
