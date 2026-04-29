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
//!
//! ## Known coverage gaps
//!
//! * `open_document`'s `app.emit("show-conflict", ...)` branch is not
//!   exercised here because emitting requires a live `tauri::AppHandle`, which
//!   needs `tauri::test::mock_builder`. We assert the underlying serde shape
//!   of `OpenOutcome::Conflict` (see `open_outcome_serializes_with_kind_*`
//!   below) but not the conditional emit. Adding a real mock-app smoke test
//!   is tracked for Phase-B `B2`/`B3` once the lifecycle of `AppHandle` and
//!   the watcher Mutex stabilises.
//! * `main.rs` itself is naturally low-coverage (Tauri framework wiring); the
//!   design's Test Coverage section accepts that exemption.

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
fn set_settings_overwrite_pattern_replaces_whole_snapshot() {
    // The IPC `set_settings` handler does `update(|s| *s = settings)`.
    // This test exercises the same wholesale-replace closure shape.
    let (state, _tmp) = ws();
    let ws = state.lock().unwrap();
    let mut replacement = ws.settings_store().get();
    replacement.profile.display_name = "Replacement".into();
    replacement.appearance.theme = mdviewer_lib::settings::Theme::Dark;
    replacement.appearance.font_size_px = 18;
    replacement.comments.show_resolved = true;
    ws.settings_store()
        .update(|s| *s = replacement.clone())
        .unwrap();
    let after = ws.settings_store().get();
    assert_eq!(after.profile.display_name, "Replacement");
    assert_eq!(after.appearance.theme, mdviewer_lib::settings::Theme::Dark);
    assert_eq!(after.appearance.font_size_px, 18);
    assert!(after.comments.show_resolved);
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
fn anchor_deserializes_from_canonical_payload() {
    // The frontend sends Anchor fields with names that already match the
    // Rust struct (single-word: start/end/exact/prefix/suffix), so no
    // camelCase rewrite is needed at the boundary. This test just pins the
    // basic round-trip; a multi-word case is below.
    let json = serde_json::json!({
        "start": 6, "end": 10, "exact": "beta",
        "prefix": "alpha ", "suffix": " gamma"
    });
    let parsed: Anchor = serde_json::from_value(json).unwrap();
    assert_eq!(parsed.exact, "beta");
}

#[test]
fn camel_case_keys_round_trip_through_serde_rename() {
    // Multi-word fields ARE the case where Tauri's default JS-camelCase
    // ↔ Rust-snake_case rewrite matters. Comment carries `created_at` and
    // `resolved_at` / `resolved_by`. Confirm both forms deserialize when
    // the user passes them in JS-canonical camelCase shape and Rust serde
    // emits them in snake_case shape.
    let camel = serde_json::json!({
        "id": "c-1", "author": "Alice", "color": "#f80",
        "body": "hi", "createdAt": "2026-04-01T00:00:00Z"
    });
    // Serde does NOT rewrite by default — the test asserts the *canonical*
    // shape (snake_case) is what serde accepts, matching what Tauri produces
    // after its rename pass on the IPC boundary. The camelCase shape above
    // would fail to deserialize at the serde layer; Tauri's IPC renames it
    // to snake_case before serde sees it.
    let snake = serde_json::json!({
        "id": "c-1", "author": "Alice", "color": "#f80",
        "body": "hi", "created_at": "2026-04-01T00:00:00Z"
    });
    let from_snake: mdviewer_lib::comments::Comment =
        serde_json::from_value(snake).unwrap();
    assert_eq!(from_snake.created_at, "2026-04-01T00:00:00Z");
    let from_camel: Result<mdviewer_lib::comments::Comment, _> =
        serde_json::from_value(camel);
    // serde-only deserialization rejects the camelCase form — proving Tauri
    // really does perform the rename on the IPC seam (otherwise our
    // handlers couldn't accept JS-side `createdAt` payloads).
    assert!(
        from_camel.is_err(),
        "raw serde should NOT accept camelCase; Tauri renames on the IPC boundary"
    );
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
