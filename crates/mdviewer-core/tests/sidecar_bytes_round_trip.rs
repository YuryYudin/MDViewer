//! A5: bytes-in/bytes-out sidecar API in `mdviewer-core`.
//!
//! These tests exercise the platform-agnostic surface that Android's
//! `ContentResolver` storage path will share with the desktop's `std::fs`
//! wrapper. The desktop's path-form tests (round-trip, v1 read, merge
//! policy) live in `src-tauri/tests/sidecar.rs`; this file mirrors the
//! coverage at the bytes layer so a regression in either platform's
//! storage glue surfaces here, not in a downstream IPC harness.

use mdviewer_core::anchor::Anchor;
use mdviewer_core::auto_merge::AutoMergeMode;
use mdviewer_core::comments::{CommentsStore, MergeOutcome, NewComment, NewThread};
use mdviewer_core::sidecar::{load_sidecar_bytes, merge_with_policy, save_sidecar_bytes};

fn anchor() -> Anchor {
    Anchor {
        start: 0,
        end: 5,
        exact: "Hello".into(),
        prefix: String::new(),
        suffix: " world".into(),
    }
}

fn fixture_thread(body: &str) -> NewThread {
    NewThread {
        anchor: anchor(),
        first_comment: NewComment {
            author: "Tester".into(),
            color: "#7c3aed".into(),
            body: body.into(),
        },
    }
}

#[test]
fn save_then_load_v2_envelope_round_trips() {
    let mut store = CommentsStore::new();
    let created = store.create_thread(fixture_thread("hello"));

    let bytes = save_sidecar_bytes(&store).unwrap();
    // Bytes must be a valid v2 envelope so Android's ContentResolver consumer
    // can decode them with the same dispatch.
    let env: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(env["schema_version"], 2);
    assert!(env["automerge"].is_string());

    let restored = load_sidecar_bytes(&bytes).unwrap();
    assert_eq!(store.list_threads().len(), restored.list_threads().len());
    assert_eq!(restored.list_threads()[0].id, created.id);
    assert_eq!(restored.list_threads()[0].comments[0].body, "hello");
}

#[test]
fn empty_bytes_returns_empty_store() {
    // Mirrors the desktop "missing file -> empty store" contract: callers
    // that read from a brand-new document handle (Android `openInputStream`
    // returning zero bytes) shouldn't have to special-case the empty payload.
    let store = load_sidecar_bytes(b"").unwrap();
    assert!(store.list_threads().is_empty());
}

#[test]
fn legacy_v1_json_loads_without_rewrite() {
    // Phase-1 plain JSON must still parse so existing user sidecars survive
    // the upgrade. The bytes API never rewrites on load — the next
    // `save_sidecar_bytes` upgrades to v2.
    let v1 = br##"{
        "schema_version": 1,
        "threads": [{
            "id": "t-legacy",
            "anchor": {"start":0,"end":5,"exact":"hello","prefix":"","suffix":""},
            "comments": [{"id":"c-legacy","author":"A","color":"#f80","body":"hi","created_at":"2025-01-01T00:00:00Z"}],
            "resolved": false
        }]
    }"##;
    let store = load_sidecar_bytes(v1).unwrap();
    assert_eq!(store.list_threads().len(), 1);
    assert_eq!(store.list_threads()[0].id, "t-legacy");
    assert_eq!(store.list_threads()[0].comments[0].id, "c-legacy");
}

#[test]
fn unsupported_schema_version_errors() {
    // Anything beyond v2 must bail loudly so a future format isn't silently
    // mishandled into data loss.
    let future = br#"{"schema_version": 99, "threads": []}"#;
    let err = load_sidecar_bytes(future).unwrap_err();
    assert!(format!("{err}").contains("unsupported schema_version"));
}

#[test]
fn invalid_json_propagates_parse_error() {
    let err = load_sidecar_bytes(b"not-valid-json").unwrap_err();
    assert!(format!("{err}").contains("parse sidecar"));
}

#[test]
fn merge_with_policy_always_unions_threads() {
    let mut local = CommentsStore::new();
    local.create_thread(fixture_thread("local-only"));
    let mut incoming = CommentsStore::new();
    incoming.create_thread(fixture_thread("incoming-only"));

    match merge_with_policy(local, incoming, AutoMergeMode::Always, /*incoming_is_newer=*/ true) {
        MergeOutcome::Adopted(merged) => assert_eq!(merged.list_threads().len(), 2),
        MergeOutcome::AskUser { .. } => panic!("Always must adopt without asking"),
    }
}

#[test]
fn merge_with_policy_ask_returns_both_sides() {
    let local = CommentsStore::new();
    let mut incoming = CommentsStore::new();
    incoming.create_thread(fixture_thread("remote"));

    match merge_with_policy(local, incoming, AutoMergeMode::Ask, false) {
        MergeOutcome::AskUser { local, incoming } => {
            assert!(local.list_threads().is_empty());
            assert_eq!(incoming.list_threads().len(), 1);
        }
        MergeOutcome::Adopted(_) => panic!("Ask must surface both sides"),
    }
}

#[test]
fn merge_with_policy_manual_returns_both_sides() {
    let outcome = merge_with_policy(
        CommentsStore::new(),
        CommentsStore::new(),
        AutoMergeMode::Manual,
        true,
    );
    assert!(matches!(outcome, MergeOutcome::AskUser { .. }));
}
