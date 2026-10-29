mod client;
mod database;

use prismagram_core as prisma;

use base64::Engine;
use std::time::UNIX_EPOCH;
use tauri::State;

#[tauri::command]
fn parse_schema(source: String) -> prisma::Schema {
    prisma::parse(&source)
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Could not read {path}: {e}"))
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("Could not write {path}: {e}"))
}

#[tauri::command]
fn write_binary_file(path: String, base64_data: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data.as_bytes())
        .map_err(|e| format!("Invalid image data: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("Could not write {path}: {e}"))
}

/// Last modification time in milliseconds, used to auto-reload files edited elsewhere.
#[tauri::command]
fn file_modified(path: String) -> Result<u64, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let modified = meta.modified().map_err(|e| e.to_string())?;
    Ok(modified
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0))
}

/// Reads the schema of a live PostgreSQL database (e.g. Supabase) as Prisma schema text.
#[tauri::command]
async fn pull_database(
    url: String,
    password: String,
    schemas: Vec<String>,
) -> Result<database::Pulled, String> {
    database::pull(&url, &password, &schemas).await
}

// The data browser: connections stay open in `client::Connections` until disconnected.

#[tauri::command]
async fn client_connect(
    connections: State<'_, client::Connections>,
    url: String,
    password: String,
) -> Result<client::Connected, String> {
    connections.connect(&url, &password).await
}

#[tauri::command]
fn client_disconnect(connections: State<'_, client::Connections>, id: String) {
    connections.disconnect(&id);
}

#[tauri::command]
async fn client_databases(
    connections: State<'_, client::Connections>,
    id: String,
) -> Result<Vec<client::Database>, String> {
    connections.databases(&id).await
}

#[tauri::command]
async fn client_collections(
    connections: State<'_, client::Connections>,
    id: String,
    database: String,
) -> Result<Vec<client::Collection>, String> {
    connections.collections(&id, &database).await
}

#[tauri::command]
async fn client_find(
    connections: State<'_, client::Connections>,
    id: String,
    request: client::FindRequest,
) -> Result<client::Page, String> {
    connections.find(&id, &request).await
}

#[tauri::command]
async fn client_aggregate(
    connections: State<'_, client::Connections>,
    id: String,
    database: String,
    collection: String,
    pipeline: String,
    limit: u64,
) -> Result<client::Page, String> {
    connections
        .aggregate(&id, &database, &collection, &pipeline, limit)
        .await
}

#[tauri::command]
async fn client_columns(
    connections: State<'_, client::Connections>,
    id: String,
    database: String,
    collection: String,
) -> Result<Vec<client::Field>, String> {
    connections.columns(&id, &database, &collection).await
}

#[tauri::command]
async fn client_indexes(
    connections: State<'_, client::Connections>,
    id: String,
    database: String,
    collection: String,
) -> Result<Vec<client::Index>, String> {
    connections.indexes(&id, &database, &collection).await
}

#[tauri::command]
async fn client_sql(
    connections: State<'_, client::Connections>,
    id: String,
    database: String,
    sql: String,
) -> Result<client::QueryResult, String> {
    connections.sql(&id, &database, &sql).await
}

/// A `.prisma` path passed on the command line (e.g. "Open with Prismagram").
#[tauri::command]
fn launch_file() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-') && std::path::Path::new(a).is_file())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebKitGTK's DMA-BUF renderer shows a blank window on many Linux GPU drivers.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(client::Connections::default())
        .invoke_handler(tauri::generate_handler![
            parse_schema,
            read_text_file,
            write_text_file,
            write_binary_file,
            file_modified,
            launch_file,
            pull_database,
            client_connect,
            client_disconnect,
            client_databases,
            client_collections,
            client_find,
            client_aggregate,
            client_columns,
            client_indexes,
            client_sql
        ])
        .run(tauri::generate_context!())
        .expect("error while running Prismagram");
}
