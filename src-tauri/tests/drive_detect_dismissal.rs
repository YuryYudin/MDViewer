//! C2: per-file dismissal of the Drive-detect toast.
//!
//! The toast appears when a document opens from a Drive Desktop path while
//! Drive is not connected. The user can dismiss it on a per-file basis
//! ("Not now"). This test asserts that the dismissal flag round-trips
//! through the existing `DocPrefStore` (the same JSON file used by the
//! per-document font-size override) and that setting the flag for one
//! file does NOT leak into another file's preferences.
//!
//! Lives in its own integration-test crate (per plan.json) so all Drive-
//! related tests are grouped under the `drive_*` prefix and run with one
//! `cargo test --test drive_detect_dismissal` invocation.

use mdviewer_lib::doc_prefs::{DocPref, DocPrefsStore};
use std::path::Path;
use tempfile::TempDir;

#[test]
fn drive_detect_dismissal_persists_per_file() {
    let dir = TempDir::new().unwrap();
    // Create the actual files so canonical-path keying succeeds (the store
    // canonicalises both on save and on load, and a non-existent path has
    // no canonical form on macOS / Linux).
    let path_a = dir.path().join("notes.md");
    let path_b = dir.path().join("other.md");
    std::fs::write(&path_a, "").unwrap();
    std::fs::write(&path_b, "").unwrap();

    let mut store = DocPrefsStore::open(dir.path()).unwrap();

    // Cold start — neither file has an entry, so .drive_detect_dismissed
    // is the default (false) regardless of which path we ask about.
    assert!(!store.load(&path_a).map(|p| p.drive_detect_dismissed).unwrap_or(false));
    assert!(!store.load(&path_b).map(|p| p.drive_detect_dismissed).unwrap_or(false));

    // Dismiss for path_a only.
    let pref = DocPref {
        font_size_px: 14,
        drive_detect_dismissed: true,
    };
    store.save(&path_a, pref).unwrap();

    // path_a now reports dismissed; path_b is untouched.
    let loaded_a = store.load(&path_a).expect("path_a should now have an entry");
    assert!(loaded_a.drive_detect_dismissed);
    assert!(store.load(&path_b).map(|p| p.drive_detect_dismissed).unwrap_or(false) == false);

    // Reopen the store from disk — the dismissal must persist across
    // process restarts (the toast must NOT re-appear after a relaunch).
    let store2 = DocPrefsStore::open(dir.path()).unwrap();
    assert!(store2.load(&path_a).expect("dismissal must round-trip to disk").drive_detect_dismissed);
}

#[test]
fn dismissal_flag_defaults_false_when_legacy_doc_prefs_lacks_field() {
    // Older app versions wrote `doc_prefs.json` entries with only a
    // `font_size_px` key. Loading those entries must surface
    // `drive_detect_dismissed = false` via `serde(default)` rather than
    // failing parse — otherwise an upgrade would silently drop every
    // user's per-document font-size override.
    let dir = TempDir::new().unwrap();
    let doc = dir.path().join("legacy.md");
    std::fs::write(&doc, "").unwrap();
    let canonical = doc.canonicalize().unwrap().to_string_lossy().into_owned();

    let raw = serde_json::json!({ canonical.clone(): { "font_size_px": 16 } });
    std::fs::write(
        dir.path().join("doc_prefs.json"),
        serde_json::to_string_pretty(&raw).unwrap(),
    )
    .unwrap();

    let store = DocPrefsStore::open(dir.path()).unwrap();
    let pref = store.load(Path::new(&canonical)).expect("legacy entry must load");
    assert_eq!(pref.font_size_px, 16);
    assert!(!pref.drive_detect_dismissed);
}
