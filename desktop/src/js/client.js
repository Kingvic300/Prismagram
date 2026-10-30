// The Data mode: a database browser in the style of MongoDB Compass. Rust keeps the live
// connections (client.rs); this module draws the sidebar of connections, databases and
// tables, the tabs, and the Documents / Schema / Indexes / Query views of each tab.
// Saved connections are listed from local storage without their passwords; the full connection
// string and password are kept in the system keychain (secrets.rs) and read back to reconnect.

import { inferSchema, parseShell, scalarText, toCSV, toShell, typeOf } from "./values.js";
import { withPassword, withoutPassword } from "./database.js";
import {
  createIndexSql,
  deleteSql,
  deleteWhereSql,
  dropIndexSql,
  insertSql,
  mongoCall,
  rowTemplate,
  updateSql,
  updateWhereSql,
} from "./writes.js";

const SAVED_KEY = "prismagram.connections";
const MAX_SAVED = 12;
/** Fields shown per document before "Show N more fields". */
const FIELDS_SHOWN = 25;
/** Characters of a string put in the page; the rest is left out of the DOM. */
const STRING_PREVIEW = 2000;
/** Array items rendered when an array is expanded. */
const ITEMS_SHOWN = 200;
const PAGE_SIZES = [20, 50, 100];
const SAMPLE_SIZE = 200;

const PLACEHOLDER = /\[YOUR-PASSWORD\]|<db_password>|<password>/;

const ICONS = {
  folder: '<svg viewBox="0 0 24 24" class="ico"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>',
  view: '<svg viewBox="0 0 24 24" class="ico"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" /><circle cx="12" cy="12" r="2.5" /></svg>',
  db: '<svg viewBox="0 0 24 24" class="ico"><ellipse cx="12" cy="5.5" rx="8" ry="2.5" /><path d="M4 5.5v13c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-13 M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5" /></svg>',
  caret: '<svg viewBox="0 0 24 24" class="ico caret-ico"><path d="M9 6l6 6-6 6" /></svg>',
  query: '<svg viewBox="0 0 24 24" class="ico"><path d="M8 9l-4 3 4 3 M16 9l4 3-4 3 M13.5 6l-3 12" /></svg>',
  diagram: '<svg viewBox="0 0 24 24" class="ico"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /><path d="M10 6.5h4a2 2 0 0 1 2 2V14" /></svg>',
  refresh: '<svg viewBox="0 0 24 24" class="ico"><path d="M20 11a8 8 0 1 0-2.3 5.7 M20 5v6h-6" /></svg>',
  unplug: '<svg viewBox="0 0 24 24" class="ico"><path d="M6 6l12 12 M18 6L6 18" /></svg>',
  plug: '<svg viewBox="0 0 24 24" class="ico"><path d="M9 3v5 M15 3v5 M6 8h12v3a6 6 0 0 1-12 0z M12 17v4" /></svg>',
  copy: '<svg viewBox="0 0 24 24" class="ico"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>',
  prev: '<svg viewBox="0 0 24 24" class="ico"><path d="M15 6l-6 6 6 6" /></svg>',
  next: '<svg viewBox="0 0 24 24" class="ico"><path d="M9 6l6 6-6 6" /></svg>',
  list: '<svg viewBox="0 0 24 24" class="ico"><path d="M4 6h16 M4 12h16 M4 18h16" /></svg>',
  json: '<svg viewBox="0 0 24 24" class="ico"><path d="M8 4c-2 0-3 1-3 3v2c0 1.5-1 3-2 3 1 0 2 1.5 2 3v2c0 2 1 3 3 3 M16 4c2 0 3 1 3 3v2c0 1.5 1 3 2 3-1 0-2 1.5-2 3v2c0 2-1 3-3 3" /></svg>',
  table: '<svg viewBox="0 0 24 24" class="ico"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18 M3 15h18 M9 4v16" /></svg>',
  close: '<svg viewBox="0 0 24 24" class="ico"><path d="M7 7l10 10 M17 7L7 17" /></svg>',
  edit: '<svg viewBox="0 0 24 24" class="ico"><path d="M4 20h4L19 9l-4-4L4 16z M14 6l4 4" /></svg>',
  clone: '<svg viewBox="0 0 24 24" class="ico"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2 M14 11v6 M11 14h6" /></svg>',
  trash: '<svg viewBox="0 0 24 24" class="ico"><path d="M4 7h16 M10 11v6 M14 11v6 M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12 M9 7V4h6v3" /></svg>',
  plus: '<svg viewBox="0 0 24 24" class="ico"><path d="M12 5v14 M5 12h14" /></svg>',
};

export function createDataClient({ dialog, invoke, tauri, toast, onDiagram, onStatus, prefs = {}, onLiveChange, onConnectionsChange }) {
  const $ = (id) => document.getElementById(id);
  const tree = $("dbTree");
  const tabBar = $("dbTabs");
  const view = $("dbView");
  const welcome = $("dbWelcome");
  const search = $("dbSearch");

  /** Remembered connections, newest first: { url (password replaced), name, kind }. */
  let saved = loadSaved();
  /** Open connections by saved url: the Rust id, databases, and the password for this session. */
  const live = new Map();
  /** Connections being opened, by saved url. */
  const connecting = new Set();
  let tabs = [];
  let activeId = null;
  let nextTab = 1;

  // ------------------------------------------------------------ connections

  function loadSaved() {
    try {
      const list = JSON.parse(localStorage.getItem(SAVED_KEY) || "[]");
      return Array.isArray(list) ? list.filter((c) => typeof c?.url === "string") : [];
    } catch {
      return [];
    }
  }

  function storeSaved() {
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify(saved));
    } catch {
      /* storage unavailable: connections last for this session only */
    }
  }

  function savedKey(url) {
    const line = url.trim().replace(/^[A-Za-z_][\w]*\s*=\s*/, "");
    return withoutPassword(line.replace(/^["']|["']$/g, ""));
  }

  async function connect(url, password, name) {
    const key = savedKey(url);
    connecting.add(key);
    renderTree();
    try {
      const result = await invoke("client_connect", { url, password });
      const old = live.get(key);
      if (old) await invoke("client_disconnect", { id: old.id }).catch(() => {});
      name = name?.trim() || result.source;
      const conn = {
        ...result,
        name,
        key,
        url,
        password,
        open: true,
        expanded: new Set(result.defaultDatabase ? [result.defaultDatabase] : []),
      };
      live.set(key, conn);
      const before = saved;
      saved = [{ url: key, name, kind: result.kind }, ...saved.filter((s) => s.url !== key)].slice(0, MAX_SAVED);
      storeSaved();
      before.filter((s) => !saved.some((k) => k.url === s.url)).forEach(forgetSecret);
      invoke("secret_save", { account: key, url, password }).catch((err) =>
        toast(`Connected, but the password could not be saved, so you'll type it again next time. ${err}`, true),
      );
      // Tabs left from an earlier session of this connection use the new id.
      tabs.filter((t) => t.conn === key).forEach((t) => fetchActive(t));
      if (result.kind === "mongodb" && result.defaultDatabase) await loadCollections(conn, result.defaultDatabase);
      toast(`Connected to ${name}`);
      return conn;
    } finally {
      connecting.delete(key);
      renderTree();
      renderTabs();
      updateStatus();
    }
  }

  async function disconnect(key) {
    const conn = live.get(key);
    if (!conn) return;
    live.delete(key);
    await invoke("client_disconnect", { id: conn.id }).catch(() => {});
    tabs = tabs.filter((t) => t.conn !== key);
    if (!tabs.some((t) => t.id === activeId)) activeId = tabs.at(-1)?.id ?? null;
    renderAll();
  }

  async function refreshConnection(conn) {
    try {
      const databases = await invoke("client_databases", { id: conn.id });
      const known = new Map(conn.databases.map((d) => [d.name, d]));
      conn.databases = databases.map((d) => ({ ...d, collections: d.collections ?? null }));
      if (conn.kind === "mongodb") {
        await Promise.all(
          conn.databases.filter((d) => conn.expanded.has(d.name) || known.get(d.name)?.collections).map((d) => loadCollections(conn, d.name, false)),
        );
      }
      renderTree();
    } catch (err) {
      toast(String(err), true);
    }
  }

  async function loadCollections(conn, name, render = true) {
    const db = conn.databases.find((d) => d.name === name);
    if (!db) return;
    db.loading = true;
    if (render) renderTree();
    try {
      db.collections = await invoke("client_collections", { id: conn.id, database: name });
      db.error = null;
    } catch (err) {
      db.error = String(err);
    }
    db.loading = false;
    if (render) renderTree();
  }

  // Connection dialog.
  const nameInput = $("connName");
  const urlInput = $("connUrl");
  const passwordInput = $("connPassword");
  const dialogError = $("connError");
  const submit = $("connSubmit");
  const copyButton = $("connCopy");
  let attempt = 0;
  /** While editing: the saved entry and what the keychain held for it. Null for a new connection. */
  let editing = null;

  function openDialog(url = "", error = "", name = "", password = "", edit = null) {
    editing = edit;
    $("connTitle").textContent = edit ? "Edit connection" : "New connection";
    copyButton.hidden = !edit;
    copyButton.textContent = "Copy connection string";
    nameInput.value = name;
    urlInput.value = url;
    passwordInput.value = password;
    dialogError.textContent = error;
    dialogError.hidden = !error;
    setBusy(false);
    dialog.showModal();
    (!name ? nameInput : url ? passwordInput : urlInput).focus();
  }

  function setBusy(busy) {
    [nameInput, urlInput, passwordInput, submit].forEach((el) => (el.disabled = busy));
    submit.textContent = busy ? (editing ? "Saving…" : "Connecting…") : editing ? "Save" : "Connect";
  }

  async function editConnection(entry) {
    const secret = await invoke("secret_load", { account: entry.url }).catch(() => null);
    openDialog(secret?.url ?? entry.url, "", entry.name, secret?.password ?? "", { entry, secret });
  }

  /** A new name alone is saved as is; a new string or password is tried first, then replaces the old. */
  async function saveEdit({ entry, secret }, name, url, password) {
    name = name.trim();
    if (url === (secret?.url ?? entry.url) && password === (secret?.password ?? "")) {
      entry.name = name;
      const conn = live.get(entry.url);
      if (conn) conn.name = name;
      storeSaved();
      renderAll();
      return toast(`Saved ${name}`);
    }
    const conn = await connect(url, password, name);
    if (conn.key !== entry.url) {
      if (live.has(entry.url)) await disconnect(entry.url);
      saved = saved.filter((s) => s.url !== entry.url);
      storeSaved();
      forgetSecret(entry);
      renderAll();
    }
  }

  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(withPassword(urlInput.value, passwordInput.value));
      copyButton.textContent = "Copied";
    } catch (err) {
      copyButton.textContent = "Couldn't copy";
    }
    setTimeout(() => (copyButton.textContent = "Copy connection string"), 1500);
  });

  dialog.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const current = ++attempt;
    dialogError.hidden = true;
    const missing = !nameInput.value.trim() ? [nameInput, "Name this connection so you can find it later."] : !urlInput.value.trim() ? [urlInput, "Paste a connection string."] : null;
    nameInput.toggleAttribute("aria-invalid", missing?.[0] === nameInput);
    urlInput.toggleAttribute("aria-invalid", missing?.[0] === urlInput);
    if (missing) {
      dialogError.textContent = missing[1];
      dialogError.hidden = false;
      return missing[0].focus();
    }
    setBusy(true);
    try {
      if (editing) await saveEdit(editing, nameInput.value, urlInput.value, passwordInput.value);
      else await connect(urlInput.value, passwordInput.value, nameInput.value);
      if (current !== attempt) return;
      dialog.close();
    } catch (err) {
      if (current !== attempt) return;
      dialogError.textContent = String(err);
      dialogError.hidden = false;
      setBusy(false);
    }
  });
  $("connCancel").addEventListener("click", () => {
    attempt++;
    dialog.close();
  });
  dialog.addEventListener("cancel", () => attempt++);

  /** Reconnects a remembered connection, asking for the password when the string needs one. */
  function forgetSecret(entry) {
    return invoke("secret_forget", { account: entry.url }).catch(() => {});
  }

  async function reconnect(entry) {
    const secret = await invoke("secret_load", { account: entry.url }).catch(() => null);
    if (!secret && PLACEHOLDER.test(entry.url)) return openDialog(entry.url, "", entry.name);
    try {
      await connect(secret?.url ?? entry.url, secret?.password ?? "", entry.name);
    } catch (err) {
      openDialog(entry.url, String(err), entry.name);
    }
  }

  // ------------------------------------------------------------ sidebar

  function renderTree() {
    $("dbConnCount").textContent = live.size;
    const q = search.value.trim().toLowerCase();
    tree.innerHTML = saved
      .map((entry, i) => {
        const conn = live.get(entry.url);
        const busy = connecting.has(entry.url);
        const kind = entry.kind === "mongodb" ? "MongoDB" : "PostgreSQL";
        const actions = conn
          ? [
              iconButton("new-query", ICONS.query, conn.kind === "mongodb" ? "New aggregation" : "New SQL query"),
              iconButton("refresh", ICONS.refresh, "Refresh"),
              iconButton("edit-conn", ICONS.edit, "Edit connection"),
              iconButton("disconnect", ICONS.unplug, "Disconnect"),
            ]
          : [
              iconButton("connect", ICONS.plug, "Connect"),
              iconButton("edit-conn", ICONS.edit, "Edit connection"),
              iconButton("forget", ICONS.close, "Forget this connection"),
            ];
        let html = `<div class="conn${conn ? " on" : ""}" data-c="${i}">
          <div class="tree-row conn-row" data-act="${conn ? "toggle-conn" : "connect"}" title="${esc(entry.url)}">
            ${conn ? `<span class="caret${conn.open ? " open" : ""}">${ICONS.caret}</span>` : '<span class="caret"></span>'}
            <span class="dot${busy ? " busy" : ""}"></span>
            <span class="name">${esc(entry.name)}</span>
            <span class="kind">${busy ? "Connecting…" : kind}</span>
            <span class="row-actions">${actions.join("")}</span>
          </div>`;
        if (conn?.open) html += conn.databases.map((db) => databaseHtml(conn, db, q)).join("");
        return html + "</div>";
      })
      .join("");
    if (!saved.length) tree.innerHTML = `<p class="tree-empty">No connections yet.</p>`;
    renderRecent();
    onConnectionsChange?.();
  }

  function databaseHtml(conn, db, q) {
    const items = (db.collections || []).filter((c) => !q || c.name.toLowerCase().includes(q));
    if (q && !items.length && !db.name.toLowerCase().includes(q)) return "";
    const open = conn.expanded.has(db.name) || (q && items.length);
    const active = activeTab();
    let html = `<div class="tree-row db-row" data-act="toggle-db" data-db="${esc(db.name)}">
      <span class="caret${open ? " open" : ""}">${ICONS.caret}</span>${ICONS.db}<span class="name">${esc(db.name)}</span>
      ${conn.kind === "postgres" ? `<span class="row-actions">${iconButton("diagram-db", ICONS.diagram, `Diagram the ${db.name} schema`)}</span>` : ""}
    </div>`;
    if (!open) return html;
    if (db.loading) return html + skeletonHtml("tree", 3);
    if (db.error) return html + `<div class="tree-note error">${esc(db.error)}</div>`;
    if (!items.length) return html + `<div class="tree-note">${q ? "No matches" : "Empty"}</div>`;
    return (
      html +
      items
        .map((c) => {
          const isActive = active && active.conn === conn.key && active.db === db.name && active.coll === c.name;
          const count = typeof c.count === "number" && c.count >= 0 ? `<span class="count">${compact(c.count)}</span>` : "";
          return `<div class="tree-row coll-row${isActive ? " active" : ""}" data-act="open" data-db="${esc(db.name)}" data-coll="${esc(c.name)}" data-kind="${esc(c.kind)}" title="${esc(c.kind)}">
            ${c.kind.includes("view") ? ICONS.view : ICONS.folder}<span class="name">${esc(c.name)}</span>${count}
          </div>`;
        })
        .join("")
    );
  }

  function renderRecent() {
    const recent = saved.filter((s) => !live.has(s.url)).slice(0, 5);
    $("dbRecent").innerHTML = recent.length
      ? `<span class="field-label">Recent</span>` +
        recent
          .map(
            (s) =>
              `<button class="btn ghost recent" data-url="${esc(s.url)}">${ICONS.db}<span>${esc(s.name)}</span><small>${s.kind === "mongodb" ? "MongoDB" : "PostgreSQL"}</small></button>`,
          )
          .join("")
      : "";
  }

  $("dbRecent").addEventListener("click", (e) => {
    const b = e.target.closest("[data-url]");
    const entry = b && saved.find((s) => s.url === b.dataset.url);
    if (entry) reconnect(entry);
  });

  tree.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-act]");
    const connEl = e.target.closest(".conn");
    if (!el || !connEl) return;
    const entry = saved[Number(connEl.dataset.c)];
    const conn = live.get(entry?.url);
    const db = el.closest("[data-db]")?.dataset.db;
    switch (el.dataset.act) {
      case "connect":
        return reconnect(entry);
      case "edit-conn":
        return editConnection(entry);
      case "forget":
        forgetSecret(entry);
        saved = saved.filter((s) => s !== entry);
        storeSaved();
        return renderTree();
      case "toggle-conn":
        conn.open = !conn.open;
        return renderTree();
      case "disconnect":
        return disconnect(entry.url);
      case "refresh":
        return refreshConnection(conn);
      case "new-query":
        return openTab(conn, conn.defaultDatabase || conn.databases[0]?.name || "public", null, null);
      case "diagram-db":
        return onDiagram({ url: conn.url, password: conn.password, schemas: [db] });
      case "toggle-db": {
        if (conn.expanded.has(db)) conn.expanded.delete(db);
        else {
          conn.expanded.add(db);
          const entry = conn.databases.find((d) => d.name === db);
          if (entry && !entry.collections && !entry.loading) return loadCollections(conn, db);
        }
        return renderTree();
      }
      case "open":
        return openTab(conn, db, el.dataset.coll, el.dataset.kind);
    }
  });

  search.addEventListener("input", renderTree);

  // ------------------------------------------------------------ tabs

  function activeTab() {
    return tabs.find((t) => t.id === activeId) || null;
  }

  function connOf(tab) {
    return live.get(tab.conn) || null;
  }

  function openTab(conn, db, coll, kind) {
    let tab = coll && tabs.find((t) => t.conn === conn.key && t.db === db && t.coll === coll);
    if (!tab) {
      const mongo = conn.kind === "mongodb";
      tab = {
        id: nextTab++,
        conn: conn.key,
        db,
        coll,
        kind,
        view: coll ? "documents" : "query",
        filter: "",
        sort: "",
        project: "",
        showOptions: false,
        skip: 0,
        limit: PAGE_SIZES.includes(prefs.pageSize) ? prefs.pageSize : PAGE_SIZES[0],
        layout: prefs.layout || "list",
        page: null,
        error: null,
        loading: false,
        seq: 0,
        moreFields: new Set(),
        fields: null,
        sample: null,
        indexes: null,
        query: mongo
          ? coll
            ? "[\n  { $match: {} },\n  { $sort: { _id: -1 } }\n]"
            : "[\n  { $match: {} }\n]"
          : coll
            ? `select *\nfrom ${sqlName(coll)}\nlimit 100;`
            : "select now();",
        result: null,
      };
      tabs.push(tab);
    }
    activeId = tab.id;
    renderAll();
    if (!tab.page && !tab.result) fetchActive(tab);
  }

  function closeTab(id) {
    const i = tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    tabs.splice(i, 1);
    if (activeId === id) activeId = (tabs[i] || tabs[i - 1])?.id ?? null;
    renderAll();
  }

  function renderTabs() {
    tabBar.innerHTML = tabs
      .map((t) => {
        const conn = connOf(t);
        const label = t.coll || (conn?.kind === "mongodb" ? "Aggregation" : "SQL query");
        return `<div class="db-tab${t.id === activeId ? " active" : ""}${conn ? "" : " offline"}" data-tab="${t.id}" title="${esc(`${t.db} › ${label}`)}">
          ${t.coll ? (String(t.kind).includes("view") ? ICONS.view : ICONS.folder) : ICONS.query}
          <span class="name">${esc(label)}</span><small>${esc(t.db)}</small>
          <button class="tab-x" data-close="${t.id}" title="Close (Ctrl+W)">${ICONS.close}</button>
        </div>`;
      })
      .join("");
  }

  tabBar.addEventListener("click", (e) => {
    const x = e.target.closest("[data-close]");
    if (x) return closeTab(Number(x.dataset.close));
    const t = e.target.closest("[data-tab]");
    if (t) {
      activeId = Number(t.dataset.tab);
      renderAll();
    }
  });
  tabBar.addEventListener("auxclick", (e) => {
    const t = e.target.closest("[data-tab]");
    if (t && e.button === 1) closeTab(Number(t.dataset.tab));
  });

  // ------------------------------------------------------------ tab views

  function renderAll() {
    renderTree();
    renderTabs();
    renderView();
    updateStatus();
  }

  function renderView() {
    const tab = activeTab();
    welcome.hidden = Boolean(tab);
    view.hidden = !tab;
    if (!tab) {
      view.innerHTML = "";
      return;
    }
    const conn = connOf(tab);
    const pg = isPostgres(tab);
    view.innerHTML = `
      <div class="db-head">
        <div class="crumbs">
          <span>${esc(conn?.name || tab.conn)}</span><span class="sep">›</span>
          <span>${esc(tab.db)}</span><span class="sep">›</span>
          <b>${esc(tab.coll || (pg ? "SQL query" : "Aggregation"))}</b>
        </div>
        ${pg && conn ? `<button class="btn" data-act="diagram">${ICONS.diagram} Diagram ${esc(tab.db)}</button>` : ""}
      </div>
      <nav class="db-subtabs">${subtabsHtml(tab, pg)}</nav>
      <div class="db-pane">${conn ? paneHtml(tab, pg) : `<div class="db-message">This connection is closed. Connect it again from the sidebar.</div>`}</div>`;
    if (conn) renderPaneContent(tab);
  }

  function isPostgres(tab) {
    return !/^mongodb/.test(tab.conn);
  }

  function subtabsHtml(tab, pg) {
    const views = tab.coll
      ? [
          ["documents", pg ? "Rows" : "Documents", tab.page?.total],
          ["schema", "Schema"],
          ["indexes", "Indexes", tab.indexes?.length],
          ["query", pg ? "SQL" : "Aggregations"],
        ]
      : [["query", pg ? "SQL" : "Aggregations"]];
    return views
      .map(
        ([key, label, count]) =>
          `<button data-view="${key}" class="${tab.view === key ? "active" : ""}">${label}${
            count !== undefined && count !== null ? ` <span class="pill">${compact(count)}</span>` : ""
          }</button>`,
      )
      .join("");
  }

  function paneHtml(tab, pg) {
    if (tab.view === "documents") {
      return `
        <form class="query-bar" data-form="find">
          <div class="qb-main">
            <span class="qb-label">${pg ? "WHERE" : "Filter"}</span>
            <input class="qb-input" name="filter" value="${esc(tab.filter)}" spellcheck="false" autocomplete="off"
              placeholder="${pg ? "email = 'ann@example.com' and status = 'active'" : "Type a query: { field: 'value' }"}" />
            <button type="button" class="btn ghost small" data-act="options">Options ${tab.showOptions ? "▾" : "▸"}</button>
            <button type="button" class="btn small" data-act="reset">Reset</button>
            <button type="submit" class="btn primary small">Find</button>
          </div>
          <div class="qb-options"${tab.showOptions ? "" : " hidden"}>
            <label><span class="qb-label">${pg ? "ORDER BY" : "Sort"}</span><input class="qb-input" name="sort" value="${esc(tab.sort)}" spellcheck="false"
              placeholder="${pg ? "created_at desc" : "{ createdAt: -1 }"}" /></label>
            ${pg ? "" : `<label><span class="qb-label">Project</span><input class="qb-input" name="project" value="${esc(tab.project)}" spellcheck="false" placeholder="{ email: 1, name: 1 }" /></label>`}
          </div>
        </form>
        <div class="doc-toolbar">
          ${
            writable(tab)
              ? `<button class="btn primary small" data-act="insert">${ICONS.plus} ${pg ? "Insert row" : "Insert document"}</button>`
              : ""
          }
          <div class="menu-wrap">
            <button class="btn small" data-act="export-menu">${ICONS.copy} Export</button>
            <div class="menu" hidden>
              <button data-export="copy">Copy page as JSON</button>
              <button data-export="json">Save page as JSON <small>.json</small></button>
              <button data-export="csv">Save page as CSV <small>.csv</small></button>
            </div>
          </div>
          ${
            writable(tab)
              ? `<button class="btn small" data-act="update-many" title="Change everything that matches the filter">${ICONS.edit} Update</button>
                 <button class="btn small danger" data-act="delete-many" title="Delete everything that matches the filter">${ICONS.trash} Delete</button>`
              : ""
          }
          <div class="spacer"></div>
          <select class="input small-select" data-act="limit" title="Rows per page">
            ${PAGE_SIZES.map((n) => `<option value="${n}"${n === tab.limit ? " selected" : ""}>${n}</option>`).join("")}
          </select>
          <span class="range" data-range></span>
          <button class="btn ghost small live-toggle${autoRefresh ? " on" : ""}" data-act="live" title="Read the data again every ${liveMs / 1000} s">Live</button>
          ${iconButton("refresh-docs", ICONS.refresh, "Refresh")}
          ${iconButton("prev", ICONS.prev, "Previous page")}
          ${iconButton("next", ICONS.next, "Next page")}
          <div class="segmented layout-switch">
            ${[["list", ICONS.list, "List"], ["json", ICONS.json, "JSON"], ["table", ICONS.table, "Table"]]
              .map(([k, icon, title]) => `<button data-layout="${k}" class="${tab.layout === k ? "active" : ""}" title="${title}">${icon}</button>`)
              .join("")}
          </div>
        </div>
        <div class="doc-results" data-results></div>`;
    }
    if (tab.view === "query") {
      return `
        <div class="query-editor">
          <textarea class="sql" data-query spellcheck="false" autocapitalize="off" autocomplete="off">${esc(tab.query)}</textarea>
          <div class="query-actions">
            <button class="btn primary small" data-act="run">Run <small>Ctrl+Enter</small></button>
            <span class="note">${
              pg
                ? `Runs on ${esc(tab.db)}. Statements that change data are applied right away.`
                : `An aggregation pipeline on ${esc(tab.coll || "a collection")}. Up to ${PAGE_SIZES.at(-1)} documents are shown.`
            }</span>
          </div>
        </div>
        <div class="query-results" data-results></div>`;
    }
    return `<div class="db-scroll" data-results></div>`;
  }

  function renderPaneContent(tab) {
    if (tab.view === "documents") return renderDocuments(tab);
    if (tab.view === "schema") return renderSchema(tab);
    if (tab.view === "indexes") return renderIndexes(tab);
    return renderQuery(tab);
  }

  function results() {
    return view.querySelector("[data-results]");
  }

  // ------------------------------------------------------------ loading

  function fetchActive(tab) {
    if (!connOf(tab)) return;
    if (tab.view === "documents") return fetchDocuments(tab);
    if (tab.view === "schema") return fetchSchema(tab);
    if (tab.view === "indexes") return fetchIndexes(tab);
  }

  /** Runs `work` for `tab`, ignoring the answer if a newer request was made meanwhile. */
  async function load(tab, work, apply) {
    const seq = ++tab.seq;
    tab.loading = true;
    tab.error = null;
    if (tab === activeTab()) renderPaneContent(tab);
    try {
      const value = await work(connOf(tab));
      if (seq !== tab.seq) return;
      apply(value);
    } catch (err) {
      if (seq !== tab.seq) return;
      tab.error = String(err?.message || err);
    }
    tab.loading = false;
    // Only the results and counts change, so the query being typed keeps its cursor.
    if (tab === activeTab()) {
      view.querySelector(".db-subtabs").innerHTML = subtabsHtml(tab, isPostgres(tab));
      renderPaneContent(tab);
      updateStatus();
    }
  }

  /** `applied` is the filter, sort and projection the page was asked for. */
  function findRequest(tab, conn, applied) {
    const mongo = conn.kind === "mongodb";
    return {
      database: tab.db,
      collection: tab.coll,
      filter: mongo ? shellJSON(applied.filter, "Filter") : applied.filter,
      sort: mongo ? shellJSON(applied.sort, "Sort") : applied.sort,
      project: mongo ? shellJSON(applied.project, "Project") : "",
      skip: tab.skip,
      limit: tab.limit,
    };
  }

  function fetchDocuments(tab) {
    const applied = { filter: tab.filter, sort: tab.sort, project: tab.project };
    return load(
      tab,
      (conn) => invoke("client_find", { id: conn.id, request: findRequest(tab, conn, applied) }),
      (page) => {
        tab.page = page;
        tab.applied = applied;
        tab.pageFilter = applied.filter;
        tab.moreFields = new Set();
      },
    );
  }

  function fetchSchema(tab) {
    return load(
      tab,
      (conn) =>
        conn.kind === "postgres"
          ? invoke("client_columns", { id: conn.id, database: tab.db, collection: tab.coll })
          : invoke("client_aggregate", {
              id: conn.id,
              database: tab.db,
              collection: tab.coll,
              pipeline: JSON.stringify([{ $sample: { size: SAMPLE_SIZE } }]),
              limit: SAMPLE_SIZE,
            }),
      (value) => {
        if (Array.isArray(value)) tab.fields = value;
        else tab.sample = { count: value.rows.length, fields: inferSchema(value.rows) };
      },
    );
  }

  function fetchIndexes(tab) {
    return load(
      tab,
      (conn) => invoke("client_indexes", { id: conn.id, database: tab.db, collection: tab.coll }),
      (indexes) => (tab.indexes = indexes),
    );
  }

  function runQuery(tab) {
    return load(
      tab,
      (conn) =>
        conn.kind === "postgres"
          ? invoke("client_sql", { id: conn.id, database: tab.db, sql: tab.query })
          : invoke("client_aggregate", {
              id: conn.id,
              database: tab.db,
              collection: tab.coll || requireCollection(),
              pipeline: shellJSON(tab.query, "Pipeline") || "[]",
              limit: PAGE_SIZES.at(-1),
            }),
      (result) => {
        tab.result = result;
        tab.resultFields = new Set();
      },
    );
  }

  function requireCollection() {
    throw new Error("Open a collection from the sidebar to run a pipeline on it.");
  }

  function shellJSON(text, what) {
    try {
      const value = parseShell(text);
      return value === undefined ? "" : JSON.stringify(value);
    } catch (err) {
      throw new Error(`${what}: ${err.message}`);
    }
  }

  // ------------------------------------------------------------ documents

  function renderDocuments(tab) {
    const box = results();
    const range = view.querySelector("[data-range]");
    const page = tab.page;
    const rows = page?.rows || [];
    if (range) range.textContent = tab.error ? "" : rangeText(tab);
    const prev = view.querySelector('[data-act="prev"]');
    const next = view.querySelector('[data-act="next"]');
    if (prev) prev.disabled = tab.skip === 0 || tab.loading;
    if (next) next.disabled = tab.loading || !hasNext(tab);
    if (tab.error) return (box.innerHTML = errorHtml(tab.error));
    if (!page) return (box.innerHTML = skeletonHtml(tab.layout === "table" ? "table" : "cards"));
    box.classList.toggle("loading", tab.loading);
    if (!rows.length) return (box.innerHTML = `<div class="db-message">${tab.filter ? "No rows match this filter." : "This is empty."}</div>`);
    const types = columnTypes(page);
    if (tab.layout === "table") box.innerHTML = tableHtml(rows, page.columns, types, tab.skip, writable(tab));
    else if (tab.layout === "json") box.innerHTML = rows.map((r, i) => jsonCard(r, i)).join("");
    else box.innerHTML = rows.map((r, i) => docCard(r, i, types, tab.moreFields)).join("");
  }

  function hasNext(tab) {
    const page = tab.page;
    if (!page) return false;
    if (page.total !== null && page.total !== undefined && !page.estimated) return tab.skip + page.rows.length < page.total;
    return page.rows.length === tab.limit;
  }

  function rangeText(tab) {
    const page = tab.page;
    if (!page) return tab.loading ? "Loading…" : "";
    const n = page.rows.length;
    if (!n) return tab.skip ? `Nothing after ${tab.skip.toLocaleString()}` : "0 results";
    const total = page.total === null || page.total === undefined ? "many" : `${page.estimated ? "about " : ""}${page.total.toLocaleString()}`;
    return `${(tab.skip + 1).toLocaleString()} – ${(tab.skip + n).toLocaleString()} of ${total}`;
  }

  function columnTypes(page) {
    return new Map((page.columns || []).map((c) => [c.name, c.type]));
  }

  function docCard(row, i, types, moreFields, src = "page") {
    const entries = Object.entries(row);
    const all = moreFields.has(i);
    const shown = all ? entries : entries.slice(0, FIELDS_SHOWN);
    const hidden = entries.length - shown.length;
    return `<div class="doc-card" data-row="${i}" data-src="${src}">
      ${docActions(src)}
      ${shown.map(([k, v]) => fieldHtml(k, v, [i, k], types.get(k))).join("")}
      ${hidden > 0 ? `<button class="more-fields" data-act="more-fields">▾ Show ${hidden} more field${hidden === 1 ? "" : "s"}</button>` : ""}
      ${all && entries.length > FIELDS_SHOWN ? `<button class="more-fields" data-act="fewer-fields">▴ Show fewer fields</button>` : ""}
    </div>`;
  }

  function fieldHtml(key, value, path, pgType) {
    const type = typeOf(value);
    const nested = (type === "Object" && Object.keys(value).length) || (type === "Array" && value.length);
    if (nested) {
      const label = type === "Array" ? `Array (${value.length})` : "Object";
      return `<div class="kv nest" data-path="${esc(JSON.stringify(path))}">
        <div class="kv-line" data-act="expand"><span class="caret">${ICONS.caret}</span><span class="k">${esc(key)}</span><span class="colon">:</span><span class="v muted">${label}</span></div>
        <div class="kids"></div>
      </div>`;
    }
    return `<div class="kv"><div class="kv-line"><span class="k">${esc(key)}</span><span class="colon">:</span>${valueHtml(value, pgType)}</div></div>`;
  }

  function childrenHtml(value, path) {
    const entries = Array.isArray(value) ? value.slice(0, ITEMS_SHOWN).map((v, i) => [i, v]) : Object.entries(value);
    let html = entries.map(([k, v]) => fieldHtml(String(k), v, [...path, k])).join("");
    if (Array.isArray(value) && value.length > ITEMS_SHOWN) {
      html += `<div class="tree-note">… ${value.length - ITEMS_SHOWN} more items. Use the JSON view to see all.</div>`;
    }
    return html;
  }

  function valueHtml(value, pgType, compactText = false) {
    let type = typeOf(value);
    let text = scalarText(value);
    // PostgreSQL sends dates, UUIDs and bytea as plain strings: color them by column type.
    if (typeof value === "string" && pgType) {
      const kind = pgKindOf(pgType);
      if (kind) {
        type = kind;
        text = value;
      }
    }
    if (type === "Array") text = compactText ? `[${value.length}]` : "[]";
    else if (type === "Object") text = compactText ? "{…}" : "{}";
    const cls =
      {
        ObjectId: "oid",
        UUID: "oid",
        String: "str",
        Int: "num",
        Double: "num",
        Long: "num",
        Decimal128: "num",
        Boolean: "bool",
        Null: "null",
        Date: "date",
        Array: "muted",
        Object: "muted",
      }[type] || "other";
    let extra = "";
    if (text.length > STRING_PREVIEW) {
      extra = ` <span class="muted">(${(text.length - STRING_PREVIEW).toLocaleString()} more characters)</span>`;
      text = text.slice(0, STRING_PREVIEW) + "…";
    }
    return `<span class="v ${cls}" data-act="wrap" title="${esc(type)}">${esc(text)}</span>${extra}`;
  }

  function pgKindOf(pgType) {
    if (/^(timestamptz|timestamp|date|time|timetz|interval)$/.test(pgType)) return "Date";
    if (pgType === "uuid") return "UUID";
    if (pgType === "bytea") return "Binary";
    return null;
  }

  function jsonCard(row, i, src = "page") {
    return `<div class="doc-card json" data-row="${i}" data-src="${src}">
      ${docActions(src)}
      <pre>${esc(toShell(row))}</pre>
    </div>`;
  }

  function docActions(src) {
    const write = src === "page" && writable(activeTab());
    return `<div class="doc-actions">${
      write ? iconButton("edit-doc", ICONS.edit, "Edit") : ""
    }${iconButton("copy-doc", ICONS.copy, "Copy as JSON")}${
      write ? iconButton("clone-doc", ICONS.clone, "Clone") + iconButton("delete-doc", ICONS.trash, "Delete") : ""
    }</div>`;
  }

  function tableHtml(rows, columns, types, offset, write = false) {
    const names = columns?.length ? columns.map((c) => c.name) : [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const head = names
      .map((n) => `<th>${esc(n)}${types.get(n) ? `<small>${esc(types.get(n))}</small>` : ""}</th>`)
      .join("");
    const body = rows
      .map(
        (r, i) =>
          `<tr data-row="${i}" data-src="page">${
            write ? `<td class="row-acts">${iconButton("edit-doc", ICONS.edit, "Edit")}${iconButton("delete-doc", ICONS.trash, "Delete")}</td>` : ""
          }<td class="rownum">${offset + i + 1}</td>${names
            .map((n) => `<td>${n in r ? valueHtml(r[n], types.get(n), true) : '<span class="v muted">—</span>'}</td>`)
            .join("")}</tr>`,
      )
      .join("");
    return `<div class="grid-wrap"><table class="grid"><thead><tr>${write ? '<th class="row-acts"></th>' : ""}<th class="rownum">#</th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function rowsOf(tab, src) {
    return src === "result" ? tab.result?.rows || [] : tab.page?.rows || [];
  }

  // ------------------------------------------------------------ schema, indexes, query

  function renderSchema(tab) {
    const box = results();
    if (tab.error) return (box.innerHTML = errorHtml(tab.error));
    if (tab.fields) {
      box.innerHTML = `<table class="grid info"><thead><tr><th>Column</th><th>Type</th><th>Null</th><th>Default</th><th>Key</th><th>Comment</th></tr></thead><tbody>${tab.fields
        .map(
          (f) => `<tr>
            <td><b>${esc(f.name)}</b></td>
            <td class="mono type">${esc(f.type)}</td>
            <td>${f.nullable ? "yes" : '<span class="muted">not null</span>'}</td>
            <td class="mono">${esc(f.default || "")}</td>
            <td>${f.primary ? '<span class="tag pk">PK</span>' : ""}${f.references ? `<span class="tag fk">FK → ${esc(f.references)}</span>` : ""}</td>
            <td class="muted">${esc(f.comment || "")}</td>
          </tr>`,
        )
        .join("")}</tbody></table>`;
      return;
    }
    if (tab.sample) {
      const { count, fields } = tab.sample;
      box.innerHTML = `<div class="schema-head">Analyzed a sample of ${count} document${count === 1 ? "" : "s"}. ${iconButton("refresh-schema", ICONS.refresh, "Sample again")}</div>
        <div class="schema-list">${fields
          .map(
            (f) => `<div class="schema-field" style="--depth:${f.depth}">
              <div class="sf-name"><b>${esc(f.name)}</b>${f.depth ? `<small>${esc(f.path)}</small>` : ""}</div>
              <div class="sf-types">
                <div class="type-bar">${f.types.map((t) => `<span class="t-${typeClass(t.name)}" style="flex:${t.share}" title="${esc(t.name)} ${pct(t.share)}"></span>`).join("")}</div>
                <div class="type-names">${f.types.map((t) => `<span><i class="t-${typeClass(t.name)}"></i>${esc(t.name)} ${pct(t.share)}</span>`).join("")}</div>
              </div>
              <div class="sf-presence" title="Share of sampled documents with this field">${pct(f.presence)}</div>
            </div>`,
          )
          .join("")}</div>`;
      return;
    }
    box.innerHTML = tab.loading ? skeletonHtml(isPostgres(tab) ? "table" : "schema") : "";
  }

  function renderIndexes(tab) {
    const box = results();
    if (tab.error) return (box.innerHTML = errorHtml(tab.error));
    if (!tab.indexes) return (box.innerHTML = skeletonHtml("table", 3));
    const write = writable(tab);
    const head = write ? `<div class="schema-head"><button class="btn primary small" data-act="create-index">${ICONS.plus} Create index</button></div>` : "";
    if (!tab.indexes.length) return (box.innerHTML = `${head}<div class="db-message">No indexes.</div>`);
    box.innerHTML = `${head}<table class="grid info"><thead><tr><th>Name</th><th>Definition</th><th>Properties</th><th>Size</th>${write ? "<th></th>" : ""}</tr></thead><tbody>${tab.indexes
      .map(
        (ix) => `<tr>
          <td><b>${esc(ix.name)}</b></td>
          <td class="mono">${esc(ix.definition)}</td>
          <td>${ix.primary ? '<span class="tag pk">primary</span>' : ""}${ix.unique && !ix.primary ? '<span class="tag">unique</span>' : ""}</td>
          <td class="muted">${esc(ix.size || "")}</td>
          ${write ? `<td class="row-end">${ix.primary ? "" : `<button class="icon-btn danger" data-act="drop-index" data-index="${esc(ix.name)}" title="Drop index">${ICONS.trash}</button>`}</td>` : ""}
        </tr>`,
      )
      .join("")}</tbody></table>`;
  }

  function renderQuery(tab) {
    const box = results();
    const run = view.querySelector('[data-act="run"]');
    if (run) run.disabled = tab.loading;
    if (tab.error) return (box.innerHTML = errorHtml(tab.error));
    if (tab.loading && !tab.result) return (box.innerHTML = skeletonHtml("table"));
    const r = tab.result;
    if (!r) return (box.innerHTML = `<div class="db-message">Press Run or Ctrl+Enter.</div>`);
    box.classList.toggle("loading", tab.loading);
    if (r.results) {
      if (!r.results.length) return (box.innerHTML = `<div class="db-message">Done in ${r.ms} ms.</div>`);
      box.innerHTML = r.results
        .map((set, i) => {
          const head = `<div class="result-head">${r.results.length > 1 ? `<b>Result ${i + 1}</b> · ` : ""}${
            set.columns.length
              ? `${set.count.toLocaleString()} row${set.count === 1 ? "" : "s"}${set.truncated ? `, first ${set.rows.length.toLocaleString()} shown` : ""}`
              : `${set.count.toLocaleString()} row${set.count === 1 ? "" : "s"} affected`
          } · ${r.ms} ms</div>`;
          if (!set.columns.length) return head;
          const rows = set.rows
            .map(
              (row, n) =>
                `<tr><td class="rownum">${n + 1}</td>${row
                  .map((v) => (v === null ? '<td><span class="v null">NULL</span></td>' : `<td><span class="v plain" data-act="wrap">${esc(v.length > 500 ? v.slice(0, 500) + "…" : v)}</span></td>`))
                  .join("")}</tr>`,
            )
            .join("");
          return `${head}<div class="grid-wrap"><table class="grid"><thead><tr><th class="rownum">#</th>${set.columns
            .map((c) => `<th>${esc(c)}</th>`)
            .join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
        })
        .join("");
      return;
    }
    const rows = r.rows || [];
    box.innerHTML =
      `<div class="result-head">${rows.length} document${rows.length === 1 ? "" : "s"} in ${r.ms} ms</div>` +
      (rows.length ? rows.map((row, i) => docCard(row, i, new Map(), tab.resultFields, "result")).join("") : "");
  }

  function typeClass(name) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  // ------------------------------------------------------------ events in the view

  view.addEventListener("submit", (e) => {
    e.preventDefault();
    const tab = activeTab();
    if (!tab) return;
    readForm(tab);
    tab.skip = 0;
    fetchDocuments(tab);
  });

  view.addEventListener("input", (e) => {
    const tab = activeTab();
    if (!tab) return;
    if (e.target.matches("[data-query]")) tab.query = e.target.value;
    else if (e.target.closest(".query-bar")) readForm(tab);
  });

  view.addEventListener("change", (e) => {
    const tab = activeTab();
    if (tab && e.target.matches('[data-act="limit"]')) {
      tab.limit = Number(e.target.value);
      tab.skip = 0;
      fetchDocuments(tab);
    }
  });

  view.addEventListener("keydown", (e) => {
    const tab = activeTab();
    if (!tab || !e.target.matches("[data-query]")) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      tab.query = e.target.value;
      runQuery(tab);
    } else if (e.key === "Tab" && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      document.execCommand("insertText", false, "  ");
    }
  });

  view.addEventListener("click", async (e) => {
    const tab = activeTab();
    if (!tab) return;
    const subtab = e.target.closest("[data-view]");
    if (subtab) {
      tab.view = subtab.dataset.view;
      tab.error = null;
      renderView();
      const loaded = { documents: tab.page, schema: tab.fields || tab.sample, indexes: tab.indexes, query: true }[tab.view];
      if (!loaded) fetchActive(tab);
      return;
    }
    const layout = e.target.closest("[data-layout]");
    if (layout) {
      tab.layout = layout.dataset.layout;
      view.querySelectorAll("[data-layout]").forEach((b) => b.classList.toggle("active", b === layout));
      return renderDocuments(tab);
    }
    const exp = e.target.closest("[data-export]");
    if (exp) {
      exp.closest(".menu").hidden = true;
      return exportPage(tab, exp.dataset.export);
    }
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const card = el.closest("[data-row]");
    switch (el.dataset.act) {
      case "options":
        tab.showOptions = !tab.showOptions;
        view.querySelector(".qb-options").hidden = !tab.showOptions;
        el.textContent = `Options ${tab.showOptions ? "▾" : "▸"}`;
        return;
      case "reset":
        Object.assign(tab, { filter: "", sort: "", project: "", skip: 0 });
        view.querySelectorAll(".query-bar input").forEach((i) => (i.value = ""));
        return fetchDocuments(tab);
      case "refresh-docs":
        return fetchDocuments(tab);
      case "prev":
        tab.skip = Math.max(0, tab.skip - tab.limit);
        return fetchDocuments(tab);
      case "next":
        tab.skip += tab.limit;
        return fetchDocuments(tab);
      case "export-menu": {
        e.stopPropagation();
        const menu = el.nextElementSibling;
        const open = menu.hidden;
        document.querySelectorAll(".menu").forEach((m) => (m.hidden = true));
        menu.hidden = !open;
        return;
      }
      case "run":
        return runQuery(tab);
      case "refresh-schema":
        return fetchSchema(tab);
      case "diagram":
        return onDiagram({ url: connOf(tab).url, password: connOf(tab).password, schemas: [tab.db] });
      case "copy-doc": {
        const row = rowsOf(tab, card.dataset.src)[Number(card.dataset.row)];
        await navigator.clipboard.writeText(JSON.stringify(row, null, 2));
        return toast("Copied as JSON");
      }
      case "more-fields":
      case "fewer-fields": {
        const set = card.dataset.src === "result" ? tab.resultFields : tab.moreFields;
        const i = Number(card.dataset.row);
        if (el.dataset.act === "more-fields") set.add(i);
        else set.delete(i);
        const rows = rowsOf(tab, card.dataset.src);
        const types = card.dataset.src === "result" ? new Map() : columnTypes(tab.page);
        card.outerHTML = docCard(rows[i], i, types, set, card.dataset.src);
        return;
      }
      case "expand": {
        const kv = el.closest(".kv");
        fillKids(tab, kv, card.dataset.src);
        kv.classList.toggle("open");
        return;
      }
      case "live":
        autoRefresh = !autoRefresh;
        view.querySelectorAll(".live-toggle").forEach((b) => b.classList.toggle("on", autoRefresh));
        onLiveChange?.(autoRefresh);
        return;
      case "wrap":
        if (!window.getSelection()?.toString()) el.classList.toggle("wrap");
        return;
      case "insert":
      case "update-many":
      case "delete-many":
      case "create-index":
        readForm(tab);
        return startWrite(tab, el.dataset.act).catch((err) => toast(String(err?.message || err), true));
      case "edit-doc":
      case "clone-doc":
      case "delete-doc":
        return startWrite(tab, el.dataset.act, rowsOf(tab, "page")[Number(card.dataset.row)]).catch((err) => toast(String(err?.message || err), true));
      case "drop-index":
        return startWrite(tab, "drop-index", el.dataset.index).catch((err) => toast(String(err?.message || err), true));
    }
  });

  // ------------------------------------------------------------ writes
  // Every change goes through one dialog that shows the SQL or mongosh call before it runs.
  // PostgreSQL rows are changed with SQL through client_sql; MongoDB through client_write.

  const actionDialog = $("actionDialog");

  function writable(tab) {
    return Boolean(tab?.coll) && ["table", "collection", "timeseries"].includes(tab.kind);
  }

  /**
   * `text` (null for none) is edited in a textarea, `index` adds the unique and name fields.
   * `preview(values)` returns what will run; `submit(values)` runs it and returns the toast.
   */
  function openAction({ title, hint = "", text = null, index = false, label, danger = false, preview, submit }) {
    actionDialog.innerHTML = `<form>
      <h2>${esc(title)}</h2>
      ${hint ? `<p class="hint">${hint}</p>` : ""}
      ${text !== null ? `<textarea class="input mono action-text" name="text" spellcheck="false" autocapitalize="off" autocomplete="off">${esc(text)}</textarea>` : ""}
      ${
        index
          ? `<div class="action-options"><label class="toggle"><input type="checkbox" name="unique" /> Unique</label>
              <input class="input" name="indexName" placeholder="Name (optional)" autocomplete="off" spellcheck="false" /></div>`
          : ""
      }
      <span class="field-label">Runs</span>
      <pre class="run-preview" data-preview></pre>
      <p class="dialog-error" data-error role="alert" hidden></p>
      <div class="dialog-actions">
        <span class="note"></span>
        <button type="button" class="btn" data-cancel>Cancel</button>
        <button type="submit" class="btn ${danger ? "destructive" : "primary"}" data-submit>${esc(label)}</button>
      </div>
    </form>`;
    const form = actionDialog.querySelector("form");
    const field = (name) => form.elements.namedItem(name);
    const values = () => ({ text: field("text")?.value ?? "", unique: field("unique")?.checked ?? false, name: field("indexName")?.value ?? "" });
    const previewEl = form.querySelector("[data-preview]");
    const errorEl = form.querySelector("[data-error]");
    const submitBtn = form.querySelector("[data-submit]");
    const update = () => {
      try {
        previewEl.textContent = preview(values());
        previewEl.classList.remove("invalid");
      } catch (err) {
        previewEl.textContent = String(err?.message || err);
        previewEl.classList.add("invalid");
      }
    };
    form.addEventListener("input", update);
    form.querySelector("[data-cancel]").addEventListener("click", () => actionDialog.close());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errorEl.hidden = true;
      submitBtn.disabled = true;
      try {
        const message = await submit(values());
        actionDialog.close();
        toast(message);
      } catch (err) {
        errorEl.textContent = String(err?.message || err);
        errorEl.hidden = false;
      } finally {
        submitBtn.disabled = false;
      }
    });
    update();
    actionDialog.showModal();
    (field("text") || submitBtn).focus();
  }

  async function startWrite(tab, act, target) {
    if (isPostgres(tab)) return startSqlWrite(tab, act, target);
    const coll = tab.coll;
    const filter = parseShell(tab.filter) ?? {};
    const docs = (n) => `${n.toLocaleString()} document${n === 1 ? "" : "s"}`;
    const write = (op) => invoke("client_write", { id: connOf(tab).id, database: tab.db, collection: coll, write: op });
    const id = () => {
      if (target?._id === undefined) throw new Error("This document has no _id, so it can't be picked out.");
      return { _id: target._id };
    };
    const insert = (title, start) =>
      openAction({
        title,
        hint: "One document, or an array of documents to insert several.",
        text: start,
        label: "Insert",
        preview: ({ text }) => {
          const value = parseShell(text) ?? {};
          return mongoCall(coll, Array.isArray(value) ? "insertMany" : "insertOne", value);
        },
        submit: async ({ text }) => {
          const r = await write({ op: "insertOne", document: shellJSON(text, "Document") || "{}" });
          afterWrite(tab);
          return `Inserted ${docs(r.count)}`;
        },
      });
    switch (act) {
      case "insert":
        return insert("Insert document", "{\n  \n}");
      case "clone-doc": {
        const { _id, ...copy } = target;
        return insert("Clone document", toShell(copy));
      }
      case "edit-doc":
        return openAction({
          title: "Edit document",
          text: toShell(target),
          label: "Replace",
          preview: ({ text }) => mongoCall(coll, "replaceOne", id(), parseShell(text) ?? {}),
          submit: async ({ text }) => {
            const r = await write({ op: "replaceOne", filter: JSON.stringify(id()), document: shellJSON(text, "Document") || "{}" });
            if (!r.count) throw new Error("No document matched. It may have been deleted; refresh and try again.");
            afterWrite(tab);
            return "Document replaced";
          },
        });
      case "delete-doc":
        return openAction({
          title: "Delete document",
          hint: "This can't be undone.",
          label: "Delete",
          danger: true,
          preview: () => mongoCall(coll, "deleteOne", id()),
          submit: async () => {
            const r = await write({ op: "deleteOne", filter: JSON.stringify(id()) });
            afterWrite(tab);
            return r.count ? "Document deleted" : "Nothing deleted: the document was already gone";
          },
        });
      case "update-many":
        return openAction({
          title: "Update documents",
          hint: `Applies to ${matching(tab, "document")}. Use update operators like <code>$set</code>, or a pipeline array.`,
          text: "{\n  $set: {\n    \n  }\n}",
          label: "Update",
          preview: ({ text }) => mongoCall(coll, "updateMany", filter, parseShell(text) ?? {}),
          submit: async ({ text }) => {
            const r = await write({ op: "updateMany", filter: JSON.stringify(filter), update: shellJSON(text, "Update") || "{}" });
            afterWrite(tab);
            return `Updated ${docs(r.count)}`;
          },
        });
      case "delete-many":
        return openAction({
          title: "Delete documents",
          hint: `Deletes ${matching(tab, "document")}. This can't be undone.`,
          label: "Delete",
          danger: true,
          preview: () => mongoCall(coll, "deleteMany", filter),
          submit: async () => {
            const r = await write({ op: "deleteMany", filter: JSON.stringify(filter) });
            afterWrite(tab);
            return `Deleted ${docs(r.count)}`;
          },
        });
      case "create-index":
        return openAction({
          title: "Create index",
          hint: "The fields to index: 1 for ascending, -1 for descending, or \"text\".",
          text: "{ field: 1 }",
          index: true,
          label: "Create",
          preview: ({ text, unique, name }) => {
            const options = { ...(unique ? { unique: true } : {}), ...(name.trim() ? { name: name.trim() } : {}) };
            return mongoCall(coll, "createIndex", parseShell(text) ?? {}, ...(Object.keys(options).length ? [options] : []));
          },
          submit: async ({ text, unique, name }) => {
            await write({ op: "createIndex", keys: shellJSON(text, "Index keys") || "{}", unique, name });
            afterWrite(tab, true);
            return "Index created";
          },
        });
      case "drop-index":
        return openAction({
          title: "Drop index",
          hint: `Queries that use <b>${esc(target)}</b> get slower.`,
          label: "Drop",
          danger: true,
          preview: () => mongoCall(coll, "dropIndex", target),
          submit: async () => {
            await write({ op: "dropIndex", name: target });
            afterWrite(tab, true);
            return `Dropped ${target}`;
          },
        });
    }
  }

  async function startSqlWrite(tab, act, target) {
    const conn = connOf(tab);
    if (!tab.fields) tab.fields = await invoke("client_columns", { id: conn.id, database: tab.db, collection: tab.coll });
    const key = tab.fields.filter((f) => f.primary).map((f) => f.name);
    const types = columnTypes(tab.page || {});
    const [schema, table] = [tab.db, tab.coll];
    const rows = (n) => `${n.toLocaleString()} row${n === 1 ? "" : "s"}`;
    const json = (text) => {
      try {
        return JSON.parse(text);
      } catch (err) {
        throw new Error(`Not valid JSON: ${err.message}`);
      }
    };
    const run = async (sql) => {
      const r = await invoke("client_sql", { id: conn.id, database: schema, sql });
      return r.results.reduce((n, set) => n + set.count, 0);
    };
    const insert = (title, start) =>
      openAction({
        title,
        hint: "A row as JSON, with column names as keys. Columns left out get their defaults. An array inserts several rows.",
        text: JSON.stringify(start, null, 2),
        label: "Insert",
        preview: ({ text }) => insertSql(schema, table, json(text), types),
        submit: async ({ text }) => {
          const n = await run(insertSql(schema, table, json(text), types));
          afterWrite(tab);
          return `Inserted ${rows(n)}`;
        },
      });
    switch (act) {
      case "insert":
        return insert("Insert row", rowTemplate(tab.fields));
      case "clone-doc": {
        // Keys filled in by the database (serial, uuid) start fresh in the copy.
        const generated = new Set(tab.fields.filter((f) => f.primary && f.default).map((f) => f.name));
        return insert("Clone row", Object.fromEntries(Object.entries(target).filter(([k]) => !generated.has(k))));
      }
      case "edit-doc":
        return openAction({
          title: "Edit row",
          hint: "Change the values; only the columns you change are updated.",
          text: JSON.stringify(target, null, 2),
          label: "Update",
          preview: ({ text }) => updateSql(schema, table, target, json(text), key, types) ?? "-- Nothing changed yet",
          submit: async ({ text }) => {
            const sql = updateSql(schema, table, target, json(text), key, types);
            if (!sql) throw new Error("Nothing changed.");
            if (!(await run(sql))) throw new Error("No row matched. It may have been changed or deleted; refresh and try again.");
            afterWrite(tab);
            return "Row updated";
          },
        });
      case "delete-doc":
        return openAction({
          title: "Delete row",
          hint: "This can't be undone.",
          label: "Delete",
          danger: true,
          preview: () => deleteSql(schema, table, target, key, types),
          submit: async () => {
            const n = await run(deleteSql(schema, table, target, key, types));
            afterWrite(tab);
            return n ? "Row deleted" : "Nothing deleted: the row was already gone";
          },
        });
      case "update-many":
        return openAction({
          title: "Update rows",
          hint: `Applies to ${matching(tab, "row")}. Type the SET part, like <code>status = 'done', updated_at = now()</code>.`,
          text: "",
          label: "Update",
          preview: ({ text }) => updateWhereSql(schema, table, text, tab.filter),
          submit: async ({ text }) => {
            const n = await run(updateWhereSql(schema, table, text, tab.filter));
            afterWrite(tab);
            return `Updated ${rows(n)}`;
          },
        });
      case "delete-many":
        return openAction({
          title: "Delete rows",
          hint: `Deletes ${matching(tab, "row")}. This can't be undone.`,
          label: "Delete",
          danger: true,
          preview: () => deleteWhereSql(schema, table, tab.filter),
          submit: async () => {
            const n = await run(deleteWhereSql(schema, table, tab.filter));
            afterWrite(tab);
            return `Deleted ${rows(n)}`;
          },
        });
      case "create-index":
        return openAction({
          title: "Create index",
          hint: "The columns or expressions to index, like <code>email</code> or <code>lower(email), created_at desc</code>.",
          text: "",
          index: true,
          label: "Create",
          preview: ({ text, unique, name }) => createIndexSql(schema, table, text, unique, name),
          submit: async ({ text, unique, name }) => {
            await run(createIndexSql(schema, table, text, unique, name));
            afterWrite(tab, true);
            return "Index created";
          },
        });
      case "drop-index":
        return openAction({
          title: "Drop index",
          hint: `Queries that use <b>${esc(target)}</b> get slower.`,
          label: "Drop",
          danger: true,
          preview: () => dropIndexSql(schema, target),
          submit: async () => {
            await run(dropIndexSql(schema, target));
            afterWrite(tab, true);
            return `Dropped ${target}`;
          },
        });
    }
  }

  /** "the 12 rows that match the filter", or "every row in the table" with no filter. */
  function matching(tab, noun) {
    const filtered = Boolean(tab.filter.trim());
    const total = tab.pageFilter === tab.filter ? tab.page?.total : null;
    const where = isPostgres(tab) ? "table" : "collection";
    if (total === null || total === undefined) return filtered ? `every ${noun} that matches the filter` : `every ${noun} in the ${where}`;
    const count = `${tab.page.estimated ? "about " : ""}${total.toLocaleString()} ${noun}${total === 1 ? "" : "s"}`;
    return filtered ? `the ${count} that match the filter` : `all ${count} in the ${where}`;
  }

  /** Reloads what a write changed: the page or the indexes, and the sidebar's row counts. */
  function afterWrite(tab, indexes = false) {
    if (indexes) fetchIndexes(tab);
    else fetchDocuments(tab);
    const conn = connOf(tab);
    if (conn?.kind === "postgres") loadCollections(conn, tab.db);
  }

  /** Draws a nested field's children the first time it is opened. */
  function fillKids(tab, kv, src) {
    const kids = kv.querySelector(":scope > .kids");
    if (kids.childElementCount) return;
    const path = JSON.parse(kv.dataset.path);
    let value = rowsOf(tab, src)[path[0]];
    for (const key of path.slice(1)) value = value?.[key];
    if (value !== undefined) kids.innerHTML = childrenHtml(value, path);
  }

  // ------------------------------------------------------------ live refresh
  // Every liveMs (Settings → Data) the open tab's rows (or indexes) and the sidebar's counts are read again and
  // redrawn only when they changed, keeping the scroll position and the opened fields. A poll
  // is skipped while the last one is still running, while the window is hidden or in Diagram
  // mode, and while a dialog is open, so an edit never targets a row that just moved. The SQL
  // and Aggregations tabs are never re-run: their statements can change data.

  let autoRefresh = prefs.live ?? true;
  let liveMs = prefs.interval || 1000;
  let polling = false;
  let lastPoll = 0;

  setInterval(async () => {
    if (!autoRefresh || polling || document.hidden || !document.body.classList.contains("mode-data")) return;
    if (document.querySelector("dialog[open]") || Date.now() - lastPoll < liveMs) return;
    lastPoll = Date.now();
    polling = true;
    try {
      await Promise.all([pollTab(activeTab()), pollTree()]);
    } finally {
      polling = false;
    }
  }, 250);

  async function pollTab(tab) {
    const conn = tab && connOf(tab);
    if (!conn || tab.loading || tab.error) return;
    const seq = tab.seq;
    const current = () => seq === tab.seq && tab === activeTab() && !document.querySelector("dialog[open]");
    if (tab.view === "documents" && tab.page && tab.applied) {
      const page = await invoke("client_find", { id: conn.id, request: findRequest(tab, conn, tab.applied) }).catch(() => null);
      if (!page || !current() || tab.view !== "documents") return;
      const same = page.total === tab.page.total && JSON.stringify(page.rows) === JSON.stringify(tab.page.rows);
      if (same || !redrawDocuments(tab, page)) return;
      view.querySelector(".db-subtabs").innerHTML = subtabsHtml(tab, isPostgres(tab));
      updateStatus();
    } else if (tab.view === "indexes" && tab.indexes) {
      const indexes = await invoke("client_indexes", { id: conn.id, database: tab.db, collection: tab.coll }).catch(() => null);
      if (!indexes || !current() || tab.view !== "indexes" || JSON.stringify(indexes) === JSON.stringify(tab.indexes)) return;
      tab.indexes = indexes;
      view.querySelector(".db-subtabs").innerHTML = subtabsHtml(tab, isPostgres(tab));
      renderIndexes(tab);
    }
  }

  /** Shows `page` in place of the current one. False, leaving the old page, while text is selected. */
  function redrawDocuments(tab, page) {
    const box = results();
    if (!box) return false;
    const selection = window.getSelection();
    if (selection?.toString() && box.contains(selection.anchorNode)) return false;
    const scroll = box.scrollTop;
    const across = box.querySelector(".grid-wrap")?.scrollLeft || 0;
    const open = [...box.querySelectorAll(".kv.open")].map((kv) => kv.dataset.path);
    tab.page = page;
    renderDocuments(tab);
    for (const path of open) {
      const kv = [...box.querySelectorAll(".kv[data-path]")].find((el) => el.dataset.path === path);
      if (!kv) continue;
      fillKids(tab, kv, "page");
      kv.classList.add("open");
    }
    box.scrollTop = scroll;
    const grid = box.querySelector(".grid-wrap");
    if (grid) grid.scrollLeft = across;
    return true;
  }

  /** Reads the table and collection lists of every opened database again, for new counts. */
  async function pollTree() {
    let changed = false;
    const jobs = [];
    for (const conn of live.values()) {
      for (const db of conn.databases) {
        if (!conn.expanded.has(db.name) || !db.collections || db.loading) continue;
        jobs.push(
          invoke("client_collections", { id: conn.id, database: db.name })
            .then((list) => {
              if (JSON.stringify(list) === JSON.stringify(db.collections)) return;
              db.collections = list;
              changed = true;
            })
            .catch(() => {}),
        );
      }
    }
    await Promise.all(jobs);
    if (changed) renderTree();
  }

  function readForm(tab) {
    const form = view.querySelector(".query-bar");
    if (!form) return;
    tab.filter = form.filter.value;
    tab.sort = form.sort?.value ?? "";
    tab.project = form.project?.value ?? "";
  }

  async function exportPage(tab, kind) {
    const rows = tab.page?.rows || [];
    if (!rows.length) return toast("Nothing to export", true);
    const json = JSON.stringify(rows, null, 2);
    try {
      if (kind === "copy") {
        await navigator.clipboard.writeText(json);
        return toast(`Copied ${rows.length} row${rows.length === 1 ? "" : "s"} as JSON`);
      }
      const ext = kind === "csv" ? "csv" : "json";
      const path = await tauri.dialog.save({
        defaultPath: `${tab.coll}.${ext}`,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      });
      if (!path) return;
      const contents = ext === "csv" ? toCSV(rows, tab.page.columns?.map((c) => c.name)) : json + "\n";
      await invoke("write_text_file", { path, contents });
      toast(`Exported ${rows.length} row${rows.length === 1 ? "" : "s"}`);
    } catch (err) {
      toast(`Export failed: ${err}`, true);
    }
  }

  // ------------------------------------------------------------ chrome

  function updateStatus() {
    const tab = activeTab();
    const parts = [live.size ? `${live.size} connection${live.size === 1 ? "" : "s"} open` : "Not connected"];
    if (tab?.page && tab.view === "documents") parts.push(`${tab.db}.${tab.coll} in ${tab.page.ms} ms`);
    onStatus(parts.join(", "));
  }

  $("dbAddConnection").addEventListener("click", () => openDialog());
  $("dbWelcomeConnect").addEventListener("click", () => openDialog());

  renderAll();

  return {
    openDialog: () => openDialog(),
    /** Live refresh, its interval, and the page size and layout of tabs opened from now on. */
    setPrefs(next) {
      prefs = next;
      autoRefresh = next.live;
      liveMs = next.interval;
      view.querySelectorAll(".live-toggle").forEach((b) => {
        b.classList.toggle("on", autoRefresh);
        b.title = `Read the data again every ${liveMs / 1000} s`;
      });
    },
    /** Saved connections for the settings page, without secrets. */
    connections: () => saved.map((s) => ({ url: s.url, name: s.name, kind: s.kind, connected: live.has(s.url) })),
    editConnection(url) {
      const entry = saved.find((s) => s.url === url);
      if (entry) editConnection(entry);
    },
    async forgetConnection(url) {
      const entry = saved.find((s) => s.url === url);
      if (!entry) return;
      if (live.has(url)) await disconnect(url);
      forgetSecret(entry);
      saved = saved.filter((s) => s !== entry);
      storeSaved();
      renderTree();
    },
    /** Closes every connection and forgets the saved ones. The caller removes the stored copy. */
    async clearAll() {
      await Promise.all([...live.keys()].map(disconnect));
      await Promise.all(saved.map(forgetSecret));
      saved = [];
      tabs = [];
      activeId = null;
      renderAll();
    },
    /** Ctrl+W closes the current tab. Returns true when the key was used. */
    handleKey(e) {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "w" && activeId !== null) {
        closeTab(activeId);
        return true;
      }
      return false;
    },
  };
}

function iconButton(act, icon, title) {
  return `<button class="icon-btn" data-act="${act}" title="${esc(title)}">${icon}</button>`;
}

function errorHtml(message) {
  return `<p class="dialog-error db-error">${esc(message)}</p>`;
}

// Placeholder shapes shown while a request runs, laid out like the content they stand in for.
// Widths cycle through a fixed list so re-renders do not make the bars jump.
const SKEL_WIDTHS = [62, 38, 80, 54, 71, 45, 88, 33];

function skeletonHtml(shape, count = 6) {
  const bar = (i, extra = "") => `<span class="skel${extra}" style="width:${SKEL_WIDTHS[i % SKEL_WIDTHS.length]}%"></span>`;
  const n = Array.from({ length: count }, (_, i) => i);
  const busy = `aria-busy="true" aria-label="Loading"`;
  if (shape === "tree") return `<div class="tree-skel" ${busy}>${n.map((i) => bar(i + 2)).join("")}</div>`;
  if (shape === "table") {
    const cols = [0, 1, 2, 3];
    return `<div class="grid-wrap" ${busy}><table class="grid skel-grid"><thead><tr>${cols.map((c) => `<th>${bar(c + 5)}</th>`).join("")}</tr></thead><tbody>${n
      .map((r) => `<tr>${cols.map((c) => `<td>${bar(r + c * 3)}</td>`).join("")}</tr>`)
      .join("")}</tbody></table></div>`;
  }
  if (shape === "schema") {
    return `<div class="schema-list" ${busy}>${n
      .map((i) => `<div class="schema-field" style="--depth:0">${bar(i)}${bar(i + 3, " tall")}${bar(4)}</div>`)
      .join("")}</div>`;
  }
  return `<div ${busy}>${n
    .slice(0, 4)
    .map((c) => `<div class="doc-card skel-card">${[0, 1, 2, 3].map((l) => `<div class="skel-field"><span class="skel key"></span>${bar(c * 2 + l)}</div>`).join("")}</div>`)
    .join("")}</div>`;
}

function pct(share) {
  const p = share * 100;
  return `${p >= 10 || p === 0 ? Math.round(p) : p.toFixed(1)}%`;
}

function compact(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${+(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  return `${+(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
}

function sqlName(name) {
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
