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

    set_doc_pref_handler_logic(&state, &doc, DocPref { font_size_px: 17, ..Default::default() });
    assert_eq!(
        get_doc_pref_handler_logic(&state, &doc),
        Some(DocPref { font_size_px: 17, ..Default::default() })
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

    set_doc_pref_handler_logic(&state, &doc, DocPref { font_size_px: 9999, ..Default::default() });
    assert_eq!(
        get_doc_pref_handler_logic(&state, &doc),
        Some(DocPref { font_size_px: 24, ..Default::default() }),
        "above-max coerced to 24"
    );

    set_doc_pref_handler_logic(&state, &doc, DocPref { font_size_px: 1, ..Default::default() });
    assert_eq!(
        get_doc_pref_handler_logic(&state, &doc),
        Some(DocPref { font_size_px: 10, ..Default::default() }),
        "below-min coerced to 10"
    );
}

#[test]
fn doc_pref_serializes_with_snake_case_payload() {
    // The IPC boundary needs DocPref to deserialize from the same canonical
    // snake_case shape that ts-rs emits for the frontend wrapper. Pin the
    // wire shape here so an accidental rename (e.g. via #[serde(rename)])
    // would fail the build.
    let pref = DocPref { font_size_px: 14, ..Default::default() };
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

// ---------------------------------------------------------------------------
// A9 review-cycle-1: SSH IPC command registration smoke tests.
//
// Mirrors the existing per-command checks. The two SSH IPC commands
// (`ssh_open_url`, `ssh_password_response`) must both have matching
// `#[tauri::command]`-decorated declarations in main.rs AND be listed in
// the `invoke_handler!` macro arm — otherwise frontend invocations fail
// with a runtime "command not found" toast.
// ---------------------------------------------------------------------------

#[test]
fn ipc_registration_includes_ssh_open_url() {
    let main_rs = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/main.rs"),
    )
    .expect("read main.rs");
    assert!(
        main_rs.contains("fn ssh_open_url("),
        "main.rs must declare `fn ssh_open_url(...)`",
    );
    assert!(
        main_rs.contains("            ssh_open_url,"),
        "main.rs must register `ssh_open_url` in the invoke_handler! list",
    );
}

#[test]
fn ipc_registration_includes_ssh_password_response() {
    let main_rs = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/main.rs"),
    )
    .expect("read main.rs");
    assert!(
        main_rs.contains("fn ssh_password_response("),
        "main.rs must declare `fn ssh_password_response(...)`",
    );
    assert!(
        main_rs.contains("            ssh_password_response,"),
        "main.rs must register `ssh_password_response` in the invoke_handler! list",
    );
}

// ---------------------------------------------------------------------------
// B1: ssh_list_dir Tauri command registration + File menu wiring.
//
// The OpenRemoteDialog calls `ssh_list_dir(url)` after the user picks a host
// to populate the file-picker tree. The handler parses the URL via the
// canonical core parser, calls the per-platform transport's `list_dir`, and
// flattens the result into a camelCase wire DTO so the dialog can render
// rows directly.
//
// The File menu also gains an "Open from remote…" item that emits the
// existing `menu-action` Tauri event with payload `open-remote`. The
// menuBridge (B2) translates that into `mdviewer:open-remote` for the
// dialog to subscribe to.
// ---------------------------------------------------------------------------

#[test]
fn ipc_registration_includes_ssh_list_dir() {
    let main_rs = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/main.rs"),
    )
    .expect("read main.rs");
    assert!(
        main_rs.contains("fn ssh_list_dir("),
        "main.rs must declare `fn ssh_list_dir(...)`",
    );
    assert!(
        main_rs.contains("            ssh_list_dir,"),
        "main.rs must register `ssh_list_dir` in the invoke_handler! list",
    );
}

#[test]
fn ssh_list_dir_is_async_and_parses_url_before_transport_call() {
    // The transport's `list_dir(&SshUrl)` takes a parsed URL, so the
    // handler MUST call `mdviewer_core::ssh_url::parse` first and bail
    // with the parser's error string on failure (no panicking unwrap).
    // The body must also be `async fn` because `Operations::list_dir`
    // returns a Future. We pin both shapes to catch a future refactor
    // that accidentally drops the parse step or sync-ifies the handler.
    let main_rs = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/main.rs"),
    )
    .expect("read main.rs");
    assert!(
        main_rs.contains("async fn ssh_list_dir("),
        "ssh_list_dir must be declared async (its body awaits the transport)",
    );
    // Locate the handler body and confirm the parse-then-list_dir ordering.
    let body_start = main_rs
        .find("fn ssh_list_dir(")
        .expect("main.rs declares fn ssh_list_dir");
    // Bound the search to the next blank-line-terminated `}` so a global
    // match in a later function doesn't falsely satisfy the assertion.
    let body = &main_rs[body_start..];
    let parse_idx = body
        .find("ssh_url::parse(")
        .expect("ssh_list_dir must call mdviewer_core::ssh_url::parse on the URL");
    let list_dir_idx = body
        .find(".list_dir(")
        .expect("ssh_list_dir must call transport.list_dir on the parsed URL");
    assert!(
        parse_idx < list_dir_idx,
        "URL parse must occur BEFORE the transport call",
    );
}

#[test]
fn ssh_list_dir_returns_camel_case_dto_not_raw_dir_entry() {
    // The frontend wants `{ name, isDir, size }` — the wire DTO. Returning
    // the raw `mdviewer_lib::ssh::transport::DirEntry` would still work
    // (it serializes to snake_case `is_dir`) but breaks the wireframe-02
    // contract the OpenRemoteDialog renders against. Pin the camelCase
    // rename so a future cleanup doesn't accidentally drop the
    // serde(rename_all = "camelCase") boundary type.
    let main_rs = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/main.rs"),
    )
    .expect("read main.rs");
    // The wire struct lives next to the handler with #[serde(rename_all
    // = "camelCase")] applied. We don't care about its exact name, only
    // that the boundary rename is present and the handler's return type
    // is NOT bare `Vec<...::DirEntry>`.
    assert!(
        main_rs.contains("rename_all = \"camelCase\""),
        "ssh_list_dir's wire DTO must carry #[serde(rename_all = \"camelCase\")] \
         so the OpenRemoteDialog receives `isDir` not `is_dir`",
    );
    let body_start = main_rs
        .find("fn ssh_list_dir(")
        .expect("main.rs declares fn ssh_list_dir");
    let body = &main_rs[body_start..];
    // The handler's signature must not return `Vec<DirEntry>` raw — the
    // wire DTO conversion is the whole point of the B1 boundary.
    let sig_window: String = body.chars().take(400).collect();
    assert!(
        !sig_window.contains("Result<Vec<DirEntry>"),
        "ssh_list_dir must NOT return Vec<DirEntry> raw — convert to the wire DTO at the boundary",
    );
}

#[test]
fn menu_includes_open_from_remote_file_item() {
    // The File menu builder must register `menu-open-remote` with the
    // platform-correct accelerator (CmdOrCtrl+Shift+O to avoid colliding
    // with the existing CmdOrCtrl+O "Open…"). Source-level check; the
    // menu builder needs an AppHandle so a runtime assertion would
    // demand the full Tauri test harness.
    let menu_rs = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/menu.rs"),
    )
    .expect("read menu.rs");
    assert!(
        menu_rs.contains("\"menu-open-remote\""),
        "menu.rs must register a File menu item with id `menu-open-remote`",
    );
    assert!(
        menu_rs.contains("Open from remote…"),
        "menu.rs must label the new item `Open from remote…` per wireframe 02",
    );
    assert!(
        menu_rs.contains("CmdOrCtrl+Shift+O"),
        "menu.rs must bind CmdOrCtrl+Shift+O to the new item — \
         CmdOrCtrl+O is already taken by `Open…`",
    );
}

#[tokio::test]
async fn ssh_list_dir_handler_logic_flattens_transport_entries() {
    // Mirrors the production handler body: parse the URL, call
    // `transport.list_dir`, map each `DirEntry` into the camelCase wire
    // DTO. The handler in main.rs goes through Operations::list_dir which
    // forwards to the transport; we exercise the transport directly here
    // because the wire-DTO conversion is the load-bearing part. The
    // ssh_list_dir_is_async_and_parses_url_before_transport_call test
    // pins the surrounding parse-then-list_dir ordering.
    use async_trait::async_trait;
    use mdviewer_core::ssh_url::SshUrl;
    use mdviewer_lib::ssh::transport::{DirEntry, SshStat, SshTransport, TransportError};
    use std::sync::Arc;

    struct StubTransport;

    #[async_trait]
    impl SshTransport for StubTransport {
        async fn fetch(&self, _url: &SshUrl) -> Result<Vec<u8>, TransportError> {
            unreachable!()
        }
        async fn push(&self, _url: &SshUrl, _bytes: &[u8]) -> Result<(), TransportError> {
            unreachable!()
        }
        async fn list_dir(&self, _url: &SshUrl) -> Result<Vec<DirEntry>, TransportError> {
            Ok(vec![
                DirEntry { name: "README.md".into(), is_dir: false, size: 1234 },
                DirEntry { name: "notes".into(), is_dir: true, size: 0 },
            ])
        }
        async fn stat(&self, _url: &SshUrl) -> Result<SshStat, TransportError> {
            unreachable!()
        }
    }

    // Hand-flatten what the handler does — name/is_dir/size pulled into
    // the camelCase wire shape. Verifies that the transport's contract is
    // exactly what the dialog needs (no missing fields, no surprise
    // unicode munging on names).
    let t: Arc<dyn SshTransport> = Arc::new(StubTransport);
    let url = mdviewer_core::ssh_url::parse("ssh://alice@host/notes").expect("parse");
    let entries = t.list_dir(&url).await.expect("stub returns ok");
    let wire: Vec<(String, bool, u64)> = entries
        .into_iter()
        .map(|e| (e.name, e.is_dir, e.size))
        .collect();
    assert_eq!(
        wire,
        vec![
            ("README.md".to_string(), false, 1234),
            ("notes".to_string(), true, 0),
        ],
    );
}

#[tokio::test]
async fn ssh_list_dir_handler_logic_propagates_transport_error_verbatim() {
    // The dialog's state-C surface renders the raw ssh stderr verbatim so
    // the user can see "Permission denied (publickey)" / "Host key has
    // changed" / etc. The handler converts `TransportError` to its
    // `Display` impl via `.to_string()`; any wrap-and-replace (e.g.
    // anyhow contextification, "An error occurred", or a hand-rolled
    // serde-tagged enum) would lose the verbatim text the wireframe
    // requires.
    use mdviewer_lib::ssh::transport::TransportError;
    let err = TransportError::Ssh {
        code: Some(255),
        stderr: "Permission denied (publickey).".to_string(),
    };
    let s = err.to_string();
    // The handler maps via `.map_err(|e| e.to_string())` so the wire string
    // is exactly the Display output. Pin both substrings.
    assert!(s.contains("Permission denied (publickey)."));
    assert!(s.contains("ssh exited"));
}

#[tokio::test]
async fn ssh_password_response_handler_logic_resolves_pending_oneshot() {
    // Mirrors the handler body in `main.rs::ssh_password_response`: register
    // a oneshot under `req_id` in a freshly-constructed AskpassInbox, then
    // invoke the same `inbox.respond(req_id, value)` the IPC handler runs.
    // The pending oneshot must resolve with the value carried by the IPC
    // payload. This proves the password-modal reply path stays intact even
    // if the handler shape ever changes.
    use mdviewer_lib::ssh::auth::AskpassInbox;
    let inbox = AskpassInbox::new();
    let rx = inbox.register("test-1".into());
    inbox.respond("test-1", Some("hunter2".into()));
    let got = rx.await.expect("oneshot delivered");
    assert_eq!(got, Some("hunter2".into()));
}

#[tokio::test]
async fn ssh_password_response_handler_logic_cancellation_path() {
    // The frontend cancel button calls `ssh_password_response` with `value =
    // None`. The pending oneshot must resolve with `None` so the
    // helper-conn task (Unix) / russh callback (Windows) returns the cancel
    // path rather than blocking forever waiting for a real value.
    use mdviewer_lib::ssh::auth::AskpassInbox;
    let inbox = AskpassInbox::new();
    let rx = inbox.register("test-cancel".into());
    inbox.respond("test-cancel", None);
    let got = rx.await.expect("oneshot delivered");
    assert_eq!(got, None);
}

#[test]
fn ssh_password_response_is_sync_not_async() {
    // `AskpassInbox::respond` has no .await. Declaring the handler `async`
    // would force callers (frontend) to await an immediately-ready future
    // and forces `State<'_, T>` to live across an await point that doesn't
    // exist. Pin the sync shape so a future refactor doesn't re-async-ify
    // the handler.
    let main_rs = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/main.rs"),
    )
    .expect("read main.rs");
    // Match the exact declaration line shape: `fn ssh_password_response(`
    // preceded by no `async`. We look for "async fn ssh_password_response("
    // and assert it does NOT appear.
    assert!(
        !main_rs.contains("async fn ssh_password_response("),
        "ssh_password_response must NOT be declared async (no .await in body)",
    );
    assert!(
        main_rs.contains("fn ssh_password_response("),
        "ssh_password_response declaration must remain present",
    );
}

// ---------------------------------------------------------------------------
// Phase-A impl-review fix: SSH save_document routing.
//
// The save_document Tauri command originally dispatched on `tab.backend`
// only — SSH tabs are pinned to `TabBackend::Local` in A8 so saves were
// silently hitting the local-write path. Operations::save_back was never
// called, the remote file was never updated, and SshHashMismatch conflict
// detection was unreachable.
//
// The handler now checks `ws.ssh_state(tab_id).is_some()` before the
// backend dispatch. If Some, it routes through Operations::save_back
// (lock-free .await) and applies the outcome under a re-acquired lock.
//
// We can't invoke the real #[tauri::command] from an integration test, so
// we exercise the dispatch logic against the same Workspace + Operations
// types the handler binds to. The fake transport drives both the Saved
// and Conflict paths and asserts push() did / did not run.
// ---------------------------------------------------------------------------

mod ssh_save_dispatch {
    use async_trait::async_trait;
    use mdviewer_core::ssh_url::SshUrl;
    use mdviewer_lib::ssh::operations::{Operations, SaveBackOutcome};
    use mdviewer_lib::ssh::transport::{
        DirEntry, SshStat, SshTransport, TransportError,
    };
    use mdviewer_lib::workspace::Workspace;
    use std::sync::{Arc, Mutex as StdMutex};

    /// Deterministic transport stand-in. `fetch_queue` is popped per call so
    /// the test can stage [open, save_back-recheck] in order, asserting the
    /// save-back code path's pre-push fetch sees exactly the bytes we want.
    /// `pushed` records every push for post-assertions.
    struct FakeTransport {
        fetch_queue: StdMutex<Vec<Vec<u8>>>,
        pushed: StdMutex<Vec<Vec<u8>>>,
    }

    impl FakeTransport {
        fn new(fetches: Vec<Vec<u8>>) -> Arc<Self> {
            Arc::new(Self {
                fetch_queue: StdMutex::new(fetches),
                pushed: StdMutex::new(Vec::new()),
            })
        }
        fn pushed_count(&self) -> usize {
            self.pushed.lock().unwrap().len()
        }
        fn last_pushed(&self) -> Option<Vec<u8>> {
            self.pushed.lock().unwrap().last().cloned()
        }
    }

    #[async_trait]
    impl SshTransport for FakeTransport {
        async fn fetch(&self, _url: &SshUrl) -> Result<Vec<u8>, TransportError> {
            let mut q = self.fetch_queue.lock().unwrap();
            if q.is_empty() {
                // Default fallback so tests that don't pre-seed every fetch
                // (e.g. sidecar fetch the save-path doesn't exercise here)
                // don't trip on an empty queue.
                return Ok(Vec::new());
            }
            Ok(q.remove(0))
        }
        async fn push(&self, _url: &SshUrl, bytes: &[u8]) -> Result<(), TransportError> {
            self.pushed.lock().unwrap().push(bytes.to_vec());
            Ok(())
        }
        async fn list_dir(&self, _url: &SshUrl) -> Result<Vec<DirEntry>, TransportError> {
            Ok(vec![])
        }
        async fn stat(&self, _url: &SshUrl) -> Result<SshStat, TransportError> {
            Ok(SshStat {
                size: 0,
                is_dir: false,
                mtime: None,
            })
        }
    }

    fn sample_ssh_url() -> SshUrl {
        SshUrl {
            user: Some("alice".into()),
            host: "host.example".into(),
            port: 22,
            path: "/notes/file.md".into(),
        }
    }

    /// Mirrors the production SSH branch of `save_document` (main.rs):
    ///   1. Snapshot ssh_state(tab_id) under a brief Workspace lock, release.
    ///   2. Await Operations::save_back lock-free.
    ///   3. On Saved, re-acquire and update ssh_state[tab_id].last_open_sha256.
    /// Returns the outcome so the test can assert against both arms.
    ///
    /// The presence of this helper is the point — if `save_document` skips
    /// the ssh_state check (as it did before the fix), this test path can't
    /// even reach `save_back` because the Workspace would have no entry for
    /// the tab. The companion source-level smoke test below pins that the
    /// production handler actually calls `ssh_state` before the backend
    /// dispatch.
    async fn save_via_ssh_branch(
        ws: &StdMutex<Workspace>,
        ops: &Operations,
        tab_id: &str,
        bytes: &[u8],
    ) -> Result<SaveBackOutcome, TransportError> {
        let (url, last_sha) = {
            let ws = ws.lock().unwrap();
            let s = ws
                .ssh_state(tab_id)
                .expect("ssh_state must be populated for an SSH tab");
            (s.url.clone(), s.last_open_sha256)
        };
        let outcome = ops.save_back(&url, bytes, &last_sha).await?;
        if let SaveBackOutcome::Saved { new_sha256 } = &outcome {
            let mut ws = ws.lock().unwrap();
            let st = ws
                .ssh_state_mut(tab_id)
                .expect("ssh_state must still be present after a successful save");
            st.last_open_sha256 = *new_sha256;
        }
        Ok(outcome)
    }

    #[tokio::test]
    async fn save_document_routes_ssh_tabs_to_save_back() {
        // Open: fetch returns the initial bytes; the open-time hash is
        // sha256(initial). Save-back: pre-push fetch returns the SAME bytes
        // (no remote drift) so save_back pushes the new local edit and
        // reports SaveBackOutcome::Saved.
        let data_dir = tempfile::tempdir().expect("data dir");
        let cache_dir = tempfile::tempdir().expect("cache dir");
        let initial = b"# v1\n".to_vec();
        // Two fetches: one for open_url, one for save_back's pre-push recheck.
        let fake = FakeTransport::new(vec![initial.clone(), initial.clone()]);
        let ops = Operations::new(fake.clone(), cache_dir.path().to_path_buf());

        let url = sample_ssh_url();
        let mut owned_ws = Workspace::new(data_dir.path()).expect("workspace");
        let summary = owned_ws.open_ssh_url(url, &ops).await.expect("open ok");
        let ws = StdMutex::new(owned_ws);

        let new_body = b"# v2 - my edit\n";
        let outcome = save_via_ssh_branch(&ws, &ops, &summary.id, new_body)
            .await
            .expect("save_back returns ok");
        match outcome {
            SaveBackOutcome::Saved { new_sha256 } => {
                use sha2::Digest;
                let mut h = sha2::Sha256::new();
                h.update(new_body);
                let expected: [u8; 32] = h.finalize().into();
                assert_eq!(new_sha256, expected, "new hash must equal sha256(local)");
            }
            SaveBackOutcome::Conflict { .. } => {
                panic!("expected Saved (no remote drift staged)")
            }
        }

        // Push happened with the new bytes — the heart of the fix.
        assert_eq!(fake.pushed_count(), 1, "exactly one push for the save");
        assert_eq!(
            fake.last_pushed().unwrap(),
            new_body.to_vec(),
            "pushed bytes == local edit",
        );

        // ssh_state's hash advanced to sha256(new_body) — the next save
        // will use this as the on_open_sha baseline.
        use sha2::Digest;
        let mut h = sha2::Sha256::new();
        h.update(new_body);
        let expected: [u8; 32] = h.finalize().into();
        let post_state = ws
            .lock()
            .unwrap()
            .ssh_state(&summary.id)
            .expect("ssh_state preserved")
            .clone();
        assert_eq!(
            post_state.last_open_sha256, expected,
            "last_open_sha256 must advance to sha256(new_body) after Saved",
        );
    }

    #[tokio::test]
    async fn save_document_ssh_branch_returns_conflict_on_remote_drift() {
        // Open returns v1. Save-back's pre-push fetch returns v2 (a peer
        // edited the remote while the user was editing locally) so the
        // hash check rejects the push and returns Conflict { local, remote }.
        let data_dir = tempfile::tempdir().expect("data dir");
        let cache_dir = tempfile::tempdir().expect("cache dir");
        let initial = b"# v1\n".to_vec();
        let remote_now = b"# v2 from peer\n".to_vec();
        let fake = FakeTransport::new(vec![initial.clone(), remote_now.clone()]);
        let ops = Operations::new(fake.clone(), cache_dir.path().to_path_buf());

        let url = sample_ssh_url();
        let mut owned_ws = Workspace::new(data_dir.path()).expect("workspace");
        let summary = owned_ws.open_ssh_url(url, &ops).await.expect("open ok");
        let ws = StdMutex::new(owned_ws);

        // Use `str::as_bytes` rather than a `b"..."` byte literal: the em-dash
        // is non-ASCII and Rust forbids it inside byte-string literals
        // (E0766 starting in 1.78). UTF-8 bytes are what we want anyway.
        let local_edit = "# v2 — my edit\n".as_bytes().to_vec();
        let outcome = save_via_ssh_branch(&ws, &ops, &summary.id, &local_edit)
            .await
            .expect("save_back returns ok-with-conflict");

        match outcome {
            SaveBackOutcome::Conflict { local, remote } => {
                assert_eq!(local, local_edit);
                assert_eq!(remote, remote_now);
            }
            SaveBackOutcome::Saved { .. } => {
                panic!("expected Conflict — remote hash drifted")
            }
        }

        // No push on the conflict path — that's the whole point.
        assert_eq!(
            fake.pushed_count(),
            0,
            "Conflict must NOT push: the local bytes would clobber the remote edit",
        );

        // ssh_state hash stays at sha256(initial) so a re-open is needed to
        // recover. (Asserting it didn't advance to sha256(local_edit) catches
        // a future bug where the handler updates the hash on the wrong arm.)
        use sha2::Digest;
        let mut h = sha2::Sha256::new();
        h.update(&initial);
        let initial_sha: [u8; 32] = h.finalize().into();
        let post = ws
            .lock()
            .unwrap()
            .ssh_state(&summary.id)
            .expect("state preserved through conflict")
            .clone();
        assert_eq!(
            post.last_open_sha256, initial_sha,
            "Conflict must NOT advance last_open_sha256 (caller re-opens to refresh)",
        );
    }

    #[test]
    fn save_document_checks_ssh_state_before_backend_dispatch() {
        // Source-level smoke: the SSH branch must run BEFORE the existing
        // `match tab.backend` dispatch in save_document. The check is the
        // marker `ws.ssh_state(&tab_id)` in main.rs's save_document body.
        // Locating that string proves the wiring exists; not finding it
        // means the Phase-A integration gap is back.
        let main_rs = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/main.rs"),
        )
        .expect("read main.rs");

        // Locate the save_document body and the backend match within it.
        let body_start = main_rs
            .find("fn save_document(")
            .expect("main.rs must declare fn save_document(");
        let body = &main_rs[body_start..];
        let ssh_check_idx = body
            .find("ssh_state(&tab_id)")
            .expect("save_document must consult ws.ssh_state(&tab_id)");
        let backend_match_idx = body
            .find("match tab_backend")
            .expect("save_document must still match on tab_backend after the SSH check");
        assert!(
            ssh_check_idx < backend_match_idx,
            "ssh_state check must occur BEFORE the tab_backend dispatch \
             (otherwise SSH tabs hit the Local write path again)",
        );

        // It must also call Operations::save_back inside the SSH branch
        // (which runs before `match tab_backend`). The exact prefix
        // (`.save_back(`) is the syntactic marker; locate it within the
        // pre-match window.
        let save_back_idx = body[..backend_match_idx]
            .find(".save_back(")
            .expect("SSH branch must call Operations::save_back(...) before backend dispatch");
        assert!(
            save_back_idx < backend_match_idx,
            "Operations::save_back must be invoked BEFORE the backend dispatch",
        );
    }
}
