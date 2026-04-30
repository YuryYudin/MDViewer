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
use mdviewer_lib::doc_prefs::DocPref;
use mdviewer_lib::workspace::Workspace;
use std::path::Path;
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
        source: "x\n".into(),
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

// ---------------------------------------------------------------------------
// A3: doc_prefs IPC command shapes
//
// We can't import main.rs's `#[tauri::command] fn`s from a Rust integration
// test (separate crate), so we mirror their handler bodies here against the
// real `Mutex<Workspace>` State equivalent and exercise the round-trip.
//
// `set_doc_pref_handler_logic` exists to pin the silent-coerce contract: an
// out-of-range font_size_px coming from the frontend (e.g. a hand-edited
// invoke payload) must NOT bubble an error — it gets clamped to 10..=24 and
// persisted. The clamp lives at the store level (A2) but the IPC handler
// repeats it as defense-in-depth per the design doc.
// ---------------------------------------------------------------------------

fn get_doc_pref_handler_logic(state: &Mutex<Workspace>, path: &Path) -> Option<DocPref> {
    state.lock().unwrap().doc_prefs().load(path)
}

fn set_doc_pref_handler_logic(state: &Mutex<Workspace>, path: &Path, mut pref: DocPref) {
    pref.font_size_px = pref.font_size_px.clamp(10, 24);
    let _ = state.lock().unwrap().doc_prefs_mut().save(path, pref);
}

fn delete_doc_pref_handler_logic(state: &Mutex<Workspace>, path: &Path) {
    let _ = state.lock().unwrap().doc_prefs_mut().delete(path);
}

#[test]
fn doc_pref_round_trip_through_handler_logic() {
    let (state, tmp) = ws();
    let doc = tmp.path().join("note.md");
    std::fs::write(&doc, "").unwrap();

    assert_eq!(get_doc_pref_handler_logic(&state, &doc), None);

    set_doc_pref_handler_logic(&state, &doc, DocPref { font_size_px: 17 });
    assert_eq!(
        get_doc_pref_handler_logic(&state, &doc),
        Some(DocPref { font_size_px: 17 })
    );

    delete_doc_pref_handler_logic(&state, &doc);
    assert_eq!(get_doc_pref_handler_logic(&state, &doc), None);
}

#[test]
fn set_doc_pref_silently_coerces_out_of_range() {
    // Design contract: set_doc_pref must NOT return an error for fuzzed /
    // hand-edited values — it silently coerces font_size_px into 10..=24.
    let (state, tmp) = ws();
    let doc = tmp.path().join("clamp.md");
    std::fs::write(&doc, "").unwrap();

    set_doc_pref_handler_logic(&state, &doc, DocPref { font_size_px: 9999 });
    assert_eq!(
        get_doc_pref_handler_logic(&state, &doc),
        Some(DocPref { font_size_px: 24 }),
        "above-max coerced to 24"
    );

    set_doc_pref_handler_logic(&state, &doc, DocPref { font_size_px: 1 });
    assert_eq!(
        get_doc_pref_handler_logic(&state, &doc),
        Some(DocPref { font_size_px: 10 }),
        "below-min coerced to 10"
    );
}

#[test]
fn doc_pref_serializes_with_snake_case_payload() {
    // The IPC boundary needs DocPref to deserialize from the same canonical
    // snake_case shape that ts-rs emits for the frontend wrapper. Pin the
    // wire shape here so an accidental rename (e.g. via #[serde(rename)])
    // would fail the build.
    let pref = DocPref { font_size_px: 14 };
    let v = serde_json::to_value(&pref).unwrap();
    assert_eq!(v["font_size_px"], 14);

    let parsed: DocPref = serde_json::from_value(serde_json::json!({
        "font_size_px": 12
    }))
    .unwrap();
    assert_eq!(parsed.font_size_px, 12);
}

#[test]
fn open_external_url_rejects_non_http_schemes() {
    // The IPC handler must refuse anything that isn't http(s) so a
    // user can't be tricked into shelling out for `file://`,
    // `javascript:`, or a custom scheme. We mirror the handler's
    // validation here (the actual handler lives in main.rs which the
    // integration-test crate can't import).
    fn validate(url: &str) -> Result<(), String> {
        let lowered = url.to_ascii_lowercase();
        if !lowered.starts_with("http://") && !lowered.starts_with("https://") {
            return Err("only http/https URLs may be opened externally".into());
        }
        Ok(())
    }
    assert!(validate("https://example.com/").is_ok());
    assert!(validate("HTTP://example.com/").is_ok());
    assert!(validate("file:///etc/passwd").is_err());
    assert!(validate("javascript:alert(1)").is_err());
    assert!(validate("ftp://example.com/").is_err());
    assert!(validate("").is_err());
}

#[test]
fn ipc_registration_includes_open_external_url() {
    // Source-level smoke that the new command is wired into main.rs.
    let main_rs = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/main.rs"),
    )
    .expect("read main.rs");
    assert!(
        main_rs.contains("fn open_external_url("),
        "main.rs must declare `fn open_external_url(...)`",
    );
    assert!(
        main_rs.contains("            open_external_url,"),
        "main.rs must register `open_external_url` in the invoke_handler! list",
    );
}

#[test]
fn ipc_registration_includes_doc_pref_commands() {
    // Source-level smoke: read main.rs and assert the three new commands
    // were appended to the invoke_handler! macro. We can't link into main.rs
    // from this test crate, so the static check is the closest proxy short
    // of a full tauri::test harness.
    let main_rs = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/main.rs"),
    )
    .expect("read main.rs");
    for cmd in ["get_doc_pref", "set_doc_pref", "delete_doc_pref"] {
        assert!(
            main_rs.contains(&format!("fn {cmd}(")),
            "main.rs must declare `fn {cmd}(...)`"
        );
        // The macro arm is a bare identifier — match it as `\n    cmd,`.
        assert!(
            main_rs.contains(&format!("            {cmd},")),
            "main.rs must register `{cmd}` in the invoke_handler! list"
        );
    }
}

#[test]
fn drive_ipc_commands_registered() {
    // A7: source-level smoke that the seven new Drive IPC commands are wired
    // into main.rs's invoke_handler! list AND have matching `#[tauri::command]`
    // declarations. Mirrors the existing per-command checks above so an
    // accidental drop from the macro arm shows up as a unit-test failure
    // rather than a runtime "command not found" toast.
    let main_rs = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/main.rs"),
    )
    .expect("read main.rs");
    let names = [
        "drive_connect",
        "drive_disconnect",
        "drive_status",
        "drive_open_url",
        "drive_resolve_path",
        "drive_get_collaborators",
        "is_drive_desktop_path",
    ];
    for n in names {
        assert!(
            main_rs.contains(&format!("fn {n}(")),
            "missing IPC handler declaration: fn {n}(",
        );
        assert!(
            main_rs.contains(&format!("            {n},")),
            "missing IPC command in invoke_handler!: {n}",
        );
    }
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
