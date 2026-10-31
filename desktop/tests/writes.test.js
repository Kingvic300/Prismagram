// The SQL and mongosh calls shown and run by Data mode's write buttons.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearableCollections,
  createIndexSql,
  deleteSql,
  deleteWhereSql,
  dropIndexSql,
  insertSql,
  literal,
  mongoCall,
  rowTemplate,
  truncateSql,
  updateSql,
  updateWhereSql,
} from "../src/js/writes.js";

const types = new Map([
  ["id", "int4"],
  ["tags", "_text"],
  ["meta", "jsonb"],
]);

test("writes literals PostgreSQL can read as the column's type", () => {
  assert.equal(literal(null), "NULL");
  assert.equal(literal(42, "int4"), "'42'");
  assert.equal(literal("it's"), "'it''s'");
  assert.equal(literal(true, "bool"), "'true'");
  assert.equal(literal({ a: "x'y" }, "jsonb"), `'{"a":"x''y"}'`);
  assert.equal(literal(["a", null, 'b"c'], "_text"), `'{"a",NULL,"b\\"c"}'`);
  assert.equal(literal([1, 2], "jsonb"), "'[1,2]'");
});

test("deletes and updates one row by its primary key", () => {
  const row = { id: 7, name: "Ada", tags: ["x"] };
  assert.equal(deleteSql("public", "users", row, ["id"], types), `DELETE FROM "public"."users"\nWHERE "id" = '7';`);
  assert.equal(
    updateSql("public", "users", row, { ...row, name: "Grace", tags: ["x", "y"] }, ["id"], types),
    `UPDATE "public"."users"\nSET "name" = 'Grace',\n    "tags" = '{"x","y"}'\nWHERE "id" = '7';`,
  );
  assert.equal(updateSql("public", "users", row, { ...row }, ["id"], types), null);
  assert.throws(() => deleteSql("public", "logs", row, [], types), /no primary key/);
});

test("matches composite and null keys", () => {
  assert.equal(
    deleteSql("app", "Member", { org: 1, user: null }, ["org", "user"]),
    `DELETE FROM "app"."Member"\nWHERE "org" = '1' AND "user" IS NULL;`,
  );
});

test("inserts one row or several", () => {
  assert.equal(insertSql("public", "users", { name: "Ada", id: 1 }, types), `INSERT INTO "public"."users" ("name", "id")\nVALUES ('Ada', '1');`);
  assert.equal(insertSql("public", "users", [{}, { name: null }]), `INSERT INTO "public"."users" DEFAULT VALUES;\nINSERT INTO "public"."users" ("name")\nVALUES (NULL);`);
  assert.throws(() => insertSql("public", "users", []), /nothing to insert/);
  assert.throws(() => insertSql("public", "users", [1]), /must be an object/);
});

test("applies bulk changes to the query bar's filter", () => {
  assert.equal(updateWhereSql("public", "t", "SET done = true;", "where id > 3"), `UPDATE "public"."t"\nSET done = true\nWHERE id > 3;`);
  assert.equal(deleteWhereSql("public", "t", ""), `DELETE FROM "public"."t";`);
  assert.throws(() => updateWhereSql("public", "t", " ", ""), /columns to set/);
});

test("creates and drops indexes", () => {
  assert.equal(createIndexSql("public", "users", "(lower(email))", true, "users_email"), `CREATE UNIQUE INDEX "users_email" ON "public"."users" (lower(email));`);
  assert.equal(createIndexSql("public", "users", "created_at desc"), `CREATE INDEX ON "public"."users" (created_at desc);`);
  assert.equal(dropIndexSql("public", "users_email"), `DROP INDEX "public"."users_email";`);
});

test("starts new rows with the columns that have no default", () => {
  assert.deepEqual(rowTemplate([{ name: "id", default: "nextval('x')" }, { name: "email", default: null }]), { email: null });
});

test("shows MongoDB changes as mongosh calls", () => {
  assert.equal(mongoCall("users", "deleteOne", { _id: { $oid: "6566a1b2c3d4e5f60718293a" } }), "db.users.deleteOne({\n  _id: ObjectId('6566a1b2c3d4e5f60718293a')\n})");
  assert.equal(mongoCall("my-logs", "dropIndex", "ts_1"), 'db.getCollection("my-logs").dropIndex("ts_1")');
});

test("clears every table of a schema in one TRUNCATE, keeping migration history and views", () => {
  const collections = [
    { name: "users", kind: "table" },
    { name: "posts", kind: "table" },
    { name: "_prisma_migrations", kind: "table" },
    { name: "active_users", kind: "view" },
    { name: "stats", kind: "materialized view" },
    { name: "events", kind: "timeseries" },
  ];
  assert.deepEqual(
    clearableCollections(collections).map((c) => c.name),
    ["users", "posts", "events"],
  );
  assert.deepEqual(clearableCollections(null), []);
  assert.equal(
    truncateSql("public", ["users", 'we"ird']),
    'TRUNCATE TABLE\n  "public"."users",\n  "public"."we""ird"\nRESTART IDENTITY;',
  );
  assert.throws(() => truncateSql("public", []), /no tables/);
});
