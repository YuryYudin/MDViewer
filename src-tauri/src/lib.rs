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

// Workspace re-exports (A7).
//
// Phase A (A3-A6) split the platform-agnostic core (anchor, comments,
// document::render, sidecar::{parse,serialize,merge}, auto_merge enum,
// sidecar_path filename helper) into the `mdviewer-core` crate so the
// upcoming Android target can consume the same logic via UniFFI without
// dragging in `notify`, `tauri`, or our filesystem helpers.
//
// To keep the existing `crate::anchor::*` / `crate::comments::*` /
// `crate::document::*` / `crate::sidecar::*` import paths resolving for
// every desktop call site, we keep the per-module stub files in
// `src-tauri/src/`:
//
// * Pure re-export stubs (no desktop additions) — `anchor.rs`, `comments.rs`.
//   Each is a 1-liner: `pub use mdviewer_core::<module>::*;`. Don't delete
//   them; the call sites in `workspace.rs` / `drive/comments.rs` import via
//   `crate::anchor::{self, Anchor}` etc. and `self` only resolves while a
//   local module by that name exists.
//
// * Thin desktop wrappers — `document.rs` (adds `save_document` + the
//   IPC-facing `SaveOutcome`), `sidecar.rs` (adds path-based `load_sidecar`
//   / `save_sidecar` + the `merge_with_policy` pass-through), `settings.rs`
//   (re-exports `AutoMergeMode` from core for back-compat). These pull
//   `pub use mdviewer_core::<module>::{...}` for the items that moved and
//   own the desktop-only items themselves.
//
// We deliberately do NOT add `pub use mdviewer_core;` at the top level: it
// would create the path `crate::mdviewer_core::anchor`, which doesn't match
// the existing `crate::anchor` call sites and offers nothing the stubs
// don't already cover.
//
// The two core modules with no desktop wrapper today (`auto_merge`,
// `sidecar_path`) are exposed via aliases so a future call site can write
// `crate::auto_merge::AutoMergeMode` without first creating another stub.
pub use mdviewer_core::{auto_merge, sidecar_path};

pub mod anchor;
pub mod cli;
pub mod cli_install;
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
pub mod ssh;
pub mod watcher;
pub mod workspace;
