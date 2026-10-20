//! A small, forgiving Prisma schema parser.
//!
//! It understands enough of the Prisma Schema Language to draw a class
//! diagram: models, views, composite types, enums, field attributes and
//! relations. It never fails outright; problems are reported as diagnostics
//! so the UI can keep rendering whatever was understood.

use serde::Serialize;
use std::collections::HashSet;

const SCALARS: &[&str] = &[
    "String", "Boolean", "Int", "BigInt", "Float", "Decimal", "DateTime", "Json", "Bytes",
];

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Schema {
    pub models: Vec<Model>,
    pub enums: Vec<Enum>,
    pub relations: Vec<Relation>,
    pub diagnostics: Vec<Diagnostic>,
    pub provider: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub name: String,
    /// "model", "view" or "type" (composite type).
    pub kind: String,
    pub fields: Vec<Field>,
    pub attributes: Vec<String>,
    pub doc: Option<String>,
    pub line: usize,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    pub name: String,
    pub type_name: String,
    pub optional: bool,
    pub list: bool,
    /// "scalar", "enum", "relation", "composite" or "unknown".
    pub kind: String,
    pub attributes: Vec<String>,
    pub is_id: bool,
    pub is_unique: bool,
    pub is_updated_at: bool,
    pub ignored: bool,
    pub default: Option<String>,
    pub relation: Option<RelationAttr>,
    pub doc: Option<String>,
    pub line: usize,
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RelationAttr {
    pub name: Option<String>,
    pub fields: Vec<String>,
    pub references: Vec<String>,
    pub on_delete: Option<String>,
    pub on_update: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Enum {
    pub name: String,
    pub values: Vec<String>,
    pub doc: Option<String>,
    pub line: usize,
}

/// A relation between two models. The parent is the referenced side,
/// the child holds the foreign key (`@relation(fields: ...)`).
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Relation {
    pub parent: String,
    pub child: String,
    pub parent_field: Option<String>,
    pub child_field: Option<String>,
    pub parent_multiplicity: String,
    pub child_multiplicity: String,
    /// "one-to-one", "one-to-many" or "many-to-many".
    pub kind: String,
    pub name: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub line: usize,
    pub message: String,
    pub severity: String,
}

impl Diagnostic {
    fn error(line: usize, message: impl Into<String>) -> Self {
        Self {
            line,
            message: message.into(),
            severity: "error".into(),
        }
    }
    fn warning(line: usize, message: impl Into<String>) -> Self {
        Self {
            line,
            message: message.into(),
            severity: "warning".into(),
        }
    }
}

/// One meaningful line inside a block, with its 1-based line number and doc comment.
struct BodyLine {
    line: usize,
    text: String,
    doc: Option<String>,
}

pub fn parse(src: &str) -> Schema {
    let mut schema = Schema::default();
    let src = blank_block_comments(src);
    let lines: Vec<&str> = src.lines().collect();
    let mut docs: Vec<String> = Vec::new();
    let mut i = 0;

    while i < lines.len() {
        let lineno = i + 1;
        let raw = lines[i].trim();
        i += 1;

        if let Some(doc) = raw.strip_prefix("///") {
            docs.push(doc.trim().to_string());
            continue;
        }
        let line = strip_comment(raw);
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let header = line.split('{').next().unwrap_or("").trim();
        let mut words = header.split_whitespace();
        let keyword = words.next().unwrap_or("");
        let name = words.next().unwrap_or("").to_string();
        let doc = take_doc(&mut docs);

        if !matches!(
            keyword,
            "model" | "view" | "type" | "enum" | "datasource" | "generator"
        ) {
            schema.diagnostics.push(Diagnostic::error(
                lineno,
                format!("Unexpected `{line}` outside of a block"),
            ));
            continue;
        }
        if name.is_empty() {
            schema.diagnostics.push(Diagnostic::error(
                lineno,
                format!("`{keyword}` block is missing a name"),
            ));
        }
        if !line.contains('{') {
            schema.diagnostics.push(Diagnostic::error(
                lineno,
                format!("Expected `{{` after `{keyword} {name}`"),
            ));
            continue;
        }

        // Collect the body until the closing brace. `model A {}` is a valid empty block.
        let mut body = Vec::new();
        let after_open = line.split_once('{').map(|(_, r)| r.trim()).unwrap_or("");
        let mut closed = after_open.starts_with('}');
        let mut body_docs: Vec<String> = Vec::new();
        while !closed && i < lines.len() {
            let n = i + 1;
            let raw = lines[i].trim();
            i += 1;
            if let Some(doc) = raw.strip_prefix("///") {
                body_docs.push(doc.trim().to_string());
                continue;
            }
            let text = strip_comment(raw).trim().to_string();
            if text.is_empty() {
                continue;
            }
            if text.starts_with('}') {
                closed = true;
                break;
            }
            body.push(BodyLine {
                line: n,
                text,
                doc: take_doc(&mut body_docs),
            });
        }
        if !closed {
            schema.diagnostics.push(Diagnostic::error(
                lineno,
                format!("`{keyword} {name}` is missing a closing `}}`"),
            ));
        }

        match keyword {
            "model" | "view" | "type" => {
                let model = parse_model(keyword, name, doc, lineno, &body, &mut schema.diagnostics);
                schema.models.push(model);
            }
            "enum" => {
                let values = body
                    .iter()
                    .filter(|b| !b.text.starts_with("@@"))
                    .filter_map(|b| b.text.split_whitespace().next().map(str::to_string))
                    .collect();
                schema.enums.push(Enum {
                    name,
                    values,
                    doc,
                    line: lineno,
                });
            }
            "datasource" => {
                for b in &body {
                    if let Some((key, value)) = b.text.split_once('=') {
                        if key.trim() == "provider" {
                            schema.provider = Some(unquote(value.trim()).to_string());
                        }
                    }
                }
            }
            _ => {}
        }
    }

    classify_fields(&mut schema);
    schema.relations = build_relations(&schema.models, &mut schema.diagnostics);
    schema
}

fn take_doc(docs: &mut Vec<String>) -> Option<String> {
    if docs.is_empty() {
        None
    } else {
        Some(std::mem::take(docs).join("\n"))
    }
}

fn parse_model(
    keyword: &str,
    name: String,
    doc: Option<String>,
    line: usize,
    body: &[BodyLine],
    diagnostics: &mut Vec<Diagnostic>,
) -> Model {
    let mut fields = Vec::new();
    let mut attributes = Vec::new();
    let mut compound_ids: Vec<String> = Vec::new();

    for b in body {
        if b.text.starts_with("@@") {
            for (attr_name, args) in split_attributes(&b.text[1..]) {
                if attr_name == "id" {
                    if let Some(args) = &args {
                        compound_ids.extend(list_arg(args, "fields", true));
                    }
                }
                attributes.push(format!(
                    "@@{}{}",
                    attr_name,
                    args.map(|a| format!("({a})")).unwrap_or_default()
                ));
            }
            continue;
        }
        match parse_field(&b.text, b.line) {
            Ok(mut field) => {
                field.doc = b.doc.clone();
                fields.push(field);
            }
            Err(msg) => diagnostics.push(Diagnostic::error(b.line, msg)),
        }
    }

    for field in &mut fields {
        if compound_ids.contains(&field.name) {
            field.is_id = true;
        }
    }

    Model {
        name,
        kind: keyword.to_string(),
        fields,
        attributes,
        doc,
        line,
    }
}

fn parse_field(text: &str, line: usize) -> Result<Field, String> {
    let text = text.trim();
    let name_end = text
        .find(char::is_whitespace)
        .ok_or_else(|| format!("Field `{text}` has no type"))?;
    let name = &text[..name_end];
    if !name.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return Err(format!("Invalid field name `{name}`"));
    }
    let rest = text[name_end..].trim_start();

    // The type ends at whitespace or an attribute, but `Unsupported("x y")` may hold both.
    let mut depth = 0;
    let mut in_str = false;
    let mut end = rest.len();
    for (idx, c) in rest.char_indices() {
        match c {
            '"' => in_str = !in_str,
            '(' if !in_str => depth += 1,
            ')' if !in_str => depth -= 1,
            c if depth == 0 && !in_str && (c.is_whitespace() || c == '@') => {
                end = idx;
                break;
            }
            _ => {}
        }
    }
    let mut type_name = &rest[..end];
    if type_name.is_empty() {
        return Err(format!("Field `{name}` has no type"));
    }
    let attrs_text = &rest[end..];

    let mut optional = false;
    let mut list = false;
    if let Some(t) = type_name.strip_suffix('?') {
        optional = true;
        type_name = t;
    }
    if let Some(t) = type_name.strip_suffix("[]") {
        list = true;
        type_name = t;
    }

    let mut field = Field {
        name: name.to_string(),
        type_name: type_name.to_string(),
        optional,
        list,
        kind: "unknown".into(),
        attributes: Vec::new(),
        is_id: false,
        is_unique: false,
        is_updated_at: false,
        ignored: false,
        default: None,
        relation: None,
        doc: None,
        line,
    };

    for (attr_name, args) in split_attributes(attrs_text) {
        match attr_name.as_str() {
            "id" => field.is_id = true,
            "unique" => field.is_unique = true,
            "updatedAt" => field.is_updated_at = true,
            "ignore" => field.ignored = true,
            "default" => field.default = args.clone(),
            "relation" => field.relation = Some(parse_relation_attr(args.as_deref().unwrap_or(""))),
            _ => {}
        }
        field.attributes.push(format!(
            "@{}{}",
            attr_name,
            args.map(|a| format!("({a})")).unwrap_or_default()
        ));
    }
    Ok(field)
}

/// Splits `@id @default(uuid()) @db.VarChar(255)` into `(name, args)` pairs.
fn split_attributes(text: &str) -> Vec<(String, Option<String>)> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '@' {
            i += 1;
            continue;
        }
        i += 1;
        let start = i;
        while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_' || chars[i] == '.')
        {
            i += 1;
        }
        let name: String = chars[start..i].iter().collect();
        let mut j = i;
        while j < chars.len() && chars[j] == ' ' {
            j += 1;
        }
        let mut args = None;
        if j < chars.len() && chars[j] == '(' {
            let (depth_start, mut depth, mut in_str) = (j + 1, 0i32, false);
            let mut k = j;
            while k < chars.len() {
                let c = chars[k];
                if c == '"' && (k == 0 || chars[k - 1] != '\\') {
                    in_str = !in_str;
                } else if !in_str && c == '(' {
                    depth += 1;
                } else if !in_str && c == ')' {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                k += 1;
            }
            let end = k.min(chars.len());
            args = Some(
                chars[depth_start..end]
                    .iter()
                    .collect::<String>()
                    .trim()
                    .to_string(),
            );
            i = end + 1;
        }
        if !name.is_empty() {
            out.push((name, args));
        }
    }
    out
}

/// Splits arguments on top-level commas, ignoring commas inside brackets or strings.
fn split_args(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0;
    let mut in_str = false;
    let mut current = String::new();
    for c in text.chars() {
        match c {
            '"' => in_str = !in_str,
            '(' | '[' if !in_str => depth += 1,
            ')' | ']' if !in_str => depth -= 1,
            ',' if depth == 0 && !in_str => {
                out.push(current.trim().to_string());
                current.clear();
                continue;
            }
            _ => {}
        }
        current.push(c);
    }
    if !current.trim().is_empty() {
        out.push(current.trim().to_string());
    }
    out
}

/// Reads a `[a, b]` list from a named argument, or from the first positional one.
fn list_arg(args: &str, key: &str, positional: bool) -> Vec<String> {
    for (idx, arg) in split_args(args).iter().enumerate() {
        let value = match named(arg) {
            Some((k, v)) if k == key => v,
            None if positional && idx == 0 => arg.as_str(),
            _ => continue,
        };
        return value
            .trim()
            .trim_start_matches('[')
            .trim_end_matches(']')
            .split(',')
            .map(|s| s.trim().split('(').next().unwrap_or("").trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
    }
    Vec::new()
}

fn named(arg: &str) -> Option<(&str, &str)> {
    let (key, value) = arg.split_once(':')?;
    let key = key.trim();
    if key.chars().all(|c| c.is_alphanumeric() || c == '_') && !key.is_empty() {
        Some((key, value.trim()))
    } else {
        None
    }
}

fn parse_relation_attr(args: &str) -> RelationAttr {
    let mut rel = RelationAttr {
        fields: list_arg(args, "fields", false),
        references: list_arg(args, "references", false),
        ..Default::default()
    };
    for (idx, arg) in split_args(args).iter().enumerate() {
        match named(arg) {
            Some(("name", v)) => rel.name = Some(unquote(v).to_string()),
            Some(("onDelete", v)) => rel.on_delete = Some(v.to_string()),
            Some(("onUpdate", v)) => rel.on_update = Some(v.to_string()),
            None if idx == 0 && arg.starts_with('"') => rel.name = Some(unquote(arg).to_string()),
            _ => {}
        }
    }
    rel
}

fn classify_fields(schema: &mut Schema) {
    let models: HashSet<String> = schema
        .models
        .iter()
        .filter(|m| m.kind != "type")
        .map(|m| m.name.clone())
        .collect();
    let composites: HashSet<String> = schema
        .models
        .iter()
        .filter(|m| m.kind == "type")
        .map(|m| m.name.clone())
        .collect();
    let enums: HashSet<String> = schema.enums.iter().map(|e| e.name.clone()).collect();

    for model in &mut schema.models {
        for field in &mut model.fields {
            let t = field.type_name.as_str();
            field.kind = if SCALARS.contains(&t) || t.starts_with("Unsupported(") {
                "scalar"
            } else if enums.contains(t) {
                "enum"
            } else if models.contains(t) {
                "relation"
            } else if composites.contains(t) {
                "composite"
            } else {
                schema.diagnostics.push(Diagnostic::warning(
                    field.line,
                    format!("Unknown type `{t}` on `{}.{}`", model.name, field.name),
                ));
                "unknown"
            }
            .to_string();
        }
    }
}

fn multiplicity(field: &Field) -> String {
    if field.list {
        "*".into()
    } else if field.optional {
        "0..1".into()
    } else {
        "1".into()
    }
}

fn build_relations(models: &[Model], diagnostics: &mut Vec<Diagnostic>) -> Vec<Relation> {
    struct End<'a> {
        model: &'a str,
        field: &'a Field,
        name: Option<&'a str>,
    }
    let ends: Vec<End> = models
        .iter()
        .flat_map(|m| {
            m.fields
                .iter()
                .filter(|f| f.kind == "relation")
                .map(move |f| End {
                    model: &m.name,
                    field: f,
                    name: f.relation.as_ref().and_then(|r| r.name.as_deref()),
                })
        })
        .collect();

    let has_fk = |f: &Field| {
        f.relation
            .as_ref()
            .map(|r| !r.fields.is_empty())
            .unwrap_or(false)
    };
    let mut used = vec![false; ends.len()];
    let mut relations = Vec::new();

    for a in 0..ends.len() {
        if used[a] {
            continue;
        }
        used[a] = true;
        let ea = &ends[a];
        let partner = (0..ends.len()).find(|&b| {
            !used[b]
                && ends[b].model == ea.field.type_name
                && ends[b].field.type_name == ea.model
                && ends[b].name == ea.name
        });

        let Some(b) = partner else {
            diagnostics.push(Diagnostic::warning(
                ea.field.line,
                format!(
                    "`{}.{}` has no opposite relation field on `{}`",
                    ea.model, ea.field.name, ea.field.type_name
                ),
            ));
            // Still draw it: the model holding the field points at the target.
            relations.push(Relation {
                parent: ea.field.type_name.clone(),
                child: ea.model.to_string(),
                parent_field: None,
                child_field: Some(ea.field.name.clone()),
                parent_multiplicity: multiplicity(ea.field),
                child_multiplicity: "*".into(),
                kind: "one-to-many".into(),
                name: ea.name.map(str::to_string),
            });
            continue;
        };
        used[b] = true;
        let eb = &ends[b];

        // The child is the side holding the foreign key.
        let (parent, child) = if has_fk(ea.field) {
            (eb, ea)
        } else if has_fk(eb.field) {
            (ea, eb)
        } else if ea.model <= eb.model {
            (ea, eb)
        } else {
            (eb, ea)
        };
        let kind = match (parent.field.list, child.field.list) {
            (true, true) => "many-to-many",
            (false, false) => "one-to-one",
            _ => "one-to-many",
        };
        relations.push(Relation {
            parent: parent.model.to_string(),
            child: child.model.to_string(),
            parent_field: Some(parent.field.name.clone()),
            child_field: Some(child.field.name.clone()),
            parent_multiplicity: multiplicity(child.field),
            child_multiplicity: multiplicity(parent.field),
            kind: kind.into(),
            name: parent.name.map(str::to_string),
        });
    }
    relations
}

/// Replaces `/* ... */` comments with spaces, keeping newlines so line numbers stay correct.
fn blank_block_comments(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let mut chars = src.chars().peekable();
    let (mut in_str, mut in_line_comment, mut in_block) = (false, false, false);
    while let Some(c) = chars.next() {
        if in_block {
            if c == '*' && chars.peek() == Some(&'/') {
                chars.next();
                out.push_str("  ");
                in_block = false;
            } else {
                out.push(if c == '\n' { '\n' } else { ' ' });
            }
            continue;
        }
        match c {
            '\n' => {
                in_str = false;
                in_line_comment = false;
            }
            '\\' if in_str => {
                out.push(c);
                if let Some(next) = chars.next() {
                    out.push(next);
                }
                continue;
            }
            '"' if !in_line_comment => in_str = !in_str,
            '/' if !in_str && !in_line_comment && chars.peek() == Some(&'/') => {
                in_line_comment = true
            }
            '/' if !in_str && !in_line_comment && chars.peek() == Some(&'*') => {
                chars.next();
                out.push_str("  ");
                in_block = true;
                continue;
            }
            _ => {}
        }
        out.push(c);
    }
    out
}

/// Removes a trailing `//` comment, leaving `//` inside strings alone.
fn strip_comment(line: &str) -> &str {
    let bytes = line.as_bytes();
    let mut in_str = false;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' if in_str => i += 1,
            b'"' => in_str = !in_str,
            b'/' if !in_str && bytes.get(i + 1) == Some(&b'/') => return &line[..i],
            _ => {}
        }
        i += 1;
    }
    line
}

fn unquote(s: &str) -> &str {
    s.trim().trim_matches('"')
}

#[cfg(test)]
mod tests {
    use super::*;

    const BLOG: &str = r#"
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

/// A registered user
model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String?  // display name
  role      Role     @default(USER)
  posts     Post[]
  profile   Profile?
  createdAt DateTime @default(now())
}

model Profile {
  id     Int    @id @default(autoincrement())
  bio    String @default("Hello // not a comment")
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  userId Int    @unique
}

model Post {
  id       Int        @id @default(autoincrement())
  title    String     @db.VarChar(255)
  author   User       @relation(fields: [authorId], references: [id])
  authorId Int
  tags     Tag[]
}

model Tag {
  id    Int    @id
  posts Post[]
}

model Follow {
  followerId  Int
  followingId Int
  @@id([followerId, followingId])
}

enum Role {
  USER
  ADMIN @map("admin")
}
"#;

    #[test]
    fn parses_models_and_enums() {
        let s = parse(BLOG);
        assert_eq!(s.provider.as_deref(), Some("postgresql"));
        assert_eq!(s.models.len(), 5);
        assert_eq!(s.enums[0].values, vec!["USER", "ADMIN"]);
        let user = &s.models[0];
        assert_eq!(user.doc.as_deref(), Some("A registered user"));
        assert!(user.fields[0].is_id);
        assert_eq!(user.fields[0].default.as_deref(), Some("autoincrement()"));
        assert!(user.fields[2].optional);
        assert_eq!(user.fields[3].kind, "enum");
        assert!(user.fields[4].list);
        assert!(s.diagnostics.is_empty(), "{:?}", s.diagnostics);
    }

    #[test]
    fn keeps_comment_markers_inside_strings() {
        let s = parse(BLOG);
        let bio = &s.models[1].fields[1];
        assert_eq!(bio.default.as_deref(), Some("\"Hello // not a comment\""));
    }

    #[test]
    fn compound_ids_mark_fields() {
        let s = parse(BLOG);
        let follow = s.models.iter().find(|m| m.name == "Follow").unwrap();
        assert!(follow.fields.iter().all(|f| f.is_id));
        assert_eq!(follow.attributes, vec!["@@id([followerId, followingId])"]);
    }

    #[test]
    fn builds_relations() {
        let s = parse(BLOG);
        let find = |p: &str, c: &str| {
            s.relations
                .iter()
                .find(|r| r.parent == p && r.child == c)
                .unwrap()
        };

        let posts = find("User", "Post");
        assert_eq!(posts.kind, "one-to-many");
        assert_eq!(posts.parent_multiplicity, "1");
        assert_eq!(posts.child_multiplicity, "*");

        let profile = find("User", "Profile");
        assert_eq!(profile.kind, "one-to-one");
        assert_eq!(profile.child_multiplicity, "0..1");

        assert_eq!(find("Post", "Tag").kind, "many-to-many");
        assert_eq!(s.relations.len(), 3);
    }

    #[test]
    fn named_self_relations_pair_up() {
        let s = parse(
            r#"
model Person {
  id          Int      @id
  mentorId    Int?
  mentor      Person?  @relation("Mentoring", fields: [mentorId], references: [id])
  mentees     Person[] @relation("Mentoring")
}"#,
        );
        assert_eq!(s.relations.len(), 1);
        let r = &s.relations[0];
        assert_eq!((r.parent.as_str(), r.child.as_str()), ("Person", "Person"));
        assert_eq!(r.child_field.as_deref(), Some("mentor"));
        assert_eq!(r.name.as_deref(), Some("Mentoring"));
    }

    #[test]
    fn ignores_block_comments() {
        let s = parse("/* ── Platform ── */\nmodel A {\n  id Int @id /* inline */\n  /* spans\n     lines */\n  name String @default(\"/* kept */\")\n}\n");
        assert!(s.diagnostics.is_empty(), "{:?}", s.diagnostics);
        let a = &s.models[0];
        assert_eq!(a.line, 2);
        assert_eq!(a.fields.len(), 2);
        assert_eq!(a.fields[1].line, 6);
        assert_eq!(a.fields[1].default.as_deref(), Some("\"/* kept */\""));
    }

    #[test]
    fn reports_problems_without_failing() {
        let s = parse("model A {\n  id Int @id\n  b Missing\n\nstray");
        assert_eq!(s.models.len(), 1);
        assert!(s
            .diagnostics
            .iter()
            .any(|d| d.message.contains("Unknown type `Missing`")));
        assert!(s
            .diagnostics
            .iter()
            .any(|d| d.message.contains("missing a closing")));
    }
}
