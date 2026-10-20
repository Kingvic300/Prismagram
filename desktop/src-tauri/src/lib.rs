use prismagram_core as prisma;

use base64::Engine;
use std::time::UNIX_EPOCH;

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
        .invoke_handler(tauri::generate_handler![
            parse_schema,
            read_text_file,
            write_text_file,
            write_binary_file,
            file_modified,
            launch_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running Prismagram");
}
