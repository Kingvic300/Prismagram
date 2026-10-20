#!/usr/bin/env bash
# Start the desktop app in development mode. Pass a .prisma path to open it on launch:
#   scripts/dev.sh path/to/schema.prisma
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/desktop"
if [[ $# -gt 0 ]]; then
  exec npx tauri dev -- -- "$(realpath "$1")"
fi
exec npx tauri dev
