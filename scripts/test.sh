#!/usr/bin/env bash
# Run every automated test.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "== core (cargo test) =="
(cd "$ROOT/core" && cargo test --quiet)
echo "== desktop (node --test) =="
(cd "$ROOT/desktop" && npm test --silent)
echo "== shell (cargo check) =="
(cd "$ROOT/desktop/src-tauri" && cargo check --quiet)
echo "All tests passed."
