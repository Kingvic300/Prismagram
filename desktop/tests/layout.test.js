// Run with `npm test` (Node's built-in test runner). Text widths are estimated outside the
// webview, so these tests check structure and geometry rules, not exact pixel positions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, layout } from "../src/js/layout.js";
import { renderSVG, THEMES } from "../src/js/render.js";

const OPTS = {
  notation: "prisma",
  marker: "triangle",
  showRelations: true,
  showEnums: true,
  showDefaults: true,
  showProps: false,
  showConstraints: false,
  showLabels: true,
  rounded: false,
  linkMode: "auto",
};

const field = (name, typeName, kind, extra = {}) => ({
  name,
  typeName,
  kind,
  optional: false,
  list: false,
  attributes: [],
  isId: false,
  isUnique: false,
  isUpdatedAt: false,
  ignored: false,
  default: null,
  relation: null,
  doc: null,
  line: 1,
  ...extra,
});

const model = (name, fields) => ({ name, kind: "model", fields, attributes: [], doc: null, line: 1 });

const rel = (parent, child, extra = {}) => ({
  parent,
  child,
  parentField: child.toLowerCase(),
  childField: parent.toLowerCase(),
  parentMultiplicity: "1",
  childMultiplicity: "0..1",
  kind: "one-to-one",
  name: null,
  ...extra,
});

// The zoo from the README: one parent with three children.
const zoo = {
  provider: "postgresql",
  diagnostics: [],
  enums: [],
  models: [
    model("Animal", [field("id", "Int", "scalar"), field("duck", "Duck", "relation", { optional: true })]),
    model("Duck", [field("beakColor", "String", "scalar", { default: '"Yellow"' }), field("animal", "Animal", "relation")]),
    model("Fish", [field("animal", "Animal", "relation")]),
    model("Zebra", [field("animal", "Animal", "relation")]),
  ],
  relations: [rel("Animal", "Duck"), rel("Animal", "Fish"), rel("Animal", "Zebra")],
};

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test("parents sit above their children", () => {
  const d = layout(buildGraph(zoo, OPTS));
  const animal = d.byId.get("Animal");
  for (const id of ["Duck", "Fish", "Zebra"]) assert.ok(d.byId.get(id).y > animal.y + animal.h);
});

test("boxes never overlap", () => {
  const d = layout(buildGraph(zoo, OPTS));
  for (const [i, a] of d.nodes.entries()) {
    for (const b of d.nodes.slice(i + 1)) assert.ok(!overlaps(a, b), `${a.id} overlaps ${b.id}`);
  }
});

test("connectors are orthogonal and end on the boxes", () => {
  const d = layout(buildGraph(zoo, OPTS));
  for (const e of d.edges) {
    for (let i = 1; i < e.points.length; i++) {
      const [x0, y0] = e.points[i - 1];
      const [x1, y1] = e.points[i];
      assert.ok(Math.abs(x0 - x1) < 0.5 || Math.abs(y0 - y1) < 0.5, "diagonal segment");
    }
    const parent = d.byId.get(e.parent);
    const child = d.byId.get(e.child);
    assert.equal(Math.round(e.points[0][1]), Math.round(parent.y + parent.h));
    assert.equal(Math.round(e.points.at(-1)[1]), Math.round(child.y));
  }
});

test("hubs mode hides the lines of models linked to most of the schema", () => {
  const children = Array.from({ length: 12 }, (_, i) => `M${i}`);
  const schema = {
    ...zoo,
    models: [model("Tenant", []), ...children.map((c) => model(c, []))],
    relations: children.map((c) => rel("Tenant", c)),
  };
  const graph = buildGraph(schema, { ...OPTS, linkMode: "hubs" });
  assert.equal(graph.edges.length, 0);
  assert.equal(graph.nodes[0].hiddenLinks, 12);
  assert.equal(buildGraph(schema, { ...OPTS, linkMode: "all" }).edges.length, 12);
});

test("tree mode keeps one line per model, preferring the owning parent", () => {
  // Grade has three parents; the required, cascading one (Sheet) should be kept.
  const schema = {
    ...zoo,
    models: ["Sheet", "Pupil", "Term", "Grade"].map((n) => model(n, [])),
    relations: [
      rel("Pupil", "Grade", { childMultiplicity: "*", parentMultiplicity: "0..1" }),
      rel("Sheet", "Grade", { childMultiplicity: "*" }),
      rel("Term", "Grade", { childMultiplicity: "*" }),
    ],
  };
  schema.models[3].fields = [
    field("sheet", "Sheet", "relation", { relation: { onDelete: "Cascade", fields: ["sheetId"], references: ["id"] } }),
  ];
  schema.relations[1].childField = "sheet";
  const graph = buildGraph(schema, { ...OPTS, linkMode: "tree" });
  assert.deepEqual(graph.edges.map((e) => e.parent), ["Sheet"]);
  assert.equal(graph.hidden.length, 2);
  assert.equal(graph.nodes.find((n) => n.id === "Grade").hiddenLinks, 2);
});

test("auto mode draws everything for small sparse schemas only", () => {
  assert.equal(buildGraph(zoo, { ...OPTS, linkMode: "auto" }).linkMode, "all");
  const many = Array.from({ length: 20 }, (_, i) => `M${i}`);
  const dense = {
    ...zoo,
    models: many.map((n) => model(n, [])),
    relations: many.slice(1).flatMap((c, i) => [rel(many[0], c), rel(many[i], c)]),
  };
  assert.equal(buildGraph(dense, { ...OPTS, linkMode: "auto" }).linkMode, "tree");
});

test("exported SVG is self-contained", () => {
  const svg = renderSVG(layout(buildGraph(zoo, OPTS)), THEMES.classic, OPTS, { background: true });
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.ok(!svg.includes('class="hit"'), "interactive hit areas leak into exports");
  assert.ok(svg.includes(">+beakColor</tspan>") && svg.includes("> = &quot;Yellow&quot;</tspan>"));
});
