//! Sidecar JSON IO: load / save / path resolution.
//!
//! The on-disk format is `<doc>.md.comments.json` (configurable via
//! `settings.comments.sidecar_pattern`). Phase-1 ships `schema_version: 1`;
//! C1 introduces `schema_version: 2` (Automerge) and a one-way migration
//! test from this layout.
//!
//! ## Why pattern lives here, not in `comments.rs`
//!
//! The Settings -> consumer mapping in the design doc says
//! `comments.sidecar_pattern` is owned by sidecar IO. Putting it here means
//! a Settings change (rename pattern at runtime) only has to thread through
//! one module — the `CommentsStore` itself stays oblivious to disk paths.

use crate::comments::{CommentsStore, MergeOutcome, Thread};
use crate::settings::AutoMergeMode;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Deserialize)]
struct OnDiskV1 {
    schema_version: u32,
    threads: Vec<Thread>,
}

/// Resolve the sidecar path next to `md_path` using `pattern`.
///
/// Pattern uses `{name}` as a placeholder for the file stem (filename without
/// its extension). The default pattern `"{name}.md.comments.json"` produces
/// `spec.md.comments.json` next to `spec.md`. Custom patterns like
/// `".{name}.comments"` produce `.spec.comments`.
pub fn sidecar_path(md_path: &Path, pattern: &str) -> PathBuf {
    let parent = md_path.parent().unwrap_or(Path::new(""));
    let name = md_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    // Replace `{name}` with the bare stem so the result stays predictable
    // for any extension casing (.md / .MD / .markdown).
    let stem = md_path.file_stem().and_then(|s| s.to_str()).unwrap_or(name);
    let resolved = pattern.replace("{name}", stem);
    parent.join(resolved)
}

/// Load a sidecar from disk into a fresh `CommentsStore`. Missing file is
/// not an error — a brand-new document has no comments yet, so we return an
/// empty store and let the caller decide whether to save when the user
/// creates the first thread.
pub fn load_sidecar(path: &Path) -> Result<CommentsStore> {
    if !path.exists() {
        return Ok(CommentsStore::new());
    }
    let bytes = std::fs::read_to_string(path).context("read sidecar")?;
    let on_disk: OnDiskV1 = serde_json::from_str(&bytes).context("parse sidecar")?;
    if on_disk.schema_version != 1 {
        // Phase-3 (C1) layers in v2 handling. For Phase-1 we accept v1 only.
        anyhow::bail!("unsupported schema_version {}", on_disk.schema_version);
    }
    Ok(CommentsStore::from_threads(on_disk.threads))
}

/// Persist `store`'s current threads to `path` as pretty-printed JSON with a
/// `schema_version: 1` header. Creates parent directories as needed so the
/// caller doesn't have to worry about a missing workspace folder.
pub fn save_sidecar(path: &Path, store: &CommentsStore) -> Result<()> {
    if let Some(parent) = path.parent() {
        // `create_dir_all` is a no-op when the directory already exists, so
        // we don't gate this on `parent.exists()`.
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).context("create sidecar parent dir")?;
        }
    }
    let on_disk = OnDiskV1 {
        schema_version: 1,
        threads: store.list_threads().to_vec(),
    };
    let body = serde_json::to_string_pretty(&on_disk)?;
    std::fs::write(path, body).context("write sidecar")?;
    Ok(())
}

/// Decide how to reconcile an `incoming` sidecar (from disk) against a
/// `local` in-memory store, given the user's auto-merge preference.
///
/// - `Always` -> caller adopts the version with the newer mtime;
///   this function picks based on `incoming_is_newer`.
/// - `Ask` / `Manual` -> return `AskUser` so the frontend can prompt.
///
/// The `mtime` comparison itself happens in B2 (file watcher), which has the
/// `Metadata::modified()` value — we just receive the precomputed boolean so
/// this module stays free of `std::fs` for the policy decision.
pub fn merge_with_policy(
    local: CommentsStore,
    incoming: CommentsStore,
    mode: AutoMergeMode,
    incoming_is_newer: bool,
) -> MergeOutcome {
    match mode {
        AutoMergeMode::Always => {
            if incoming_is_newer {
                MergeOutcome::Adopted(incoming)
            } else {
                MergeOutcome::Adopted(local)
            }
        }
        AutoMergeMode::Ask | AutoMergeMode::Manual => {
            MergeOutcome::AskUser { local, incoming }
        }
    }
}
