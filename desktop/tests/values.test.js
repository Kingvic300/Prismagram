// Queries typed in mongosh syntax must reach Rust as Extended JSON, and documents must read back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inferSchema, parseShell, toCSV, toShell, typeOf } from "../src/js/values.js";

test("parses mongosh query syntax into Extended JSON", () => {
  assert.equal(parseShell("   "), undefined);
  assert.deepEqual(parseShell("{ field: 'value', \"n\": -1.5e2, ok: true, none: null, }"), {
    field: "value",
    n: -150,
    ok: true,
    none: null,
  });
  assert.deepEqual(parseShell("{ _id: ObjectId('69E1F6D8FC5C0AA566D73025') }"), { _id: { $oid: "69e1f6d8fc5c0aa566d73025" } });
  assert.deepEqual(parseShell("{ createdAt: { $gte: ISODate('2026-04-17'), $lt: new Date('2026-05-01T00:00:00Z') } }"), {
    createdAt: { $gte: { $date: "2026-04-17T00:00:00.000Z" }, $lt: { $date: "2026-05-01T00:00:00.000Z" } },
  });
  assert.deepEqual(parseShell("{ email: /naelix\\.com$/mi, 'profile.city': { $in: ['Lagos', \"Abuja\"] } }"), {
    email: { $regularExpression: { pattern: "naelix\\.com$", options: "im" } },
    "profile.city": { $in: ["Lagos", "Abuja"] },
  });
  assert.deepEqual(parseShell("[{ $match: {} }, // first\n { $limit: NumberInt(5) }]"), [{ $match: {} }, { $limit: { $numberInt: "5" } }]);
  assert.deepEqual(parseShell("{ price: NumberDecimal('1.50'), big: NumberLong(\"9007199254740993\") }"), {
    price: { $numberDecimal: "1.50" },
    big: { $numberLong: "9007199254740993" },
  });
  assert.deepEqual(parseShell("{ s: 'it\\'s \\u00e9' }"), { s: "it's é" });
});

test("says where a query is wrong", () => {
  assert.throws(() => parseShell("{ field: 'value' "), /Missing “}”/);
  assert.throws(() => parseShell("{ field: value }"), /Unknown name “value” at character 10/);
  assert.throws(() => parseShell("{ _id: ObjectId('nope') }"), /24-character hex/);
  assert.throws(() => parseShell("{ a: 1 } x"), /Unexpected “x”/);
  assert.throws(() => parseShell("{ a: 'open }"), /Unclosed string/);
});

test("names Extended JSON types", () => {
  assert.equal(typeOf({ $oid: "69e1f6d8fc5c0aa566d73025" }), "ObjectId");
  assert.equal(typeOf({ $date: "2026-04-17T09:01:12.077Z" }), "Date");
  assert.equal(typeOf({ $binary: { base64: "AAAAAAAAAAAAAAAAAAAAAA==", subType: "04" } }), "UUID");
  assert.equal(typeOf({ a: 1 }), "Object");
  assert.equal(typeOf(2.5), "Double");
  assert.equal(typeOf([]), "Array");
});

test("prints documents in mongosh syntax", () => {
  const doc = {
    _id: { $oid: "69e1f6d8fc5c0aa566d73025" },
    createdAt: { $date: "2026-04-17T09:01:12.077Z" },
    "first-name": "Ann",
    tags: ["a"],
    empty: {},
  };
  assert.equal(
    toShell(doc),
    `{
  _id: ObjectId('69e1f6d8fc5c0aa566d73025'),
  createdAt: ISODate('2026-04-17T09:01:12.077Z'),
  "first-name": "Ann",
  tags: [
    "a"
  ],
  empty: {}
}`,
  );
  assert.deepEqual(parseShell(toShell(doc)), doc);
});

test("infers fields, presence and types from sampled documents", () => {
  const fields = inferSchema([
    { _id: { $oid: "69e1f6d8fc5c0aa566d73025" }, profile: { city: "Lagos" }, n: 1 },
    { _id: { $oid: "69e1f7b4d5702d38e2f75b9f" }, profile: { city: "Abuja", zip: 1 }, n: "1" },
  ]);
  assert.deepEqual(
    fields.map((f) => [f.path, f.depth, f.presence, f.types.map((t) => t.name).join("|")]),
    [
      ["_id", 0, 1, "ObjectId"],
      ["profile", 0, 1, "Object"],
      ["profile.city", 1, 1, "String"],
      ["profile.zip", 1, 0.5, "Int"],
      ["n", 0, 1, "Int|String"],
    ],
  );
});

test("writes CSV with nested values as JSON", () => {
  const csv = toCSV([
    { _id: { $oid: "69e1f6d8fc5c0aa566d73025" }, name: 'Ann "A", B', tags: ["x"] },
    { _id: { $oid: "69e1f7b4d5702d38e2f75b9f" }, extra: null },
  ]);
  assert.equal(
    csv,
    '_id,name,tags,extra\n69e1f6d8fc5c0aa566d73025,"Ann ""A"", B","[""x""]",\n69e1f7b4d5702d38e2f75b9f,,,\n',
  );
});
