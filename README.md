<p align="center"><img src="site/logo.svg" width="72" alt=""></p>

# Prismagram

**Turn Prisma schema files into clean UML class diagrams.**

Open a `schema.prisma` and Prismagram draws every model, enum and relation as a class
diagram: a green header with the model name, a compartment for fields, a compartment for
relations, and connectors with multiplicities between them. Edit the schema and the diagram
redraws as you type. Export to PNG or SVG.

![Prismagram showing a schema next to its diagram](docs/screenshot.png)

- **Desktop app** for Linux, macOS and Windows, built with Rust and Tauri.
- **Live**: edit in the built-in editor, or keep the file open in your IDE. Prismagram
  reloads it when it changes on disk.
- **Readable at any size**: small schemas show every link; large ones switch to a tree view
  with one line per model, and you click a model to see all of its links.
- **Offline and private**: no network access, no telemetry.

Licensed under [MIT](LICENSE).

## Contents

- [Install (Linux / Kali)](#install-linux--kali)
- [Using Prismagram](#using-prismagram)
- [How the diagram is drawn](#how-the-diagram-is-drawn)
- [Development](#development)
- [Architecture](docs/ARCHITECTURE.md) · [Releasing](docs/RELEASING.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## Install (Linux / Kali)

Download from the [latest release](https://github.com/Kingvic300/Prismagram/releases/latest)
or the [download page](https://kingvic300.github.io/Prismagram/).

| Distribution | File | Install |
| --- | --- | --- |
| Debian, Ubuntu, Kali | `Prismagram_<version>_amd64.deb` | `sudo apt install ./Prismagram_<version>_amd64.deb` |
| Fedora, openSUSE | `Prismagram-<version>-1.x86_64.rpm` | `sudo dnf install ./Prismagram-<version>-1.x86_64.rpm` |
| Any distribution | `Prismagram_<version>_amd64.AppImage` | `chmod +x Prismagram_*.AppImage` then run it |

Then start **Prismagram** from your applications menu, or from a terminal:

```bash
prismagram                       # empty editor
prismagram path/to/schema.prisma # open a schema
```

**macOS and Windows** builds are attached to each release too. They are not code-signed yet:
on macOS right-click the app and choose Open the first time; on Windows choose
More info → Run anyway if SmartScreen warns you.

## Using Prismagram

| Action | How |
| --- | --- |
| Open a schema | **Open** (<kbd>Ctrl</kbd>+<kbd>O</kbd>), drag a `.prisma` file onto the window, or pass it on the command line |
| Edit | Type in the editor on the left. Errors and warnings show in the gutter and the problems list |
| Save the schema | <kbd>Ctrl</kbd>+<kbd>S</kbd> (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> to save as) |
| Pan / zoom | Drag the canvas; mouse wheel to zoom; <kbd>Ctrl</kbd>+<kbd>0</kbd> to fit |
| Focus a model | Click it: its links are highlighted and hidden links are drawn |
| Jump to source | Double-click a model or a field |
| Find a model | <kbd>Ctrl</kbd>+<kbd>F</kbd> |
| Export | **Export** → PNG (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>) or SVG (<kbd>Ctrl</kbd>+<kbd>E</kbd>) |
| Hide the editor | <kbd>Ctrl</kbd>+<kbd>B</kbd> |

**Settings** (the sliders icon, bottom right):

- **Theme**: Classic (the textbook UML look), Mint, Paper, Midnight, Blueprint.
- **Links**: Auto, Tree, Hubs or All. See below.
- **Type notation**: Prisma style (`String?`, `Post[]`) or UML style (`String [0..1]`, `Post [*]`).
- **Relation marker**: triangle, diamond, arrow or none.
- **Show**: relation fields, enums, default values, `{id}` / `{unique}` tags, `@@` constraints,
  edge labels, rounded corners.

Not sure what to try? **Samples** has three schemas, including the classic Animal / Duck /
Fish / Zebra example.

## How the diagram is drawn

| Prisma | Diagram |
| --- | --- |
| `model` | class box: name, fields, relation fields |
| `view`, `type` | class box with a `«view»` or `«type»` stereotype |
| `enum` | box with an `«enumeration»` stereotype and its values |
| field `name Type @default(x)` | `+name: Type = x` |
| `@ignore` field | `-name: Type` |
| relation | connector from the referenced model (top) to the model holding the foreign key, with multiplicities `1`, `0..1` or `*` at each end |
| enum used by a field | dashed arrow to the enum |
| `///` doc comment | tooltip on the box |

Dense schemas can't show every link without a tangle, so **Links** decides which ones get
a line:

- **All**: every relation and enum link.
- **Hubs**: drops the lines of models linked to a large share of the schema, such as a
  tenant or account table.
- **Tree**: each model keeps one line, to the parent that most likely owns it (a required,
  cascading foreign key to the most specific model). Its other links stay listed as fields
  and are counted in a `+N links` badge.
- **Auto** (default): All for small, sparse schemas; Tree otherwise.

In every mode, clicking a model draws all of its links.

## Development

You need Rust (stable), Node.js 22+ and the Tauri system libraries:

```bash
sudo apt install -y libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev librsvg2-dev \
  build-essential libssl-dev patchelf file

scripts/setup-dev.sh          # one-time setup
scripts/dev.sh                # run the app
scripts/test.sh               # run every test
scripts/build-linux.sh        # .deb, .rpm and AppImage into release/
```

```
core/       Rust crate: the Prisma parser
desktop/    Tauri app: frontend in src/, Rust shell in src-tauri/, tests in tests/
docs/       architecture and release process
scripts/    setup, dev, test and build helpers
site/       download page (GitHub Pages)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
