//! Per-file cache metadata at `<config_dir>/drive_cache_meta/<file_id>.json`.
//!
//! Stores the conditional-GET ETag, the last-fetched timestamp, and a
//! content hash so the sync engine (B5) can:
//! 1. Send `If-None-Match` on the next poll and trust a 304 to mean "skip".
//! 2. Detect a stale local cache when the hash doesn't match what the user
//!    is about to upload (precondition check before PATCH).
//!
//! ## Why a separate dir from `drive_id_map/`
//!
//! `drive_cache_meta/<file_id>.json` is **invalidated** when the cached
//! document body is recomputed (every successful download). Conversely
//! `drive_id_map/<file_id>.json` is **persisted** across cache wipes — the
//! local→Drive comment id mapping is a Drive-side identity, not a cache
//! artifact, and re-deriving it would require a full poll cycle that
//! re-imports every comment as new (= duplicate threads on screen).
//!
//! Keeping the two in distinct directories means a future "clear cache"
//! affordance can `rm -rf drive_cache_meta/` without taking the id_map
//! with it.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CacheMeta {
    /// The Drive ETag returned with the last 200 download. Sent back as
    /// `If-None-Match` on the next conditional GET so a 304 short-circuits
    /// re-download when nothing changed.
    pub etag: String,
    /// RFC3339 timestamp of the last successful fetch. Surfaced in the UI
    /// status pill ("last synced 3 min ago") and used by B5 to decide when
    /// to re-poll on a focused-tab cycle.
    pub last_fetched: String,
    /// SHA-256 of the cached file body (hex-lowercase). Used by the upload
    /// path to verify the cache wasn't tampered with between download and
    /// edit — if the hash mismatches, we refuse to overwrite Drive.
    pub content_sha256: String,
}

fn cache_meta_path(config_dir: &Path, file_id: &str) -> PathBuf {
    let mut p = config_dir.to_path_buf();
    p.push("drive_cache_meta");
    let _ = std::fs::create_dir_all(&p);
    p.push(format!("{}.json", file_id));
    p
}

/// Persist cache metadata for a given file id. Whole-file rewrite is fine
/// here — the payload is a few hundred bytes and the write happens at most
/// once per poll cycle.
pub fn save_cache_meta(
    config_dir: &Path,
    file_id: &str,
    m: &CacheMeta,
) -> std::io::Result<()> {
    let p = cache_meta_path(config_dir, file_id);
    let body = serde_json::to_string(m).unwrap();
    std::fs::write(p, body)
}

/// Load cache metadata for a given file id. Missing file or malformed JSON
/// → `None`, so the next poll falls through to an unconditional GET (slower,
/// but always correct).
pub fn load_cache_meta(config_dir: &Path, file_id: &str) -> Option<CacheMeta> {
    let p = cache_meta_path(config_dir, file_id);
    std::fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}
