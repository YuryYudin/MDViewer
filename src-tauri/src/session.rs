//! Session store — open tab paths persisted across app restarts.
//!
//! Drives the "restore where I left off" startup option. On every
//! `Workspace::open_document` and `Workspace::close_tab`, the workspace
//! pushes the current open-tab list (and the active tab) into this store;
//! `<data_dir>/session.json` mirrors that state. On startup, when
//! `Settings.appearance.startup_mode == "restore"`, `main.rs` reads the
//! stored list and re-opens each path in order before mounting the
//! workspace.
//!
//! # Why a separate file
//!
//! Settings are saved on user action (rare); session is updated on every
//! tab open/close (frequent). Sharing a TOML file with settings would
//! make every tab-open serialize the entire settings struct and race
//! with user-driven saves. A separate JSON file matches the recents.json
//! pattern and is easy to inspect when debugging.
//!
//! # Why eager (write on every change), not lazy (write on shutdown)
//!
//! Restore-on-launch is most valuable precisely when the app crashed —
//! that's when the user wants their tabs back. Writing only on a clean
//! shutdown loses the state in exactly the case where it's needed.
//! Eager writes are cheap (a small JSON blob) and the cost is amortized
//! over the user's typing speed.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use crate::recents::canonical_or_self;

/// On-disk shape. `active_tab` may be one of the entries in `open_tabs`,
/// or `None` if no tab was active when the session was saved (rare —
/// only happens transiently during shutdown).
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Session {
    pub open_tabs: Vec<PathBuf>,
    pub active_tab: Option<PathBuf>,
}

pub struct SessionStore {
    path: PathBuf,
    inner: RwLock<Session>,
}

impl SessionStore {
    /// Open (or create) the session store rooted at `data_dir`. If
    /// `session.json` exists and parses, the entries are filtered to
    /// paths that still exist on disk (a deleted file in the saved
    /// session must not block startup). Both I/O and parse failures
    /// fall back to an empty session — restore is best-effort, not
    /// authoritative state.
    pub fn open(data_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(data_dir).context("create data dir")?;
        let path = data_dir.join("session.json");
        let session: Session = if path.exists() {
            match std::fs::read_to_string(&path) {
                Ok(bytes) => {
                    let raw: Session = serde_json::from_str(&bytes).unwrap_or_default();
                    // Prune nonexistent paths so the boot loop in main.rs
                    // doesn't waste an open_document call (and surface a
                    // confusing error) for a file the user deleted.
                    let open_tabs: Vec<PathBuf> =
                        raw.open_tabs.into_iter().filter(|p| p.exists()).collect();
                    let active_tab = raw
                        .active_tab
                        .filter(|p| open_tabs.iter().any(|t| t == p));
                    Session { open_tabs, active_tab }
                }
                Err(e) => {
                    tracing::warn!(?path, ?e, "could not read session.json; starting empty");
                    Session::default()
                }
            }
        } else {
            Session::default()
        };
        Ok(Self {
            path,
            inner: RwLock::new(session),
        })
    }

    /// Snapshot the current session.
    pub fn get(&self) -> Session {
        self.inner.read().unwrap().clone()
    }

    /// Replace the saved session with the given (open_tabs, active_tab).
    /// Paths are canonicalized via the shared [`canonical_or_self`]
    /// helper so the keys agree with the recents and doc-prefs stores.
    /// The disk write happens while the lock is still held so concurrent
    /// updates serialize against each other and the on-disk file always
    /// reflects the most-recent in-memory state.
    pub fn save(&self, open_tabs: Vec<PathBuf>, active_tab: Option<PathBuf>) -> Result<()> {
        let canonical_tabs: Vec<PathBuf> = open_tabs.iter().map(|p| canonical_or_self(p)).collect();
        let canonical_active = active_tab.map(|p| canonical_or_self(&p)).filter(|p| {
            // Only keep `active_tab` when it's actually one of the
            // saved tabs — otherwise startup would activate a tab that
            // wasn't restored, leaving the workspace in a dangling state.
            canonical_tabs.iter().any(|t| t == p)
        });
        let session = Session {
            open_tabs: canonical_tabs,
            active_tab: canonical_active,
        };
        let mut guard = self.inner.write().unwrap();
        *guard = session.clone();
        let bytes = serde_json::to_string_pretty(&session).context("serialize session.json")?;
        std::fs::write(&self.path, bytes).context("write session.json")?;
        Ok(())
    }

    /// Convenience: clear the session (used by tests + a future "Clear
    /// session" UI affordance if we ever need one).
    pub fn clear(&self) -> Result<()> {
        self.save(Vec::new(), None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn touch(dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, "x").unwrap();
        p
    }

    #[test]
    fn open_returns_empty_when_no_file() {
        let dir = tempdir().unwrap();
        let store = SessionStore::open(dir.path()).unwrap();
        assert!(store.get().open_tabs.is_empty());
        assert!(store.get().active_tab.is_none());
    }

    #[test]
    fn save_then_open_round_trips() {
        let dir = tempdir().unwrap();
        let a = touch(dir.path(), "a.md");
        let b = touch(dir.path(), "b.md");
        {
            let store = SessionStore::open(dir.path()).unwrap();
            store.save(vec![a.clone(), b.clone()], Some(b.clone())).unwrap();
        }
        let reopened = SessionStore::open(dir.path()).unwrap();
        let s = reopened.get();
        assert_eq!(s.open_tabs.len(), 2);
        // canonical_or_self may resolve macOS /var → /private/var; compare basenames.
        assert_eq!(s.open_tabs[0].file_name().unwrap(), "a.md");
        assert_eq!(s.open_tabs[1].file_name().unwrap(), "b.md");
        assert_eq!(s.active_tab.as_ref().unwrap().file_name().unwrap(), "b.md");
    }

    #[test]
    fn open_prunes_missing_paths() {
        let dir = tempdir().unwrap();
        let a = touch(dir.path(), "a.md");
        let ghost = dir.path().join("ghost.md");
        {
            let store = SessionStore::open(dir.path()).unwrap();
            // Save with a path that exists + one that doesn't (simulate
            // a file the user deleted between sessions).
            store.save(vec![a.clone(), ghost.clone()], Some(ghost.clone())).unwrap();
        }
        // Delete the file that did exist to test that pruning runs at
        // load — both paths are now ghosts.
        std::fs::remove_file(&a).unwrap();
        let reopened = SessionStore::open(dir.path()).unwrap();
        let s = reopened.get();
        assert!(s.open_tabs.is_empty(), "all ghosts pruned");
        assert!(s.active_tab.is_none(), "active falls back to None when its tab is pruned");
    }

    #[test]
    fn save_drops_active_when_not_in_open_tabs() {
        // Defensive: a caller passing an active_tab that isn't in
        // open_tabs would create a dangling reference. The store
        // silently drops it instead of writing inconsistent state.
        let dir = tempdir().unwrap();
        let a = touch(dir.path(), "a.md");
        let b = touch(dir.path(), "b.md");
        let store = SessionStore::open(dir.path()).unwrap();
        store.save(vec![a.clone()], Some(b.clone())).unwrap();
        let s = store.get();
        assert_eq!(s.open_tabs.len(), 1);
        assert!(s.active_tab.is_none());
    }

    #[test]
    fn save_canonicalizes_paths() {
        // Two paths pointing at the same file via different symlinks
        // should be deduped via canonical_or_self. Test on a single
        // file without symlinks: the canonical form equals the input
        // up to platform variations like /var → /private/var on macOS.
        // The acceptance is "round-trip stable", not "byte-equal to input".
        let dir = tempdir().unwrap();
        let a = touch(dir.path(), "a.md");
        let store = SessionStore::open(dir.path()).unwrap();
        store.save(vec![a.clone()], Some(a.clone())).unwrap();
        let s1 = store.get();
        // Save again with the canonicalized form — must remain stable.
        store.save(s1.open_tabs.clone(), s1.active_tab.clone()).unwrap();
        let s2 = store.get();
        assert_eq!(s1.open_tabs, s2.open_tabs);
        assert_eq!(s1.active_tab, s2.active_tab);
    }

    #[test]
    fn corrupt_file_falls_back_to_empty() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("session.json"), "{not json").unwrap();
        let store = SessionStore::open(dir.path()).unwrap();
        assert!(store.get().open_tabs.is_empty());
    }

    #[test]
    fn clear_writes_an_empty_session() {
        let dir = tempdir().unwrap();
        let a = touch(dir.path(), "a.md");
        let store = SessionStore::open(dir.path()).unwrap();
        store.save(vec![a.clone()], Some(a.clone())).unwrap();
        store.clear().unwrap();
        let s = store.get();
        assert!(s.open_tabs.is_empty());
        assert!(s.active_tab.is_none());
        // Reopen: still empty.
        let reopened = SessionStore::open(dir.path()).unwrap();
        assert!(reopened.get().open_tabs.is_empty());
    }
}
