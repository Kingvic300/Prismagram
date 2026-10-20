#!/usr/bin/env bash
# Build Linux packages (.deb, .rpm and AppImage) into release/.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/desktop"
npx tauri build --bundles "${PRISMAGRAM_BUNDLES:-deb,rpm,appimage}"
mkdir -p "$ROOT/release"
find src-tauri/target/release/bundle \( -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' \) -exec cp {} "$ROOT/release/" \;
(cd "$ROOT/release" && rm -f SHA256SUMS && sha256sum ./* > SHA256SUMS)
ls -lh "$ROOT/release"
