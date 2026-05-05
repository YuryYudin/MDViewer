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

// Workspace re-export so `mdviewer_lib::mdviewer_core::*` resolves identically
// to the in-crate paths for any external consumer (only export_types today).
pub use mdviewer_core;

pub mod anchor;
pub mod cli;
pub mod comments;
pub mod conflict;
pub mod doc_prefs;
pub mod document;
pub mod drive;
pub mod menu;
pub mod recents;
pub mod session;
pub mod settings;
pub mod sidecar;
pub mod watcher;
pub mod workspace;
