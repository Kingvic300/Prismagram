import { buildGraph, layout, quickRoute } from "./layout.js";
import { renderEdge, renderSVG, THEMES } from "./render.js";
import { Editor } from "./editor.js";
import { SAMPLES } from "./samples.js";
import { toMermaid } from "./mermaid.js";
import { createUpdater } from "./updater.js";
import { createDatabaseImport } from "./database.js";
import { createDataClient } from "./client.js";

const tauri = window.__TAURI__;
const invoke = (cmd, args) => tauri.core.invoke(cmd, args);
const $ = (id) => document.getElementById(id);

const DEFAULT_OPTIONS = {
  theme: "classic",
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
  autoUpdate: true,
  editorWidth: 440,
  editorHidden: false,
  mode: "diagram",
};

const state = {
  path: null,
  dirty: false,
  mtime: 0,
  schema: null,
  diagram: null,
  view: { x: 0, y: 0, k: 1 },
  needsFit: true,
  focus: null,
  opts: loadOptions(),
};

function loadOptions() {
  try {
    return { ...DEFAULT_OPTIONS, ...JSON.parse(localStorage.getItem("prismagram.options") || "{}") };
  } catch {
    return { ...DEFAULT_OPTIONS };
  }
}

function saveOptions() {
  try {
    localStorage.setItem("prismagram.options", JSON.stringify(state.opts));
  } catch {
    /* storage unavailable: settings last for this session only */
  }
}

// ---------------------------------------------------------------- editor + parsing

const editor = new Editor({
  textarea: $("source"),
  highlight: $("highlight"),
  gutter: $("gutter"),
  onChange: () => {
    setDirty(true);
    scheduleParse();
  },
});

let parseTimer = 0;
let parseSeq = 0;
function scheduleParse(delay = 160) {
  clearTimeout(parseTimer);
  parseTimer = setTimeout(parseNow, delay);
}

async function parseNow() {
  const seq = ++parseSeq;
  const source = editor.value;
  let schema;
  try {
    schema = await invoke("parse_schema", { source });
  } catch (err) {
    toast(`Parser failed: ${err}`, true);
    return;
  }
  if (seq !== parseSeq) return; // a newer edit is already being parsed
  state.schema = schema;
  editor.setDiagnostics(schema.diagnostics);
  updateStatus();
  redraw();
}

function updateStatus() {
  const s = state.schema;
  const errors = s.diagnostics.filter((d) => d.severity === "error").length;
  const warnings = s.diagnostics.length - errors;
  const el = $("statusProblems");
  el.className = "status-item diagram-only " + (errors ? "bad" : warnings ? "warn" : "ok");
  el.textContent = errors || warnings
    ? [errors && `${errors} error${errors > 1 ? "s" : ""}`, warnings && `${warnings} warning${warnings > 1 ? "s" : ""}`].filter(Boolean).join(" · ")
    : "No problems";

  const models = s.models.filter((m) => m.kind !== "type").length;
  const parts = [`${models} model${models === 1 ? "" : "s"}`];
  const types = s.models.length - models;
  if (types) parts.push(`${types} type${types === 1 ? "" : "s"}`);
  parts.push(`${s.enums.length} enum${s.enums.length === 1 ? "" : "s"}`);
  parts.push(`${s.relations.length} relation${s.relations.length === 1 ? "" : "s"}`);
  $("statusCounts").textContent = parts.join(" · ");

  const badge = $("providerBadge");
  badge.hidden = !s.provider;
  badge.textContent = s.provider || "";

  const problems = $("problems");
  problems.innerHTML = s.diagnostics
    .map(
      (d) =>
        `<button data-line="${d.line}"><span class="sev ${d.severity}"></span><span class="ln">${d.line}</span><span>${escapeHtml(d.message)}</span></button>`,
    )
    .join("");
  problems.hidden = !s.diagnostics.length;

  $("modelList").innerHTML = [...s.models, ...s.enums].map((m) => `<option value="${escapeHtml(m.name)}">`).join("");
}

$("problems").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-line]");
  if (btn) editor.goToLine(Number(btn.dataset.line));
});
$("statusProblems").addEventListener("click", () => {
  const first = state.schema?.diagnostics[0];
  if (first) {
    showEditor(true);
    editor.goToLine(first.line);
  }
});

// ---------------------------------------------------------------- diagram

const stage = $("stage");
const viewport = $("viewport");
const pane = $("canvasPane");

function theme() {
  return THEMES[state.opts.theme] || THEMES.classic;
}

function redraw() {
  const s = state.schema;
  const hasContent = s && (s.models.length || s.enums.length);
  $("emptyState").hidden = Boolean(hasContent) || editor.value.trim().length > 0;
  if (!hasContent) {
    viewport.innerHTML = "";
    state.diagram = null;
    return;
  }
  const graph = buildGraph(s, state.opts);
  state.diagram = layout(graph);
  viewport.innerHTML = renderSVG(state.diagram, theme(), state.opts);
  const hiddenCount = state.diagram.hidden.length;
  $("statusView").hidden = !hiddenCount;
  $("statusView").textContent = `${state.diagram.linkMode === "tree" ? "Tree view" : "Hubs collapsed"} · ${hiddenCount} link${hiddenCount === 1 ? "" : "s"} shown on click`;
  applyTheme();
  if (state.focus && !state.diagram.byId.has(state.focus)) state.focus = null;
  applyFocus();
  // A hidden canvas has no size to fit to: fit when Diagram mode is shown.
  if (state.needsFit && !$("workspace").hidden) {
    state.needsFit = false;
    fit(false);
  }
}

function applyTheme() {
  const t = theme();
  pane.style.setProperty("--canvas", t.canvas);
  pane.style.setProperty("--grid", t.grid);
}

function applyView(animate = false) {
  const { x, y, k } = state.view;
  viewport.classList.toggle("animate", animate);
  viewport.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
  const size = 22 * k;
  stage.style.backgroundSize = `${size}px ${size}px`;
  stage.style.backgroundPosition = `${x}px ${y}px`;
  $("zoomLabel").textContent = `${Math.round(k * 100)}%`;
}

function fit(animate = true) {
  const d = state.diagram;
  if (!d) return;
  const { clientWidth: cw, clientHeight: ch } = stage;
  const k = Math.min(1.5, Math.max(0.08, Math.min((cw - 40) / d.width, (ch - 90) / d.height)));
  state.view = { k, x: (cw - d.width * k) / 2, y: Math.max(20, (ch - d.height * k) / 2) };
  applyView(animate);
}

function zoomAt(factor, cx = stage.clientWidth / 2, cy = stage.clientHeight / 2, animate = false) {
  const v = state.view;
  const k = Math.min(4, Math.max(0.08, v.k * factor));
  const f = k / v.k;
  state.view = { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f };
  applyView(animate);
}

function centerOn(id) {
  const n = state.diagram?.byId.get(id);
  if (!n) return false;
  const k = Math.max(state.view.k, 0.9);
  state.view = {
    k,
    x: stage.clientWidth / 2 - (n.x + n.w / 2) * k,
    y: stage.clientHeight / 2 - (n.y + n.h / 2) * k,
  };
  applyView(true);
  state.focus = id;
  applyFocus();
  return true;
}

function applyFocus() {
  const id = state.focus;
  stage.classList.toggle("focused", Boolean(id));
  viewport.querySelectorAll(".hl").forEach((el) => el.classList.remove("hl"));
  viewport.querySelector("#focus-links")?.remove();
  if (!id) return;
  const related = new Set([id]);
  // Draw the links that are hidden in the overview, on top of everything else.
  const extra = state.diagram.hidden
    .filter((e) => e.parent === id || e.child === id)
    .map((e) => quickRoute(e, state.diagram.byId))
    .filter(Boolean);
  if (extra.length) {
    const svg = viewport.querySelector("svg");
    const markup = extra.map((e) => renderEdge(e, theme(), state.opts, true)).join("");
    // Above the other links, below the boxes.
    svg.lastElementChild.insertAdjacentHTML("beforebegin", `<g id="focus-links">${markup}</g>`);
  }
  viewport.querySelectorAll(".edge").forEach((el) => {
    if (el.dataset.a === id || el.dataset.b === id) {
      el.classList.add("hl");
      related.add(el.dataset.a);
      related.add(el.dataset.b);
    }
  });
  viewport.querySelectorAll(".node").forEach((el) => el.classList.toggle("hl", related.has(el.dataset.id)));
}

// Pan with drag, zoom with the wheel.
let drag = null;
stage.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 && e.button !== 1) return;
  drag = { x: e.clientX, y: e.clientY, vx: state.view.x, vy: state.view.y, moved: false };
  stage.setPointerCapture(e.pointerId);
});
stage.addEventListener("pointermove", (e) => {
  if (drag) {
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    stage.classList.add("panning");
    hideTooltip();
    state.view.x = drag.vx + dx;
    state.view.y = drag.vy + dy;
    applyView();
    return;
  }
  hover(e);
});
stage.addEventListener("pointerup", (e) => {
  const wasClick = drag && !drag.moved;
  drag = null;
  stage.classList.remove("panning");
  if (!wasClick) return;
  const node = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.closest?.(".node"))?.closest(".node");
  state.focus = node && node.dataset.id !== state.focus ? node.dataset.id : null;
  applyFocus();
});
stage.addEventListener("dblclick", (e) => {
  const text = e.target.closest("text[data-line]");
  const node = e.target.closest(".node");
  if (!node) return;
  const line = text ? Number(text.dataset.line) : state.diagram.byId.get(node.dataset.id)?.line;
  if (line) {
    showEditor(true);
    editor.goToLine(line);
  }
});
stage.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const rect = stage.getBoundingClientRect();
    if (e.ctrlKey || Math.abs(e.deltaY) >= 40 || e.deltaMode === 1) {
      zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018)), e.clientX - rect.left, e.clientY - rect.top);
    } else {
      // Small deltas usually come from a touchpad: pan instead.
      state.view.x -= e.deltaX;
      state.view.y -= e.deltaY;
      applyView();
    }
  },
  { passive: false },
);

// Tooltips for relations and documented models.
const tooltip = $("tooltip");
function hover(e) {
  const edgeEl = e.target.closest?.(".edge");
  const nodeEl = e.target.closest?.(".node");
  viewport.querySelectorAll(".edge.hover").forEach((el) => el !== edgeEl && el.classList.remove("hover"));
  let html = "";
  if (edgeEl) {
    edgeEl.classList.add("hover");
    html = describeEdge(state.diagram.edgeById.get(edgeEl.dataset.edge));
  } else if (nodeEl) {
    const n = state.diagram.byId.get(nodeEl.dataset.id);
    const notes = [];
    if (n?.doc) notes.push(escapeHtml(n.doc));
    if (n?.hiddenLinks) {
      notes.push(`${n.hiddenLinks} more link${n.hiddenLinks === 1 ? " is" : "s are"} hidden to keep the diagram readable. Click the model to show them.`);
    }
    if (notes.length) html = `<b>${escapeHtml(n.id)}</b>\n${notes.join("\n\n")}`;
  }
  if (!html) return hideTooltip();
  const rect = pane.getBoundingClientRect();
  tooltip.innerHTML = html;
  tooltip.hidden = false;
  const x = Math.min(e.clientX - rect.left + 14, rect.width - tooltip.offsetWidth - 10);
  const y = Math.min(e.clientY - rect.top + 16, rect.height - tooltip.offsetHeight - 10);
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}
function hideTooltip() {
  tooltip.hidden = true;
}
stage.addEventListener("pointerleave", hideTooltip);

function describeEdge(e) {
  if (!e) return "";
  if (e.kind === "enum") return `<b>${escapeHtml(e.parent)}</b> uses enum <b>${escapeHtml(e.child)}</b>`;
  if (e.kind === "composite") return `<b>${escapeHtml(e.parent)}</b> embeds type <b>${escapeHtml(e.child)}</b>`;
  const r = e.rel;
  const kind = r.kind.replace(/-/g, " ");
  const left = `${r.parent}${r.parentField ? "." + r.parentField : ""}`;
  const right = `${r.child}${r.childField ? "." + r.childField : ""}`;
  return `<b>${escapeHtml(kind)}</b>${r.name ? ` · "${escapeHtml(r.name)}"` : ""}\n${escapeHtml(left)}  ${r.parentMultiplicity} ── ${r.childMultiplicity}  ${escapeHtml(right)}`;
}

// ---------------------------------------------------------------- files

function baseName(path) {
  return path ? path.split(/[\\/]/).pop() : "untitled.prisma";
}

function setDirty(dirty) {
  state.dirty = dirty;
  $("dirtyDot").hidden = !dirty;
  updateTitle();
}

function updateTitle() {
  const name = baseName(state.path);
  $("fileName").textContent = name;
  $("fileChip").title = state.path || "Not saved yet";
  const title = `${state.dirty ? "• " : ""}${name} — Prismagram`;
  document.title = title;
  tauri?.window?.getCurrentWindow().setTitle(title).catch(() => {});
}

async function confirmDiscard() {
  if (!state.dirty || !editor.value.trim()) return true;
  return tauri.dialog.ask("You have unsaved changes in the editor. Discard them?", {
    title: "Unsaved changes",
    kind: "warning",
    okLabel: "Discard",
    cancelLabel: "Keep editing",
  });
}

async function loadPath(path) {
  try {
    const text = await invoke("read_text_file", { path });
    state.path = path;
    state.mtime = await invoke("file_modified", { path }).catch(() => 0);
    editor.value = text;
    setDirty(false);
    state.needsFit = true;
    state.focus = null;
    $("statusWatch").hidden = false;
    await parseNow();
  } catch (err) {
    toast(String(err), true);
  }
}

async function openFile() {
  if (!(await confirmDiscard())) return;
  const path = await tauri.dialog.open({
    multiple: false,
    directory: false,
    filters: [
      { name: "Prisma schema", extensions: ["prisma"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (path) await loadPath(path);
}

async function saveFile(saveAs = false) {
  let path = state.path;
  if (!path || saveAs) {
    path = await tauri.dialog.save({
      defaultPath: baseName(state.path) || "schema.prisma",
      filters: [{ name: "Prisma schema", extensions: ["prisma"] }],
    });
    if (!path) return;
  }
  try {
    await invoke("write_text_file", { path, contents: editor.value });
    state.path = path;
    state.mtime = await invoke("file_modified", { path }).catch(() => Date.now());
    $("statusWatch").hidden = false;
    setDirty(false);
    toast(`Saved ${baseName(path)}`);
  } catch (err) {
    toast(String(err), true);
  }
}

async function loadSample(key) {
  if (!(await confirmDiscard())) return;
  state.path = null;
  state.focus = null;
  state.needsFit = true;
  $("statusWatch").hidden = true;
  editor.value = SAMPLES[key];
  setDirty(false);
  await parseNow();
}

async function showImported({ schema, source, tables, views, enums }) {
  state.path = null;
  state.focus = null;
  state.needsFit = true;
  $("statusWatch").hidden = true;
  editor.value = schema;
  // Not saved anywhere yet: Save asks where to put it.
  setDirty(true);
  await parseNow();
  const counts = [[tables, "table"], [views, "view"], [enums, "enum"]]
    .filter(([n]) => n)
    .map(([n, word]) => `${n} ${word}${n === 1 ? "" : "s"}`);
  toast(`Imported ${counts.join(", ")} from ${source}`);
}

const databaseImport = createDatabaseImport({
  dialog: $("dbDialog"),
  invoke,
  onImported: showImported,
});

async function openDatabase() {
  if (await confirmDiscard()) databaseImport.open();
}

// ---------------------------------------------------------------- data mode

const dataClient = createDataClient({
  dialog: $("connDialog"),
  invoke,
  tauri,
  toast,
  onStatus: (text) => ($("statusData").textContent = text),
  // "Diagram" on a PostgreSQL schema: import it like the Supabase dialog does, then show it.
  onDiagram: async ({ url, password, schemas }) => {
    if (!(await confirmDiscard())) return;
    toast(`Reading ${schemas.join(", ")}…`);
    try {
      const result = await invoke("pull_database", { url, password, schemas });
      setMode("diagram");
      await showImported(result);
    } catch (err) {
      toast(String(err), true);
    }
  },
});

function setMode(mode) {
  state.opts.mode = mode === "data" ? "data" : "diagram";
  const data = state.opts.mode === "data";
  document.body.classList.toggle("mode-data", data);
  $("workspace").hidden = data;
  $("dataspace").hidden = !data;
  $("modeSwitch")
    .querySelectorAll("button")
    .forEach((b) => b.classList.toggle("active", b.dataset.mode === state.opts.mode));
  hideTooltip();
  setSettings(false);
  saveOptions();
  // The canvas had no size while hidden.
  if (!data && state.needsFit) redraw();
  else if (!data && state.diagram) applyView();
}

$("modeSwitch").addEventListener("click", (e) => {
  const b = e.target.closest("[data-mode]");
  if (b) setMode(b.dataset.mode);
});
$("btnNewConnection").addEventListener("click", () => dataClient.openDialog());

// Reload the file when it changes on disk (e.g. edited in VS Code), unless there are local edits.
setInterval(async () => {
  if (!state.path || state.dirty) return;
  try {
    const mtime = await invoke("file_modified", { path: state.path });
    if (mtime && mtime !== state.mtime) {
      state.mtime = mtime;
      const text = await invoke("read_text_file", { path: state.path });
      if (text !== editor.value) {
        editor.value = text;
        setDirty(false);
        await parseNow();
        toast("Reloaded — file changed on disk");
      }
    }
  } catch {
    /* file moved or deleted: keep what is in the editor */
  }
}, 1500);

// ---------------------------------------------------------------- export

function exportBaseName() {
  return baseName(state.path).replace(/\.prisma$/i, "") || "diagram";
}

function exportSVG() {
  return renderSVG(state.diagram, theme(), state.opts, { background: true });
}

// Image tools and AI chats reject very large images (Groq: ~33 MP), so the default PNG is
// capped; "full resolution" ignores the cap.
const PNG_MAX_PIXELS = 30e6;
const PNG_MAX_SIDE = 8000;

function pngScale(full) {
  const { width, height } = state.diagram;
  if (full) return 2;
  return Math.min(2, Math.sqrt(PNG_MAX_PIXELS / (width * height)), PNG_MAX_SIDE / Math.max(width, height));
}

async function rasterize(svg, scale = 2) {
  const img = new Image();
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(state.diagram.width * scale);
  canvas.height = Math.round(state.diagram.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, state.diagram.width, state.diagram.height);
  return canvas.toDataURL("image/png").split(",")[1];
}

async function doExport(kind) {
  if (!state.diagram) return toast("Nothing to export yet", true);
  try {
    const svg = exportSVG();
    if (kind === "copy") {
      await navigator.clipboard.writeText(svg);
      return toast("SVG markup copied");
    }
    if (kind === "copy-mermaid") {
      await navigator.clipboard.writeText(toMermaid(state.schema));
      return toast("Mermaid diagram copied — paste it into any chat or markdown file");
    }
    const ext = kind.startsWith("png") ? "png" : kind === "mermaid" ? "mmd" : "svg";
    const path = await tauri.dialog.save({
      defaultPath: `${exportBaseName()}.${ext}`,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (!path) return;
    if (ext === "png") {
      const scale = pngScale(kind === "png-full");
      await invoke("write_binary_file", { path, base64Data: await rasterize(svg, scale) });
      const w = Math.round(state.diagram.width * scale);
      const h = Math.round(state.diagram.height * scale);
      return toast(`Exported ${baseName(path)} (${w} × ${h})`);
    }
    const contents = ext === "mmd" ? toMermaid(state.schema) : `<?xml version="1.0" encoding="UTF-8"?>\n${svg}\n`;
    await invoke("write_text_file", { path, contents });
    toast(`Exported ${baseName(path)}`);
  } catch (err) {
    toast(`Export failed: ${err}`, true);
  }
}

// ---------------------------------------------------------------- chrome

function toggleMenu(id, show) {
  const menu = $(id);
  const open = show ?? menu.hidden;
  document.querySelectorAll(".menu").forEach((m) => (m.hidden = true));
  menu.hidden = !open;
}

$("btnSamples").addEventListener("click", (e) => {
  e.stopPropagation();
  toggleMenu("menuSamples");
});
$("btnExport").addEventListener("click", (e) => {
  e.stopPropagation();
  toggleMenu("menuExport");
});
$("menuSamples").addEventListener("click", (e) => {
  const b = e.target.closest("[data-sample]");
  if (b) loadSample(b.dataset.sample);
});
$("menuExport").addEventListener("click", (e) => {
  const b = e.target.closest("[data-export]");
  if (b) doExport(b.dataset.export);
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".menu-wrap")) document.querySelectorAll(".menu").forEach((m) => (m.hidden = true));
  if (!e.target.closest("#settings") && !e.target.closest("#btnSettings")) setSettings(false);
});

$("btnOpen").addEventListener("click", openFile);
$("emptyOpen").addEventListener("click", openFile);
$("emptySample").addEventListener("click", () => loadSample("zoo"));
$("btnDatabase").addEventListener("click", openDatabase);
$("emptyDatabase").addEventListener("click", openDatabase);
$("btnSave").addEventListener("click", () => saveFile());
$("zoomIn").addEventListener("click", () => zoomAt(1.2, undefined, undefined, true));
$("zoomOut").addEventListener("click", () => zoomAt(1 / 1.2, undefined, undefined, true));
$("zoomFit").addEventListener("click", () => fit());
$("zoomLabel").addEventListener("click", () => zoomAt(1 / state.view.k, undefined, undefined, true));
$("btnToggleEditor").addEventListener("click", () => showEditor(state.opts.editorHidden));

$("search").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const q = e.target.value.trim().toLowerCase();
  const n = state.diagram?.nodes.find((n) => n.id.toLowerCase() === q) || state.diagram?.nodes.find((n) => n.id.toLowerCase().includes(q));
  if (!n || !centerOn(n.id)) toast(`No model matches “${e.target.value}”`, true);
});

function showEditor(show) {
  state.opts.editorHidden = !show;
  $("workspace").classList.toggle("editor-hidden", !show);
  saveOptions();
}

// Resizable editor pane.
const splitter = $("splitter");
splitter.addEventListener("pointerdown", (e) => {
  splitter.setPointerCapture(e.pointerId);
  splitter.classList.add("active");
  const move = (ev) => {
    state.opts.editorWidth = Math.max(260, Math.min(window.innerWidth - 360, ev.clientX));
    document.documentElement.style.setProperty("--editor-width", `${state.opts.editorWidth}px`);
  };
  const up = () => {
    splitter.classList.remove("active");
    splitter.removeEventListener("pointermove", move);
    splitter.removeEventListener("pointerup", up);
    saveOptions();
  };
  splitter.addEventListener("pointermove", move);
  splitter.addEventListener("pointerup", up);
});

// Settings panel.
function setSettings(open) {
  $("settings").hidden = !open;
  $("btnSettings").classList.toggle("active", open);
}
$("btnSettings").addEventListener("click", () => setSettings($("settings").hidden));

function renderSettings() {
  $("themeSwatches").innerHTML = Object.entries(THEMES)
    .map(
      ([key, t]) => `<div><button class="swatch${key === state.opts.theme ? " active" : ""}" data-theme="${key}" title="${t.title}" style="background:${t.canvas}">
        <i style="background:${t.fill};border-color:${t.stroke};--h:${t.header}"></i></button><span class="swatch-name">${t.title}</span></div>`,
    )
    .join("");
  document.querySelectorAll(".swatch i").forEach((i) => {
    i.style.backgroundImage = `linear-gradient(${i.style.getPropertyValue("--h")} 0 8px, transparent 8px)`;
  });
  document.querySelectorAll(".segmented[data-opt]").forEach((seg) => {
    seg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", state.opts[seg.dataset.opt] === b.dataset.value));
  });
  document.querySelectorAll("input[data-opt]").forEach((input) => (input.checked = Boolean(state.opts[input.dataset.opt])));
}

$("settings").addEventListener("click", (e) => {
  const swatch = e.target.closest("[data-theme]");
  const seg = e.target.closest(".segmented button");
  if (swatch) state.opts.theme = swatch.dataset.theme;
  else if (seg) state.opts[seg.parentElement.dataset.opt] = seg.dataset.value;
  else return;
  saveOptions();
  renderSettings();
  redraw();
});
$("settings").addEventListener("change", (e) => {
  const key = e.target.dataset.opt;
  if (!key) return;
  state.opts[key] = e.target.checked;
  saveOptions();
  if (key === "autoUpdate") updater.setAuto(state.opts.autoUpdate);
  else redraw();
});

// Updates.
const updater = createUpdater({
  banner: $("updateBanner"),
  onStatus: (text) => {
    const el = $("updateStatus");
    el.hidden = !text;
    el.textContent = text || "";
  },
});
$("btnCheckUpdates").addEventListener("click", () => updater.check({ manual: true }));
$("btnCheckUpdates").hidden = !updater.available;

// Drag and drop from the file manager.
if (tauri?.event) {
  const overlay = $("dropOverlay");
  tauri.event.listen("tauri://drag-enter", () => (overlay.hidden = false));
  tauri.event.listen("tauri://drag-leave", () => (overlay.hidden = true));
  tauri.event.listen("tauri://drag-drop", async (event) => {
    overlay.hidden = true;
    const path = event.payload?.paths?.[0];
    if (!path) return;
    if (!/\.prisma$/i.test(path)) return toast("That isn't a .prisma file", true);
    if (await confirmDiscard()) loadPath(path);
  });
}

// Keyboard shortcuts.
document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && (e.key === "1" || e.key === "2")) {
    e.preventDefault();
    return setMode(e.key === "1" ? "diagram" : "data");
  }
  if (state.opts.mode === "data") {
    if (dataClient.handleKey(e)) e.preventDefault();
    return;
  }
  if (e.key === "Escape") {
    state.focus = null;
    applyFocus();
    setSettings(false);
    toggleMenu("menuExport", false);
    return;
  }
  if (!mod) return;
  const key = e.key.toLowerCase();
  const actions = {
    o: () => openFile(),
    s: () => saveFile(e.shiftKey),
    e: () => doExport(e.shiftKey ? "png" : "svg"),
    b: () => showEditor(state.opts.editorHidden),
    0: () => fit(),
    "=": () => zoomAt(1.2, undefined, undefined, true),
    "+": () => zoomAt(1.2, undefined, undefined, true),
    "-": () => zoomAt(1 / 1.2, undefined, undefined, true),
    f: () => $("search").focus(),
  };
  if (actions[key]) {
    e.preventDefault();
    actions[key]();
  }
});

// ---------------------------------------------------------------- misc

let toastTimer = 0;
function toast(message, error = false) {
  const el = $("toast");
  el.textContent = message;
  el.className = "toast" + (error ? " error" : "");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), error ? 4200 : 2400);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

window.addEventListener("resize", () => state.diagram && applyView());

async function init() {
  document.documentElement.style.setProperty("--editor-width", `${state.opts.editorWidth}px`);
  $("workspace").classList.toggle("editor-hidden", state.opts.editorHidden);
  setMode(state.opts.mode);
  renderSettings();
  applyTheme();
  applyView();
  updateTitle();
  if (!tauri) {
    toast("Prismagram must run inside its desktop shell", true);
    return;
  }
  // Wait for fonts so text measurement matches what is drawn.
  await document.fonts?.ready;
  tauri.app
    ?.getVersion()
    .then((v) => ($("appVersion").textContent = `Version ${v}`))
    .catch(() => {});
  updater.setAuto(state.opts.autoUpdate);
  const launch = await invoke("launch_file").catch(() => null);
  if (launch) {
    setMode("diagram");
    await loadPath(launch);
  }
  else await parseNow();
}

init();
