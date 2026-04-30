//! Recents (most-recently-used) store.
//!
//! Persists a JSON-backed list of recently opened paths at
//! `<data_dir>/recents.json`, separate from `settings.toml` so the two stores
//! can be written on independent cadences without contention. The list is
//! capped at [`MAX_ENTRIES`] entries and is pruned of missing files at load
//! time so the StartPage never displays stale rows.
//!
//! # Why a separate file
//! Settings are saved on user action; recents are saved on every file open.
//! Sharing a TOML file would mean every file-open save races with settings
//! saves. A separate JSON file is also easy to inspect when debugging.
//!
//! # Why a Vec, not a stack overlay
//! The StartPage wireframe shows the most-recent-first list, deduplicated.
//! Maintaining a Vec with an explicit cap means rendering is a clone of the
//! current snapshot, not a re-walk of an append-only log.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::UNIX_EPOCH;

/// Canonicalize `p`, falling back to `p` as-given if canonicalize fails (e.g.
/// for nonexistent files). Shared between [`RecentsStore::push`] and the
/// per-document preferences store so both stores agree on the key shape:
/// a path canonicalized on tab open must match the same form on save, or
/// lookups silently miss.
pub(crate) fn canonical_or_self(p: &Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}

/// One entry in the most-recently-used list, augmented with the file's
/// last-modified mtime (Unix seconds) so the StartPage can render
/// wireframe-01's "when" column ("2 hours ago", "Yesterday", "Mar 14")
/// without a follow-up IPC per row.
///
/// `mtime` is `None` when the file was unreadable at list time (deleted,
/// permission denied) — the frontend renders `—` in that case.
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct RecentEntry {
    pub path: PathBuf,
    pub mtime: Option<i64>,
}

const MAX_ENTRIES: usize = 10;

#[derive(Debug, Default, Serialize, Deserialize)]
struct OnDisk {
    entries: Vec<PathBuf>,
}

pub struct RecentsStore {
    path: PathBuf,
    inner: RwLock<Vec<PathBuf>>,
}

impl RecentsStore {
    /// Open (or create) the recents store rooted at `data_dir`. If
    /// `recents.json` exists, missing paths are pruned at load time.
    /// Both read and parse failures fall back to an empty list — startup
    /// must not block on a corrupt or unreadable recents file (it is purely
    /// an MRU convenience, not authoritative state).
    pub fn open(data_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(data_dir).context("create data dir")?;
        let path = data_dir.join("recents.json");
        let entries: Vec<PathBuf> = if path.exists() {
            // Recover gracefully from both I/O and parse failures: log the
            // reason and start with an empty list. The next push() will
            // overwrite the file with valid JSON.
            match std::fs::read_to_string(&path) {
                Ok(bytes) => {
                    let on_disk: OnDisk = serde_json::from_str(&bytes).unwrap_or_default();
                    on_disk.entries.into_iter().filter(|p| p.exists()).collect()
                }
                Err(e) => {
                    tracing::warn!(?path, ?e, "could not read recents.json; starting empty");
                    Vec::new()
                }
            }
        } else {
            Vec::new()
        };
        Ok(Self {
            path,
            inner: RwLock::new(entries),
        })
    }

    /// Push `p` to the front of the recents list. The path is canonicalized
    /// (with a fallback to the as-given path if canonicalize fails — e.g. for
    /// nonexistent files) so symlinked / aliased paths dedupe correctly.
    /// If `p` is already present it is moved to the top. The list is
    /// truncated to [`MAX_ENTRIES`] and persisted to disk.
    ///
    /// The disk write happens while the lock is still held so concurrent
    /// pushes serialize against each other and the on-disk file always
    /// reflects the most-recent in-memory state.
    pub fn push(&self, p: &Path) -> Result<()> {
        let canonical = canonical_or_self(p);
        let mut g = self.inner.write().unwrap();
        g.retain(|x| x != &canonical);
        g.insert(0, canonical);
        if g.len() > MAX_ENTRIES {
            g.truncate(MAX_ENTRIES);
        }
        // Hold the lock across the write so two concurrent pushes can't race
        // on the on-disk snapshot.
        std::fs::write(
            &self.path,
            serde_json::to_string_pretty(&OnDisk { entries: g.clone() })?,
        )?;
        Ok(())
    }

    /// Return a clone of the current most-recent-first list of paths.
    /// Kept for backwards compatibility with callers that don't need
    /// mtime; new code should use [`list_with_mtime`].
    pub fn list(&self) -> Vec<PathBuf> {
        self.inner.read().unwrap().clone()
    }

    /// Most-recent-first list with each path's filesystem mtime (or
    /// `None` if the file is unreadable). Drives the StartPage's
    /// "when" column.
    pub fn list_with_mtime(&self) -> Vec<RecentEntry> {
        self.inner
            .read()
            .unwrap()
            .iter()
            .map(|p| {
                let mtime = std::fs::metadata(p)
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64);
                RecentEntry { path: p.clone(), mtime }
            })
            .collect()
    }
}
