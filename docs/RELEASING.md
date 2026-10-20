# Releasing

Releases are built by GitHub Actions ([.github/workflows/release.yml](../.github/workflows/release.yml))
when a version tag is pushed.

1. Bump the version in all three places, keeping them equal:
   - `desktop/package.json`
   - `desktop/src-tauri/Cargo.toml`
   - `desktop/src-tauri/tauri.conf.json`
2. Run `scripts/test.sh`.
3. Commit, then tag and push:

   ```bash
   git tag v0.2.0
   git push origin main v0.2.0
   ```

4. The workflow builds Linux (`.deb`, `.rpm`, `.AppImage`), macOS (`.dmg` for Apple
   silicon and Intel) and Windows (`.exe`, `.msi`) installers and attaches them to a
   GitHub release named `Prismagram v0.2.0`.
5. The `notes` job rewrites the release notes into a per-platform download table
   (`scripts/release_notes.py`), and the Pages workflow republishes the download page.

## Building Linux packages locally

```bash
scripts/build-linux.sh
```

The packages and a `SHA256SUMS` file land in `release/`. Set `PRISMAGRAM_BUNDLES=deb` to
build only some formats. Building the AppImage downloads `linuxdeploy` the first time.

## Download page

`site/` is published to GitHub Pages by [.github/workflows/pages.yml](../.github/workflows/pages.yml).
Enable Pages once in the repository settings with "GitHub Actions" as the source. The page
reads the release list from the GitHub API, so it needs no rebuild per release.
