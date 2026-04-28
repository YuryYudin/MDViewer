//! MDViewer library crate.
//!
//! This crate is referenced by both `main.rs` (binary entry) and the
//! integration tests under `tests/`. Modules added in later tasks
//! (settings, recents, document, anchor, comments, sidecar, workspace,
//! watcher, conflict) attach here as they are implemented.
//!
//! ## IPC type contract
//!
//! Every type that crosses the Tauri IPC boundary must derive `ts_rs::TS`
//! and be appended to `src/bin/export_types.rs::export_all`. Run
//! `npm run gen:types` (or `cargo run --bin export_types`) after touching
//! any such type. The generated `src/types-generated.ts` is the only place
//! the frontend reads IPC shapes from — `src/ipc.ts` re-exports it.

#[derive(Debug, Clone, serde::Serialize, ts_rs::TS)]
#[ts(export)]
pub struct BuildInfo {
    pub version: String,
    pub commit_hash: String,
}

pub fn build_info() -> BuildInfo {
    BuildInfo {
        version: env!("MDVIEWER_VERSION").to_string(),
        commit_hash: env!("MDVIEWER_COMMIT_HASH").to_string(),
    }
}

pub mod anchor;
pub mod document;
pub mod recents;
pub mod settings;
