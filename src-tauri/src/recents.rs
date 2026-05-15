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
    // SSH URLs are remote handles, not local filesystem paths. Calling
    // `canonicalize()` on them would resolve relative to the cwd and return
    // garbage (or fail outright on some platforms). Short-circuit so the URL
    // is preserved verbatim through the push/lookup pipeline.
    if p.to_string_lossy().starts_with("ssh://") {
        return p.to_path_buf();
    }
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}

/// One entry in the most-recently-used list, augmented with the file's
/// last-modified mtime (Unix seconds) so the StartPage can render
/// wireframe-01's "when" column ("2 hours ago", "Yesterday", "Mar 14")
/// without a follow-up IPC per row.
///
/// `mtime` is `None` when the file was unreadable at list time (deleted,
/// permission denied) — the frontend renders `—` in that case.
///
/// `kind` is derived at materialization time by sniffing the path's prefix —
/// `ssh://` URLs land as [`EntryKind::Ssh`], everything else is
/// [`EntryKind::Local`]. It is intentionally **not** stored on disk: keeping
/// the on-disk schema as a bare `[String, ...]` means old recents.json files
/// load unchanged and a future migration mangling kind-vs-path can't drift.
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct RecentEntry {
    pub path: PathBuf,
    pub mtime: Option<i64>,
    pub kind: EntryKind,
}

/// Origin tag for a [`RecentEntry`]. Derived from the path string at
/// materialization time, not persisted (see `RecentEntry`'s doc comment).
/// `#[ts(rename_all = "kebab-case")]` makes the emitted TS literal type
/// `"local" | "ssh"` — single-word variants serialize lowercased.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, rename_all = "kebab-case")]
pub enum EntryKind {
    Local,
    Ssh,
}

impl RecentEntry {
    /// Sniff a path's prefix to decide which origin tier it belongs to.
    /// Anything starting with `ssh://` is remote; everything else is local.
    /// Keeping this in one place means the classification rule lives next
    /// to the field definition, not scattered across call sites.
    fn classify(path: &Path) -> EntryKind {
        if path.to_string_lossy().starts_with("ssh://") {
            EntryKind::Ssh
        } else {
            EntryKind::Local
        }
    }
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
                    on_disk
                        .entries
                        .into_iter()
                        .filter(|p| {
                            // SSH URLs can't be stat'd without spawning ssh —
                            // applying `.exists()` to them would (a) always
                            // return false on local FS, dropping every remote
                            // recent, or (b) require a network probe per
                            // startup. Trust the entry instead; A11 surfaces
                            // unreachable hosts to the user at open time.
                            if p.to_string_lossy().starts_with("ssh://") {
                                return true;
                            }
                            p.exists()
                        })
                        .collect()
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
                RecentEntry {
                    path: p.clone(),
                    mtime,
                    kind: RecentEntry::classify(p),
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod ssh_tests {
    use super::*;

    /// `canonical_or_self` must short-circuit on `ssh://` prefixes — these are
    /// URLs, not local paths, and calling `canonicalize()` on them resolves
    /// relative to the cwd which produces garbage.
    #[test]
    fn ssh_url_preserved_unchanged() {
        let p = Path::new("ssh://alice@host:22/notes/file.md");
        let result = canonical_or_self(p);
        assert_eq!(result, p);
    }

    /// On load, the existing filter at the load path drops paths that don't
    /// `.exists()`. SSH URLs would always fail that check (we can't stat a
    /// remote without spawning ssh), so they need to pass through
    /// unconditionally.
    #[test]
    fn ssh_entries_survive_load_filter() {
        let dir = tempfile::tempdir().unwrap();
        let r = RecentsStore::open(dir.path()).unwrap();
        r.push(Path::new("ssh://host/file.md")).unwrap();
        let r2 = RecentsStore::open(dir.path()).unwrap();
        let entries = r2.list_with_mtime();
        assert!(
            entries
                .iter()
                .any(|e| e.path.to_string_lossy() == "ssh://host/file.md"),
            "ssh entry must survive the load-time `.exists()` filter"
        );
        assert!(
            entries.iter().any(|e| matches!(e.kind, EntryKind::Ssh)),
            "loaded ssh entry must be classified as Ssh"
        );
    }

    /// Local entries keep their `Local` classification — kind is derived at
    /// materialization time, not stored on disk.
    #[test]
    fn local_entries_keep_existing_kind() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("hello.md");
        std::fs::write(&file, "x").unwrap();
        let r = RecentsStore::open(dir.path()).unwrap();
        r.push(&file).unwrap();
        let entries = r.list_with_mtime();
        assert!(
            entries.iter().any(|e| matches!(e.kind, EntryKind::Local)),
            "local file must classify as Local"
        );
    }

    /// On-disk schema stays the bare-path-array shape — `kind` is derived,
    /// not persisted. A schema change here would force every existing user
    /// through a migration, which we explicitly want to avoid.
    #[test]
    fn on_disk_schema_unchanged_no_kind_field() {
        let dir = tempfile::tempdir().unwrap();
        let r = RecentsStore::open(dir.path()).unwrap();
        r.push(Path::new("ssh://host/file.md")).unwrap();
        let bytes = std::fs::read_to_string(dir.path().join("recents.json")).unwrap();
        // Schema is `{"entries": ["..."]}` — no `kind`, no `mtime`.
        assert!(bytes.contains("\"entries\""), "must keep `entries` key");
        assert!(
            !bytes.contains("\"kind\""),
            "kind must NOT be persisted to disk (derived at materialize time)"
        );
        assert!(
            bytes.contains("ssh://host/file.md"),
            "ssh URL must be stored verbatim as a string entry"
        );
    }

    /// Legacy on-disk format (the bare `{"entries": ["/abs/path"]}` shape we
    /// already ship) must load cleanly without any schema migration. Drop a
    /// hand-rolled legacy file in place and verify it deserializes.
    #[test]
    fn legacy_recents_file_loads_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("legacy.md");
        std::fs::write(&file, "x").unwrap();
        // Hand-roll the legacy on-disk shape (no `kind` field anywhere).
        let canonical = file.canonicalize().unwrap();
        let raw = format!(
            "{{\"entries\":[{}]}}",
            serde_json::to_string(&canonical).unwrap()
        );
        std::fs::write(dir.path().join("recents.json"), raw).unwrap();
        let r = RecentsStore::open(dir.path()).unwrap();
        let entries = r.list_with_mtime();
        assert_eq!(entries.len(), 1, "legacy entry must survive load");
        assert!(matches!(entries[0].kind, EntryKind::Local));
    }
}
