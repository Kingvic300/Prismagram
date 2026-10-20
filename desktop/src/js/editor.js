// A lightweight code editor: a transparent textarea over a syntax-highlighted <pre>.

const KEYWORDS = /^()(model|enum|type|view|datasource|generator)\b/;
const TOKENS = /(\/\/.*$|\/\*.*?(?:\*\/|$))|("(?:[^"\\]|\\.)*"?)|(@@?[\w.]+)|\b([A-Z]\w*)\b|([{}[\]()?=,:])/g;

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

function highlightLine(line) {
  let out = "";
  let rest = line;
  const kw = KEYWORDS.exec(line);
  if (kw) {
    out += esc(kw[1]) + `<span class="tok-kw">${kw[2]}</span>`;
    rest = line.slice(kw[0].length);
  }
  let last = 0;
  rest.replace(TOKENS, (m, com, str, attr, type, punct, idx) => {
    out += esc(rest.slice(last, idx));
    const cls = com ? "com" : str ? "str" : attr ? "attr" : type ? "type" : "punct";
    out += `<span class="tok-${cls}">${esc(m)}</span>`;
    last = idx + m.length;
    return m;
  });
  return out + esc(rest.slice(last));
}

export class Editor {
  constructor({ textarea, highlight, gutter, onChange }) {
    this.ta = textarea;
    this.hl = highlight;
    this.gutter = gutter;
    this.onChange = onChange;
    this.diagnostics = [];
    this.lineCount = 0;

    this.ta.addEventListener("input", () => {
      this.refresh();
      this.onChange(this.ta.value);
    });
    this.ta.addEventListener("scroll", () => this.syncScroll());
    this.ta.addEventListener("keydown", (e) => this.onKey(e));
  }

  get value() {
    return this.ta.value;
  }

  set value(text) {
    this.ta.value = text;
    this.ta.scrollTop = 0;
    this.refresh();
  }

  setDiagnostics(diagnostics) {
    this.diagnostics = diagnostics;
    this.renderGutter(true);
  }

  refresh() {
    this.hl.innerHTML = this.ta.value.split("\n").map(highlightLine).join("\n") + "\n\n";
    this.renderGutter(false);
    this.syncScroll();
  }

  renderGutter(force) {
    const count = this.ta.value.split("\n").length;
    if (!force && count === this.lineCount) return;
    this.lineCount = count;
    const byLine = new Map();
    for (const d of this.diagnostics) {
      const prev = byLine.get(d.line);
      if (!prev || d.severity === "error") byLine.set(d.line, d);
    }
    let html = "";
    for (let i = 1; i <= count; i++) {
      const d = byLine.get(i);
      html += d
        ? `<div class="${d.severity}" title="${esc(d.message).replace(/"/g, "&quot;")}">${i}</div>`
        : `<div>${i}</div>`;
    }
    this.gutter.innerHTML = html + "<div></div><div></div>";
    this.syncScroll();
  }

  syncScroll() {
    this.hl.scrollTop = this.ta.scrollTop;
    this.hl.scrollLeft = this.ta.scrollLeft;
    this.gutter.scrollTop = this.ta.scrollTop;
  }

  onKey(e) {
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      document.execCommand("insertText", false, "  ");
    } else if (e.key === "Enter" && !e.ctrlKey) {
      // Keep the current indentation, and indent one level after an opening brace.
      const { selectionStart: pos, value } = this.ta;
      const lineStart = value.lastIndexOf("\n", pos - 1) + 1;
      const line = value.slice(lineStart, pos);
      let indent = line.match(/^\s*/)[0];
      if (line.trimEnd().endsWith("{")) indent += "  ";
      e.preventDefault();
      document.execCommand("insertText", false, "\n" + indent);
    }
  }

  goToLine(line) {
    const lines = this.ta.value.split("\n");
    const target = Math.max(1, Math.min(line, lines.length));
    let start = 0;
    for (let i = 0; i < target - 1; i++) start += lines[i].length + 1;
    const end = start + lines[target - 1].length;
    this.ta.focus();
    this.ta.setSelectionRange(start, end);
    const lineH = parseFloat(getComputedStyle(this.ta).lineHeight) || 20;
    this.ta.scrollTop = Math.max(0, (target - 1) * lineH - this.ta.clientHeight / 3);
    this.syncScroll();
  }
}
