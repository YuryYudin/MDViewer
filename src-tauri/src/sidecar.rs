//! Desktop sidecar IO: resolves paths and shells bytes through
//! `mdviewer_core::sidecar`.
//!
//! Pre-A5 this module owned the on-disk format dispatch (v1 plain JSON vs.
//! v2 Automerge envelope) directly. A5 moved that dispatch into
//! `mdviewer_core::sidecar` so Android's `ContentResolver` consumer shares
//! the same decoder; this wrapper now contributes only what's
//! desktop-specific:
//!
//! - Filesystem path -> sidecar path resolution (delegating filename
//!   shaping to `mdviewer_core::sidecar_path::sidecar_filename`).
//! - `std::fs::read` / `std::fs::write` (Android uses `ContentResolver`).
//! - `std::fs::create_dir_all` for missing parent dirs (Android uses
//!   `DocumentFile.createDirectory`).
//!
//! Format dispatch, base64 encoding, the v2 envelope, and the merge policy
//! all live in core. A bug fix to either side can no longer drift the two
//! platforms' interpretation of the same on-disk bytes.

use crate::settings::AutoMergeMode;
use anyhow::{Context, Result};
use mdviewer_core::comments::{CommentsStore, MergeOutcome};
use mdviewer_core::sidecar as core_sidecar;
use mdviewer_core::sidecar_path::sidecar_filename;
use std::path::{Path, PathBuf};

/// Resolve the sidecar path next to `md_path` using `pattern`. Filename
/// shape (the `{name}` substitution) is delegated to the core helper so
/// Android's `DocumentFile`-sibling logic stays in lockstep with desktop.
pub fn sidecar_path(md_path: &Path, pattern: &str) -> PathBuf {
    let parent = md_path.parent().unwrap_or(Path::new(""));
    let filename = md_path.file_name().and_then(|s| s.to_str()).unwrap_or("");
    parent.join(sidecar_filename(filename, pattern))
}

/// Load a sidecar from disk. Missing file is not an error — a brand-new
/// document has no comments yet, so we return an empty store and let the
/// caller decide whether to save when the user creates the first thread.
pub fn load_sidecar(path: &Path) -> Result<CommentsStore> {
    if !path.exists() {
        return Ok(CommentsStore::new());
    }
    let bytes = std::fs::read(path).context("read sidecar")?;
    core_sidecar::load_sidecar_bytes(&bytes)
}

/// Persist `store` to `path`. Creates missing parent directories so the
/// caller doesn't need to know whether the workspace folder already exists
/// on disk.
///
/// Returns the bytes that hit disk so callers can prime the file watcher's
/// self-write suppression list (`Watcher::record_self_write`) without a
/// follow-up read. Without that prime, the comments-mutation IPC handlers
/// would generate spurious `external-change` events for the file MDViewer
/// itself just wrote.
pub fn save_sidecar(path: &Path, store: &CommentsStore) -> Result<Vec<u8>> {
    if let Some(parent) = path.parent() {
        // `create_dir_all` is a no-op when the directory already exists, so
        // we don't gate this on `parent.exists()`.
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).context("create sidecar parent dir")?;
        }
    }
    let bytes = core_sidecar::save_sidecar_bytes(store)?;
    std::fs::write(path, &bytes).context("write sidecar")?;
    Ok(bytes)
}

/// Pass-through to `mdviewer_core::sidecar::merge_with_policy`. Re-exported
/// here so existing IPC handlers can keep their `crate::sidecar::merge_with_policy`
/// import paths unchanged. `AutoMergeMode` is the desktop-side re-export
/// of the core enum (see `settings.rs`), so the conversion is a no-op.
pub fn merge_with_policy(
    local: CommentsStore,
    incoming: CommentsStore,
    mode: AutoMergeMode,
    incoming_is_newer: bool,
) -> MergeOutcome {
    core_sidecar::merge_with_policy(local, incoming, mode, incoming_is_newer)
}
