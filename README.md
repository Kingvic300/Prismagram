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
- **Supabase import**: paste your Supabase (or any PostgreSQL) connection string and
  Prismagram reads the tables, enums and foreign keys and draws them. Read-only.
- **Data mode**: switch from **Diagram** to **Data** to browse a PostgreSQL, Supabase or
  MongoDB database, in the style of MongoDB Compass: every table and collection, its rows as
  documents, a table or JSON view, filters, schema analysis, indexes, and a SQL or
  aggregation editor.
- **Updates itself**: new versions download in the background; click **Restart now** and
  you're on the latest. No reinstalling.
- **Private**: your schema never leaves your computer. The update check is a plain file
  download from GitHub Releases; the only other connection is the one you ask for, from
  your computer straight to your database. No telemetry.

Licensed under [MIT](LICENSE).

## Contents

- [Install (Linux / Kali)](#install-linux--kali)
- [Using Prismagram](#using-prismagram)
- [Browsing data](#browsing-data)
- [How the diagram is drawn](#how-the-diagram-is-drawn)
- [Development](#development)
- [Architecture](docs/ARCHITECTURE.md) · [Releasing](docs/RELEASING.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## Install (Linux / Kali)

Install from the terminal on any distribution. Debian, Ubuntu, Kali, Fedora and openSUSE get
Prismagram's signed package repository, so `apt upgrade`, `dnf upgrade` or `zypper update`
keep it current; anything else gets the AppImage in `/opt/prismagram`.

```bash
curl -fsSL https://kingvic300.github.io/Prismagram/install.sh | sudo sh
```

Or download a file from the [latest release](https://github.com/Kingvic300/Prismagram/releases/latest)
or the [download page](https://kingvic300.github.io/Prismagram/):

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

Once installed, Prismagram keeps itself up to date: it checks GitHub Releases shortly after
launch and every few hours, downloads new versions in the background, and shows a
**Restart now** banner. Turn this off in Settings → App. The AppImage updates in place
without a password; the `.deb` and `.rpm` ask for your password to install the update.

**macOS and Windows** builds are attached to each release too, and this repository is a
Homebrew tap and a Scoop bucket:

```bash
brew tap kingvic300/prismagram https://github.com/Kingvic300/Prismagram && brew install --cask prismagram
scoop bucket add prismagram https://github.com/Kingvic300/Prismagram; scoop install prismagram
```

The builds are not code-signed yet:
on macOS right-click the app and choose Open the first time; on Windows choose
More info → Run anyway if SmartScreen warns you.

## Using Prismagram

| Action | How |
| --- | --- |
| Open a schema | **Open** (<kbd>Ctrl</kbd>+<kbd>O</kbd>), drag a `.prisma` file onto the window, or pass it on the command line |
| Import a database | **Supabase**, then paste a connection string. See [Importing from Supabase](#importing-from-supabase) |
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

### Importing from Supabase

1. In Supabase, open your project, click **Connect** and copy the **Session pooler**
   connection string. (The direct connection needs IPv6, which many networks don't have.)
2. In Prismagram, click **Supabase**, paste the string and type your database password.
   It replaces `[YOUR-PASSWORD]` in the string.
3. Click **Import**. The tables, views, enums, indexes and foreign keys become a Prisma
   schema in the editor, and the diagram draws. Save it with <kbd>Ctrl</kbd>+<kbd>S</kbd>.

Only `public` is read by default. Add `auth` under **Schemas** to include Supabase's users
table and the links to it. Any PostgreSQL connection string works the same way, including
a `DATABASE_URL=...` line from a `.env` file.

Prismagram reads only the structure: no rows, and nothing is written. The password is never
saved; the connection string is remembered with `[YOUR-PASSWORD]` in its place. The
connection is encrypted; to also verify Supabase's certificate, download it from
Database Settings → SSL and add `?sslmode=verify-full&sslrootcert=/path/to/prod-supabase.cer`.

## Browsing data

Click **Data** at the top left (<kbd>Ctrl</kbd>+<kbd>2</kbd>; <kbd>Ctrl</kbd>+<kbd>1</kbd> goes
back to the diagram), then **New connection**, and paste a connection string:

- PostgreSQL or Supabase: `postgresql://user:password@host:5432/db`
- MongoDB or Atlas: `mongodb://localhost:27017/app` or `mongodb+srv://user:<db_password>@cluster0.abcd.mongodb.net/`

Type the password in the **Password** field to fill in `<db_password>` or `[YOUR-PASSWORD]`.
Several connections can be open at once. The sidebar lists each database (MongoDB) or schema
(PostgreSQL) and its collections or tables; click one to open it in a tab.

| Tab | What it shows |
| --- | --- |
| **Documents** / **Rows** | Rows as documents, a table or JSON, 20 to 100 per page. Expand nested objects and arrays. Filter with a MongoDB query (`{ status: 'active', createdAt: { $gt: ISODate('2026-01-01') } }`) or a SQL `WHERE` clause (`status = 'active'`); **Options** adds sort and projection. **Export** copies the page as JSON or saves it as JSON or CSV |
| **Schema** | PostgreSQL: columns, types, defaults, primary and foreign keys. MongoDB: the fields of 200 sampled documents, with their types and how often they appear |
| **Indexes** | Each index and its definition |
| **SQL** / **Aggregations** | Any SQL (several statements are fine; up to 2,000 rows per result are shown), or a MongoDB aggregation pipeline. <kbd>Ctrl</kbd>+<kbd>Enter</kbd> runs it |

On a PostgreSQL schema, **Diagram** imports it as a Prisma schema and switches to the
diagram. SQL runs as typed, so statements such as `update` and `delete` change your data;
the other tabs only read. Passwords are never saved: connections are remembered with the
password replaced by a placeholder, and you type it again to reconnect.

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
core/       Rust crate: the Prisma parser, and the PostgreSQL-to-Prisma generator
desktop/    Tauri app: frontend in src/, Rust shell in src-tauri/, tests in tests/
docs/       architecture and release process
scripts/    setup, dev, test and build helpers
site/       download page (GitHub Pages)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
