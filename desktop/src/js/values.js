// Values in the data browser. MongoDB documents arrive as relaxed Extended JSON, so an ObjectId
// is {"$oid": "..."} and a date is {"$date": "..."}. Queries are typed in mongosh syntax
// ({ _id: ObjectId('...'), name: /ann/i }) and sent back to Rust as Extended JSON.

/** The type name shown for a value, as Compass names them. */
export function typeOf(value) {
  if (value === null || value === undefined) return "Null";
  if (typeof value === "boolean") return "Boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "Int" : "Double";
  if (typeof value === "string") return "String";
  if (Array.isArray(value)) return "Array";
  const wrapper = WRAPPERS.find(([key]) => key in value && Object.keys(value).length <= 2);
  if (wrapper) return typeof wrapper[1] === "function" ? wrapper[1](value) : wrapper[1];
  return "Object";
}

const WRAPPERS = [
  ["$oid", "ObjectId"],
  ["$date", "Date"],
  ["$numberDecimal", "Decimal128"],
  ["$numberLong", "Long"],
  ["$numberInt", "Int"],
  ["$numberDouble", "Double"],
  ["$binary", (v) => (v.$binary?.subType === "04" ? "UUID" : "Binary")],
  ["$uuid", "UUID"],
  ["$regularExpression", "RegExp"],
  ["$timestamp", "Timestamp"],
  ["$minKey", "MinKey"],
  ["$maxKey", "MaxKey"],
  ["$code", "Code"],
  ["$symbol", "Symbol"],
  ["$undefined", "Undefined"],
];

/** A scalar in mongosh syntax: ObjectId('...'), ISODate('...'), 'text', 42. Objects give null. */
export function scalarText(value) {
  switch (typeOf(value)) {
    case "Null":
      return "null";
    case "String":
      return JSON.stringify(value);
    case "Boolean":
    case "Int":
    case "Double":
      return String(value);
    case "ObjectId":
      return `ObjectId('${value.$oid}')`;
    case "Date":
      return `ISODate('${dateText(value.$date)}')`;
    case "Decimal128":
      return `NumberDecimal('${value.$numberDecimal}')`;
    case "Long":
      return `NumberLong('${value.$numberLong}')`;
    case "UUID":
      return `UUID('${value.$uuid || uuidFromBase64(value.$binary.base64)}')`;
    case "Binary":
      return `Binary.createFromBase64('${value.$binary.base64}', ${parseInt(value.$binary.subType, 16)})`;
    case "RegExp":
      return `/${value.$regularExpression.pattern}/${value.$regularExpression.options}`;
    case "Timestamp":
      return `Timestamp({ t: ${value.$timestamp.t}, i: ${value.$timestamp.i} })`;
    case "Array":
    case "Object":
      return null;
    default:
      return JSON.stringify(value);
  }
}

function dateText(date) {
  if (typeof date === "string") return date;
  const ms = Number(date?.$numberLong ?? date);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? String(ms) : d.toISOString();
}

function uuidFromBase64(b64) {
  const hex = [...atob(b64)].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A document in mongosh syntax, indented like Compass's JSON view. */
export function toShell(value, indent = "") {
  const scalar = scalarText(value);
  if (scalar !== null) return scalar;
  const inner = indent + "  ";
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return `[\n${value.map((v) => inner + toShell(v, inner)).join(",\n")}\n${indent}]`;
  }
  const entries = Object.entries(value);
  if (!entries.length) return "{}";
  const key = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));
  return `{\n${entries.map(([k, v]) => `${inner}${key(k)}: ${toShell(v, inner)}`).join(",\n")}\n${indent}}`;
}

// ---------------------------------------------------------------- mongosh query syntax

/**
 * Parses a query typed in mongosh syntax into Extended JSON. Accepts unquoted keys, single
 * quotes, trailing commas, regex literals and ObjectId(), ISODate(), new Date(), NumberLong(),
 * NumberInt(), NumberDecimal() and UUID(). Returns undefined for empty input.
 */
export function parseShell(text) {
  const p = new ShellParser(text);
  p.space();
  if (p.done()) return undefined;
  const value = p.value();
  p.space();
  if (!p.done()) p.fail(`Unexpected “${p.peek()}”`);
  return value;
}

const CALLS = {
  ObjectId: ([id]) => {
    if (typeof id !== "string" || !/^[0-9a-f]{24}$/i.test(id)) throw new Error("ObjectId() needs a 24-character hex string");
    return { $oid: id.toLowerCase() };
  },
  ISODate: (args) => ({ $date: isoDate(args) }),
  Date: (args) => ({ $date: isoDate(args) }),
  NumberLong: ([n]) => ({ $numberLong: String(n) }),
  Long: ([n]) => ({ $numberLong: String(n) }),
  NumberInt: ([n]) => ({ $numberInt: String(n) }),
  Int32: ([n]) => ({ $numberInt: String(n) }),
  NumberDecimal: ([n]) => ({ $numberDecimal: String(n) }),
  Decimal128: ([n]) => ({ $numberDecimal: String(n) }),
  UUID: ([id]) => ({ $uuid: String(id) }),
  RegExp: ([pattern, flags = ""]) => regex(String(pattern), String(flags)),
};

function isoDate(args) {
  const d = args.length ? new Date(args[0]) : new Date();
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date ${JSON.stringify(args[0])}`);
  return d.toISOString();
}

function regex(pattern, flags) {
  return { $regularExpression: { pattern, options: [...flags].sort().join("") } };
}

class ShellParser {
  constructor(text) {
    this.s = text;
    this.i = 0;
  }

  done() {
    return this.i >= this.s.length;
  }

  peek() {
    return this.s[this.i];
  }

  fail(message) {
    throw new Error(`${message} at character ${this.i + 1}`);
  }

  space() {
    for (;;) {
      while (/\s/.test(this.s[this.i] ?? "")) this.i++;
      if (this.s.startsWith("//", this.i)) {
        const end = this.s.indexOf("\n", this.i);
        this.i = end < 0 ? this.s.length : end;
      } else return;
    }
  }

  eat(ch) {
    this.space();
    if (this.s[this.i] === ch) {
      this.i++;
      return true;
    }
    return false;
  }

  expect(ch) {
    if (!this.eat(ch)) this.fail(this.done() ? `Missing “${ch}”` : `Expected “${ch}” but found “${this.peek()}”`);
  }

  value() {
    this.space();
    const c = this.peek();
    if (c === "{") return this.object();
    if (c === "[") return this.array();
    if (c === '"' || c === "'") return this.string();
    if (c === "/") return this.regex();
    if (c === "-" || c === "+" || c === "." || /\d/.test(c ?? "")) return this.number();
    const word = this.word();
    if (!word) this.fail(this.done() ? "Unexpected end of query" : `Unexpected “${c}”`);
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null" || word === "undefined") return null;
    if (word === "new") {
      const name = this.word();
      if (!name) this.fail("Expected a name after “new”");
      return this.call(name);
    }
    return this.call(word);
  }

  word() {
    this.space();
    const m = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.i));
    if (!m) return "";
    this.i += m[0].length;
    return m[0];
  }

  call(name) {
    const start = this.i;
    if (!CALLS[name]) {
      this.i = start - name.length;
      this.fail(`Unknown name “${name}”`);
    }
    this.expect("(");
    const args = [];
    while (!this.eat(")")) {
      args.push(this.value());
      if (!this.eat(",")) {
        this.expect(")");
        break;
      }
    }
    try {
      return CALLS[name](args);
    } catch (err) {
      this.i = start - name.length;
      this.fail(err.message);
    }
  }

  object() {
    this.expect("{");
    const out = {};
    while (!this.eat("}")) {
      this.space();
      const c = this.peek();
      let key;
      if (c === '"' || c === "'") key = this.string();
      else {
        const m = /^[\w$.-]+/.exec(this.s.slice(this.i));
        if (!m) this.fail(this.done() ? "Missing “}”" : `Expected a field name but found “${c}”`);
        key = m[0];
        this.i += key.length;
      }
      this.expect(":");
      out[key] = this.value();
      if (!this.eat(",")) {
        this.expect("}");
        break;
      }
    }
    return out;
  }

  array() {
    this.expect("[");
    const out = [];
    while (!this.eat("]")) {
      out.push(this.value());
      if (!this.eat(",")) {
        this.expect("]");
        break;
      }
    }
    return out;
  }

  string() {
    const quote = this.s[this.i++];
    let out = "";
    for (;;) {
      if (this.done()) this.fail("Unclosed string");
      const c = this.s[this.i++];
      if (c === quote) return out;
      if (c !== "\\") {
        out += c;
        continue;
      }
      const e = this.s[this.i++];
      const simple = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", 0: "\0" };
      if (e === "u") {
        const hex = this.s.slice(this.i, this.i + 4);
        if (!/^[0-9a-f]{4}$/i.test(hex)) this.fail("Bad \\u escape");
        out += String.fromCharCode(parseInt(hex, 16));
        this.i += 4;
      } else out += simple[e] ?? e;
    }
  }

  regex() {
    const start = ++this.i;
    let inClass = false;
    for (;;) {
      if (this.done()) this.fail("Unclosed regular expression");
      const c = this.s[this.i++];
      if (c === "\\") this.i++;
      else if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) break;
    }
    const pattern = this.s.slice(start, this.i - 1);
    const flags = /^[a-z]*/.exec(this.s.slice(this.i))[0];
    this.i += flags.length;
    return regex(pattern, flags);
  }

  number() {
    const m = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(this.s.slice(this.i));
    if (!m) this.fail(`Unexpected “${this.peek()}”`);
    this.i += m[0].length;
    return Number(m[0]);
  }
}

// ---------------------------------------------------------------- schema analysis

/**
 * Infers fields from sampled documents: each field (nested fields as `a.b`, under their parent)
 * with how many documents have it and which types it holds.
 */
export function inferSchema(docs) {
  const root = { children: new Map() };
  const visit = (node, doc, seen, prefix) => {
    for (const [key, value] of Object.entries(doc)) {
      const path = prefix ? `${prefix}.${key}` : key;
      let child = node.children.get(key);
      if (!child) {
        child = { name: key, path, count: 0, types: new Map(), children: new Map() };
        node.children.set(key, child);
      }
      if (!seen.has(child)) {
        seen.add(child);
        child.count++;
      }
      const type = typeOf(value);
      child.types.set(type, (child.types.get(type) || 0) + 1);
      if (type === "Object") visit(child, value, seen, path);
      if (type === "Array") {
        for (const item of value) if (typeOf(item) === "Object") visit(child, item, seen, path);
      }
    }
  };
  for (const doc of docs) visit(root, doc, new Set(), "");

  const out = [];
  const flatten = (node, depth) => {
    for (const child of node.children.values()) {
      const seen = [...child.types.values()].reduce((a, b) => a + b, 0);
      out.push({
        path: child.path,
        name: child.name,
        depth,
        presence: docs.length ? child.count / docs.length : 0,
        types: [...child.types].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, share: n / seen })),
      });
      flatten(child, depth + 1);
    }
  };
  flatten(root, 0);
  return out;
}

// ---------------------------------------------------------------- export

/** Rows as CSV. Nested values are written as JSON; Extended JSON scalars as plain text. */
export function toCSV(rows, columns) {
  const cols = columns?.length ? columns : [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v) => {
    if (v === null || v === undefined) return "";
    const type = typeOf(v);
    let text;
    if (type === "ObjectId") text = v.$oid;
    else if (type === "Date") text = dateText(v.$date);
    else if (type === "Decimal128") text = v.$numberDecimal;
    else if (type === "Long") text = v.$numberLong;
    else text = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [cols.map(cell).join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}
