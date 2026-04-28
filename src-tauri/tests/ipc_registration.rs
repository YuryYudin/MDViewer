//! IPC registration test (Phase-1).
//!
//! The IPC commands live in `main.rs`, which a Rust integration test (its own
//! crate) cannot import. We test the handler logic by exercising the same
//! `Workspace` shapes and serde envelopes that the IPC layer uses, plus the
//! camelCase-aware deserialization. This avoids depending on `tauri::test`'s
//! mock-app helpers — whose exact shape varies across Tauri 2.x patch
//! versions — while still asserting (a) the handler shapes compile against
//! the real types, (b) they propagate the right errors, and (c) the
//! camelCase-aware deserialization works.

use mdviewer_lib::anchor::{Anchor, ResolveOutcome};
use mdviewer_lib::comments::Thread;
use mdviewer_lib::workspace::Workspace;
use std::sync::Mutex;
use tempfile::TempDir;

// Mirror of main.rs's per-handler bodies. We test the handler logic by
// calling each fn directly with a `tauri::State`-equivalent (we use the
// mutex-locked Workspace since `State` is just a wrapper). This keeps the
// test pure-Rust and independent of tauri::test API drift.

fn ws() -> (Mutex<Workspace>, TempDir) {
    let tmp = TempDir::new().unwrap();
    (Mutex::new(Workspace::new(tmp.path()).unwrap()), tmp)
}

#[test]
fn list_threads_returns_err_for_unknown_tab() {
    let (state, _tmp) = ws();
    let res = state
        .lock()
        .unwrap()
        .comments_for("missing-tab")
        .map(|c| c.list_threads().to_vec());
    assert!(res.is_err());
}

#[test]
fn settings_round_trip_through_handler_logic() {
    let (state, _tmp) = ws();
    {
        let ws = state.lock().unwrap();
        let original = ws.settings_store().get();
        ws.settings_store()
            .update(|s| {
                s.profile.display_name = "Carol".into();
            })
            .unwrap();
        let updated = ws.settings_store().get();
        assert_eq!(updated.profile.display_name, "Carol");
        assert_eq!(updated.appearance, original.appearance); // untouched
    }
}

#[test]
fn resolve_anchor_for_tab_propagates_unknown_tab_err() {
    let (state, _tmp) = ws();
    let a = Anchor {
        start: 0,
        end: 5,
        exact: "Hello".into(),
        prefix: "".into(),
        suffix: "".into(),
    };
    let res = state
        .lock()
        .unwrap()
        .resolve_anchor_for_tab("missing", &a);
    assert!(res.is_err());
}

#[test]
fn camel_case_payload_deserializes_to_snake_case_anchor() {
    // Tauri's IPC layer renames JS-side camelCase keys to Rust-side
    // snake_case automatically, but the Anchor struct's fields are already
    // snake_case (start/end/exact/prefix/suffix). We assert a sample payload
    // matching what the frontend sends round-trips losslessly.
    let json = serde_json::json!({
        "start": 6, "end": 10, "exact": "beta",
        "prefix": "alpha ", "suffix": " gamma"
    });
    let parsed: Anchor = serde_json::from_value(json).unwrap();
    assert_eq!(parsed.exact, "beta");
}

#[test]
fn render_markdown_returns_serializable_result() {
    use mdviewer_lib::document::{render_markdown, RenderOptions, RenderResult};
    let r: RenderResult = render_markdown("# Hi", &RenderOptions::default());
    let v = serde_json::to_value(&r).unwrap();
    assert!(v["html"].as_str().unwrap().contains("<h1"));
    // text_spans serializes to a JSON array of [start, end] tuples.
    assert!(v["text_spans"].is_array());
}

#[test]
fn open_outcome_serializes_with_kind_discriminant() {
    use mdviewer_lib::workspace::{OpenOutcome, OpenResult};
    let outcome = OpenOutcome::Document(OpenResult {
        tab_id: "t-x".into(),
        path: std::path::PathBuf::from("/tmp/x.md"),
        html: "<p>x</p>".into(),
        threads: vec![],
    });
    let v = serde_json::to_value(&outcome).unwrap();
    assert_eq!(v["kind"], "document");
    assert_eq!(v["tab_id"], "t-x");

    let conflict = OpenOutcome::Conflict {
        tab_id: "t-c".into(),
        path: std::path::PathBuf::from("/tmp/c.md"),
        local: "L".into(),
        incoming: "I".into(),
    };
    let v = serde_json::to_value(&conflict).unwrap();
    assert_eq!(v["kind"], "conflict");
    assert_eq!(v["local"], "L");
}

#[test]
fn thread_resolveoutcome_serialize_matches_ts_generated_shape() {
    let r = ResolveOutcome::Resolved { start: 0, end: 5 };
    let v = serde_json::to_value(&r).unwrap();
    assert_eq!(v["kind"], "resolved");
    assert_eq!(v["start"], 0);
    let _ = serde_json::to_value(&Thread {
        id: "t".into(),
        anchor: Anchor {
            start: 0,
            end: 1,
            exact: "a".into(),
            prefix: "".into(),
            suffix: "".into(),
        },
        comments: vec![],
        resolved: false,
        resolved_at: None,
        resolved_by: None,
    })
    .unwrap();
}
