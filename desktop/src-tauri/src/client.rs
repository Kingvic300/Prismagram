//! The data browser: keeps live connections to PostgreSQL (and Supabase) or MongoDB databases,
//! lists their tables and collections, pages through rows, and runs the queries the user types.
//! Rows reach the UI as JSON. MongoDB documents use relaxed Extended JSON, so `ObjectId`s and
//! dates arrive as `{"$oid": ...}` and `{"$date": ...}`.

use crate::database;
use futures_util::TryStreamExt;
use mongodb::bson::{doc, Bson, Document};
use mongodb::options::ClientOptions;
use mongodb::results::CollectionType;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio_postgres::error::ErrorPosition;
use tokio_postgres::SimpleQueryMessage;

/// Tables larger than this show PostgreSQL's row estimate instead of an exact `count(*)`.
const EXACT_COUNT_LIMIT: i64 = 1_000_000;
/// Rows kept per result in the SQL tab; the rest are counted but not sent to the UI.
const MAX_SQL_ROWS: usize = 2_000;
/// What MongoDB Atlas and Supabase show in connection strings until you paste your password.
const PASSWORD_PLACEHOLDERS: &[&str] = &["<db_password>", "<password>", "[YOUR-PASSWORD]"];

#[derive(Default)]
pub struct Connections {
    next: AtomicU64,
    open: Mutex<HashMap<String, Arc<Connection>>>,
}

enum Connection {
    Postgres(tokio_postgres::Client),
    Mongo(mongodb::Client),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connected {
    pub id: String,
    /// "postgres" or "mongodb".
    pub kind: &'static str,
    /// Host and database name, without credentials.
    pub source: String,
    /// The database (MongoDB) or schema (PostgreSQL) to open first.
    pub default_database: Option<String>,
    pub databases: Vec<Database>,
}

#[derive(Serialize)]
pub struct Database {
    pub name: String,
    /// Left out for MongoDB, where each database's collections are listed when it is opened.
    pub collections: Option<Vec<Collection>>,
}

#[derive(Serialize)]
pub struct Collection {
    pub name: String,
    /// "table", "view", "materialized view", "foreign table", "collection" or "timeseries".
    pub kind: String,
    /// The row count: exact for PostgreSQL tables under EXACT_COUNT_LIMIT rows, otherwise the
    /// planner's estimate (-1 when the table was never analyzed).
    pub count: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindRequest {
    pub database: String,
    pub collection: String,
    /// PostgreSQL: a `where` clause. MongoDB: a filter document as Extended JSON.
    #[serde(default)]
    pub filter: String,
    /// PostgreSQL: an `order by` clause. MongoDB: a sort document.
    #[serde(default)]
    pub sort: String,
    /// MongoDB only: a projection document.
    #[serde(default)]
    pub project: String,
    #[serde(default)]
    pub skip: u64,
    pub limit: u64,
}

#[derive(Serialize)]
pub struct Page {
    /// PostgreSQL only: the table's columns in order, with their type names.
    pub columns: Vec<Column>,
    pub rows: Vec<Value>,
    /// Rows matching the filter, when counting them is cheap enough.
    pub total: Option<u64>,
    pub estimated: bool,
    pub ms: u64,
}

#[derive(Serialize)]
pub struct Column {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
}

#[derive(Serialize)]
pub struct Field {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub primary: bool,
    /// `table.column` for a foreign key.
    pub references: Option<String>,
    pub comment: Option<String>,
}

#[derive(Serialize)]
pub struct Index {
    pub name: String,
    pub definition: String,
    pub unique: bool,
    pub primary: bool,
    pub size: Option<String>,
}

#[derive(Serialize, Default)]
pub struct ResultSet {
    /// Empty for statements that return no rows, such as `update`.
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    /// Rows returned or changed.
    pub count: u64,
    pub truncated: bool,
}

/// A change to a MongoDB collection. Filters, documents and keys are Extended JSON. PostgreSQL
/// tables are changed with SQL instead, through `sql`, so the UI can show the statement it runs.
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Write {
    /// One document, or an array of them.
    InsertOne {
        document: String,
    },
    ReplaceOne {
        filter: String,
        document: String,
    },
    DeleteOne {
        filter: String,
    },
    DeleteMany {
        filter: String,
    },
    /// `update` is an update document like `{ $set: ... }` or a pipeline array.
    UpdateMany {
        filter: String,
        update: String,
    },
    CreateIndex {
        keys: String,
        unique: bool,
        name: String,
    },
    DropIndex {
        name: String,
    },
}

#[derive(Serialize)]
pub struct WriteResult {
    /// Documents inserted, changed or deleted; 1 for index changes.
    pub count: u64,
    pub ms: u64,
}

#[derive(Serialize)]
pub struct QueryResult {
    pub results: Vec<ResultSet>,
    pub ms: u64,
}

impl Connections {
    pub async fn connect(&self, url: &str, password: &str) -> Result<Connected, String> {
        let url = clean_url(url);
        let (connection, source, default_database) = if is_mongo(&url) {
            let (client, source, default) = connect_mongo(&url, password).await?;
            (Connection::Mongo(client), source, default)
        } else {
            let target = database::parse_target(&url, password)?;
            let client = tokio::time::timeout(Duration::from_secs(30), database::connect(&target))
                .await
                .map_err(|_| {
                    format!("{} took longer than 30 seconds to answer.", target.source)
                })??;
            (
                Connection::Postgres(client),
                target.source,
                Some("public".into()),
            )
        };
        let databases = match &connection {
            Connection::Postgres(client) => postgres_tables(client).await?,
            Connection::Mongo(client) => {
                mongo_databases(client, default_database.as_deref()).await?
            }
        };
        let id = format!("c{}", self.next.fetch_add(1, Ordering::Relaxed) + 1);
        let kind = match connection {
            Connection::Postgres(_) => "postgres",
            Connection::Mongo(_) => "mongodb",
        };
        self.open
            .lock()
            .unwrap()
            .insert(id.clone(), Arc::new(connection));
        Ok(Connected {
            id,
            kind,
            source,
            default_database,
            databases,
        })
    }

    pub fn disconnect(&self, id: &str) {
        self.open.lock().unwrap().remove(id);
    }

    fn get(&self, id: &str) -> Result<Arc<Connection>, String> {
        self.open
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| "This connection was closed. Connect again.".into())
    }

    /// Every schema with its tables (PostgreSQL), or every database (MongoDB).
    pub async fn databases(&self, id: &str) -> Result<Vec<Database>, String> {
        match &*self.get(id)? {
            Connection::Postgres(client) => postgres_tables(client).await,
            Connection::Mongo(client) => mongo_databases(client, None).await,
        }
    }

    pub async fn collections(&self, id: &str, database: &str) -> Result<Vec<Collection>, String> {
        match &*self.get(id)? {
            Connection::Postgres(client) => Ok(postgres_tables(client)
                .await?
                .into_iter()
                .find(|d| d.name == database)
                .and_then(|d| d.collections)
                .unwrap_or_default()),
            Connection::Mongo(client) => mongo_collections(client, database).await,
        }
    }

    pub async fn find(&self, id: &str, request: &FindRequest) -> Result<Page, String> {
        let start = Instant::now();
        let mut page = match &*self.get(id)? {
            Connection::Postgres(client) => find_postgres(client, request).await?,
            Connection::Mongo(client) => find_mongo(client, request).await?,
        };
        page.ms = start.elapsed().as_millis() as u64;
        Ok(page)
    }

    /// Runs a MongoDB aggregation pipeline, given as an Extended JSON array of stages.
    pub async fn aggregate(
        &self,
        id: &str,
        database: &str,
        collection: &str,
        pipeline: &str,
        limit: u64,
    ) -> Result<Page, String> {
        let Connection::Mongo(client) = &*self.get(id)? else {
            return Err("Aggregation pipelines only run on MongoDB.".into());
        };
        let start = Instant::now();
        let mut stages = match parse_json(pipeline, "pipeline")? {
            Bson::Array(stages) => stages
                .into_iter()
                .map(|stage| match stage {
                    Bson::Document(stage) => Ok(stage),
                    _ => Err(
                        "Each pipeline stage must be a document, like { $match: {} }.".to_string(),
                    ),
                })
                .collect::<Result<Vec<_>, _>>()?,
            Bson::Document(stage) => vec![stage],
            _ => return Err("The pipeline must be an array of stages.".into()),
        };
        let writes = stages
            .last()
            .is_some_and(|s| s.contains_key("$out") || s.contains_key("$merge"));
        if !writes {
            stages.push(doc! { "$limit": limit as i64 });
        }
        let docs: Vec<Document> = client
            .database(database)
            .collection::<Document>(collection)
            .aggregate(stages)
            .await
            .map_err(mongo_message)?
            .try_collect()
            .await
            .map_err(mongo_message)?;
        Ok(Page {
            columns: Vec::new(),
            total: None,
            estimated: false,
            rows: docs
                .into_iter()
                .map(|d| Bson::Document(d).into_relaxed_extjson())
                .collect(),
            ms: start.elapsed().as_millis() as u64,
        })
    }

    /// A PostgreSQL table's columns with their keys and defaults. MongoDB has no fixed columns:
    /// the UI samples documents instead.
    pub async fn columns(&self, id: &str, schema: &str, table: &str) -> Result<Vec<Field>, String> {
        let Connection::Postgres(client) = &*self.get(id)? else {
            return Err("Only PostgreSQL tables have fixed columns.".into());
        };
        let sql = "select a.attname::text, format_type(a.atttypid, a.atttypmod), not a.attnotnull, \
                   pg_get_expr(d.adbin, d.adrelid), \
                   exists (select 1 from pg_index i where i.indrelid = a.attrelid and i.indisprimary \
                           and a.attnum = any (i.indkey)), \
                   (select string_agg(cf.relname || '.' || af.attname, ', ') \
                      from pg_constraint fk \
                      join pg_class cf on cf.oid = fk.confrelid \
                      join pg_attribute af on af.attrelid = fk.confrelid \
                       and af.attnum = fk.confkey[array_position(fk.conkey, a.attnum)] \
                     where fk.conrelid = a.attrelid and fk.contype = 'f' and a.attnum = any (fk.conkey)), \
                   col_description(a.attrelid, a.attnum) \
                   from pg_attribute a \
                   left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum \
                   where a.attrelid = to_regclass($1) and a.attnum > 0 and not a.attisdropped \
                   order by a.attnum";
        let rows = client
            .query(sql, &[&qualified(schema, table)])
            .await
            .map_err(|e| sql_error(&e, None))?;
        Ok(rows
            .iter()
            .map(|r| Field {
                name: r.get(0),
                ty: r.get(1),
                nullable: r.get(2),
                default: r.get(3),
                primary: r.get(4),
                references: r.get(5),
                comment: r.get(6),
            })
            .collect())
    }

    pub async fn indexes(
        &self,
        id: &str,
        database: &str,
        collection: &str,
    ) -> Result<Vec<Index>, String> {
        match &*self.get(id)? {
            Connection::Postgres(client) => {
                let sql = "select i.relname::text, pg_get_indexdef(i.oid), ix.indisunique, ix.indisprimary, \
                           pg_size_pretty(pg_relation_size(i.oid)) \
                           from pg_index ix join pg_class i on i.oid = ix.indexrelid \
                           where ix.indrelid = to_regclass($1) \
                           order by ix.indisprimary desc, 1";
                let rows = client
                    .query(sql, &[&qualified(database, collection)])
                    .await
                    .map_err(|e| sql_error(&e, None))?;
                Ok(rows
                    .iter()
                    .map(|r| Index {
                        name: r.get(0),
                        definition: r.get(1),
                        unique: r.get(2),
                        primary: r.get(3),
                        size: r.get(4),
                    })
                    .collect())
            }
            Connection::Mongo(client) => {
                let models: Vec<mongodb::IndexModel> = client
                    .database(database)
                    .collection::<Document>(collection)
                    .list_indexes()
                    .await
                    .map_err(mongo_message)?
                    .try_collect()
                    .await
                    .map_err(mongo_message)?;
                Ok(models
                    .into_iter()
                    .map(|m| {
                        let options = m.options.unwrap_or_default();
                        let name = options.name.unwrap_or_default();
                        let mut definition =
                            Bson::Document(m.keys).into_relaxed_extjson().to_string();
                        if options.sparse == Some(true) {
                            definition.push_str(" sparse");
                        }
                        if let Some(ttl) = options.expire_after {
                            definition.push_str(&format!(" TTL {}s", ttl.as_secs()));
                        }
                        Index {
                            primary: name == "_id_",
                            unique: options.unique == Some(true) || name == "_id_",
                            name,
                            definition,
                            size: None,
                        }
                    })
                    .collect())
            }
        }
    }

    pub async fn write(
        &self,
        id: &str,
        database: &str,
        collection: &str,
        write: &Write,
    ) -> Result<WriteResult, String> {
        let Connection::Mongo(client) = &*self.get(id)? else {
            return Err("PostgreSQL tables are changed with SQL.".into());
        };
        let start = Instant::now();
        let coll = client.database(database).collection::<Document>(collection);
        let count = match write {
            Write::InsertOne { document } => match parse_json(document, "document")? {
                Bson::Document(doc) => coll.insert_one(doc).await.map(|_| 1),
                Bson::Array(items) => {
                    let docs = items
                        .into_iter()
                        .map(|item| match item {
                            Bson::Document(doc) => Ok(doc),
                            _ => Err("Each item to insert must be a document.".to_string()),
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    if docs.is_empty() {
                        return Err("There is nothing to insert.".into());
                    }
                    coll.insert_many(docs)
                        .await
                        .map(|r| r.inserted_ids.len() as u64)
                }
                _ => return Err("Insert a document, like { name: 'Ada' }.".into()),
            },
            Write::ReplaceOne { filter, document } => coll
                .replace_one(
                    parse_document(filter, "filter")?,
                    parse_document(document, "document")?,
                )
                .await
                .map(|r| r.matched_count),
            Write::DeleteOne { filter } => coll
                .delete_one(parse_document(filter, "filter")?)
                .await
                .map(|r| r.deleted_count),
            Write::DeleteMany { filter } => coll
                .delete_many(parse_document(filter, "filter")?)
                .await
                .map(|r| r.deleted_count),
            Write::UpdateMany { filter, update } => {
                let filter = parse_document(filter, "filter")?;
                match parse_json(update, "update")? {
                    Bson::Document(update) => coll.update_many(filter, update).await,
                    Bson::Array(stages) => {
                        let stages = stages
                            .into_iter()
                            .map(|stage| match stage {
                                Bson::Document(stage) => Ok(stage),
                                _ => Err("Each pipeline stage must be a document.".to_string()),
                            })
                            .collect::<Result<Vec<_>, _>>()?;
                        coll.update_many(filter, stages).await
                    }
                    _ => {
                        return Err(
                            "The update must be a document, like { $set: { status: 'done' } }."
                                .into(),
                        )
                    }
                }
                .map(|r| r.modified_count)
            }
            Write::CreateIndex { keys, unique, name } => {
                let options = mongodb::options::IndexOptions::builder()
                    .unique(unique.then_some(true))
                    .name((!name.trim().is_empty()).then(|| name.trim().to_string()))
                    .build();
                let model = mongodb::IndexModel::builder()
                    .keys(parse_document(keys, "index keys")?)
                    .options(options)
                    .build();
                coll.create_index(model).await.map(|_| 1)
            }
            Write::DropIndex { name } => coll.drop_index(name.as_str()).await.map(|_| 1),
        }
        .map_err(mongo_message)?;
        Ok(WriteResult {
            count,
            ms: start.elapsed().as_millis() as u64,
        })
    }

    /// Runs SQL typed by the user, which may hold several statements. `schema` goes first on
    /// the search path, so unqualified table names resolve to the schema being browsed.
    pub async fn sql(&self, id: &str, schema: &str, sql: &str) -> Result<QueryResult, String> {
        let Connection::Postgres(client) = &*self.get(id)? else {
            return Err("SQL only runs on PostgreSQL. Use an aggregation pipeline instead.".into());
        };
        if !schema.is_empty() {
            client
                .batch_execute(&format!("set search_path to {}, public", ident(schema)))
                .await
                .map_err(|e| sql_error(&e, None))?;
        }
        let start = Instant::now();
        let messages = client
            .simple_query(sql)
            .await
            .map_err(|e| sql_error(&e, Some(sql)))?;
        let mut results = Vec::new();
        let mut current: Option<ResultSet> = None;
        for message in messages {
            match message {
                SimpleQueryMessage::RowDescription(columns) => {
                    current = Some(ResultSet {
                        columns: columns.iter().map(|c| c.name().to_string()).collect(),
                        ..Default::default()
                    });
                }
                SimpleQueryMessage::Row(row) => {
                    let set = current.get_or_insert_with(|| ResultSet {
                        columns: row.columns().iter().map(|c| c.name().to_string()).collect(),
                        ..Default::default()
                    });
                    if set.rows.len() < MAX_SQL_ROWS {
                        set.rows.push(
                            (0..row.len())
                                .map(|i| row.get(i).map(str::to_string))
                                .collect(),
                        );
                    } else {
                        set.truncated = true;
                    }
                }
                SimpleQueryMessage::CommandComplete(count) => {
                    let mut set = current.take().unwrap_or_default();
                    set.count = count;
                    results.push(set);
                }
                _ => {}
            }
        }
        Ok(QueryResult {
            results,
            ms: start.elapsed().as_millis() as u64,
        })
    }
}

// ---------------------------------------------------------------- PostgreSQL

async fn postgres_tables(client: &tokio_postgres::Client) -> Result<Vec<Database>, String> {
    let sql = "select n.nspname::text, c.relname::text, c.relkind::text, c.reltuples::bigint, \
               c.relkind in ('r', 'p', 'm') and has_table_privilege(c.oid, 'SELECT') \
               from pg_class c join pg_namespace n on n.oid = c.relnamespace \
               where c.relkind in ('r', 'p', 'v', 'm', 'f') and not c.relispartition \
               and n.nspname !~ '^pg_' and n.nspname <> 'information_schema' \
               and has_schema_privilege(n.oid, 'USAGE') \
               order by n.nspname <> 'public', 1, 2";
    let rows = client
        .query(sql, &[])
        .await
        .map_err(|e| format!("Could not list the tables: {}", sql_error(&e, None)))?;
    let mut databases: Vec<Database> = Vec::new();
    // Tables small enough to count exactly, as `(schema, table)` in list order.
    let mut small: Vec<(String, String)> = Vec::new();
    for row in rows {
        let schema: String = row.get(0);
        let estimate: i64 = row.get(3);
        if row.get::<_, bool>(4) && estimate < EXACT_COUNT_LIMIT {
            small.push((schema.clone(), row.get(1)));
        }
        let kind = match row.get::<_, &str>(2) {
            "v" => "view",
            "m" => "materialized view",
            "f" => "foreign table",
            _ => "table",
        };
        let table = Collection {
            name: row.get(1),
            kind: kind.into(),
            count: Some(estimate),
        };
        match databases.last_mut() {
            Some(db) if db.name == schema => {
                db.collections.get_or_insert_with(Vec::new).push(table)
            }
            _ => databases.push(Database {
                name: schema,
                collections: Some(vec![table]),
            }),
        }
    }

    // reltuples only changes on VACUUM and ANALYZE, so on a small or freshly written table it
    // is often far off or -1. Count those exactly, in one round trip, the way the Rows tab does.
    // If the count fails (a lock, a permission), the estimates stay.
    if !small.is_empty() {
        let sql = small
            .iter()
            .enumerate()
            .map(|(i, (schema, table))| {
                format!("select {i}, count(*) from {}", qualified(schema, table))
            })
            .collect::<Vec<_>>()
            .join(" union all ");
        if let Ok(rows) = client.query(&sql, &[]).await {
            let counts: HashMap<i32, i64> = rows.iter().map(|r| (r.get(0), r.get(1))).collect();
            for (i, (schema, table)) in small.iter().enumerate() {
                let Some(&count) = counts.get(&(i as i32)) else {
                    continue;
                };
                if let Some(c) = databases
                    .iter_mut()
                    .find(|db| &db.name == schema)
                    .and_then(|db| db.collections.as_mut())
                    .and_then(|list| list.iter_mut().find(|c| &c.name == table))
                {
                    c.count = Some(count);
                }
            }
        }
    }
    Ok(databases)
}

async fn find_postgres(
    client: &tokio_postgres::Client,
    request: &FindRequest,
) -> Result<Page, String> {
    let table = qualified(&request.database, &request.collection);
    let filter = clause(&request.filter, "where");
    let sort = clause(&request.sort, "order by");
    let mut from = format!("from {table}");
    if !filter.is_empty() {
        // On its own line, so a trailing `-- comment` can't swallow the rest.
        from.push_str(&format!("\nwhere {filter}\n"));
    }
    let mut select = format!("select * {from}");
    if !sort.is_empty() {
        select.push_str(&format!("\norder by {sort}\n"));
    }
    select.push_str(&format!(" limit {} offset {}", request.limit, request.skip));

    let statement = client
        .prepare(&select)
        .await
        .map_err(|e| sql_error(&e, None))?;
    let columns = statement
        .columns()
        .iter()
        .map(|c| Column {
            name: c.name().into(),
            ty: c.type_().name().into(),
        })
        .collect();
    let json = format!("select coalesce(json_agg(t), '[]')::text from ({select}) t");
    let row = client
        .query_one(&json, &[])
        .await
        .map_err(|e| sql_error(&e, None))?;
    let rows: Vec<Value> = serde_json::from_str(row.get(0)).map_err(|e| e.to_string())?;

    let estimate: i64 = client
        .query_one(
            "select coalesce((select reltuples::bigint from pg_class where oid = to_regclass($1)), -1)",
            &[&table],
        )
        .await
        .map(|r| r.get(0))
        .unwrap_or(-1);
    let (total, estimated) = if estimate >= EXACT_COUNT_LIMIT {
        // Counting a big table can take minutes: show the estimate, or nothing when filtered.
        (filter.is_empty().then_some(estimate as u64), true)
    } else {
        let count = client
            .query_one(&format!("select count(*) {from}"), &[])
            .await
            .map_err(|e| sql_error(&e, None))?;
        (Some(count.get::<_, i64>(0) as u64), false)
    };
    Ok(Page {
        columns,
        rows,
        total,
        estimated,
        ms: 0,
    })
}

/// A clause typed with or without its keyword: `where id = 1` and `id = 1` both give `id = 1`.
fn clause<'a>(text: &'a str, keyword: &str) -> &'a str {
    let text = text.trim().trim_end_matches(';').trim();
    let mut words = keyword.split(' ');
    let mut rest = text;
    for word in words.by_ref() {
        let head = rest.get(..word.len()).unwrap_or("");
        let boundary = rest[head.len()..].starts_with(char::is_whitespace);
        if !head.eq_ignore_ascii_case(word) || !boundary {
            return text;
        }
        rest = rest[word.len()..].trim_start();
    }
    rest
}

fn ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn qualified(schema: &str, table: &str) -> String {
    format!("{}.{}", ident(schema), ident(table))
}

/// A database error with its detail and hint. With `sql`, says which line of it failed.
fn sql_error(e: &tokio_postgres::Error, sql: Option<&str>) -> String {
    let Some(db) = e.as_db_error() else {
        return database::db_message(e);
    };
    let mut message = db.message().to_string();
    if let (Some(sql), Some(ErrorPosition::Original(position))) = (sql, db.position()) {
        let before: String = sql.chars().take(*position as usize).collect();
        message.push_str(&format!(" (line {})", before.matches('\n').count() + 1));
    }
    if let Some(detail) = db.detail() {
        message.push_str(&format!("\n{detail}"));
    }
    if let Some(hint) = db.hint() {
        message.push_str(&format!("\nHint: {hint}"));
    }
    message
}

// ---------------------------------------------------------------- MongoDB

async fn connect_mongo(
    url: &str,
    password: &str,
) -> Result<(mongodb::Client, String, Option<String>), String> {
    let mut url = url.to_string();
    if let Some(placeholder) = PASSWORD_PLACEHOLDERS.iter().find(|p| url.contains(*p)) {
        if password.is_empty() {
            return Err(format!(
                "Replace {placeholder} in the connection string with your database password, or type it in the Password field."
            ));
        }
        // The real password is set below, so it needs no URL encoding.
        url = url.replace(placeholder, "password");
    }
    let mut options = ClientOptions::parse(&url)
        .await
        .map_err(|e| format!("Could not read the connection string: {}", e.kind))?;
    if !password.is_empty() {
        match options.credential.as_mut() {
            Some(credential) if credential.username.is_some() => {
                credential.password = Some(password.into())
            }
            _ => return Err("The connection string has no user name.".into()),
        }
    }
    options.app_name = Some("Prismagram".into());
    options.connect_timeout = Some(Duration::from_secs(15));
    options.server_selection_timeout = Some(Duration::from_secs(15));
    let default = options.default_database.clone();
    let source = mongo_source(&url, default.as_deref());

    let client = mongodb::Client::with_options(options).map_err(mongo_message)?;
    client
        .database(default.as_deref().unwrap_or("admin"))
        .run_command(doc! { "ping": 1 })
        .await
        .map_err(|e| format!("Could not connect to {source}: {}", mongo_message(e)))?;
    Ok((client, source, default))
}

/// Lists databases. Users allowed to see only their own database get just that one.
async fn mongo_databases(
    client: &mongodb::Client,
    default: Option<&str>,
) -> Result<Vec<Database>, String> {
    let names = match client.list_database_names().await {
        Ok(names) => names,
        Err(_) if default.is_some() => vec![default.unwrap().to_string()],
        Err(e) => {
            return Err(format!(
                "Could not list the databases: {}",
                mongo_message(e)
            ))
        }
    };
    Ok(names
        .into_iter()
        .map(|name| Database {
            name,
            collections: None,
        })
        .collect())
}

async fn mongo_collections(
    client: &mongodb::Client,
    database: &str,
) -> Result<Vec<Collection>, String> {
    let specs: Vec<mongodb::results::CollectionSpecification> = client
        .database(database)
        .list_collections()
        .await
        .map_err(mongo_message)?
        .try_collect()
        .await
        .map_err(mongo_message)?;
    let mut collections: Vec<Collection> = specs
        .into_iter()
        .filter(|s| !s.name.starts_with("system."))
        .map(|s| Collection {
            kind: match s.collection_type {
                CollectionType::View => "view",
                CollectionType::Timeseries => "timeseries",
                _ => "collection",
            }
            .into(),
            name: s.name,
            count: None,
        })
        .collect();
    collections.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(collections)
}

async fn find_mongo(client: &mongodb::Client, request: &FindRequest) -> Result<Page, String> {
    let collection = client
        .database(&request.database)
        .collection::<Document>(&request.collection);
    let filter = parse_document(&request.filter, "filter")?;
    let mut find = collection
        .find(filter.clone())
        .skip(request.skip)
        .limit(request.limit as i64);
    let sort = parse_document(&request.sort, "sort")?;
    if !sort.is_empty() {
        find = find.sort(sort);
    }
    let project = parse_document(&request.project, "projection")?;
    if !project.is_empty() {
        find = find.projection(project);
    }
    let docs: Vec<Document> = find
        .await
        .map_err(mongo_message)?
        .try_collect()
        .await
        .map_err(mongo_message)?;
    let total = if filter.is_empty() {
        collection.estimated_document_count().await.ok()
    } else {
        // A filter on an unindexed field scans the collection: give up rather than hang.
        collection
            .count_documents(filter)
            .max_time(Duration::from_secs(5))
            .await
            .ok()
    };
    Ok(Page {
        columns: Vec::new(),
        rows: docs
            .into_iter()
            .map(|d| Bson::Document(d).into_relaxed_extjson())
            .collect(),
        total,
        estimated: false,
        ms: 0,
    })
}

fn parse_json(text: &str, what: &str) -> Result<Bson, String> {
    let value: Value =
        serde_json::from_str(text).map_err(|e| format!("The {what} is not valid: {e}"))?;
    Bson::try_from(value).map_err(|e| format!("The {what} is not valid: {e}"))
}

fn parse_document(text: &str, what: &str) -> Result<Document, String> {
    if text.trim().is_empty() {
        return Ok(Document::new());
    }
    match parse_json(text, what)? {
        Bson::Document(doc) => Ok(doc),
        _ => Err(format!(
            "The {what} must be a document, like {{ field: 'value' }}."
        )),
    }
}

fn mongo_message(e: mongodb::error::Error) -> String {
    e.kind.to_string()
}

/// `mongodb+srv://user:pw@cluster0.abcd.mongodb.net/app?x=y` → `cluster0.abcd.mongodb.net/app`.
fn mongo_source(url: &str, database: Option<&str>) -> String {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let hosts = rest.split(['/', '?']).next().unwrap_or(rest);
    let hosts = hosts.rsplit_once('@').map_or(hosts, |(_, hosts)| hosts);
    match database {
        Some(db) => format!("{hosts}/{db}"),
        None => hosts.to_string(),
    }
}

// ---------------------------------------------------------------- connection strings

fn is_mongo(url: &str) -> bool {
    url.starts_with("mongodb://") || url.starts_with("mongodb+srv://")
}

/// Trims quotes, and takes the value out of a whole `DATABASE_URL="..."` line from a .env file.
fn clean_url(input: &str) -> String {
    let unquote = |s: &str| s.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
    let url = unquote(input);
    if let Some((key, value)) = url.split_once('=') {
        let value = unquote(value);
        if !key.trim().is_empty()
            && key
                .trim()
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
            && value.contains("://")
        {
            return value;
        }
    }
    url
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_clause_keywords() {
        assert_eq!(clause("where id = 1", "where"), "id = 1");
        assert_eq!(clause("  WHERE\n status = 'x';", "where"), "status = 'x'");
        assert_eq!(clause("whereabouts = 2", "where"), "whereabouts = 2");
        assert_eq!(
            clause("order by created_at desc", "order by"),
            "created_at desc"
        );
        assert_eq!(clause("ORDER  BY 1", "order by"), "1");
        assert_eq!(clause("orderly", "order by"), "orderly");
        assert_eq!(clause("", "where"), "");
    }

    #[test]
    fn quotes_identifiers() {
        assert_eq!(qualified("public", "User"), "\"public\".\"User\"");
        assert_eq!(ident("we\"ird"), "\"we\"\"ird\"");
    }

    #[test]
    fn reads_mongo_strings() {
        assert_eq!(
            mongo_source(
                "mongodb+srv://me:p%40ss@cluster0.abcd.mongodb.net/?retryWrites=true",
                None
            ),
            "cluster0.abcd.mongodb.net"
        );
        assert_eq!(
            mongo_source(
                "mongodb://a:b@h1:27017,h2:27017/app?replicaSet=rs",
                Some("app")
            ),
            "h1:27017,h2:27017/app"
        );
        assert_eq!(
            clean_url("MONGO_URL='mongodb://localhost/app'"),
            "mongodb://localhost/app"
        );
        assert_eq!(
            clean_url(" \"postgres://u@h/db?x=1\" "),
            "postgres://u@h/db?x=1"
        );
        assert!(is_mongo("mongodb+srv://x"));
    }

    #[test]
    fn mongo_placeholder_needs_a_password() {
        let err = tauri::async_runtime::block_on(connect_mongo(
            "mongodb+srv://me:<db_password>@cluster0.abcd.mongodb.net/",
            "",
        ))
        .err()
        .unwrap();
        assert!(err.contains("<db_password>"), "{err}");
    }

    #[test]
    fn parses_extended_json() {
        let doc = parse_document(
            r#"{"_id": {"$oid": "69e1f6d8fc5c0aa566d73025"}, "n": {"$gt": 2}}"#,
            "filter",
        )
        .unwrap();
        assert!(matches!(doc.get("_id"), Some(Bson::ObjectId(_))));
        assert!(parse_document("[1]", "filter").is_err());
        assert!(parse_document(" ", "filter").unwrap().is_empty());
    }
}

/// Browses the databases in `PRISMAGRAM_TEST_DATABASE_URL` and `PRISMAGRAM_TEST_MONGO_URL`:
/// `cargo test -- --ignored`. Both need at least one table or collection with rows.
#[cfg(test)]
mod live {
    use super::*;

    async fn browse(url: &str) {
        let connections = Connections::default();
        let c = connections.connect(url, "").await.unwrap();
        let mut databases = c.databases;
        if c.kind == "mongodb" {
            for db in &mut databases {
                db.collections = Some(connections.collections(&c.id, &db.name).await.unwrap());
            }
        }
        let (db, table) = databases
            .iter()
            .flat_map(|d| d.collections.iter().flatten().map(move |t| (d, t)))
            .find(|(d, _)| !["admin", "config", "local"].contains(&d.name.as_str()))
            .expect("no tables");
        let request = FindRequest {
            database: db.name.clone(),
            collection: table.name.clone(),
            filter: String::new(),
            sort: String::new(),
            project: String::new(),
            skip: 0,
            limit: 5,
        };
        let page = connections.find(&c.id, &request).await.unwrap();
        assert!(
            !page.rows.is_empty() && page.total.unwrap() > 0,
            "{}",
            table.name
        );
        assert!(!connections
            .indexes(&c.id, &db.name, &table.name)
            .await
            .unwrap()
            .is_empty());
        if c.kind == "postgres" {
            assert!(!connections
                .columns(&c.id, &db.name, &table.name)
                .await
                .unwrap()
                .is_empty());
            let result = connections
                .sql(&c.id, &db.name, "select 1 as one; select 2")
                .await
                .unwrap();
            assert_eq!(result.results.len(), 2);
            assert_eq!(result.results[0].rows[0][0].as_deref(), Some("1"));
            let err = connections
                .sql(&c.id, &db.name, "select 1;\nselect nope")
                .await
                .err()
                .unwrap();
            assert!(err.contains("line 2"), "{err}");
        } else {
            let page = connections
                .aggregate(&c.id, &db.name, &table.name, r#"[{"$match": {}}]"#, 3)
                .await
                .unwrap();
            assert!(page.rows.len() <= 3);
        }
        connections.disconnect(&c.id);
        assert!(connections.find(&c.id, &request).await.is_err());
    }

    #[test]
    #[ignore = "needs a database in PRISMAGRAM_TEST_DATABASE_URL"]
    fn browses_postgres() {
        let url = std::env::var("PRISMAGRAM_TEST_DATABASE_URL").unwrap();
        tauri::async_runtime::block_on(browse(&url));
    }

    #[test]
    #[ignore = "needs a database in PRISMAGRAM_TEST_MONGO_URL"]
    fn browses_mongo() {
        let url = std::env::var("PRISMAGRAM_TEST_MONGO_URL").unwrap();
        tauri::async_runtime::block_on(browse(&url));
    }
}
