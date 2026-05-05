//! Sidecar bytes IO + merge policy.
//!
//! Bytes-in, bytes-out: callers (desktop `std::fs` wrapper at
//! `src-tauri/src/sidecar.rs`, Android `ContentResolver`-backed wrapper)
//! handle storage. Format dispatch is identical to the desktop's pre-A5
//! implementation — peek `schema_version`, route v1 plain JSON vs. v2
//! Automerge envelope.
//!
//! ## Why split path-form from bytes-form
//!
//! Phase A6 introduces an Android target that opens sidecars via
//! `ContentResolver.openInputStream`/`openOutputStream` rather than
//! `std::path::Path`. Sharing the dispatch + merge policy in core means a
//! bug fix to either platform's storage glue can't drift the on-disk
//! interpretation of v1 vs. v2 — there's a single decoder.
//!
//! ## Why we never write v1
//!
//! v1 was Phase-1's plain-JSON shape; v2 wraps an `automerge::AutoCommit::save()`
//! blob. Saving v1 again would lose CRDT history. The v1 reader stays only
//! to migrate existing user files in-memory; the next save naturally upgrades.

use crate::auto_merge::AutoMergeMode;
use crate::comments::{
    merge_stores, store_from_automerge, store_to_automerge, CommentsStore, MergeOutcome, Thread,
};
use anyhow::{Context, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};

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
    #[allow(dead_code)] // peeked separately via SchemaPeek; kept for serde shape
    schema_version: u32,
    threads: Vec<Thread>,
}

/// Lightweight peek used to detect the schema_version without parsing the
/// full envelope. Lets us route v1 vs v2 with a single read.
#[derive(Debug, Deserialize)]
struct SchemaPeek {
    schema_version: u32,
}

/// Load a sidecar from raw bytes. Empty bytes mean "no sidecar yet" — the
/// caller (desktop `load_sidecar` after a missing-file check, Android
/// after a zero-byte `openInputStream` read) gets a fresh empty store.
///
/// Format dispatch:
/// - `schema_version: 2` -> decode base64 + Automerge `load()`, walk back
///   to threads.
/// - `schema_version: 1` -> Phase-1 path; parse the legacy `OnDiskV1` shape
///   and seed the store directly. We do NOT rewrite the bytes here — that
///   would silently mutate the user's document on first read after upgrade.
///   The next save naturally upgrades the file to v2.
/// - anything else -> bail with `unsupported schema_version`.
pub fn load_sidecar_bytes(bytes: &[u8]) -> Result<CommentsStore> {
    if bytes.is_empty() {
        return Ok(CommentsStore::new());
    }
    // Peek at the version first so we can route without trying to parse
    // the wrong shape (which would surface as a misleading parse error).
    let peek: SchemaPeek = serde_json::from_slice(bytes).context("parse sidecar")?;
    match peek.schema_version {
        2 => {
            let env: EnvelopeV2 = serde_json::from_slice(bytes).context("parse sidecar")?;
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
            let v1: OnDiskV1 = serde_json::from_slice(bytes).context("parse sidecar")?;
            Ok(CommentsStore::from_threads(v1.threads))
        }
        other => anyhow::bail!("unsupported schema_version {}", other),
    }
}

/// Serialize `store` as a v2 envelope: a JSON wrapper around the
/// base64-encoded `AutoCommit::save()` blob. Always v2 — the v1 reader
/// is one-way (legacy compat only) because writing v1 would lose CRDT
/// history that incoming sidecars rely on.
///
/// Returns owned bytes so the caller can both write them to disk *and*
/// prime the file watcher's self-write suppression list without a follow-up
/// read; on the desktop the bytes hit `std::fs::write`, on Android they
/// stream into `ContentResolver.openOutputStream`.
pub fn save_sidecar_bytes(store: &CommentsStore) -> Result<Vec<u8>> {
    let am_bytes = store_to_automerge(store).context("serialize store to Automerge")?;
    let env = EnvelopeV2 {
        schema_version: 2,
        automerge: base64::engine::general_purpose::STANDARD.encode(&am_bytes),
    };
    let body = serde_json::to_string_pretty(&env)?;
    Ok(body.into_bytes())
}

/// Decide how to reconcile an `incoming` sidecar against a `local`
/// in-memory store, given the user's auto-merge preference.
///
/// - `Always` -> CRDT-merge `local` and `incoming` (deterministic and
///   conflict-free thanks to Automerge's `doc.merge()`); we no longer
///   rely on the Phase-1 newest-mtime heuristic because that loses
///   work whenever both sides edited.
/// - `Ask` / `Manual` -> return `AskUser` so the frontend can prompt.
///
/// The `_incoming_is_newer` parameter is retained for API compatibility
/// with B2's file watcher but is no longer consulted in the `Always` path.
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
            // Automerge payload — better to surface the freshest copy
            // than to silently drop everything.
            MergeOutcome::Adopted(merge_stores(&local, &incoming))
        }
        AutoMergeMode::Ask | AutoMergeMode::Manual => MergeOutcome::AskUser { local, incoming },
    }
}
