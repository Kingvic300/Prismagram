#!/usr/bin/env bash
# Build Linux packages (.deb, .rpm and AppImage) into release/.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Update packages are signed. Use the local key if present (see docs/RELEASING.md).
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" && -f "$HOME/.tauri/prismagram-updater.key" ]]; then
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$HOME/.tauri/prismagram-updater.key")"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat "$HOME/.tauri/prismagram-updater.password" 2>/dev/null || true)"
fi
cd "$ROOT/desktop"
npx tauri build --bundles "${PRISMAGRAM_BUNDLES:-deb,rpm,appimage}"
mkdir -p "$ROOT/release"
find src-tauri/target/release/bundle \( -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' \) -exec cp {} "$ROOT/release/" \;
(cd "$ROOT/release" && rm -f SHA256SUMS && sha256sum ./* > SHA256SUMS)
ls -lh "$ROOT/release"
