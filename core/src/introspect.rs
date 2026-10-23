//! Turns a live PostgreSQL catalog into Prisma schema text, the way `prisma db pull` does.
//!
//! [`catalog_query`] asks Postgres for every table, view, column, index, foreign key and
//! enum in the chosen schemas as one JSON document, and [`to_prisma`] writes that document
//! as a schema. Neither touches the network, so both are tested without a database; the
//! desktop shell runs the query.

use serde::Deserialize;
use std::collections::{BTreeSet, HashMap, HashSet};

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Catalog {
    pub tables: Vec<Table>,
    pub enums: Vec<EnumType>,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Table {
    pub schema: String,
    pub name: String,
    /// "table" or "view".
    pub kind: String,
    pub comment: Option<String>,
    pub columns: Vec<Column>,
    pub indexes: Vec<Index>,
    pub foreign_keys: Vec<ForeignKey>,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Column {
    pub name: String,
    /// The Postgres type, or the element type for arrays, with domains resolved.
    pub type_name: String,
    pub type_schema: String,
    /// `pg_type.typtype`: "b" base, "e" enum, "c" composite, "r" range, ...
    pub type_kind: String,
    /// The type as Postgres prints it, e.g. `character varying(255)[]`.
    pub full_type: String,
    pub list: bool,
    pub typmod: i32,
    pub not_null: bool,
    pub default: Option<String>,
    pub identity: bool,
    pub generated: bool,
    pub comment: Option<String>,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Index {
    pub name: String,
    pub primary: bool,
    pub unique: bool,
    pub columns: Vec<String>,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ForeignKey {
    pub name: String,
    pub columns: Vec<String>,
    pub ref_schema: String,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    /// `pg_constraint.confdeltype`: "a" no action, "r" restrict, "c" cascade,
    /// "n" set null, "d" set default.
    pub on_delete: String,
    pub on_update: String,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct EnumType {
    pub schema: String,
    pub name: String,
    pub values: Vec<String>,
    pub comment: Option<String>,
}

/// One read-only statement that returns the catalog of `schemas` as a single JSON text value.
/// It only reads `pg_catalog`, so it runs through connection poolers in transaction mode too.
pub fn catalog_query(schemas: &[String]) -> String {
    let list = schemas
        .iter()
        .map(|s| format!("E'{}'", s.replace('\\', "\\\\").replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(", ");
    CATALOG_SQL.replace("$SCHEMAS", &list)
}

const CATALOG_SQL: &str = r#"
with ns as (
  select oid, nspname from pg_namespace where nspname = any (array[$SCHEMAS]::text[])
),
rels as (
  select c.oid, n.nspname, c.relname, c.relkind
  from pg_class c join ns n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p', 'v', 'm', 'f') and not c.relispartition
),
cols as (
  select a.attrelid, a.attnum, a.attname,
    et.oid as type_oid, et.typname, etn.nspname as type_schema, et.typtype::text as type_kind,
    t.typcategory = 'A' as list,
    format_type(a.atttypid, a.atttypmod) as full_type,
    case when e.typtype = 'd' then e.typtypmod else a.atttypmod end as typmod,
    a.attnotnull, pg_get_expr(d.adbin, d.adrelid) as def,
    a.attidentity <> '' as identity, a.attgenerated <> '' as generated,
    col_description(a.attrelid, a.attnum) as comment
  from pg_attribute a
  join rels r on r.oid = a.attrelid
  join pg_type t on t.oid = a.atttypid
  join pg_type e on e.oid = case when t.typcategory = 'A' and t.typelem <> 0 then t.typelem else t.oid end
  join pg_type et on et.oid = case when e.typtype = 'd' then e.typbasetype else e.oid end
  join pg_namespace etn on etn.oid = et.typnamespace
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where a.attnum > 0 and not a.attisdropped
)
select json_build_object(
  'tables', coalesce((
    select json_agg(json_build_object(
      'schema', r.nspname,
      'name', r.relname,
      'kind', case when r.relkind in ('v', 'm') then 'view' else 'table' end,
      'comment', obj_description(r.oid, 'pg_class'),
      'columns', coalesce((
        select json_agg(json_build_object(
          'name', c.attname, 'typeName', c.typname, 'typeSchema', c.type_schema,
          'typeKind', c.type_kind, 'fullType', c.full_type, 'list', c.list, 'typmod', c.typmod,
          'notNull', c.attnotnull, 'default', c.def, 'identity', c.identity,
          'generated', c.generated, 'comment', c.comment
        ) order by c.attnum)
        from cols c where c.attrelid = r.oid
      ), '[]'),
      'indexes', coalesce((
        select json_agg(json_build_object(
          'name', ic.relname, 'primary', i.indisprimary, 'unique', i.indisunique,
          'columns', coalesce((
            select json_agg(a.attname order by k.ord)
            from unnest(i.indkey::int2[]) with ordinality k(attnum, ord)
            join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
            where k.ord <= i.indnkeyatts
          ), '[]')
        ) order by ic.relname)
        from pg_index i join pg_class ic on ic.oid = i.indexrelid
        where i.indrelid = r.oid and i.indexprs is null and i.indpred is null
      ), '[]'),
      'foreignKeys', coalesce((
        select json_agg(json_build_object(
          'name', con.conname,
          'columns', coalesce((
            select json_agg(a.attname order by k.ord)
            from unnest(con.conkey) with ordinality k(attnum, ord)
            join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
          ), '[]'),
          'refSchema', fn.nspname,
          'refTable', fc.relname,
          'refColumns', coalesce((
            select json_agg(a.attname order by k.ord)
            from unnest(con.confkey) with ordinality k(attnum, ord)
            join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum
          ), '[]'),
          'onDelete', con.confdeltype::text,
          'onUpdate', con.confupdtype::text
        ) order by con.conname)
        from pg_constraint con
        join pg_class fc on fc.oid = con.confrelid
        join pg_namespace fn on fn.oid = fc.relnamespace
        where con.conrelid = r.oid and con.contype = 'f' and con.conparentid = 0
      ), '[]')
    ) order by r.nspname, r.relname)
    from rels r
  ), '[]'),
  'enums', coalesce((
    select json_agg(json_build_object(
      'schema', n.nspname,
      'name', t.typname,
      'values', coalesce((
        select json_agg(v.enumlabel order by v.enumsortorder) from pg_enum v where v.enumtypid = t.oid
      ), '[]'),
      'comment', obj_description(t.oid, 'pg_type')
    ) order by n.nspname, t.typname)
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where t.typtype = 'e'
      and (t.typnamespace in (select oid from ns) or t.oid in (select type_oid from cols))
  ), '[]')
)::text
"#;

/// A field (or enum value) line before it is aligned and written out.
#[derive(Default)]
struct Line {
    name: String,
    ty: String,
    id: bool,
    unique: bool,
    attrs: Vec<String>,
    doc: Option<String>,
    /// Written as a trailing `//` comment.
    note: Option<String>,
}

struct Block {
    name: String,
    lines: Vec<Line>,
    attrs: Vec<String>,
    taken: Names,
    /// Column name to its index in `lines`.
    columns: HashMap<String, usize>,
    /// Sorted column sets of the primary key and unique indexes.
    unique_sets: HashSet<Vec<String>>,
    ignored: bool,
}

impl Block {
    fn field(&self, column: &str) -> Option<&str> {
        self.columns
            .get(column)
            .map(|&i| self.lines[i].name.as_str())
    }
}

#[derive(Default)]
struct Names(HashSet<String>);

impl Names {
    /// Claims `wanted`, or `wanted2`, `wanted3`, ... if it is taken.
    fn take(&mut self, wanted: &str) -> String {
        let mut name = wanted.to_string();
        let mut n = 2;
        while !self.0.insert(name.clone()) {
            name = format!("{wanted}{n}");
            n += 1;
        }
        name
    }
}

/// Writes `catalog` as a Prisma schema. `source` names the database in the header comment;
/// it must not contain credentials.
pub fn to_prisma(catalog: &Catalog, source: &str) -> String {
    let mut taken = Names::default();
    taken.0.extend(super::SCALARS.iter().map(|s| s.to_string()));
    taken.0.insert("Unsupported".into());
    let model_names = top_level_names(
        catalog
            .tables
            .iter()
            .map(|t| (t.schema.as_str(), t.name.as_str())),
        &mut taken,
        "",
    );
    let enum_names = top_level_names(
        catalog
            .enums
            .iter()
            .map(|e| (e.schema.as_str(), e.name.as_str())),
        &mut taken,
        "_enum",
    );

    // Enum values keyed by their database label, for defaults like `'draft'::status`.
    let enum_values: Vec<Vec<(String, String)>> = catalog
        .enums
        .iter()
        .map(|e| {
            let mut names = Names::default();
            e.values
                .iter()
                .map(|v| (v.clone(), names.take(&identifier(v))))
                .collect()
        })
        .collect();
    let enum_index: HashMap<(&str, &str), usize> = catalog
        .enums
        .iter()
        .enumerate()
        .map(|(i, e)| ((e.schema.as_str(), e.name.as_str()), i))
        .collect();
    let table_index: HashMap<(&str, &str), usize> = catalog
        .tables
        .iter()
        .enumerate()
        .map(|(i, t)| ((t.schema.as_str(), t.name.as_str()), i))
        .collect();

    let mut models: Vec<Block> = catalog
        .tables
        .iter()
        .zip(&model_names)
        .map(|(table, name)| {
            let mut block = Block {
                name: name.clone(),
                lines: Vec::new(),
                attrs: Vec::new(),
                taken: Names::default(),
                columns: HashMap::new(),
                unique_sets: HashSet::new(),
                ignored: false,
            };
            for col in &table.columns {
                let field = block.taken.take(&identifier(&col.name));
                let enum_at = (col.type_kind == "e")
                    .then(|| enum_index.get(&(col.type_schema.as_str(), col.type_name.as_str())))
                    .flatten();
                let (base, native) = match enum_at {
                    Some(&i) => (enum_names[i].clone(), None),
                    None => scalar(col),
                };
                let values = enum_at.map(|&i| enum_values[i].as_slice());
                let mut attrs = Vec::new();
                if let Some(value) = default_value(col, &base, values) {
                    attrs.push(format!("@default({value})"));
                }
                if field != col.name {
                    attrs.push(format!("@map({})", quote(&col.name)));
                }
                attrs.extend(native);
                let ty = if base.starts_with("Unsupported(") || !col.list {
                    format!("{base}{}", if col.not_null { "" } else { "?" })
                } else {
                    format!("{base}[]")
                };
                block.columns.insert(col.name.clone(), block.lines.len());
                block.lines.push(Line {
                    name: field,
                    ty,
                    attrs,
                    doc: col.comment.clone(),
                    ..Default::default()
                });
            }
            add_indexes(&mut block, table);
            block.ignored = table.kind == "table" && block.unique_sets.is_empty();
            block
        })
        .collect();

    // Foreign keys whose both ends were pulled become relation fields.
    let mut links = Vec::new();
    for (child, table) in catalog.tables.iter().enumerate() {
        for fk in &table.foreign_keys {
            let parent = table_index
                .get(&(fk.ref_schema.as_str(), fk.ref_table.as_str()))
                .copied()
                .filter(|&p| {
                    !fk.columns.is_empty()
                        && fk.columns.len() == fk.ref_columns.len()
                        && fk
                            .columns
                            .iter()
                            .all(|c| models[child].columns.contains_key(c))
                        && fk
                            .ref_columns
                            .iter()
                            .all(|c| models[p].columns.contains_key(c))
                });
            match parent {
                Some(parent) => links.push((child, parent, fk)),
                None => {
                    if let Some(&i) = fk
                        .columns
                        .first()
                        .and_then(|c| models[child].columns.get(c))
                    {
                        let line = &mut models[child].lines[i];
                        line.note.get_or_insert(format!(
                            "references {}.{}({})",
                            fk.ref_schema,
                            fk.ref_table,
                            fk.ref_columns.join(", ")
                        ));
                    }
                }
            }
        }
    }
    let mut pair_count: HashMap<(usize, usize), usize> = HashMap::new();
    for &(child, parent, _) in &links {
        *pair_count
            .entry((child.min(parent), child.max(parent)))
            .or_default() += 1;
    }

    for (child, parent, fk) in links {
        // Prisma needs a relation name when two models are linked more than once.
        let ambiguous = child == parent || pair_count[&(child.min(parent), child.max(parent))] > 1;
        let relation_name = ambiguous.then(|| quote(&fk.name));
        let child_table = &catalog.tables[child];
        let optional = fk.columns.iter().any(|c| {
            !child_table
                .columns
                .iter()
                .any(|col| &col.name == c && col.not_null)
        });
        let mut key = fk.columns.clone();
        key.sort();
        let one_to_one = models[child].unique_sets.contains(&key);

        let fields: Vec<&str> = fk
            .columns
            .iter()
            .filter_map(|c| models[child].field(c))
            .collect();
        let references: Vec<&str> = fk
            .ref_columns
            .iter()
            .filter_map(|c| models[parent].field(c))
            .collect();
        let mut args: Vec<String> = relation_name.iter().cloned().collect();
        args.push(format!("fields: [{}]", fields.join(", ")));
        args.push(format!("references: [{}]", references.join(", ")));
        // Written only when they differ from Prisma's defaults, like `prisma db pull`.
        let default_delete = if optional { "n" } else { "r" };
        if let Some(action) = (fk.on_delete != default_delete)
            .then(|| referential_action(&fk.on_delete))
            .flatten()
        {
            args.push(format!("onDelete: {action}"));
        }
        if let Some(action) = (fk.on_update != "c")
            .then(|| referential_action(&fk.on_update))
            .flatten()
        {
            args.push(format!("onUpdate: {action}"));
        }

        let parent_name = models[parent].name.clone();
        let child_name = models[child].name.clone();
        let wanted = match fk.columns.as_slice() {
            [column] => relation_field_base(column).map(identifier),
            _ => None,
        }
        .unwrap_or_else(|| parent_name.clone());
        let field = models[child].taken.take(&wanted);
        let back_wanted = if ambiguous {
            format!("{child_name}_{field}")
        } else {
            child_name.clone()
        };
        let back = models[parent].taken.take(&back_wanted);

        // Prisma requires fields pointing at an ignored model to be ignored too.
        let mut attrs = vec![format!("@relation({})", args.join(", "))];
        if models[parent].ignored && !models[child].ignored {
            attrs.push("@ignore".into());
        }
        models[child].lines.push(Line {
            name: field,
            ty: format!("{parent_name}{}", if optional { "?" } else { "" }),
            attrs,
            ..Default::default()
        });
        let mut attrs: Vec<String> = relation_name
            .iter()
            .map(|n| format!("@relation({n})"))
            .collect();
        if models[child].ignored && !models[parent].ignored {
            attrs.push("@ignore".into());
        }
        models[parent].lines.push(Line {
            name: back,
            ty: format!("{child_name}{}", if one_to_one { "?" } else { "[]" }),
            attrs,
            ..Default::default()
        });
    }

    let schemas: BTreeSet<&str> = catalog
        .tables
        .iter()
        .map(|t| t.schema.as_str())
        .chain(catalog.enums.iter().map(|e| e.schema.as_str()))
        .collect();
    let multi_schema = schemas.len() > 1;

    let mut out = vec![
        format!("// Pulled from {source} by Prismagram."),
        String::new(),
        "datasource db {".into(),
        "  provider = \"postgresql\"".into(),
        "  url      = env(\"DATABASE_URL\")".into(),
    ];
    if multi_schema {
        let list: Vec<String> = schemas.iter().map(|s| quote(s)).collect();
        out.push(format!("  schemas  = [{}]", list.join(", ")));
    }
    out.push("}".into());

    for (table, mut block) in catalog.tables.iter().zip(models) {
        let mut doc: Vec<String> = table.comment.iter().map(String::clone).collect();
        if block.ignored {
            doc.push(
                "Prisma Client can't use this table: it has no primary key or unique column."
                    .into(),
            );
        }
        if block.name != table.name {
            block.attrs.push(format!("@@map({})", quote(&table.name)));
        }
        if block.ignored {
            block.attrs.push("@@ignore".into());
        }
        if multi_schema {
            block
                .attrs
                .push(format!("@@schema({})", quote(&table.schema)));
        }
        let keyword = if table.kind == "view" {
            "view"
        } else {
            "model"
        };
        write_block(
            &mut out,
            keyword,
            &block.name,
            &doc,
            &block.lines,
            &block.attrs,
        );
    }

    for ((e, name), values) in catalog.enums.iter().zip(&enum_names).zip(&enum_values) {
        let lines: Vec<Line> = values
            .iter()
            .map(|(label, value)| Line {
                name: value.clone(),
                attrs: (label != value)
                    .then(|| format!("@map({})", quote(label)))
                    .into_iter()
                    .collect(),
                ..Default::default()
            })
            .collect();
        let mut attrs = Vec::new();
        if name != &e.name {
            attrs.push(format!("@@map({})", quote(&e.name)));
        }
        if multi_schema {
            attrs.push(format!("@@schema({})", quote(&e.schema)));
        }
        let doc: Vec<String> = e.comment.iter().map(String::clone).collect();
        write_block(&mut out, "enum", name, &doc, &lines, &attrs);
    }

    out.push(String::new());
    out.join("\n")
}

/// Model or enum names: the database name, or `schema_name` when two schemas share it.
fn top_level_names<'a>(
    items: impl Iterator<Item = (&'a str, &'a str)> + Clone,
    taken: &mut Names,
    suffix: &str,
) -> Vec<String> {
    let mut count: HashMap<String, usize> = HashMap::new();
    for (_, name) in items.clone() {
        *count.entry(identifier(name)).or_default() += 1;
    }
    items
        .map(|(schema, name)| {
            let mut wanted = identifier(name);
            if count[&wanted] > 1 {
                wanted = identifier(&format!("{schema}_{name}"));
            }
            if !suffix.is_empty() && taken.0.contains(&wanted) {
                wanted.push_str(suffix);
            }
            taken.take(&wanted)
        })
        .collect()
}

fn add_indexes(block: &mut Block, table: &Table) {
    let mut indexes: Vec<&Index> = table
        .indexes
        .iter()
        .filter(|i| {
            !i.columns.is_empty() && i.columns.iter().all(|c| block.columns.contains_key(c))
        })
        .collect();
    indexes.sort_by_key(|i| (!i.primary, !i.unique));
    let mut seen: HashSet<Vec<String>> = HashSet::new();

    for index in indexes {
        let mut key = index.columns.clone();
        key.sort();
        let fields: Vec<&str> = index
            .columns
            .iter()
            .filter_map(|c| block.field(c))
            .collect();
        let list = fields.join(", ");
        let single = (index.columns.len() == 1).then(|| block.columns[&index.columns[0]]);
        if index.primary || index.unique {
            if !block.unique_sets.insert(key) {
                continue;
            }
            seen.insert(index.columns.clone());
            match (single, index.primary) {
                (Some(i), true) => block.lines[i].id = true,
                (Some(i), false) => block.lines[i].unique = true,
                (None, true) => block.attrs.push(format!("@@id([{list}])")),
                (None, false) => block.attrs.push(format!("@@unique([{list}])")),
            }
        } else if seen.insert(index.columns.clone()) {
            block.attrs.push(format!("@@index([{list}])"));
        }
    }
}

fn write_block(
    out: &mut Vec<String>,
    keyword: &str,
    name: &str,
    doc: &[String],
    lines: &[Line],
    attrs: &[String],
) {
    out.push(String::new());
    for d in doc.iter().flat_map(|d| d.lines()) {
        out.push(format!("/// {d}").trim_end().to_string());
    }
    out.push(format!("{keyword} {name} {{"));
    let name_width = lines.iter().map(|l| l.name.len()).max().unwrap_or(0);
    let type_width = lines.iter().map(|l| l.ty.len()).max().unwrap_or(0);
    for line in lines {
        for d in line.doc.iter().flat_map(|d| d.lines()) {
            out.push(format!("  /// {d}").trim_end().to_string());
        }
        let mut parts = vec![format!("{:name_width$}", line.name)];
        if type_width > 0 {
            parts.push(format!("{:type_width$}", line.ty));
        }
        parts.extend(line.id.then(|| "@id".to_string()));
        parts.extend(line.unique.then(|| "@unique".to_string()));
        parts.extend(line.attrs.iter().cloned());
        let mut text = format!("  {}", parts.join(" ").trim_end());
        if let Some(note) = &line.note {
            text.push_str(&format!(" // {note}"));
        }
        out.push(text);
    }
    if !attrs.is_empty() {
        if !lines.is_empty() {
            out.push(String::new());
        }
        out.extend(attrs.iter().map(|a| format!("  {a}")));
    }
    out.push("}".into());
}

/// The Prisma scalar type for a column, and its `@db.*` native type when Prisma's default
/// mapping isn't the one in the database.
fn scalar(col: &Column) -> (String, Option<String>) {
    let m = col.typmod;
    // Postgres stores no precision as -1 and defaults it to 6.
    let precision = if m >= 0 { m } else { 6 };
    let (base, native) = match col.type_name.as_str() {
        "text" => ("String", None),
        "varchar" => (
            "String",
            Some(if m > 4 {
                format!("VarChar({})", m - 4)
            } else {
                "VarChar".into()
            }),
        ),
        "bpchar" => (
            "String",
            Some(format!("Char({})", if m > 4 { m - 4 } else { 1 })),
        ),
        "uuid" => ("String", Some("Uuid".into())),
        "citext" => ("String", Some("Citext".into())),
        "inet" => ("String", Some("Inet".into())),
        "xml" => ("String", Some("Xml".into())),
        "bit" => ("String", Some(format!("Bit({})", m.max(1)))),
        "varbit" => (
            "String",
            Some(if m > 0 {
                format!("VarBit({m})")
            } else {
                "VarBit".into()
            }),
        ),
        "int2" => ("Int", Some("SmallInt".into())),
        "int4" => ("Int", None),
        "oid" => ("Int", Some("Oid".into())),
        "int8" => ("BigInt", None),
        "float4" => ("Float", Some("Real".into())),
        "float8" => ("Float", None),
        "numeric" => (
            "Decimal",
            Some(if m > 4 {
                format!(
                    "Decimal({}, {})",
                    ((m - 4) >> 16) & 0xffff,
                    (m - 4) & 0xffff
                )
            } else {
                "Decimal".into()
            }),
        ),
        "money" => ("Decimal", Some("Money".into())),
        "bool" => ("Boolean", None),
        "timestamp" => (
            "DateTime",
            (precision != 3).then(|| format!("Timestamp({precision})")),
        ),
        "timestamptz" => ("DateTime", Some(format!("Timestamptz({precision})"))),
        "date" => ("DateTime", Some("Date".into())),
        "time" => ("DateTime", Some(format!("Time({precision})"))),
        "timetz" => ("DateTime", Some(format!("Timetz({precision})"))),
        "json" => ("Json", Some("Json".into())),
        "jsonb" => ("Json", None),
        "bytea" => ("Bytes", None),
        _ => return (format!("Unsupported({})", quote(&col.full_type)), None),
    };
    (base.to_string(), native.map(|n| format!("@db.{n}")))
}

/// The argument of `@default(...)` for a column's database default.
fn default_value(
    col: &Column,
    base: &str,
    enum_values: Option<&[(String, String)]>,
) -> Option<String> {
    if col.generated {
        return None;
    }
    if col.identity {
        return Some("autoincrement()".into());
    }
    let expr = col.default.as_deref()?.trim();
    let lower = expr.to_ascii_lowercase();
    if lower.starts_with("nextval(") {
        return Some("autoincrement()".into());
    }
    if matches!(
        lower.as_str(),
        "now()" | "current_timestamp" | "transaction_timestamp()"
    ) {
        return Some("now()".into());
    }
    if lower == "null" || lower.starts_with("null::") {
        return None;
    }
    let literal = string_literal(expr);
    if col.list {
        if literal.as_deref() == Some("{}") || lower.starts_with("array[]") {
            return Some("[]".into());
        }
    } else if let Some(values) = enum_values {
        if let Some((_, value)) = values
            .iter()
            .find(|(label, _)| Some(label) == literal.as_ref())
        {
            return Some(value.clone());
        }
    } else {
        match base {
            "String" | "Json" if literal.is_some() => return literal.as_deref().map(quote),
            "Boolean" if lower == "true" || lower == "false" => return Some(lower),
            "Int" | "BigInt" | "Float" | "Decimal" => {
                let number = literal.unwrap_or_else(|| bare(expr).to_string());
                let digits = number.strip_prefix('-').unwrap_or(&number);
                if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit() || c == '.') {
                    return Some(number);
                }
            }
            _ => {}
        }
    }
    Some(format!("dbgenerated({})", quote(expr)))
}

/// `'it''s'::text` gives `it's`. None unless the whole expression is one quoted literal,
/// optionally cast.
fn string_literal(expr: &str) -> Option<String> {
    let rest = expr.strip_prefix('\'')?;
    let mut value = String::new();
    let mut chars = rest.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if c == '\'' {
            if chars.peek().map(|&(_, next)| next) == Some('\'') {
                chars.next();
                value.push('\'');
                continue;
            }
            // Only a cast may follow: `'a'::character varying(10)[]`, not `'a' || 'b'`.
            let tail = &rest[i + 1..];
            let cast = tail.starts_with("::")
                && tail
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || " _.,:[]()\"".contains(c));
            return (tail.is_empty() || cast).then_some(value);
        }
        value.push(c);
    }
    None
}

/// `(-1)::integer` gives `-1`.
fn bare(expr: &str) -> &str {
    let e = expr.split("::").next().unwrap_or(expr).trim();
    e.strip_prefix('(')
        .and_then(|e| e.strip_suffix(')'))
        .unwrap_or(e)
        .trim()
}

fn referential_action(code: &str) -> Option<&'static str> {
    Some(match code {
        "a" => "NoAction",
        "r" => "Restrict",
        "c" => "Cascade",
        "n" => "SetNull",
        "d" => "SetDefault",
        _ => return None,
    })
}

/// `author_id` or `authorId` gives `author`.
fn relation_field_base(column: &str) -> Option<&str> {
    let base = column
        .strip_suffix("_id")
        .or_else(|| column.strip_suffix("_ID"))
        .or_else(|| column.strip_suffix("Id"))?;
    (!base.is_empty()).then_some(base)
}

/// A valid Prisma identifier for a database name; callers add `@map` when it differs.
fn identifier(raw: &str) -> String {
    let mut id: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if !id.starts_with(|c: char| c.is_ascii_alphabetic()) {
        id.insert(0, 'x');
    }
    id
}

fn quote(s: &str) -> String {
    let mut out = String::from('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, type_name: &str, not_null: bool) -> serde_json::Value {
        serde_json::json!({
            "name": name, "typeName": type_name, "typeSchema": "pg_catalog", "typeKind": "b",
            "fullType": type_name, "list": false, "typmod": -1, "notNull": not_null,
            "default": null, "identity": false, "generated": false, "comment": null
        })
    }

    fn with(mut v: serde_json::Value, patch: serde_json::Value) -> serde_json::Value {
        for (k, val) in patch.as_object().unwrap() {
            v[k] = val.clone();
        }
        v
    }

    fn pk(columns: &[&str]) -> serde_json::Value {
        serde_json::json!({ "name": "pkey", "primary": true, "unique": true, "columns": columns })
    }

    fn fk(
        name: &str,
        columns: &[&str],
        table: &str,
        refs: &[&str],
        on_delete: &str,
    ) -> serde_json::Value {
        serde_json::json!({
            "name": name, "columns": columns, "refSchema": "public", "refTable": table,
            "refColumns": refs, "onDelete": on_delete, "onUpdate": "a"
        })
    }

    /// A small Supabase-style project: profiles keyed by `auth.users`, which isn't pulled.
    fn supabase() -> Catalog {
        let json = serde_json::json!({
            "tables": [
                {
                    "schema": "public", "name": "audit_log", "kind": "table",
                    "columns": [col("message", "text", true)]
                },
                {
                    "schema": "public", "name": "categories", "kind": "table",
                    "columns": [
                        with(col("id", "int4", true), serde_json::json!({ "default": "nextval('categories_id_seq'::regclass)" })),
                        col("parent_id", "int4", false)
                    ],
                    "indexes": [pk(&["id"])],
                    "foreignKeys": [fk("categories_parent_id_fkey", &["parent_id"], "categories", &["id"], "n")]
                },
                {
                    "schema": "public", "name": "post_likes", "kind": "table",
                    "columns": [col("post_id", "int8", true), col("profile_id", "uuid", true)],
                    "indexes": [pk(&["post_id", "profile_id"])],
                    "foreignKeys": [
                        fk("post_likes_post_id_fkey", &["post_id"], "posts", &["id"], "c"),
                        fk("post_likes_profile_id_fkey", &["profile_id"], "profiles", &["id"], "c")
                    ]
                },
                {
                    "schema": "public", "name": "posts", "kind": "table", "comment": "Blog posts",
                    "columns": [
                        with(col("id", "int8", true), serde_json::json!({ "identity": true })),
                        col("author_id", "uuid", true),
                        col("editor_id", "uuid", false),
                        with(col("title", "varchar", true), serde_json::json!({ "typmod": 124 })),
                        with(col("status", "post_status", true), serde_json::json!({
                            "typeSchema": "public", "typeKind": "e", "default": "'in-review'::post_status"
                        })),
                        with(col("tags", "text", true), serde_json::json!({ "list": true, "default": "'{}'::text[]" })),
                        with(col("Rating", "numeric", false), serde_json::json!({ "typmod": 196613, "default": "0" })),
                        with(col("created_at", "timestamptz", true), serde_json::json!({ "default": "now()" })),
                        with(col("search", "tsvector", false), serde_json::json!({ "generated": true }))
                    ],
                    "indexes": [
                        pk(&["id"]),
                        { "name": "posts_author_idx", "primary": false, "unique": false, "columns": ["author_id", "created_at"] }
                    ],
                    "foreignKeys": [
                        fk("posts_author_id_fkey", &["author_id"], "profiles", &["id"], "c"),
                        fk("posts_editor_id_fkey", &["editor_id"], "profiles", &["id"], "n")
                    ]
                },
                {
                    "schema": "public", "name": "profiles", "kind": "table",
                    "columns": [
                        col("id", "uuid", true),
                        with(col("username", "text", false), serde_json::json!({ "comment": "Shown on posts" })),
                        with(col("bio", "text", true), serde_json::json!({ "default": "'it''s me'::text" }))
                    ],
                    "indexes": [
                        pk(&["id"]),
                        { "name": "profiles_username_key", "primary": false, "unique": true, "columns": ["username"] }
                    ],
                    "foreignKeys": [{
                        "name": "profiles_id_fkey", "columns": ["id"], "refSchema": "auth", "refTable": "users",
                        "refColumns": ["id"], "onDelete": "c", "onUpdate": "a"
                    }]
                },
                {
                    "schema": "public", "name": "settings", "kind": "table",
                    "columns": [col("profile_id", "uuid", true), col("theme", "text", false)],
                    "indexes": [pk(&["profile_id"])],
                    "foreignKeys": [fk("settings_profile_id_fkey", &["profile_id"], "profiles", &["id"], "c")]
                }
            ],
            "enums": [{ "schema": "public", "name": "post_status", "values": ["draft", "published", "in-review"] }]
        });
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn pulled_schema_parses_cleanly() {
        let text = to_prisma(&supabase(), "db.example.supabase.co/postgres");
        let schema = crate::parse(&text);
        assert!(
            schema.diagnostics.is_empty(),
            "{:?}\n{text}",
            schema.diagnostics
        );
        assert_eq!(schema.models.len(), 6);
        assert_eq!(
            schema.enums[0].values,
            vec!["draft", "published", "in_review"]
        );
        assert_eq!(schema.relations.len(), 6, "{text}");

        let find = |p: &str, c: &str| -> Vec<&crate::Relation> {
            schema
                .relations
                .iter()
                .filter(|r| r.parent == p && r.child == c)
                .collect()
        };
        assert_eq!(find("profiles", "posts").len(), 2);
        assert!(find("profiles", "posts").iter().all(|r| r.name.is_some()));
        assert_eq!(find("profiles", "settings")[0].kind, "one-to-one");
        assert_eq!(find("categories", "categories").len(), 1);
    }

    #[test]
    fn writes_fields_like_db_pull() {
        let text = to_prisma(&supabase(), "db.example.supabase.co/postgres");
        for expected in [
            "// Pulled from db.example.supabase.co/postgres by Prismagram.",
            "@id @default(autoincrement())",
            "@default(in_review)",
            "in_review @map(\"in-review\")",
            "String[]                 @default([])",
            "Decimal?                 @default(0) @db.Decimal(3, 1)",
            "@default(now()) @db.Timestamptz(6)",
            "@db.VarChar(120)",
            "Unsupported(\"tsvector\")?",
            "@default(\"it's me\")",
            "@@id([post_id, profile_id])",
            "@@index([author_id, created_at])",
            "@unique",
            "/// Shown on posts",
            "/// Blog posts",
            "// references auth.users(id)",
            "profiles                 @relation(\"posts_author_id_fkey\", fields: [author_id], references: [id], onDelete: Cascade, onUpdate: NoAction)",
            "@relation(\"categories_parent_id_fkey\", fields: [parent_id], references: [id], onUpdate: NoAction)",
            "@@ignore",
        ] {
            assert!(text.contains(expected), "missing `{expected}` in\n{text}");
        }
        // Generated columns have no default.
        assert!(!text.contains("dbgenerated"), "{text}");
        assert!(!text.contains("schemas"), "{text}");
    }

    #[test]
    fn same_name_in_two_schemas() {
        let json = serde_json::json!({
            "tables": [
                { "schema": "auth", "name": "users", "kind": "table", "columns": [col("id", "uuid", true)], "indexes": [pk(&["id"])] },
                {
                    "schema": "public", "name": "users", "kind": "table",
                    "columns": [col("id", "uuid", true), col("my-name", "text", false)],
                    "indexes": [pk(&["id"])],
                    "foreignKeys": [{
                        "name": "users_id_fkey", "columns": ["id"], "refSchema": "auth", "refTable": "users",
                        "refColumns": ["id"], "onDelete": "c", "onUpdate": "a"
                    }]
                }
            ]
        });
        let text = to_prisma(&serde_json::from_value(json).unwrap(), "localhost/postgres");
        let schema = crate::parse(&text);
        assert!(
            schema.diagnostics.is_empty(),
            "{:?}\n{text}",
            schema.diagnostics
        );
        let names: Vec<&str> = schema.models.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, vec!["auth_users", "public_users"]);
        for expected in [
            "schemas  = [\"auth\", \"public\"]",
            "@@map(\"users\")",
            "@@schema(\"auth\")",
            "my_name ",
            "@map(\"my-name\")",
        ] {
            assert!(text.contains(expected), "missing `{expected}` in\n{text}");
        }
        assert_eq!(schema.relations[0].kind, "one-to-one");
    }

    #[test]
    fn defaults() {
        let c = |default: &str| Column {
            default: Some(default.into()),
            ..Default::default()
        };
        assert_eq!(
            default_value(&c("'a\"b'::character varying"), "String", None).as_deref(),
            Some("\"a\\\"b\"")
        );
        assert_eq!(
            default_value(&c("(-1)"), "Int", None).as_deref(),
            Some("-1")
        );
        assert_eq!(
            default_value(&c("'1.5'::numeric"), "Decimal", None).as_deref(),
            Some("1.5")
        );
        assert_eq!(default_value(&c("NULL::text"), "String", None), None);
        assert_eq!(
            default_value(&c("CURRENT_TIMESTAMP"), "DateTime", None).as_deref(),
            Some("now()")
        );
        assert_eq!(
            default_value(&c("gen_random_uuid()"), "String", None).as_deref(),
            Some("dbgenerated(\"gen_random_uuid()\")")
        );
        assert_eq!(
            default_value(&c("'x'::text || 'y'"), "String", None).as_deref(),
            Some("dbgenerated(\"'x'::text || 'y'\")")
        );
    }

    #[test]
    fn query_quotes_schema_names() {
        let sql = catalog_query(&["public".into(), "it's\\".into()]);
        assert!(sql.contains("array[E'public', E'it''s\\\\']::text[]"));
    }
}
