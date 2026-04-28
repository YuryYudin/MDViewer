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
    pub fn open(data_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(data_dir).context("create data dir")?;
        let path = data_dir.join("recents.json");
        let entries: Vec<PathBuf> = if path.exists() {
            let bytes = std::fs::read_to_string(&path).context("read recents.json")?;
            let on_disk: OnDisk = serde_json::from_str(&bytes).unwrap_or_default();
            on_disk.entries.into_iter().filter(|p| p.exists()).collect()
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
    pub fn push(&self, p: &Path) -> Result<()> {
        let canonical = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
        let snapshot = {
            let mut g = self.inner.write().unwrap();
            g.retain(|x| x != &canonical);
            g.insert(0, canonical);
            if g.len() > MAX_ENTRIES {
                g.truncate(MAX_ENTRIES);
            }
            g.clone()
        };
        std::fs::write(
            &self.path,
            serde_json::to_string_pretty(&OnDisk { entries: snapshot })?,
        )?;
        Ok(())
    }

    /// Return a clone of the current most-recent-first list.
    pub fn list(&self) -> Vec<PathBuf> {
        self.inner.read().unwrap().clone()
    }
}
