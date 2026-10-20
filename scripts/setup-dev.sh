#!/usr/bin/env bash
# One-time developer setup: npm packages for the desktop shell and a first Rust build.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

(cd "$ROOT/desktop" && npm ci)
(cd "$ROOT/core" && cargo fetch --quiet)

cat <<'MSG'

Setup complete.
Linux system packages needed by Tauri (Debian / Ubuntu / Kali):
  sudo apt install -y libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev librsvg2-dev \
    build-essential libssl-dev patchelf file

Run the app in development:   scripts/dev.sh
Run all tests:                scripts/test.sh
Build installable packages:   scripts/build-linux.sh
MSG
