// Converts a parsed schema to a Mermaid class diagram. Text survives where big images don't:
// chat assistants, GitHub markdown and docs sites all render or read Mermaid.

const SAFE = /[^A-Za-z0-9_]/g;

function id(name) {
  return name.replace(SAFE, "_");
}

function memberType(f) {
  // Mermaid treats "(" as a method and "~" as generics, so keep the type plain.
  const base = f.typeName.startsWith("Unsupported(") ? "Unsupported" : f.typeName;
  return base.replace(SAFE, "_") + (f.list ? "[]" : "") + (f.optional ? "?" : "");
}

/** Every model, enum and relation, regardless of what the canvas currently shows. */
export function toMermaid(schema) {
  const lines = ["classDiagram", "  direction TB"];
  const names = new Set([...schema.models.map((m) => m.name), ...schema.enums.map((e) => e.name)]);

  for (const m of schema.models) {
    lines.push(`  class ${id(m.name)} {`);
    if (m.kind !== "model") lines.push(`    <<${m.kind}>>`);
    for (const f of m.fields) lines.push(`    ${f.ignored ? "-" : "+"}${memberType(f)} ${id(f.name)}`);
    lines.push("  }");
  }

  for (const e of schema.enums) {
    lines.push(`  class ${id(e.name)} {`, "    <<enumeration>>");
    for (const v of e.values) lines.push(`    ${id(v)}`);
    lines.push("  }");
  }

  for (const r of schema.relations) {
    const label = r.parentField || r.childField;
    lines.push(
      `  ${id(r.parent)} "${r.parentMultiplicity}" --> "${r.childMultiplicity}" ${id(r.child)}${label ? ` : ${id(label)}` : ""}`,
    );
  }

  const seen = new Set();
  for (const m of schema.models) {
    for (const f of m.fields) {
      if ((f.kind !== "enum" && f.kind !== "composite") || !names.has(f.typeName)) continue;
      const key = m.name + "\u0000" + f.typeName;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(f.kind === "enum" ? `  ${id(m.name)} ..> ${id(f.typeName)}` : `  ${id(m.name)} *-- ${id(f.typeName)}`);
    }
  }
  return lines.join("\n") + "\n";
}
