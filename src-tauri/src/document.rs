//! Desktop-only document IO: atomic save + IPC SaveOutcome.
//!
//! Render moved to `mdviewer_core::document` in A6. The renderer pulls in
//! `pulldown-cmark` + `syntect` and does not need filesystem coupling, so
//! Android can consume it via UniFFI without dragging in `notify` or our
//! `quick_hash` watcher logic. Save coupling stays here because it depends
//! on `crate::watcher::quick_hash` for the self-write suppression handshake
//! and emits the IPC-facing `SaveOutcome` enum that the Tauri command in
//! `main.rs` consumes — both desktop concerns. Android writes via SAF,
//! never `std::fs::rename`.
//!
//! `pub use` keeps existing call sites resolving `crate::document::
//! render_markdown` (and friends) without forcing every importer to switch
//! to the workspace path. New desktop callers can also reach through to
//! `mdviewer_core::document` directly when they want the explicit dep edge.

pub use mdviewer_core::document::{render_markdown, RenderOptions, RenderResult};

use crate::watcher::quick_hash;
use std::path::Path;

/// Result of an atomic `save_document` call.
///
/// `content_hash` is the [`quick_hash`] of the bytes that landed on disk —
/// the same value the watcher uses for self-write suppression. `bytes_written`
/// echoes the input length so callers can surface "Saved 1.2 KB" UI without
/// a follow-up `metadata()` call.
#[derive(Debug, Clone, Copy)]
pub struct SaveResult {
    pub bytes_written: usize,
    pub content_hash: u64,
}

/// IPC-facing save outcome for the `save_document` command. Distinct from
/// the lower-level `SaveResult` struct above (which counts bytes + hashes
/// and is returned by the `save_document` filesystem helper). Only the IPC
/// layer surfaces conflicts — the on-disk write helper is local-only and
/// has no remote-divergence concept.
///
/// `Ok.etag` is the new resource ETag for DriveApi saves and `None` for
/// Local + DriveDesktop saves (no ETag concept on either of those paths).
/// `Conflict.drive_source` disambiguates the two Drive code paths for the
/// banner string in wireframe 07; `None` when the conflict came from the
/// existing Local mtime-mismatch path that predates the Drive integration.
#[derive(Debug, Clone, serde::Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SaveOutcome {
    Ok {
        etag: Option<String>,
    },
    Conflict {
        local: String,
        remote: String,
        drive_source: Option<String>,
    },
}

/// Atomically write `contents` to `path`.
///
/// The crash-safe pattern: write to `<path>.tmp`, fsync, then `rename` over
/// the target. A crash between `create` and `rename` leaves the original
/// file intact; a crash between `rename` and the next operation has already
/// committed the new bytes.
///
/// Self-write priming: the spec's Avoid clause requires that the watcher's
/// suppression list be primed BEFORE the rename so notify's worker thread
/// can never deliver an unsuppressed event. Pass a closure that records the
/// hash with [`crate::watcher::Watcher::record_self_write`]; the closure
/// fires after the temp file is fsynced and BEFORE the rename, closing the
/// race window unconditionally rather than relying on notify being slower
/// than a Mutex acquisition.
pub fn save_document<F>(
    path: &Path,
    contents: &[u8],
    prime_self_write: F,
) -> std::io::Result<SaveResult>
where
    F: FnOnce(&Path, u64),
{
    use std::io::Write;
    // Build a sibling `<path>.tmp` (or `<path>.<ext>.tmp` when the original
    // has an extension). `with_extension` would *replace* the extension, so
    // we splice manually to keep the original on the temp name. That makes
    // it trivial to spot abandoned temp files in case of a crash.
    let tmp = path.with_extension(
        path.extension()
            .and_then(|s| s.to_str())
            .map(|e| format!("{e}.tmp"))
            .unwrap_or_else(|| "tmp".into()),
    );
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(contents)?;
        f.sync_all()?;
    }
    // Hash the bytes once. Pass to the priming closure BEFORE rename so the
    // watcher's self-write list can suppress the resulting notify event.
    let content_hash = quick_hash(contents);
    prime_self_write(path, content_hash);

    std::fs::rename(&tmp, path)?;

    // Defensive: fsync the parent directory so the rename itself is durable
    // (the file content is already fsynced above). On filesystems where
    // metadata journaling is not data-ordered, a power loss between rename
    // and the next directory flush can otherwise lose the rename.
    if let Some(parent) = path.parent() {
        if let Ok(dir) = std::fs::File::open(parent) {
            // Best-effort — sync_all on a directory handle isn't supported
            // on every platform (e.g. Windows). Ignore Err here; the worst
            // case is the same fragility the previous version had.
            let _ = dir.sync_all();
        }
    }

    Ok(SaveResult {
        bytes_written: contents.len(),
        content_hash,
    })
}
