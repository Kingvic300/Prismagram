# Architecture

Prismagram has two halves: a Rust parser that understands Prisma, and a JavaScript frontend
that lays out and draws the diagram. They talk through one Tauri command.

```
schema.prisma ──► core (Rust) ──► JSON model ──► layout.js ──► render.js ──► SVG
                  parse()          models,        boxes,         themes,      screen,
                                   enums,         positions,     markers,     .svg, .png
                                   relations,     connectors     labels
                                   diagnostics
```

## core/ — the parser

`prismagram_core::parse(&str) -> Schema` is a forgiving, line-based parser:

1. Block comments are blanked out (newlines kept, so line numbers stay right).
2. Top-level blocks (`model`, `view`, `type`, `enum`, `datasource`, `generator`) are
   collected up to their closing brace. `///` doc comments attach to the next block or field.
3. Each field line is split into name, type (with `?` / `[]`) and attributes. Attributes are
   parsed with string- and bracket-aware scanning, so `@default("a // b")` and
   `@default(dbgenerated("(x)::uuid"))` survive.
4. Field types are classified: scalar, enum, relation, composite or unknown (a warning).
5. Relation fields are paired up (by target model and relation name). The side holding
   `@relation(fields: …)` is the **child**; the other is the **parent**. Multiplicities come
   from each side's `?` and `[]`.

Nothing panics: malformed input becomes a `Diagnostic` with a line number.

### Database import (`introspect`)

`introspect::catalog_query(schemas)` is one read-only SQL statement over `pg_catalog` that
returns every table, view, column, index, foreign key and enum in the chosen schemas as a
single JSON value. `introspect::to_prisma(&Catalog, source)` turns that into Prisma schema
text the way `prisma db pull` does: Postgres types become Prisma scalars plus `@db.*`
native types, defaults become `@default(...)`, names that aren't valid identifiers get
`@map`, and each foreign key becomes a relation field on both models (named with the
constraint when two models are linked more than once). Foreign keys to tables that weren't
pulled stay plain columns with a `// references ...` comment. Both functions are pure; the
tests feed a catalog in and parse the output with `parse()`.

## desktop/src-tauri — the shell

A thin Tauri 2 app. Commands: `parse_schema`, `read_text_file`, `write_text_file`,
`write_binary_file`, `file_modified` (for auto-reload), `launch_file` (a path passed on
the command line) and `pull_database`.

`pull_database` (`database.rs`) connects with `tokio-postgres` over rustls, runs the
catalog query with the simple query protocol (so it works through Supabase's pooler in
transaction mode too) and returns the generated schema. It accepts Supabase's
`[YOUR-PASSWORD]` placeholder plus a separate password, a `DATABASE_URL=...` line, and
libpq's `sslmode` values; Prisma-only URL options such as `pgbouncer=true` are dropped.
Errors are rewritten with hints for the usual Supabase mistakes (IPv6-only direct host,
pooler user name). On Linux it disables WebKitGTK's DMA-BUF renderer, which shows a blank
window on many GPU drivers.

## desktop/src/js — layout and rendering

### Building the graph (`buildGraph`)

Each model becomes a box with up to three compartments, like a UML class: scalar and enum
fields, relation fields, and optionally `@@` constraints. Enums become `«enumeration»` boxes.
Box sizes come from measured text.

### Choosing which links get a line (`pickLinks`)

Real schemas are dense: a tenant table can be linked to every other model, and many models
have three or more parents. Drawing every link produces a tangle no layout can fix, so the
**Links** setting decides what gets a line:

| Mode | Lines drawn |
| --- | --- |
| All | every relation and enum link |
| Hubs | everything except links of models connected to ≥ 25% of the schema |
| Tree | one line per model, to the parent that most likely owns it |
| Auto | All for small sparse schemas (≤ 15 models, ≤ 2 parents each), otherwise Tree |

In Tree mode the owner is picked by: required foreign key, cascading delete, and how
connected the parent is (a parent linked to everything is the least specific owner).
Hidden links are still listed as fields, counted in a `+N links` badge, and drawn when
the user clicks the model.

### Layout (`layout`)

A Sugiyama-style layered layout:

1. **Leaf grids.** Five or more leaf children of one parent are packed into a grid block,
   so one parent doesn't produce a very wide row.
2. **Cycle breaking** with a DFS; back edges are drawn reversed.
3. **Layering** by longest path, then **compaction**: each box moves to the row that
   minimises its total link length.
4. **Dummy vertices** for links that span rows. Links from the same box share one trunk.
5. **Crossing reduction** with barycenter sweeps (keeping the best ordering), then a
   transpose pass that swaps neighbours when that removes crossings.
6. **Horizontal placement**: boxes are pulled toward their neighbours, and an isotonic
   regression (pool-adjacent-violators) keeps the minimum spacing.
7. **Routing**: every link is orthogonal. Links leaving a box share a bus per edge kind;
   buses that overlap get separate lanes in the gap between rows; entries into a box are
   spread along its top edge. Grid members get a comb: down a gutter, along their row.
8. Boxes without links go in a grid at the bottom, models first, then enums.

### Rendering (`renderSVG`)

Produces one SVG string with inline attributes only, used both on screen and for export.
PNG export draws that SVG onto a canvas at 2× and saves the bytes through Rust.
