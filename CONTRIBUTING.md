# Contributing to Prismagram

Thanks for helping! Prismagram turns Prisma schema files into UML class diagrams. It is a
small, offline desktop app, and a few rules keep it that way.

## Ground rules

1. **Offline and private.** The app never sends a schema anywhere. PRs that add analytics,
   crash reporting, remote fonts or any network call from the app will be declined.
2. **Never fail on a schema.** The parser is forgiving: problems become diagnostics, and the
   diagram keeps rendering whatever was understood. A crash or a blank canvas is a bug.
3. **Readable diagrams first.** Layout changes must not tangle large schemas. Check the
   samples and at least one big real-world schema before and after your change (see below).
4. **No new runtime dependencies without a reason.** The frontend is plain HTML, CSS and ES
   modules with no bundler. The core crate depends only on `serde`.

## Project layout

```
core/                 Rust crate: Prisma parser -> diagram model (models, enums, relations)
desktop/              Tauri 2 desktop app
  src/                frontend (index.html, styles.css, js/)
    js/layout.js      graph building, link modes, layered layout, routing
    js/render.js      SVG rendering and themes
    js/editor.js      schema editor with highlighting
    js/main.js        app wiring: files, export, pan/zoom, settings
  src-tauri/          Rust shell: commands for parsing and file access
  tests/              Node tests for layout and rendering
docs/                 architecture and release notes for maintainers
scripts/              setup, dev, test and build helpers
site/                 download page published to GitHub Pages
```

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how a schema becomes a diagram.

## Getting started

You need Rust (stable), Node.js 22 or newer, and the Tauri system libraries. On Debian,
Ubuntu or Kali:

```bash
sudo apt install -y libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev librsvg2-dev \
  build-essential libssl-dev patchelf file
```

Then:

```bash
scripts/setup-dev.sh                    # npm packages and Rust crates
scripts/dev.sh                          # run the app with hot reload
scripts/dev.sh path/to/schema.prisma    # run the app with a schema open
scripts/test.sh                         # every test: core, layout, shell
scripts/build-linux.sh                  # .deb, .rpm and AppImage into release/
```

## Making changes

### Parser (`core/`)

- Add a unit test in `core/src/lib.rs` for every syntax you add or fix, including the
  line number the diagnostic or field should report.
- The JSON field names are a contract with the frontend. `core/tests/json_shape.rs` guards
  them; update both sides together.

### Layout and rendering (`desktop/src/js/`)

- `layout.js` is pure: no DOM access except text measurement, which falls back to an
  estimate under Node. Keep it that way so `npm test` can run it.
- Exported SVG must be self-contained: inline attributes only, no CSS classes for looks.
- When you change layout, compare before and after on the three built-in samples (Samples
  menu) and on a large schema (40+ models). Attach screenshots to the PR.

### UI

- Keep the dark shell and the diagram themes separate: shell colours live in CSS variables
  in `styles.css`, diagram colours in `THEMES` in `render.js`.
- New settings go in `DEFAULT_OPTIONS` in `main.js` so existing users get a sensible value.

## Pull requests

- One logical change per PR. Describe the user-visible effect and include a screenshot for
  anything visual.
- `scripts/test.sh` must pass.
- Use Conventional Commit messages (`feat:`, `fix:`, `docs:`, `refactor:` …).
- Match the surrounding style: `cargo fmt` for Rust, 2-space indentation and double quotes
  for JavaScript.

## Reporting bugs

Open an issue with the smallest schema that shows the problem, what you expected, what you
got (a screenshot helps) and your OS and Prismagram version. Remove anything private from
the schema first. Security issues: see [SECURITY.md](SECURITY.md).

By contributing you agree that your contributions are licensed under the MIT License.
