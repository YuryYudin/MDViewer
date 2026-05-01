//! Integration tests for `DocPrefsStore`.
//!
//! These tests round-trip the public API through a real temp `data_dir`
//! and assert the on-disk JSON shape matches the design's
//! `{ "<canonical-path>": { "font_size_px": N } }` schema. They are the
//! sibling of `tests/recents.rs` and act as the cross-task boundary
//! contract for downstream IPC consumers.

use mdviewer_lib::doc_prefs::{DocPref, DocPrefsStore};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use tempfile::TempDir;

fn data_dir() -> TempDir {
    TempDir::new().expect("tempdir")
}

#[test]
fn round_trip_save_load_delete_through_disk() {
    let dir = data_dir();
    let doc = dir.path().join("notes.md");
    fs::write(&doc, "").unwrap();

    let mut store = DocPrefsStore::open(dir.path()).expect("open");
    assert_eq!(store.load(&doc), None, "fresh store has no entries");

    store.save(&doc, DocPref { font_size_px: 18, ..Default::default() }).expect("save");
    assert_eq!(store.load(&doc), Some(DocPref { font_size_px: 18, ..Default::default() }));

    // Reopen — confirms persistence really hit disk and survives
    // dropping the in-memory snapshot.
    let store2 = DocPrefsStore::open(dir.path()).expect("reopen");
    assert_eq!(store2.load(&doc), Some(DocPref { font_size_px: 18, ..Default::default() }));

    let mut store3 = DocPrefsStore::open(dir.path()).expect("reopen3");
    store3.delete(&doc).expect("delete");
    assert_eq!(store3.load(&doc), None);

    // Reopen one last time — the delete must persist to disk.
    let store4 = DocPrefsStore::open(dir.path()).expect("reopen4");
    assert_eq!(store4.load(&doc), None);
}

#[test]
fn on_disk_schema_is_canonical_path_keyed_object() {
    // Asserts the design-doc-specified shape:
    //   { "<canonical-path>": { "font_size_px": N }, ... }
    let dir = data_dir();
    let doc = dir.path().join("schema.md");
    fs::write(&doc, "").unwrap();
    let canonical = doc.canonicalize().unwrap().to_string_lossy().into_owned();

    let mut store = DocPrefsStore::open(dir.path()).expect("open");
    store
        .save(&doc, DocPref { font_size_px: 16, ..Default::default() })
        .expect("save");

    let raw = fs::read_to_string(dir.path().join("doc_prefs.json")).expect("read file");
    let value: Value = serde_json::from_str(&raw).expect("valid JSON");

    let obj = value.as_object().expect("top-level must be an object");
    assert_eq!(obj.len(), 1);
    let entry = obj
        .get(&canonical)
        .expect("entry keyed by canonical path string");
    assert_eq!(
        entry.get("font_size_px").and_then(|v| v.as_u64()),
        Some(16),
        "entry has the design-specified `font_size_px` field"
    );

    // Round-trip via the typed shape too — the IPC consumer (next task) will
    // deserialize through `HashMap<String, DocPref>` so prove that works.
    let typed: HashMap<String, DocPref> = serde_json::from_str(&raw).expect("typed parse");
    assert_eq!(typed.get(&canonical), Some(&DocPref { font_size_px: 16, ..Default::default() }));
}

#[test]
fn save_clamps_out_of_range_input_silently() {
    let dir = data_dir();
    let doc = dir.path().join("clamped.md");
    fs::write(&doc, "").unwrap();

    let mut store = DocPrefsStore::open(dir.path()).expect("open");
    // 1000 px is well beyond the 24-px upper bound.
    store
        .save(&doc, DocPref { font_size_px: 1000, ..Default::default() })
        .expect("save coerces silently");
    assert_eq!(store.load(&doc), Some(DocPref { font_size_px: 24, ..Default::default() }));

    // And below the lower bound:
    store.save(&doc, DocPref { font_size_px: 1, ..Default::default() }).expect("save");
    assert_eq!(store.load(&doc), Some(DocPref { font_size_px: 10, ..Default::default() }));
}

#[test]
fn corrupt_disk_file_yields_empty_store() {
    // Lossy fallback contract: a corrupted file must never block app
    // launch. This is the single most important boundary contract for
    // Workspace's open path.
    let dir = data_dir();
    fs::write(dir.path().join("doc_prefs.json"), "definitely not json {").unwrap();

    let store = DocPrefsStore::open(dir.path()).expect("open must not error on corrupt file");
    let any = dir.path().join("any.md");
    assert_eq!(store.load(&any), None);
}

#[test]
fn missing_file_yields_empty_store() {
    let dir = data_dir();
    assert!(!dir.path().join("doc_prefs.json").exists());

    let store = DocPrefsStore::open(dir.path()).expect("open must succeed on missing file");
    let any = dir.path().join("any.md");
    assert_eq!(store.load(&any), None);
}
