//! Per-document font-size overrides.
//!
//! Loads/saves `<data_dir>/doc_prefs.json`, keyed by canonical path. The
//! file is created lazily on the first save; absent file means "no
//! overrides" (cold-start state for new installs).
//!
//! Clamping: `font_size_px` is clamped to `10..=24` on both `save` and
//! `load`, so a hand-edited disk file cannot poison layout. The narrower
//! bound here is intentional and does NOT widen to match the existing
//! `Settings` clamp `(8, 64)` — see the design doc's "Bounds caveat" for
//! the rationale (preserves behavior for users with hand-edited
//! `settings.toml`).
//!
//! Stale-entry pruning for renamed/deleted files is OUT OF SCOPE for this
//! pass; a future cleanup pass can prune entries whose paths no longer
//! resolve. See the design doc's Non-Goals / Risks sections.

use crate::recents::canonical_or_self;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Per-document font-size override. Crosses the IPC boundary — see
/// `src/bin/export_types.rs::export_all` for the type-export wiring.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct DocPref {
    pub font_size_px: u16,
}

const MIN_FONT_PX: u16 = 10;
const MAX_FONT_PX: u16 = 24;

/// JSON-backed map of canonical-path -> [`DocPref`]. Reads happen in-memory
/// from a snapshot loaded at `open` time; writes flush the entire snapshot
/// back to disk.
pub struct DocPrefsStore {
    file_path: PathBuf,
    entries: HashMap<String, DocPref>,
}

impl DocPrefsStore {
    /// Open the per-document preferences store rooted at `data_dir`. The
    /// file at `<data_dir>/doc_prefs.json` is read into memory; missing or
    /// corrupt files fall back to an empty map (lossy — a corrupted prefs
    /// file must never block app launch). The file itself is NOT rewritten
    /// here; the next [`save`](Self::save) writes a clean snapshot.
    pub fn open(data_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(data_dir).context("create data dir")?;
        let file_path = data_dir.join("doc_prefs.json");
        let entries: HashMap<String, DocPref> = if file_path.exists() {
            match std::fs::read_to_string(&file_path) {
                Ok(bytes) => match serde_json::from_str::<HashMap<String, DocPref>>(&bytes) {
                    Ok(mut map) => {
                        // Defense-in-depth clamp on load — a hand-edited
                        // file cannot poison layout with absurd sizes.
                        for pref in map.values_mut() {
                            pref.font_size_px = pref.font_size_px.clamp(MIN_FONT_PX, MAX_FONT_PX);
                        }
                        map
                    }
                    Err(e) => {
                        tracing::warn!(
                            ?file_path,
                            ?e,
                            "could not parse doc_prefs.json; starting empty"
                        );
                        HashMap::new()
                    }
                },
                Err(e) => {
                    tracing::warn!(
                        ?file_path,
                        ?e,
                        "could not read doc_prefs.json; starting empty"
                    );
                    HashMap::new()
                }
            }
        } else {
            HashMap::new()
        };
        Ok(Self { file_path, entries })
    }

    /// Look up the per-document override for `path`. Returns `None` if no
    /// entry exists. The returned `font_size_px` is guaranteed to be inside
    /// `10..=24` even if the on-disk file held a value outside that range.
    pub fn load(&self, path: &Path) -> Option<DocPref> {
        let key = key_for(path);
        self.entries.get(&key).copied().map(|mut pref| {
            pref.font_size_px = pref.font_size_px.clamp(MIN_FONT_PX, MAX_FONT_PX);
            pref
        })
    }

    /// Persist `pref` for `path`, clamping `font_size_px` into `10..=24`
    /// before storing. The clamp is silent — callers (e.g. the IPC handler)
    /// pass user input through unchanged and rely on this method to coerce
    /// fuzzed or hand-edited values.
    pub fn save(&mut self, path: &Path, mut pref: DocPref) -> Result<()> {
        pref.font_size_px = pref.font_size_px.clamp(MIN_FONT_PX, MAX_FONT_PX);
        let key = key_for(path);
        self.entries.insert(key, pref);
        self.persist()
    }

    /// Remove the per-document override for `path` (the "reset" path). A
    /// missing entry is a no-op; the file is still rewritten so the
    /// on-disk state matches memory.
    pub fn delete(&mut self, path: &Path) -> Result<()> {
        let key = key_for(path);
        self.entries.remove(&key);
        self.persist()
    }

    fn persist(&self) -> Result<()> {
        let body = serde_json::to_string_pretty(&self.entries)?;
        std::fs::write(&self.file_path, body)?;
        Ok(())
    }
}

fn key_for(path: &Path) -> String {
    canonical_or_self(path).to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn data_dir() -> TempDir {
        TempDir::new().expect("tempdir")
    }

    #[test]
    fn round_trip_load_save_delete() {
        let dir = data_dir();
        let doc = dir.path().join("notes.md");
        std::fs::write(&doc, "").unwrap();

        let mut store = DocPrefsStore::open(dir.path()).unwrap();
        assert_eq!(store.load(&doc), None);

        store
            .save(&doc, DocPref { font_size_px: 18 })
            .unwrap();
        assert_eq!(store.load(&doc), Some(DocPref { font_size_px: 18 }));

        // Reopen — verify persistence across instances.
        let store2 = DocPrefsStore::open(dir.path()).unwrap();
        assert_eq!(store2.load(&doc), Some(DocPref { font_size_px: 18 }));

        // Delete clears the entry and persists.
        let mut store3 = DocPrefsStore::open(dir.path()).unwrap();
        store3.delete(&doc).unwrap();
        assert_eq!(store3.load(&doc), None);
        let store4 = DocPrefsStore::open(dir.path()).unwrap();
        assert_eq!(store4.load(&doc), None);
    }

    #[test]
    fn canonical_keying_relative_matches_absolute() {
        // Saving via a relative path must be retrievable via the absolute
        // path — both sides must canonicalize to the same key, otherwise a
        // save during paste/edit (relative cwd) and a load on tab open
        // (absolute) silently miss.
        let dir = data_dir();
        let doc = dir.path().join("rel.md");
        std::fs::write(&doc, "").unwrap();

        // Compute a relative-style path by going through cwd-independent
        // canonicalization; an alias path that resolves to the same target
        // is what `canonical_or_self` is designed to dedupe.
        let absolute = doc.canonicalize().unwrap();

        let mut store = DocPrefsStore::open(dir.path()).unwrap();
        store
            .save(&doc, DocPref { font_size_px: 16 })
            .unwrap();

        // The absolute (canonical) path must hit the same entry.
        assert_eq!(
            store.load(&absolute),
            Some(DocPref { font_size_px: 16 })
        );
    }

    #[test]
    fn missing_file_returns_empty_map() {
        let dir = data_dir();
        // Don't create doc_prefs.json — it shouldn't exist yet.
        assert!(!dir.path().join("doc_prefs.json").exists());

        let store = DocPrefsStore::open(dir.path()).unwrap();
        let any_path = dir.path().join("anywhere.md");
        assert_eq!(store.load(&any_path), None);
    }

    #[test]
    fn corrupt_file_returns_empty_map() {
        // A corrupted prefs file must never block app launch — the design
        // calls for a lossy fallback (return empty map, log warn).
        let dir = data_dir();
        std::fs::write(dir.path().join("doc_prefs.json"), "{not valid json").unwrap();

        let store = DocPrefsStore::open(dir.path()).unwrap();
        let any_path = dir.path().join("anywhere.md");
        assert_eq!(store.load(&any_path), None);
    }

    #[test]
    fn save_clamps_above_max() {
        let dir = data_dir();
        let doc = dir.path().join("huge.md");
        std::fs::write(&doc, "").unwrap();

        let mut store = DocPrefsStore::open(dir.path()).unwrap();
        store
            .save(&doc, DocPref { font_size_px: 1000 })
            .unwrap();
        assert_eq!(
            store.load(&doc),
            Some(DocPref { font_size_px: 24 }),
            "save must clamp font_size_px to MAX (24)"
        );
    }

    #[test]
    fn save_clamps_below_min() {
        let dir = data_dir();
        let doc = dir.path().join("tiny.md");
        std::fs::write(&doc, "").unwrap();

        let mut store = DocPrefsStore::open(dir.path()).unwrap();
        store.save(&doc, DocPref { font_size_px: 4 }).unwrap();
        assert_eq!(
            store.load(&doc),
            Some(DocPref { font_size_px: 10 }),
            "save must clamp font_size_px to MIN (10)"
        );
    }

    #[test]
    fn load_clamps_out_of_range_disk_value() {
        // Defense in depth: even if a hand-edit slipped in past `save`, a
        // load must clamp. Write a poisoned file directly.
        let dir = data_dir();
        let doc = dir.path().join("poisoned.md");
        std::fs::write(&doc, "").unwrap();
        let canonical_key = doc.canonicalize().unwrap().to_string_lossy().into_owned();

        let raw = serde_json::json!({ canonical_key.clone(): { "font_size_px": 7 } });
        std::fs::write(
            dir.path().join("doc_prefs.json"),
            serde_json::to_string_pretty(&raw).unwrap(),
        )
        .unwrap();

        let store = DocPrefsStore::open(dir.path()).unwrap();
        assert_eq!(
            store.load(&doc),
            Some(DocPref { font_size_px: 10 }),
            "load must clamp out-of-range disk value to MIN (10)"
        );
    }

    #[test]
    fn load_clamps_above_range_disk_value() {
        let dir = data_dir();
        let doc = dir.path().join("toobig.md");
        std::fs::write(&doc, "").unwrap();
        let canonical_key = doc.canonicalize().unwrap().to_string_lossy().into_owned();

        let raw = serde_json::json!({ canonical_key.clone(): { "font_size_px": 999 } });
        std::fs::write(
            dir.path().join("doc_prefs.json"),
            serde_json::to_string_pretty(&raw).unwrap(),
        )
        .unwrap();

        let store = DocPrefsStore::open(dir.path()).unwrap();
        assert_eq!(
            store.load(&doc),
            Some(DocPref { font_size_px: 24 }),
            "load must clamp out-of-range disk value to MAX (24)"
        );
    }

    #[test]
    fn delete_missing_entry_is_noop() {
        let dir = data_dir();
        let doc = dir.path().join("never-saved.md");
        std::fs::write(&doc, "").unwrap();

        let mut store = DocPrefsStore::open(dir.path()).unwrap();
        // Should not error even though no entry exists.
        store.delete(&doc).unwrap();
        assert_eq!(store.load(&doc), None);
    }

    #[test]
    fn save_persists_canonical_key_to_disk() {
        // The on-disk shape must be `{ "<canonical-path>": { "font_size_px": N } }`.
        // Verify by reading the file back and parsing it.
        let dir = data_dir();
        let doc = dir.path().join("schema.md");
        std::fs::write(&doc, "").unwrap();
        let canonical = doc.canonicalize().unwrap().to_string_lossy().into_owned();

        let mut store = DocPrefsStore::open(dir.path()).unwrap();
        store
            .save(&doc, DocPref { font_size_px: 12 })
            .unwrap();

        let body = std::fs::read_to_string(dir.path().join("doc_prefs.json")).unwrap();
        let parsed: HashMap<String, DocPref> = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed.get(&canonical), Some(&DocPref { font_size_px: 12 }));
    }
}
