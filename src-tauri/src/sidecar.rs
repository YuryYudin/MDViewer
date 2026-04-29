//! Sidecar JSON IO: load / save / path resolution.
//!
//! The on-disk format is `<doc>.md.comments.json` (configurable via
//! `settings.comments.sidecar_pattern`). C1 promotes the format to
//! `schema_version: 2`: a JSON envelope wrapping a base64-encoded
//! Automerge save() blob. v1 sidecars (Phase-1 plain JSON) are still
//! readable via a fallback parser, and the migration is in-memory only —
//! the disk file isn't rewritten until the next save.
//!
//! ## Why pattern lives here, not in `comments.rs`
//!
//! The Settings -> consumer mapping in the design doc says
//! `comments.sidecar_pattern` is owned by sidecar IO. Putting it here means
//! a Settings change (rename pattern at runtime) only has to thread through
//! one module — the `CommentsStore` itself stays oblivious to disk paths.

use crate::comments::{merge_stores, store_from_automerge, store_to_automerge, CommentsStore, MergeOutcome, Thread};
use crate::settings::AutoMergeMode;
use anyhow::{Context, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// On-disk envelope for `schema_version: 2`. The Automerge document is
/// saved via `AutoCommit::save()` (a binary blob with full op history)
/// and base64-encoded so the file stays valid JSON. Keeping it JSON
/// preserves grep-ability and round-trips through serde for tests.
#[derive(Debug, Serialize, Deserialize)]
struct EnvelopeV2 {
    schema_version: u32,
    /// base64(automerge::AutoCommit::save() bytes)
    automerge: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct OnDiskV1 {
    schema_version: u32,
    threads: Vec<Thread>,
}

/// Lightweight peek used to detect the schema_version without parsing the
/// full envelope. Lets us route v1 vs v2 with a single read.
#[derive(Debug, Deserialize)]
struct SchemaPeek {
    schema_version: u32,
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
///
/// Format dispatch:
/// - `schema_version: 2` -> decode base64 + Automerge `load()`, walk back
///   to threads.
/// - `schema_version: 1` -> Phase-1 path; parse the legacy `OnDiskV1` shape
///   and seed the store directly. We do NOT rewrite the file here — that
///   would silently mutate a user's document on first read after upgrade.
///   The next save naturally upgrades the file to v2.
/// - anything else -> bail with `unsupported schema_version`.
pub fn load_sidecar(path: &Path) -> Result<CommentsStore> {
    if !path.exists() {
        return Ok(CommentsStore::new());
    }
    let bytes = std::fs::read(path).context("read sidecar")?;
    // Peek at the version first so we can route without trying to parse
    // the wrong shape (which would surface as a misleading parse error).
    let peek: SchemaPeek = serde_json::from_slice(&bytes).context("parse sidecar")?;
    match peek.schema_version {
        2 => {
            let env: EnvelopeV2 =
                serde_json::from_slice(&bytes).context("parse sidecar")?;
            let am_bytes = base64::engine::general_purpose::STANDARD
                .decode(&env.automerge)
                .context("decode automerge payload")?;
            let store = store_from_automerge(&am_bytes)
                .context("rebuild CommentsStore from Automerge doc")?;
            Ok(store)
        }
        1 => {
            // Phase-1 plain JSON. Preserve every thread / comment ID
            // verbatim so a counterpart's CRDT doesn't see them as "new"
            // after the first auto-merge.
            let v1: OnDiskV1 =
                serde_json::from_slice(&bytes).context("parse sidecar")?;
            Ok(CommentsStore::from_threads(v1.threads))
        }
        other => anyhow::bail!("unsupported schema_version {}", other),
    }
}

/// Persist `store`'s current threads to `path` as a v2 envelope:
/// JSON wrapper around a base64-encoded Automerge save() blob. Creates
/// parent directories as needed so the caller doesn't have to worry
/// about a missing workspace folder.
pub fn save_sidecar(path: &Path, store: &CommentsStore) -> Result<()> {
    if let Some(parent) = path.parent() {
        // `create_dir_all` is a no-op when the directory already exists, so
        // we don't gate this on `parent.exists()`.
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).context("create sidecar parent dir")?;
        }
    }
    let am_bytes = store_to_automerge(store).context("serialize store to Automerge")?;
    let env = EnvelopeV2 {
        schema_version: 2,
        automerge: base64::engine::general_purpose::STANDARD.encode(&am_bytes),
    };
    let body = serde_json::to_string_pretty(&env)?;
    std::fs::write(path, body).context("write sidecar")?;
    Ok(())
}

/// Decide how to reconcile an `incoming` sidecar (from disk) against a
/// `local` in-memory store, given the user's auto-merge preference.
///
/// - `Always` -> CRDT-merge `local` and `incoming` (deterministic and
///   conflict-free thanks to Automerge's `doc.merge()`); we no longer
///   rely on the Phase-1 newest-mtime heuristic because that loses
///   work whenever both sides edited.
/// - `Ask` / `Manual` -> return `AskUser` so the frontend can prompt.
///
/// The `mtime` comparison parameter is retained for API compatibility
/// with Phase-1 callers (B2's file watcher) but is no longer consulted
/// in the `Always` path.
pub fn merge_with_policy(
    local: CommentsStore,
    incoming: CommentsStore,
    mode: AutoMergeMode,
    _incoming_is_newer: bool,
) -> MergeOutcome {
    match mode {
        AutoMergeMode::Always => {
            // CRDT merge: union of both sides' threads with deterministic
            // ordering. Falling back to "adopt incoming" only happens if
            // the merge itself errors, which would indicate a corrupted
            // Automerge payload — better to surface the freshest disk
            // copy than to silently drop everything.
            let merged = merge_stores(&local, &incoming);
            MergeOutcome::Adopted(merged)
        }
        AutoMergeMode::Ask | AutoMergeMode::Manual => {
            MergeOutcome::AskUser { local, incoming }
        }
    }
}
