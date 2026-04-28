//! MDViewer library crate.
//!
//! This crate is referenced by both `main.rs` (binary entry) and the
//! integration tests under `tests/`. Modules added in later tasks
//! (settings, recents, document, anchor, comments, sidecar, workspace,
//! watcher, conflict) attach here as they are implemented.

#[derive(Debug, Clone, serde::Serialize)]
pub struct BuildInfo {
    pub version: &'static str,
    pub commit_hash: &'static str,
}

pub fn build_info() -> BuildInfo {
    BuildInfo {
        version: env!("MDVIEWER_VERSION"),
        commit_hash: env!("MDVIEWER_COMMIT_HASH"),
    }
}
