#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use mdviewer_lib::{build_info, BuildInfo};

#[tauri::command]
fn app_info() -> BuildInfo {
    build_info()
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![app_info])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
