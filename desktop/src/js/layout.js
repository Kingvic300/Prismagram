// Turns a parsed schema into positioned boxes and orthogonal connectors.
//
// The layout is a small Sugiyama-style pipeline: break cycles, assign layers
// (referenced models above the models that point at them), insert dummy nodes
// for edges that skip layers, reduce crossings with barycenter sweeps, place
// boxes horizontally, then route every edge through the gaps between rows.

export const FONT_FAMILY =
  "'Noto Sans', 'Source Sans 3', 'Source Sans Pro', 'DejaVu Sans', 'Liberation Sans', Arial, sans-serif";

export const METRICS = {
  titleSize: 18,
  stereoSize: 12,
  memberSize: 14,
  labelSize: 12,
  padX: 14,
  lineH: 21,
  sectionPad: 8,
  emptySection: 16,
  titleH: 40,
  stereoH: 18,
  minW: 150,
  nodeGap: 96,
  dummyGap: 30,
  laneStep: 20,
  gapBase: 110,
  margin: 60,
  gridMin: 5,
  gridColGap: 60,
  gridRowGap: 84,
};

export const fonts = {
  title: `normal 700 ${METRICS.titleSize}px ${FONT_FAMILY}`,
  stereo: `italic 400 ${METRICS.stereoSize}px ${FONT_FAMILY}`,
  member: `italic 400 ${METRICS.memberSize}px ${FONT_FAMILY}`,
  label: `normal 500 ${METRICS.labelSize}px ${FONT_FAMILY}`,
};

// Outside a browser (unit tests) there is no canvas, so widths are estimated from the font size.
const measureCtx = globalThis.document?.createElement("canvas").getContext("2d") ?? null;
const widthCache = new Map();

export function textWidth(text, font) {
  const key = font + "\u0000" + text;
  let w = widthCache.get(key);
  if (w === undefined) {
    if (measureCtx) {
      measureCtx.font = font;
      w = measureCtx.measureText(text).width;
    } else {
      w = text.length * parseFloat(font.match(/(\d+(?:\.\d+)?)px/)[1]) * 0.55;
    }
    if (widthCache.size > 5000) widthCache.clear();
    widthCache.set(key, w);
  }
  return w;
}

// ---------------------------------------------------------------- content

function typeLabel(f, notation) {
  if (notation === "uml") {
    const mult = f.list ? " [*]" : f.optional ? " [0..1]" : "";
    return f.typeName + mult;
  }
  return f.typeName + (f.list ? "[]" : "") + (f.optional ? "?" : "");
}

function shorten(text, max = 30) {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function fieldSpans(f, opts) {
  const spans = [
    { t: (f.ignored ? "-" : "+") + f.name, r: "name" },
    { t: ": " + typeLabel(f, opts.notation), r: "type" },
  ];
  if (opts.showDefaults && f.default != null) spans.push({ t: " = " + shorten(f.default), r: "default" });
  if (opts.showProps) {
    const props = [];
    if (f.isId) props.push("id");
    if (f.isUnique) props.push("unique");
    if (f.isUpdatedAt) props.push("updatedAt");
    if (props.length) spans.push({ t: ` {${props.join(", ")}}`, r: "meta" });
  }
  return spans;
}

function makeNode(id, kind, stereotype, sections, info) {
  const { padX, lineH, sectionPad, emptySection, titleH, stereoH, minW } = METRICS;
  let w = textWidth(id, fonts.title) + padX * 2 + 16;
  if (stereotype) w = Math.max(w, textWidth(stereotype, fonts.stereo) + padX * 2);
  for (const rows of sections) {
    for (const row of rows) {
      w = Math.max(w, textWidth(row.spans.map((s) => s.t).join(""), fonts.member) + padX * 2);
    }
  }
  const headH = titleH + (stereotype ? stereoH : 0);
  let h = headH;
  for (const rows of sections) h += rows.length ? rows.length * lineH + sectionPad * 2 : emptySection;
  return { id, kind, stereotype, sections, headH, w: Math.ceil(Math.max(minW, w)), h: Math.ceil(h), ...info };
}

/** Builds boxes and edges (without positions) from the parsed schema. */
export function buildGraph(schema, opts) {
  const nodes = [];
  const ids = new Set();
  const stereotypes = { view: "«view»", type: "«type»" };

  for (const m of schema.models) {
    if (ids.has(m.name)) continue;
    ids.add(m.name);
    const plain = m.fields.filter((f) => f.kind !== "relation");
    const rels = m.fields.filter((f) => f.kind === "relation");
    const sections = [plain.map((f) => ({ spans: fieldSpans(f, opts), field: f }))];
    if (opts.showRelations && rels.length) sections.push(rels.map((f) => ({ spans: fieldSpans(f, opts), field: f })));
    if (opts.showConstraints && m.attributes.length) {
      sections.push(m.attributes.map((a) => ({ spans: [{ t: shorten(a, 48), r: "meta" }] })));
    }
    nodes.push(makeNode(m.name, m.kind, stereotypes[m.kind] || null, sections, { line: m.line, doc: m.doc }));
  }

  if (opts.showEnums) {
    for (const e of schema.enums) {
      if (ids.has(e.name)) continue;
      ids.add(e.name);
      const rows = e.values.map((v) => ({ spans: [{ t: v, r: "name" }] }));
      nodes.push(makeNode(e.name, "enum", "«enumeration»", [rows], { line: e.line, doc: e.doc }));
    }
  }

  const edges = [];
  for (const r of schema.relations) {
    if (!ids.has(r.parent) || !ids.has(r.child)) continue;
    const childModel = schema.models.find((m) => m.name === r.child);
    const fk = childModel?.fields.find((f) => f.name === r.childField);
    edges.push({ parent: r.parent, child: r.child, kind: "relation", rel: r, onDelete: fk?.relation?.onDelete || null });
  }
  const seen = new Set();
  for (const m of schema.models) {
    for (const f of m.fields) {
      const kind = f.kind === "enum" && opts.showEnums ? "enum" : f.kind === "composite" ? "composite" : null;
      const key = m.name + "\u0000" + f.typeName;
      if (!kind || seen.has(key) || !ids.has(f.typeName) || f.typeName === m.name) continue;
      seen.add(key);
      edges.push({ parent: m.name, child: f.typeName, kind, field: f.name });
    }
  }
  const { shown, hidden, mode } = pickLinks(nodes, edges, opts);
  const touching = new Map();
  for (const e of hidden) {
    if (e.kind !== "relation") continue;
    touching.set(e.parent, (touching.get(e.parent) || 0) + 1);
    touching.set(e.child, (touching.get(e.child) || 0) + 1);
  }
  for (const n of nodes) {
    const count = touching.get(n.id);
    if (!count) continue;
    n.hiddenLinks = count;
    n.badge = `+${count} link${count === 1 ? "" : "s"}`;
    const pill = textWidth(n.badge, fonts.label) + 16;
    n.w = Math.max(n.w, Math.ceil(textWidth(n.id, fonts.title) + 2 * (pill + 18)));
  }
  shown.forEach((e, i) => (e.id = String(i)));
  hidden.forEach((e, i) => (e.id = `h${i}`));
  return { nodes, edges: shown, hidden, linkMode: mode };
}

/**
 * Decides which links get a line. Dense schemas can't be drawn without a tangle, so:
 *  - "all":  every relation and enum link.
 *  - "hubs": drop lines of models linked to a large share of the schema (e.g. a tenant table).
 *  - "tree": each model keeps one line, to the parent that most likely owns it; the rest are
 *            listed as fields, counted in a badge and drawn when the model is focused.
 *  - "auto": "all" for small, sparse schemas, otherwise "tree".
 * Hidden links stay available for focus highlighting.
 */
export function pickLinks(nodes, edges, opts) {
  const relations = edges.filter((e) => e.kind === "relation" && e.parent !== e.child);
  const degree = new Map();
  const parents = new Map();
  for (const e of relations) {
    degree.set(e.parent, (degree.get(e.parent) || 0) + 1);
    degree.set(e.child, (degree.get(e.child) || 0) + 1);
    if (!parents.has(e.child)) parents.set(e.child, new Set());
    parents.get(e.child).add(e.parent);
  }
  const models = nodes.filter((n) => n.kind !== "enum").length;

  let mode = opts.linkMode || "auto";
  if (mode === "auto") {
    const maxParents = Math.max(0, ...[...parents.values()].map((p) => p.size));
    mode = models <= 15 && maxParents <= 2 && relations.length <= models * 1.5 ? "all" : "tree";
  }
  if (mode === "all") return { shown: edges, hidden: [], mode };

  if (mode === "hubs") {
    const threshold = Math.max(8, Math.ceil(models * 0.25));
    const hubs = new Set([...degree].filter(([, d]) => d >= threshold).map(([id]) => id));
    const isHidden = (e) => e.kind === "relation" && (hubs.has(e.parent) || hubs.has(e.child));
    return { shown: edges.filter((e) => !isHidden(e)), hidden: edges.filter(isHidden), mode };
  }

  // Tree: per child, prefer a required foreign key and a cascading one (ownership), weighed
  // against how connected the parent is; ties keep schema order.
  const best = new Map();
  const score = (e) => {
    const rel = e.rel;
    const required = rel.parentMultiplicity === "1" ? 4 : 0;
    const cascade = e.onDelete === "Cascade" ? 1 : 0;
    const manyToMany = rel.kind === "many-to-many" ? -8 : 0;
    // A parent linked to everything (a tenant or account table) is the least specific owner.
    return required + cascade + manyToMany - Math.log2(1 + (degree.get(e.parent) || 0));
  };
  for (const e of relations) {
    const current = best.get(e.child);
    if (!current || score(e) > score(current)) best.set(e.child, e);
  }
  const keep = new Set(best.values());
  const isShown = (e) => keep.has(e) || (e.kind === "relation" && e.parent === e.child);
  return { shown: edges.filter(isShown), hidden: edges.filter((e) => !isShown(e)), mode };
}

// ---------------------------------------------------------------- layout

/** Pool-adjacent-violators: closest positions to `want` that keep each item `sep` apart. */
function spacedFit(want, seps) {
  const n = want.length;
  const offset = new Array(n).fill(0);
  for (let i = 1; i < n; i++) offset[i] = offset[i - 1] + seps[i - 1];
  const blocks = [];
  for (let i = 0; i < n; i++) {
    blocks.push({ sum: want[i] - offset[i], count: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      if (a.sum / a.count <= b.sum / b.count) break;
      a.sum += b.sum;
      a.count += b.count;
      blocks.pop();
    }
  }
  const out = [];
  for (const b of blocks) for (let k = 0; k < b.count; k++) out.push(b.sum / b.count);
  return out.map((q, i) => q + offset[i]);
}

function crossings(upper, lower) {
  const pos = new Map(lower.map((v, i) => [v, i]));
  const segs = [];
  upper.forEach((u, i) => u.down.forEach((s) => segs.push([i, pos.get(s.v)])));
  let c = 0;
  for (let a = 0; a < segs.length; a++) {
    for (let b = a + 1; b < segs.length; b++) {
      if ((segs[a][0] - segs[b][0]) * (segs[a][1] - segs[b][1]) < 0) c++;
    }
  }
  return c;
}

export function layout(graph) {
  const M = METRICS;
  const allNodes = graph.nodes;
  const allEdges = graph.edges;
  const byId = new Map(allNodes.map((n) => [n.id, n]));

  // Leaf children (no children of their own, one parent) of the same box are packed into a
  // compact grid block. Without this a parent with many leaves makes one very wide row.
  const outCount = new Map();
  const inEdges = new Map();
  for (const e of allEdges) {
    if (e.parent === e.child) continue;
    outCount.set(e.parent, (outCount.get(e.parent) || 0) + 1);
    if (!inEdges.has(e.child)) inEdges.set(e.child, []);
    inEdges.get(e.child).push(e);
  }
  const groups = new Map();
  for (const n of allNodes) {
    const ins = inEdges.get(n.id);
    if (outCount.get(n.id) || !ins || ins.length !== 1) continue;
    const key = ins[0].parent + "\u0000" + ins[0].kind;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ins[0]);
  }
  const grids = [];
  const inGrid = new Set();
  const proxies = [];
  for (const list of groups.values()) {
    if (list.length < M.gridMin) continue;
    const members = list.map((e) => byId.get(e.child));
    const cols = Math.max(2, Math.round(Math.sqrt(members.length * 1.6)));
    const cellW = Math.max(...members.map((n) => n.w));
    const rows = [];
    members.forEach((n, i) => (rows[Math.floor(i / cols)] ||= []).push(n));
    const rowH = rows.map((r) => Math.max(...r.map((n) => n.h)));
    const grid = {
      id: `#grid${grids.length}`,
      kind: "grid",
      members,
      edges: list,
      cols,
      cellW,
      rows,
      rowH,
      w: cols * cellW + (cols - 1) * M.gridColGap,
      h: rowH.reduce((a, h) => a + h, 0) + (rows.length - 1) * M.gridRowGap,
    };
    grids.push(grid);
    members.forEach((n) => inGrid.add(n.id));
    byId.set(grid.id, grid);
    proxies.push({ parent: list[0].parent, child: grid.id, kind: list[0].kind, proxy: true, grid });
  }
  const gridEdges = new Set(grids.flatMap((g) => g.edges));
  const nodes = [...allNodes.filter((n) => !inGrid.has(n.id)), ...grids];
  const edges = [...allEdges.filter((e) => !gridEdges.has(e)), ...proxies];

  const degree = new Map(nodes.map((n) => [n.id, 0]));
  const selfEdges = [];
  const flow = [];
  for (const e of edges) {
    if (e.parent === e.child) {
      selfEdges.push(e);
    } else {
      flow.push(e);
      degree.set(e.parent, degree.get(e.parent) + 1);
      degree.set(e.child, degree.get(e.child) + 1);
    }
  }
  const connected = nodes.filter((n) => degree.get(n.id) > 0);
  const isolated = nodes
    .filter((n) => degree.get(n.id) === 0)
    .sort((a, b) => (a.kind === "enum") - (b.kind === "enum"));

  // 1. Break cycles with a DFS from the roots; back edges are drawn reversed.
  const out = new Map(connected.map((n) => [n.id, []]));
  const indeg = new Map(connected.map((n) => [n.id, 0]));
  for (const e of flow) {
    out.get(e.parent).push(e);
    indeg.set(e.child, indeg.get(e.child) + 1);
  }
  const state = new Map();
  const reversed = new Set();
  const visit = (id) => {
    state.set(id, 1);
    for (const e of out.get(id)) {
      const s = state.get(e.child) || 0;
      if (s === 1) reversed.add(e);
      else if (s === 0) visit(e.child);
    }
    state.set(id, 2);
  };
  const starts = [...connected].sort((a, b) => (indeg.get(a.id) === 0 ? 0 : 1) - (indeg.get(b.id) === 0 ? 0 : 1));
  for (const n of starts) if (!state.get(n.id)) visit(n.id);
  for (const e of flow) {
    e.parentOnTop = !reversed.has(e);
    e.src = e.parentOnTop ? e.parent : e.child;
    e.dst = e.parentOnTop ? e.child : e.parent;
  }

  // 2. Longest-path layering.
  const layerOf = new Map(connected.map((n) => [n.id, 0]));
  const succ = new Map(connected.map((n) => [n.id, []]));
  const pending = new Map(connected.map((n) => [n.id, 0]));
  for (const e of flow) {
    succ.get(e.src).push(e.dst);
    pending.set(e.dst, pending.get(e.dst) + 1);
  }
  const queue = connected.filter((n) => pending.get(n.id) === 0).map((n) => n.id);
  while (queue.length) {
    const id = queue.shift();
    for (const d of succ.get(id)) {
      layerOf.set(d, Math.max(layerOf.get(d), layerOf.get(id) + 1));
      pending.set(d, pending.get(d) - 1);
      if (pending.get(d) === 0) queue.push(d);
    }
  }
  // Compact: move each box to the row that minimises total link length, so links span
  // as few rows as possible (a cheap stand-in for network-simplex layering).
  const pred = new Map(connected.map((n) => [n.id, []]));
  for (const e of flow) pred.get(e.dst).push(e.src);
  for (let pass = 0; pass < 16; pass++) {
    let moved = false;
    for (const n of connected) {
      const ups = pred.get(n.id);
      const downs = succ.get(n.id);
      const lo = ups.length ? Math.max(...ups.map((u) => layerOf.get(u))) + 1 : -Infinity;
      const hi = downs.length ? Math.min(...downs.map((d) => layerOf.get(d))) - 1 : Infinity;
      const cur = layerOf.get(n.id);
      const target = ups.length > downs.length ? lo : ups.length < downs.length ? hi : Math.min(Math.max(cur, lo), hi);
      if (Number.isFinite(target) && target !== cur) {
        layerOf.set(n.id, target);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const minLayer = Math.min(...connected.map((n) => layerOf.get(n.id)));
  for (const n of connected) layerOf.set(n.id, layerOf.get(n.id) - minLayer);

  // 3. Layout vertices, with dummies for long edges.
  const verts = new Map();
  const layers = [];
  const addVert = (v) => {
    (layers[v.layer] ||= []).push(v);
    return v;
  };
  for (const n of connected) {
    verts.set(n.id, addVert({ id: n.id, node: n, w: n.w, h: n.h, layer: layerOf.get(n.id), up: [], down: [] }));
  }
  // Long links from the same box share one trunk (bundle) until they branch off.
  let dummyCount = 0;
  const trunks = new Map();
  for (const e of flow) {
    const group = e.rel?.kind === "many-to-many" ? "many" : e.kind;
    const chain = [verts.get(e.src)];
    for (let l = chain[0].layer + 1; l < verts.get(e.dst).layer; l++) {
      const key = `${e.src}\u0000${group}\u0000${l}`;
      if (!trunks.has(key)) {
        trunks.set(key, addVert({ id: `~${dummyCount++}`, dummy: true, w: 0, h: 0, layer: l, up: [], down: [] }));
      }
      chain.push(trunks.get(key));
    }
    chain.push(verts.get(e.dst));
    e.segs = [];
    for (let k = 0; k + 1 < chain.length; k++) {
      const seg = { edge: e, u: chain[k], v: chain[k + 1] };
      chain[k].down.push(seg);
      chain[k + 1].up.push(seg);
      e.segs.push(seg);
    }
  }
  for (let l = 0; l < layers.length; l++) layers[l] ||= [];

  // 4. Crossing reduction with barycenter sweeps, keeping the best ordering seen.
  const order = () => layers.forEach((layer) => layer.forEach((v, i) => (v.pos = i)));
  order();
  const totalCrossings = () => {
    let c = 0;
    for (let l = 0; l + 1 < layers.length; l++) c += crossings(layers[l], layers[l + 1]);
    return c;
  };
  let best = layers.map((l) => [...l]);
  let bestC = totalCrossings();
  for (let iter = 0; iter < 24 && bestC > 0; iter++) {
    const down = iter % 2 === 0;
    const range = down ? [...layers.keys()].slice(1) : [...layers.keys()].reverse().slice(1);
    for (const l of range) {
      const bary = (v) => {
        const nb = down ? v.up.map((s) => s.u) : v.down.map((s) => s.v);
        return nb.length ? nb.reduce((a, n) => a + n.pos, 0) / nb.length : v.pos;
      };
      const keyed = layers[l].map((v) => [bary(v), v.pos, v]);
      keyed.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      layers[l] = keyed.map((k) => k[2]);
      layers[l].forEach((v, i) => (v.pos = i));
    }
    const c = totalCrossings();
    if (c < bestC) {
      bestC = c;
      best = layers.map((l) => [...l]);
    }
  }
  best.forEach((l, i) => (layers[i] = l));
  order();

  // Transpose: swap neighbours whenever that removes crossings.
  const pairCost = (a, b) => {
    let c = 0;
    for (const sa of a.up) for (const sb of b.up) if (sa.u.pos > sb.u.pos) c++;
    for (const sa of a.down) for (const sb of b.down) if (sa.v.pos > sb.v.pos) c++;
    return c;
  };
  for (let pass = 0; pass < 8; pass++) {
    let improved = false;
    for (const layer of layers) {
      for (let i = 0; i + 1 < layer.length; i++) {
        const a = layer[i];
        const b = layer[i + 1];
        if (pairCost(b, a) < pairCost(a, b)) {
          layer[i] = b;
          layer[i + 1] = a;
          b.pos = i;
          a.pos = i + 1;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }

  // 5. Horizontal placement: pull each vertex towards its neighbours, keep spacing.
  const sep = (a, b) => (a.w + b.w) / 2 + (a.dummy && b.dummy ? M.dummyGap : a.dummy || b.dummy ? M.dummyGap + 16 : M.nodeGap);
  for (const layer of layers) {
    let x = 0;
    layer.forEach((v, i) => {
      if (i > 0) x += sep(layer[i - 1], v);
      v.x = x;
    });
    const shift = x / 2;
    layer.forEach((v) => (v.x -= shift));
  }
  const relax = (layer, pick) => {
    if (!layer.length) return;
    const want = layer.map((v) => {
      const nb = pick(v);
      return nb.length ? nb.reduce((a, n) => a + n.x, 0) / nb.length : v.x;
    });
    const seps = layer.slice(1).map((v, i) => sep(layer[i], v));
    spacedFit(want, seps).forEach((x, i) => (layer[i].x = x));
  };
  const ups = (v) => v.up.map((s) => s.u);
  const downs = (v) => v.down.map((s) => s.v);
  const both = (v) => [...ups(v), ...downs(v)];
  for (let iter = 0; iter < 30; iter++) {
    if (iter % 3 === 0) for (let l = 1; l < layers.length; l++) relax(layers[l], ups);
    else if (iter % 3 === 1) for (let l = layers.length - 2; l >= 0; l--) relax(layers[l], downs);
    else for (const layer of layers) relax(layer, both);
  }

  // 6. Routing: ports, lanes and row heights.
  const gaps = [];
  for (let l = 0; l + 1 < layers.length; l++) {
    // One bus per source and edge kind, so enum and many-to-many links get their own trunk.
    const buses = [];
    for (const u of layers[l]) {
      if (!u.down.length) continue;
      const groups = new Map();
      for (const s of u.down) {
        const key = s.edge.rel?.kind === "many-to-many" ? "many" : s.edge.kind;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(s);
      }
      const list = [...groups.values()].map((segs) => ({
        u,
        segs,
        tx: segs.reduce((a, s) => a + s.v.x, 0) / segs.length,
      }));
      list.sort((a, b) => a.tx - b.tx);
      const step = Math.min(34, (u.w - 30) / list.length);
      list.forEach((bus, i) => {
        bus.x = u.x + (i - (list.length - 1) / 2) * step;
        bus.segs.forEach((s) => (s.bus = bus));
        buses.push(bus);
      });
    }
    for (const v of layers[l + 1]) {
      if (v.dummy || !v.up.length) continue;
      // Spread entries from different buses along the top edge; labels go on the outer side.
      const sources = [...new Set(v.up.map((s) => s.bus))].sort((a, b) => a.x - b.x);
      const n = sources.length;
      const step = Math.min(56, (v.w - 24) / Math.max(1, n));
      const portOf = new Map(sources.map((b, i) => [b, i]));
      for (const s of v.up) {
        const i = portOf.get(s.bus);
        s.entryX = v.x + (i - (n - 1) / 2) * step;
        s.side = n > 1 && i < (n - 1) / 2 ? "left" : "right";
        // With three or more entries, alternate label heights so neighbours don't overlap.
        s.labelRow = n > 2 ? i % 2 : 0;
      }
    }
    for (const bus of buses) {
      for (const s of bus.segs) {
        s.exitX = bus.x;
        if (s.entryX === undefined) s.entryX = s.v.x;
      }
      const xs = [bus.x, ...bus.segs.map((s) => s.entryX)];
      bus.lo = Math.min(...xs);
      bus.hi = Math.max(...xs);
      bus.straight = bus.hi - bus.lo < 1;
    }
    const lanesEnd = [];
    for (const bus of buses.filter((b) => !b.straight).sort((a, b) => a.lo - b.lo)) {
      let lane = lanesEnd.findIndex((end) => end < bus.lo - 10);
      if (lane === -1) lane = lanesEnd.length;
      lanesEnd[lane] = bus.hi;
      bus.lane = lane;
    }
    gaps.push({ buses, lanes: lanesEnd.length });
  }

  const layerH = layers.map((layer) => Math.max(0, ...layer.map((v) => v.h)));
  const layerTop = [];
  let y = 0;
  for (let l = 0; l < layers.length; l++) {
    layerTop[l] = y;
    y += layerH[l];
    if (l < gaps.length) {
      const g = gaps[l];
      g.top = y;
      g.h = M.gapBase + Math.max(0, g.lanes - 1) * M.laneStep;
      const first = g.top + (g.h - (g.lanes - 1) * M.laneStep) / 2;
      for (const bus of g.buses) {
        const laneY = bus.straight ? first : first + bus.lane * M.laneStep;
        for (const s of bus.segs) s.laneY = laneY;
      }
      y += g.h;
    }
  }
  let mainBottom = y;

  // 7. Final positions for real nodes and connector polylines.
  let minX = Infinity;
  let maxX = -Infinity;
  for (const [l, layer] of layers.entries()) {
    for (const v of layer) {
      v.top = layerTop[l];
      v.bottom = v.dummy ? layerTop[l] + layerH[l] : v.top + v.h;
      if (v.dummy) continue;
      v.node.x = v.x - v.w / 2;
      v.node.y = v.top;
      minX = Math.min(minX, v.node.x);
      maxX = Math.max(maxX, v.node.x + v.w);
    }
  }
  if (!connected.length) {
    minX = 0;
    maxX = 0;
    mainBottom = -M.gapBase;
  }

  for (const e of flow) {
    const pts = [];
    for (const s of e.segs) {
      pts.push([s.exitX, s.u.bottom], [s.exitX, s.laneY], [s.entryX, s.laneY], [s.entryX, s.v.top]);
    }
    e.rawPoints = pts;
    e.points = simplify(pts);
    const last = e.segs[e.segs.length - 1];
    e.labelSide = e.parentOnTop ? last.side || "right" : "right";
    e.labelRow = e.parentOnTop ? last.labelRow || 0 : 0;
  }

  // Place grid members and route a comb: down the gutter left of each column, then along the
  // gap above each member's row.
  for (const g of grids) {
    const proxy = proxies.find((p) => p.grid === g);
    const base = proxy.rawPoints.slice(0, -1);
    const laneY = base[base.length - 1][1];
    let top = g.y;
    g.rows.forEach((row, r) => {
      row.forEach((n, c) => {
        const cellX = g.x + c * (g.cellW + M.gridColGap);
        n.x = cellX + (g.cellW - n.w) / 2;
        n.y = top;
        const e = g.edges[r * g.cols + c];
        const cx = n.x + n.w / 2;
        let pts;
        if (r === 0) {
          pts = [...base, [cx, laneY], [cx, n.y]];
        } else {
          const gutter = cellX - M.gridColGap / 2;
          const busY = top - M.gridRowGap / 2;
          pts = [...base, [gutter, laneY], [gutter, busY], [cx, busY], [cx, n.y]];
        }
        e.parentOnTop = true;
        e.points = simplify(pts);
        e.labelSide = "right";
        e.labelRow = 0;
      });
      top += g.rowH[r] + M.gridRowGap;
    });
  }
  minX = Math.min(minX, ...allNodes.filter((n) => inGrid.has(n.id)).map((n) => n.x));
  maxX = Math.max(maxX, ...allNodes.filter((n) => inGrid.has(n.id)).map((n) => n.x + n.w));

  // Unconnected boxes go in a wrapped grid below the main diagram.
  const gridW = Math.max(maxX - minX, 1100);
  let gx = minX;
  let gy = mainBottom + M.gapBase;
  let rowH = 0;
  for (const n of isolated) {
    if (gx > minX && gx + n.w > minX + gridW) {
      gx = minX;
      gy += rowH + M.nodeGap / 1.5;
      rowH = 0;
    }
    n.x = gx;
    n.y = gy;
    gx += n.w + M.nodeGap / 1.5;
    rowH = Math.max(rowH, n.h);
  }

  for (const e of selfEdges) {
    const n = byId.get(e.parent);
    const x0 = n.x + n.w;
    const y1 = n.y + Math.min(24, n.h / 4);
    const y2 = n.y + Math.min(n.h - 12, 78);
    e.points = [
      [x0, y1],
      [x0 + 34, y1],
      [x0 + 34, y2],
      [x0, y2],
    ];
    e.self = true;
  }

  // 8. Normalise to a positive origin with a margin.
  const all = allNodes;
  const edgesOut = allEdges;
  const bx0 = Math.min(...all.map((n) => n.x), ...edgesOut.flatMap((e) => e.points.map((p) => p[0])));
  const by0 = Math.min(...all.map((n) => n.y));
  const dx = M.margin - bx0;
  const dy = M.margin - by0;
  for (const n of all) {
    n.x += dx;
    n.y += dy;
  }
  for (const e of edgesOut) e.points = e.points.map(([px, py]) => [px + dx, py + dy]);
  const width = Math.max(...all.map((n) => n.x + n.w), ...edgesOut.flatMap((e) => e.points.map((p) => p[0] + 40))) + M.margin;
  const height = Math.max(...all.map((n) => n.y + n.h)) + M.margin;

  const hidden = graph.hidden || [];
  const edgeById = new Map([...edgesOut, ...hidden].map((e) => [e.id, e]));
  return { nodes: allNodes, edges: edgesOut, hidden, edgeById, linkMode: graph.linkMode, width: Math.ceil(width), height: Math.ceil(height), byId };
}

/** Drops duplicate points and merges collinear runs. */
function simplify(pts) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 0.5 && Math.abs(last[1] - p[1]) < 0.5) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2];
      const b = last;
      const sameX = Math.abs(a[0] - b[0]) < 0.5 && Math.abs(b[0] - p[0]) < 0.5;
      const sameY = Math.abs(a[1] - b[1]) < 0.5 && Math.abs(b[1] - p[1]) < 0.5;
      if (sameX || sameY) {
        out[out.length - 1] = p;
        continue;
      }
    }
    out.push(p);
  }
  return out;
}

/** A simple orthogonal route between two placed boxes, used for links drawn on focus. */
export function quickRoute(e, byId) {
  const a = byId.get(e.parent);
  const b = byId.get(e.child);
  const acx = a.x + a.w / 2;
  const bcx = b.x + b.w / 2;
  if (a === b) return null;
  if (b.y >= a.y + a.h + 10) {
    const my = (a.y + a.h + b.y) / 2;
    return { ...e, parentOnTop: true, points: simplify([[acx, a.y + a.h], [acx, my], [bcx, my], [bcx, b.y]]) };
  }
  if (a.y >= b.y + b.h + 10) {
    const my = (b.y + b.h + a.y) / 2;
    return { ...e, parentOnTop: false, points: simplify([[bcx, b.y + b.h], [bcx, my], [acx, my], [acx, a.y]]) };
  }
  const [left, right] = a.x < b.x ? [a, b] : [b, a];
  const mx = (left.x + left.w + right.x) / 2;
  const y1 = left.y + 22;
  const y2 = right.y + 22;
  return {
    ...e,
    parentOnTop: left === a,
    points: simplify([[left.x + left.w, y1], [mx, y1], [mx, y2], [right.x, y2]]),
  };
}
