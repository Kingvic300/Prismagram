// The statements behind Data mode's write buttons. PostgreSQL changes run as SQL built here,
// and MongoDB changes are shown as the mongosh call they make, so every dialog can say exactly
// what will run before it does.

import { toShell } from "./values.js";

// ---------------------------------------------------------------- PostgreSQL

export function ident(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

export function tableName(schema, table) {
  return `${ident(schema)}.${ident(table)}`;
}

/**
 * A value from a row as an SQL literal. Literals are left untyped, so PostgreSQL reads them as
 * the column's type: `'42'` fills an integer and `'2026-01-01'` a date. `type` is the column's
 * type name as the server reports it, like `int4`, `jsonb` or `_text` for `text[]`.
 */
export function literal(value, type = "") {
  if (value === null || value === undefined) return "NULL";
  let text;
  if (typeof value === "object") {
    text = Array.isArray(value) && type.startsWith("_") ? arrayText(value) : JSON.stringify(value);
  } else {
    text = String(value);
  }
  return `'${text.replace(/'/g, "''")}'`;
}

/** `["a", null, "b\"c"]` → `{"a",NULL,"b\"c"}`, PostgreSQL's array input syntax. */
function arrayText(items) {
  const item = (v) => {
    if (v === null || v === undefined) return "NULL";
    if (Array.isArray(v)) return arrayText(v);
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  };
  return `{${items.map(item).join(",")}}`;
}

/** The `where` clause that finds `row` by its primary key. */
export function keyCondition(row, key, types = new Map()) {
  if (!key.length) throw new Error("This table has no primary key, so one row can't be picked out. Use the SQL tab instead.");
  return key
    .map((col) => {
      if (!(col in row)) throw new Error(`The row has no ${col} column, so it can't be picked out.`);
      return row[col] === null ? `${ident(col)} IS NULL` : `${ident(col)} = ${literal(row[col], types.get(col))}`;
    })
    .join(" AND ");
}

/** One `insert` per object; `rows` is an object or an array of them. */
export function insertSql(schema, table, rows, types = new Map()) {
  const list = Array.isArray(rows) ? rows : [rows];
  if (!list.length) throw new Error("There is nothing to insert.");
  return list
    .map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Each row must be an object, like { \"name\": \"Ada\" }.");
      const cols = Object.keys(row);
      if (!cols.length) return `INSERT INTO ${tableName(schema, table)} DEFAULT VALUES;`;
      return `INSERT INTO ${tableName(schema, table)} (${cols.map(ident).join(", ")})\nVALUES (${cols.map((c) => literal(row[c], types.get(c))).join(", ")});`;
    })
    .join("\n");
}

/** An `update` setting only the columns that changed, or null when nothing did. */
export function updateSql(schema, table, before, after, key, types = new Map()) {
  if (!after || typeof after !== "object" || Array.isArray(after)) throw new Error("The row must be an object.");
  const changed = Object.keys(after).filter((c) => JSON.stringify(after[c]) !== JSON.stringify(before[c]));
  if (!changed.length) return null;
  const set = changed.map((c) => `${ident(c)} = ${literal(after[c], types.get(c))}`).join(",\n    ");
  return `UPDATE ${tableName(schema, table)}\nSET ${set}\nWHERE ${keyCondition(before, key, types)};`;
}

export function deleteSql(schema, table, row, key, types = new Map()) {
  return `DELETE FROM ${tableName(schema, table)}\nWHERE ${keyCondition(row, key, types)};`;
}

/** `where` is the filter typed in the query bar; empty means every row. */
export function updateWhereSql(schema, table, set, where) {
  const assignments = set.trim().replace(/^set\s+/i, "").replace(/;\s*$/, "");
  if (!assignments) throw new Error("Type the columns to set, like status = 'done'.");
  return `UPDATE ${tableName(schema, table)}\nSET ${assignments}${whereClause(where)};`;
}

export function deleteWhereSql(schema, table, where) {
  return `DELETE FROM ${tableName(schema, table)}${whereClause(where)};`;
}

function whereClause(where) {
  const text = where.trim().replace(/^where\s+/i, "").replace(/;\s*$/, "");
  return text ? `\nWHERE ${text}` : "";
}

/** `columns` is what goes in the parentheses: `email`, or `lower(email), created_at desc`. */
export function createIndexSql(schema, table, columns, unique = false, name = "") {
  const cols = columns.trim().replace(/^\(([^]*)\)$/, "$1");
  if (!cols) throw new Error("Type the columns to index, like email or lower(email).");
  return `CREATE ${unique ? "UNIQUE " : ""}INDEX ${name.trim() ? `${ident(name.trim())} ` : ""}ON ${tableName(schema, table)} (${cols});`;
}

export function dropIndexSql(schema, name) {
  return `DROP INDEX ${tableName(schema, name)};`;
}

/**
 * Tables that record which migrations ran (Prisma, Drizzle, Rails, Knex, Sequelize, Flyway,
 * EF Core, goose, TypeORM). Clearing them would make the next migrate run every migration again.
 */
export const MIGRATION_TABLES = new Set([
  "_prisma_migrations",
  "__drizzle_migrations",
  "schema_migrations",
  "ar_internal_metadata",
  "knex_migrations",
  "knex_migrations_lock",
  "SequelizeMeta",
  "flyway_schema_history",
  "__EFMigrationsHistory",
  "goose_db_version",
  "typeorm_migrations",
]);

/**
 * What "Clear all data" empties in a schema (PostgreSQL) or database (MongoDB): every table or
 * collection that holds rows, except views and the migration tables above.
 */
export function clearableCollections(collections) {
  return (collections || []).filter((c) => ["table", "collection", "timeseries"].includes(c.kind) && !MIGRATION_TABLES.has(c.name));
}

/**
 * Empties `tables` in one statement, so foreign keys between them don't get in the way, and
 * restarts their identity sequences. No CASCADE: a table outside the list that references one
 * of them makes the statement fail instead of being emptied too.
 */
export function truncateSql(schema, tables) {
  if (!tables.length) throw new Error("There are no tables to clear.");
  return `TRUNCATE TABLE\n  ${tables.map((t) => tableName(schema, t)).join(",\n  ")}\nRESTART IDENTITY;`;
}

/** Columns a new row should start with: everything without a default, empty. */
export function rowTemplate(fields) {
  return Object.fromEntries(fields.filter((f) => !f.default).map((f) => [f.name, null]));
}

// ---------------------------------------------------------------- MongoDB

/** `db.getCollection("users").deleteOne({ _id: ObjectId('…') })`, as mongosh would take it. */
export function mongoCall(collection, method, ...args) {
  const coll = /^[A-Za-z_][\w]*$/.test(collection) ? `db.${collection}` : `db.getCollection(${JSON.stringify(collection)})`;
  return `${coll}.${method}(${args.map((a) => (typeof a === "string" ? JSON.stringify(a) : toShell(a))).join(", ")})`;
}
