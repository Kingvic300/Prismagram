// Renders a laid-out diagram as a standalone SVG string.
// The same markup is shown on screen and exported, so it only uses inline attributes.

import { FONT_FAMILY, METRICS, fonts, textWidth } from "./layout.js";

export const THEMES = {
  classic: {
    title: "Classic",
    canvas: "#f4f5f4",
    grid: "#dde2dd",
    fill: "#ffffff",
    header: "#d5e8d4",
    headerText: "#111111",
    stroke: "#2b2b2b",
    divider: "#2b2b2b",
    name: "#1a1a1a",
    type: "#1a1a1a",
    default: "#1a1a1a",
    meta: "#5f6b7a",
    stereo: "#3f4a3f",
    line: "#2b2b2b",
    label: "#3b4452",
    shadow: false,
  },
  mint: {
    title: "Mint",
    canvas: "#f6f9fb",
    grid: "#dfe7ee",
    fill: "#ffffff",
    header: "#ccfbf1",
    headerText: "#0f3d3a",
    stroke: "#9fb4c4",
    divider: "#d5e1ea",
    name: "#0f172a",
    type: "#0f766e",
    default: "#7c3aed",
    meta: "#64748b",
    stereo: "#0f766e",
    line: "#5b7488",
    label: "#475569",
    shadow: true,
  },
  paper: {
    title: "Paper",
    canvas: "#f8f4ec",
    grid: "#e7dfd0",
    fill: "#fffdf8",
    header: "#fde3c3",
    headerText: "#3b2414",
    stroke: "#4a3426",
    divider: "#cdb9a2",
    name: "#2e211a",
    type: "#9a4a12",
    default: "#5b6b2c",
    meta: "#8a7766",
    stereo: "#9a4a12",
    line: "#4a3426",
    label: "#5d4637",
    shadow: false,
  },
  midnight: {
    title: "Midnight",
    canvas: "#0d1117",
    grid: "#1b222c",
    fill: "#161b22",
    header: "#1f3a5f",
    headerText: "#e6edf3",
    stroke: "#36414f",
    divider: "#2a333f",
    name: "#e6edf3",
    type: "#7ee787",
    default: "#d2a8ff",
    meta: "#8b949e",
    stereo: "#79c0ff",
    line: "#58a6ff",
    label: "#9aa7b4",
    shadow: true,
  },
  blueprint: {
    title: "Blueprint",
    canvas: "#0f2b4c",
    grid: "#1a3d66",
    fill: "#103154",
    header: "#1a4677",
    headerText: "#ffffff",
    stroke: "#8fb8ef",
    divider: "#4f7fb8",
    name: "#eaf2ff",
    type: "#9cc7ff",
    default: "#ffd38a",
    meta: "#87a6cc",
    stereo: "#bcd6ff",
    line: "#cfe2ff",
    label: "#bcd6ff",
    shadow: false,
  },
};

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const r1 = (n) => Math.round(n * 10) / 10;

/** Rounded orthogonal polyline. */
function pathFor(points, radius) {
  let d = `M${r1(points[0][0])},${r1(points[0][1])}`;
  for (let i = 1; i < points.length; i++) {
    const [x, y] = points[i];
    const next = points[i + 1];
    if (!next || radius <= 0) {
      d += ` L${r1(x)},${r1(y)}`;
      continue;
    }
    const [px, py] = points[i - 1];
    const inLen = Math.hypot(x - px, y - py);
    const outLen = Math.hypot(next[0] - x, next[1] - y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    const ax = x - ((x - px) / inLen) * r;
    const ay = y - ((y - py) / inLen) * r;
    const bx = x + ((next[0] - x) / outLen) * r;
    const by = y + ((next[1] - y) / outLen) * r;
    d += ` L${r1(ax)},${r1(ay)} Q${r1(x)},${r1(y)} ${r1(bx)},${r1(by)}`;
  }
  return d;
}

/** Marker with its tip at `p`, pointing along the unit vector `dir`. */
function marker(kind, p, dir, theme) {
  const [x, y] = p;
  const [dx, dy] = dir;
  const nx = -dy;
  const ny = dx;
  const at = (back, side) => `${r1(x - dx * back + nx * side)},${r1(y - dy * back + ny * side)}`;
  const stroke = `stroke="${theme.line}" stroke-width="1.6" stroke-linejoin="round"`;
  switch (kind) {
    case "triangle":
      return `<polygon points="${at(0, 0)} ${at(14, 8)} ${at(14, -8)}" fill="${theme.canvas}" ${stroke}/>`;
    case "diamond":
      return `<polygon points="${at(0, 0)} ${at(9, 6)} ${at(18, 0)} ${at(9, -6)}" fill="${theme.canvas}" ${stroke}/>`;
    case "diamond-filled":
      return `<polygon points="${at(0, 0)} ${at(9, 6)} ${at(18, 0)} ${at(9, -6)}" fill="${theme.line}" ${stroke}/>`;
    case "arrow":
      return `<polyline points="${at(11, 6)} ${at(0, 0)} ${at(11, -6)}" fill="none" ${stroke}/>`;
    default:
      return "";
  }
}

const markerDepth = { triangle: 14, diamond: 18, "diamond-filled": 18, arrow: 4 };

function unit(a, b) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
}

function label(text, x, y, anchor, theme) {
  return `<text x="${r1(x)}" y="${r1(y)}" text-anchor="${anchor}" dominant-baseline="middle" font-family="${esc(FONT_FAMILY)}" font-size="${METRICS.labelSize}" font-weight="500" fill="${theme.label}" stroke="${theme.canvas}" stroke-width="3.5" stroke-linejoin="round" paint-order="stroke">${esc(text)}</text>`;
}

export function renderEdge(e, theme, opts, interactive) {
  const pts = e.points;
  if (!pts || pts.length < 2) return "";
  const dashed = e.kind === "enum";
  const radius = opts.rounded ? 8 : 3;
  let parentEnd;
  let childEnd;
  if (e.self) {
    parentEnd = { p: pts[0], dir: unit(pts[1], pts[0]) };
    childEnd = { p: pts[pts.length - 1], dir: unit(pts[pts.length - 2], pts[pts.length - 1]) };
  } else {
    const first = { p: pts[0], dir: unit(pts[1], pts[0]) };
    const last = { p: pts[pts.length - 1], dir: unit(pts[pts.length - 2], pts[pts.length - 1]) };
    parentEnd = e.parentOnTop ? first : last;
    childEnd = e.parentOnTop ? last : first;
  }

  const parentMarker =
    e.kind === "composite" ? "diamond-filled" : e.kind === "enum" ? "none" : e.rel?.kind === "many-to-many" ? "none" : opts.marker;
  const childMarker = e.kind === "enum" ? "arrow" : "none";

  let out = `<g class="edge" data-edge="${e.id}" data-a="${esc(e.parent)}" data-b="${esc(e.child)}">`;
  const d = pathFor(pts, radius);
  out += `<path class="line" d="${d}" fill="none" stroke="${theme.line}" stroke-width="1.6"${dashed ? ' stroke-dasharray="6 5"' : ""} stroke-linejoin="round"/>`;
  out += marker(parentMarker, parentEnd.p, parentEnd.dir, theme);
  out += marker(childMarker, childEnd.p, childEnd.dir, theme);

  if (opts.showLabels && e.kind === "relation" && e.rel) {
    const r = e.rel;
    const place = (end, depth, text, side = "right", row = 0) => {
      if (e.self) return label(text, end.p[0] + 42, end.p[1], "start", theme);
      // Sit beside the line, just outside the box (and past any marker).
      const back = depth + 12 + row * 15;
      const x = end.p[0] - end.dir[0] * back;
      const y = end.p[1] - end.dir[1] * back;
      return side === "left" ? label(text, x - 7, y, "end", theme) : label(text, x + 7, y, "start", theme);
    };
    out += place(parentEnd, markerDepth[parentMarker] || 0, r.parentMultiplicity);
    const childText = [r.parentField, r.childMultiplicity].filter(Boolean).join("  ");
    out += place(childEnd, 0, childText, e.labelSide, e.labelRow);
  }
  if (interactive) out += `<path class="hit" d="${d}" fill="none" stroke="transparent" stroke-width="12"/>`;
  return out + "</g>";
}

function headerPath(x, y, w, h, r) {
  if (r <= 0) return `M${x},${y} H${x + w} V${y + h} H${x} Z`;
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

function renderNode(n, theme, opts) {
  const { padX, lineH, sectionPad, emptySection, stereoH, titleH } = METRICS;
  const r = opts.rounded ? 8 : 0;
  const x = r1(n.x);
  const y = r1(n.y);
  const { w, h, headH } = n;
  let out = `<g class="node" data-id="${esc(n.id)}">`;
  const shadow = theme.shadow ? ' filter="url(#pg-shadow)"' : "";
  out += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${theme.fill}"${shadow}/>`;
  out += `<path d="${headerPath(x, y, w, headH, r)}" fill="${theme.header}"/>`;

  const cx = x + w / 2;
  let titleY = y + titleH / 2 + 1;
  if (n.stereotype) {
    out += `<text x="${cx}" y="${y + 16}" text-anchor="middle" dominant-baseline="middle" font-family="${esc(FONT_FAMILY)}" font-size="${METRICS.stereoSize}" font-style="italic" fill="${theme.stereo}">${esc(n.stereotype)}</text>`;
    titleY += stereoH - 1;
  }
  out += `<text x="${cx}" y="${titleY}" text-anchor="middle" dominant-baseline="middle" font-family="${esc(FONT_FAMILY)}" font-size="${METRICS.titleSize}" font-weight="700" fill="${theme.headerText}">${esc(n.id)}</text>`;

  if (n.badge) {
    const pw = textWidth(n.badge, fonts.label) + 16;
    const px = x + w - pw - 8;
    out += `<rect x="${r1(px)}" y="${y + 9}" width="${r1(pw)}" height="20" rx="10" fill="${theme.line}" fill-opacity="0.14" stroke="${theme.line}" stroke-opacity="0.5"/>`;
    out += `<text x="${r1(px + pw / 2)}" y="${y + 19.5}" text-anchor="middle" dominant-baseline="middle" font-family="${esc(FONT_FAMILY)}" font-size="${METRICS.labelSize}" font-weight="500" fill="${theme.headerText}">${esc(n.badge)}</text>`;
  }

  let sy = y + headH;
  for (const rows of n.sections) {
    out += `<line x1="${x}" y1="${sy}" x2="${x + w}" y2="${sy}" stroke="${theme.stroke}" stroke-width="1.2"/>`;
    if (!rows.length) {
      sy += emptySection;
      continue;
    }
    let ty = sy + sectionPad + lineH / 2 + 1;
    for (const row of rows) {
      const tspans = row.spans.map((s) => `<tspan fill="${theme[s.r] || theme.name}">${esc(s.t)}</tspan>`).join("");
      const lineAttr = row.field ? ` data-line="${row.field.line}"` : "";
      out += `<text x="${x + padX}" y="${r1(ty)}" dominant-baseline="middle" font-family="${esc(FONT_FAMILY)}" font-size="${METRICS.memberSize}" font-style="italic" xml:space="preserve"${lineAttr}>${tspans}</text>`;
      ty += lineH;
    }
    sy += rows.length * lineH + sectionPad * 2;
  }
  out += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="none" stroke="${theme.stroke}" stroke-width="1.3"/>`;
  return out + "</g>";
}

/** Returns SVG markup for the whole diagram. `background` paints the canvas colour (for export). */
export function renderSVG(diagram, theme, opts, { background = false } = {}) {
  const { width, height } = diagram;
  let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${esc(FONT_FAMILY)}">`;
  out += `<defs><filter id="pg-shadow" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="3" stdDeviation="5" flood-color="#0f172a" flood-opacity="${theme.canvas.startsWith("#f") ? 0.1 : 0.4}"/></filter></defs>`;
  if (background) out += `<rect width="100%" height="100%" fill="${theme.canvas}"/>`;
  out += "<g>";
  for (const e of diagram.edges) out += renderEdge(e, theme, opts, !background);
  out += "</g><g>";
  for (const n of diagram.nodes) out += renderNode(n, theme, opts);
  out += "</g></svg>";
  return out;
}

