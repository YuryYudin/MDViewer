//! Integration tests for the file watcher (B2).
//!
//! These tests exercise notify-based file change detection plus the
//! per-setting external-change behavior (Ask / Reload / Ignore) and the
//! unsaved-edits override (which forces Ask regardless of setting).
//!
//! File watching is inherently flaky on some platforms — we use generous
//! 2-second timeouts when waiting for events to land.

use mdviewer_lib::document::save_document;
use mdviewer_lib::settings::ExternalChangeBehavior;
use mdviewer_lib::watcher::{
    quick_hash, ExternalChange, ExternalChangeEvent, Watcher, WatchedKind,
};
use std::fs;
use std::time::Duration;
use tempfile::TempDir;

fn waitfor(rx: &std::sync::mpsc::Receiver<ExternalChangeEvent>) -> ExternalChangeEvent {
    // 5s upper bound: laptops fire in <100ms but Ubuntu CI runners with
    // restricted inotify quotas have been observed taking 2–4s. The tight
    // 2s value flaked under CI pressure once and was bumped after.
    rx.recv_timeout(Duration::from_secs(5)).expect("event")
}

#[test]
fn external_md_change_emits_event_per_setting_ask() {
    let tmp = TempDir::new().unwrap();
    let md = tmp.path().join("doc.md");
    fs::write(&md, "v1").unwrap();

    let (events_tx, events_rx) = std::sync::mpsc::channel();
    let mut w = Watcher::new(events_tx).unwrap();
    w.set_external_change_behavior(ExternalChangeBehavior::Ask);
    w.watch_md(&md).unwrap();

    fs::write(&md, "v2").unwrap();
    let ev = waitfor(&events_rx);
    assert_eq!(ev.kind, WatchedKind::Markdown);
    assert_eq!(ev.action, ExternalChange::Ask);
    // The watcher emits canonical paths so consumers don't have to deal with
    // platform-specific symlinks like macOS's /var -> /private/var.
    assert_eq!(ev.path, fs::canonicalize(&md).unwrap());
}

#[test]
fn behavior_reload_emits_reload_action() {
    let tmp = TempDir::new().unwrap();
    let md = tmp.path().join("doc.md");
    fs::write(&md, "v1").unwrap();

    let (tx, rx) = std::sync::mpsc::channel();
    let mut w = Watcher::new(tx).unwrap();
    w.set_external_change_behavior(ExternalChangeBehavior::Reload);
    w.watch_md(&md).unwrap();
    fs::write(&md, "v2").unwrap();
    let ev = waitfor(&rx);
    assert_eq!(ev.action, ExternalChange::Reload);
}

#[test]
fn behavior_ignore_drops_events() {
    let tmp = TempDir::new().unwrap();
    let md = tmp.path().join("doc.md");
    fs::write(&md, "v1").unwrap();

    let (tx, rx) = std::sync::mpsc::channel();
    let mut w = Watcher::new(tx).unwrap();
    w.set_external_change_behavior(ExternalChangeBehavior::Ignore);
    w.watch_md(&md).unwrap();
    fs::write(&md, "v2").unwrap();
    assert!(rx.recv_timeout(Duration::from_millis(1500)).is_err());
}

#[test]
fn unsaved_edits_always_ask_regardless_of_setting() {
    let tmp = TempDir::new().unwrap();
    let md = tmp.path().join("doc.md");
    fs::write(&md, "v1").unwrap();

    let (tx, rx) = std::sync::mpsc::channel();
    let mut w = Watcher::new(tx).unwrap();
    w.set_external_change_behavior(ExternalChangeBehavior::Reload);
    w.watch_md(&md).unwrap();
    w.mark_unsaved(&md, true);
    fs::write(&md, "v2").unwrap();
    let ev = waitfor(&rx);
    assert_eq!(ev.action, ExternalChange::Ask);
}

#[test]
fn sidecar_path_emits_kind_sidecar() {
    let tmp = TempDir::new().unwrap();
    let sc = tmp.path().join("doc.md.comments.json");
    fs::write(&sc, "{}").unwrap();

    let (tx, rx) = std::sync::mpsc::channel();
    let mut w = Watcher::new(tx).unwrap();
    w.set_external_change_behavior(ExternalChangeBehavior::Reload);
    w.watch_sidecar(&sc).unwrap();
    fs::write(&sc, r#"{"schema_version":1,"threads":[]}"#).unwrap();
    let ev = waitfor(&rx);
    assert_eq!(ev.kind, WatchedKind::Sidecar);
}

/// `record_self_write` followed by an external write whose content hashes
/// to the same value must be suppressed — that's the contract B3 relies on
/// to keep self-saves from echoing as external-change events.
#[test]
fn record_self_write_suppresses_matching_event() {
    let tmp = TempDir::new().unwrap();
    let md = tmp.path().join("doc.md");
    fs::write(&md, "v1").unwrap();

    let (tx, rx) = std::sync::mpsc::channel();
    let mut w = Watcher::new(tx).unwrap();
    w.set_external_change_behavior(ExternalChangeBehavior::Reload);
    w.watch_md(&md).unwrap();

    // Pre-record the hash of the bytes we're about to write so the worker
    // sees a matching self-write entry when notify fires.
    let next = b"v2-self-saved";
    w.record_self_write(&md, quick_hash(next));
    fs::write(&md, next).unwrap();

    // No event should land within the 500ms window — the suppression
    // entry consumes it.
    assert!(rx.recv_timeout(Duration::from_millis(1500)).is_err());
}

/// A self-write recorded for path A should not suppress an event on path B —
/// the suppression list is keyed on (path, content_hash) jointly.
#[test]
fn record_self_write_does_not_suppress_other_paths() {
    let tmp = TempDir::new().unwrap();
    let other = tmp.path().join("other.md");
    let md = tmp.path().join("doc.md");
    fs::write(&other, "x").unwrap();
    fs::write(&md, "v1").unwrap();

    let (tx, rx) = std::sync::mpsc::channel();
    let mut w = Watcher::new(tx).unwrap();
    w.set_external_change_behavior(ExternalChangeBehavior::Reload);
    w.watch_md(&md).unwrap();

    // Record a self-write for an unrelated path. The watched md change
    // below must still surface.
    let next = b"v2";
    w.record_self_write(&other, quick_hash(next));
    fs::write(&md, next).unwrap();

    let ev = waitfor(&rx);
    assert_eq!(ev.action, ExternalChange::Reload);
}

/// `quick_hash` must be deterministic for the same input — tests in B3 will
/// rely on hashing the same bytes on both sides of the watcher boundary.
#[test]
fn quick_hash_is_deterministic() {
    assert_eq!(quick_hash(b"hello"), quick_hash(b"hello"));
    assert_ne!(quick_hash(b"hello"), quick_hash(b"world"));
}

/// End-to-end: a `save_document` call followed by `record_self_write` (the
/// exact ordering B3's IPC handler uses) must NOT surface as an
/// `ExternalChange::Reload` event. This is the contract that prevents the
/// editor from echoing every save back to itself as a reload prompt.
/// The save_document priming closure must record the self-write BEFORE the
/// rename, eliminating the race against notify's worker thread. The watcher
/// is wrapped in a Mutex so the closure can borrow it inside save_document.
#[test]
fn save_document_does_not_trigger_reload() {
    let tmp = TempDir::new().unwrap();
    let md = tmp.path().join("doc.md");
    fs::write(&md, "v1").unwrap();

    let (tx, rx) = std::sync::mpsc::channel();
    let w = std::sync::Arc::new(std::sync::Mutex::new(Watcher::new(tx).unwrap()));
    {
        let mut guard = w.lock().unwrap();
        guard.set_external_change_behavior(ExternalChangeBehavior::Reload);
        guard.watch_md(&md).unwrap();
    }

    let w_for_prime = std::sync::Arc::clone(&w);
    let _r = save_document(&md, b"v2", move |p, hash| {
        w_for_prime.lock().unwrap().record_self_write(p, hash);
    })
    .unwrap();

    // No event should reach us within the suppression window. Because the
    // self-write was registered BEFORE the rename, this property holds even
    // if notify fires the moment rename returns.
    assert!(rx.recv_timeout(Duration::from_millis(1500)).is_err());
}

/// After a self-saved write is recorded, an unrelated *external* write to the
/// same path (different bytes -> different hash) must still surface as a
/// reload event. The suppression list is content-hash-keyed precisely so a
/// second concurrent edit isn't silently dropped.
#[test]
fn external_write_after_save_still_triggers() {
    let tmp = TempDir::new().unwrap();
    let md = tmp.path().join("doc.md");
    fs::write(&md, "v1").unwrap();

    let (tx, rx) = std::sync::mpsc::channel();
    let w = std::sync::Arc::new(std::sync::Mutex::new(Watcher::new(tx).unwrap()));
    {
        let mut guard = w.lock().unwrap();
        guard.set_external_change_behavior(ExternalChangeBehavior::Reload);
        guard.watch_md(&md).unwrap();
    }

    let w_for_prime = std::sync::Arc::clone(&w);
    let _r = save_document(&md, b"v2", move |p, hash| {
        w_for_prime.lock().unwrap().record_self_write(p, hash);
    })
    .unwrap();

    // External write — different content, distinct hash, must not be suppressed.
    fs::write(&md, "external write").unwrap();
    // 10s upper bound: this test does back-to-back writes (save_document
    // immediately followed by fs::write); inotify on Ubuntu CI runners
    // coalesces them into a single event after a debounce window that
    // can extend past 5s under load. Laptops and macOS fsevent fire in
    // milliseconds — the upper bound matters only on slow CI Linux.
    let ev = rx.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_eq!(ev.action, ExternalChange::Reload);
}
