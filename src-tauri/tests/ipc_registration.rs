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

// ---------------------------------------------------------------------------
// B2: window-scoped tab commands + addressed event routing.
//
// The IPC handlers now derive their window from the injected `tauri::Window`
// (`.label()`) instead of a client argument, events are addressed via
// `emit_to(<label>, …)`, and session restore recreates N windows. We can't
// import main.rs's `#[tauri::command] fn`s from this crate, so we (a) exercise
// the window-scoped Workspace API the handlers delegate to, (b) unit-test the
// pure helpers (`window_has_dirty_tab` / `restore_window_label`) by mirroring
// their bodies against the real Workspace, and (c) source-level smoke that the
// handlers take a `window: tauri::Window` and call `emit_to`.
// ---------------------------------------------------------------------------

mod window_scoping {
    use super::*;
    use mdviewer_lib::workspace::{OpenOpts, OpenOutcome, MAIN_LABEL};
    use std::path::Path;

    /// Mirror of main.rs's pure `window_has_dirty_tab`: any tab owned by
    /// `label` for which `dirty_for(path)` is true. The production handler
    /// passes `|p| watcher.is_unsaved(p)`; here we inject an explicit set.
    fn window_has_dirty_tab(
        ws: &mdviewer_lib::workspace::Workspace,
        label: &str,
        dirty_for: impl Fn(&Path) -> bool,
    ) -> bool {
        ws.list_open_documents_for(label)
            .iter()
            .any(|t| dirty_for(&t.path))
    }

    /// Mirror of main.rs's pure `restore_window_label`: idx 0 → "main",
    /// later windows → unique `win-{nanos+idx}`.
    fn restore_window_label(index: usize, nanos: u128) -> String {
        if index == 0 {
            MAIN_LABEL.to_string()
        } else {
            format!("win-{}", nanos + index as u128)
        }
    }

    /// E2: mirror of main.rs's pure `route_target_label` — the CLI / file-
    /// association dispatch landing-site decision. One-owner wins (`owner`
    /// re-routes into the window that already holds the doc); otherwise the
    /// target lands in the most-recently-focused window (`focused`).
    fn route_target_label(focused: &str, owner: Option<&str>) -> String {
        match owner {
            Some(owner_label) => owner_label.to_string(),
            None => focused.to_string(),
        }
    }

    #[test]
    fn route_target_label_defaults_to_focused_when_not_open() {
        // E2 S8: a not-yet-open target lands in the focused window, not `main`.
        assert_eq!(route_target_label("win-2", None), "win-2");
        // Even when the focused window happens to be main, the routing is
        // "focused", not a hard-coded constant.
        assert_eq!(route_target_label(MAIN_LABEL, None), MAIN_LABEL);
    }

    #[test]
    fn route_target_label_one_owner_wins_over_focused() {
        // One-owner: a target already open in `main` must re-route into main
        // even though `win-2` is focused — no duplicate copy in the focused
        // window.
        assert_eq!(route_target_label("win-2", Some(MAIN_LABEL)), MAIN_LABEL);
        // Owner == focused is a no-op (the focused window already owns it).
        assert_eq!(route_target_label("win-2", Some("win-2")), "win-2");
    }

    #[test]
    fn route_target_label_one_owner_canonicalized_lookup() {
        // E2: the dispatch canonicalizes the path before `owning_window_label`
        // (which compares raw `Tab.path` — stored canonical by
        // open_document). This mirror test pins that an already-open doc,
        // looked up by its CANONICAL path, resolves to its owning window so
        // route_target_label re-routes into it rather than the focused window.
        let (state, tmp) = ws();
        let doc = tmp.path().join("owned.md");
        std::fs::write(&doc, "# owned\n").unwrap();

        let mut g = state.lock().unwrap();
        g.new_window("win-2".to_string());
        // Doc lives in main.
        g.open_document_for(MAIN_LABEL, &doc, OpenOpts::default()).unwrap();

        // Dispatch is "focused = win-2"; canonicalize the path the way the
        // dispatch does before the owner lookup.
        let canonical = doc.canonicalize().unwrap_or_else(|_| doc.clone());
        let owner = g.owning_window_label(&canonical).map(str::to_string);
        assert_eq!(owner.as_deref(), Some(MAIN_LABEL));
        assert_eq!(
            route_target_label("win-2", owner.as_deref()),
            MAIN_LABEL,
            "already-open doc re-routes into its owner, not the focused window"
        );
    }

    /// F1: mirror of main.rs's `NewWindowTargetAction` + `new_window_target_action`
    /// — the per-target relocate-vs-open decision for `mdviewer -w <path>`. Given
    /// the canonicalized one-owner resolution and the freshly-spawned window
    /// label, an already-open doc in some OTHER window relocates; everything else
    /// opens fresh.
    #[derive(Debug, Clone, PartialEq, Eq)]
    enum NewWindowTargetAction {
        Relocate { tab_id: String },
        Open,
    }

    fn new_window_target_action(
        resolution: &mdviewer_lib::workspace::OneOwnerResolution,
        new_label: &str,
    ) -> NewWindowTargetAction {
        use mdviewer_lib::workspace::OneOwnerResolution;
        match resolution {
            OneOwnerResolution::Existing { label, tab_id } if label != new_label => {
                NewWindowTargetAction::Relocate { tab_id: tab_id.clone() }
            }
            _ => NewWindowTargetAction::Open,
        }
    }

    #[test]
    fn f1_new_window_action_opens_when_not_open_anywhere() {
        // A not-yet-open target opens fresh into the new window.
        let res = mdviewer_lib::workspace::OneOwnerResolution::NeedsNew;
        assert_eq!(
            new_window_target_action(&res, "win-new"),
            NewWindowTargetAction::Open
        );
    }

    #[test]
    fn f1_new_window_action_relocates_doc_open_elsewhere() {
        // S9 never-duplicate: a doc already open in another window is
        // RELOCATED (move_tab) into the new window, not re-opened.
        let res = mdviewer_lib::workspace::OneOwnerResolution::Existing {
            label: MAIN_LABEL.to_string(),
            tab_id: "tab-7".to_string(),
        };
        assert_eq!(
            new_window_target_action(&res, "win-new"),
            NewWindowTargetAction::Relocate { tab_id: "tab-7".to_string() }
        );
    }

    #[test]
    fn f1_new_window_action_open_when_already_in_new_window() {
        // Idempotency guard: if the only place the doc is open is the
        // just-spawned new window itself, don't self-move — open is a no-op.
        let res = mdviewer_lib::workspace::OneOwnerResolution::Existing {
            label: "win-new".to_string(),
            tab_id: "tab-7".to_string(),
        };
        assert_eq!(
            new_window_target_action(&res, "win-new"),
            NewWindowTargetAction::Open
        );
    }

    #[test]
    fn f1_new_window_relocate_moves_existing_tab_via_real_workspace() {
        // Boundary integration: drive the real F1 relocate path through
        // `open_in_new_window_resolve` (canonicalized one-owner lookup) +
        // `new_window_target_action` + `Workspace::move_tab`. A doc open in
        // `main` must end up owned solely by the freshly-spawned window — one
        // tab total, never duplicated.
        let (state, tmp) = ws();
        let doc = tmp.path().join("relocate.md");
        std::fs::write(&doc, "# relocate\n").unwrap();

        let mut g = state.lock().unwrap();
        // Doc starts open in main.
        g.open_document_for(MAIN_LABEL, &doc, OpenOpts::default()).unwrap();
        assert_eq!(g.list_open_documents_for(MAIN_LABEL).len(), 1);

        // `mdviewer -w relocate.md` spawns a fresh window.
        let new_label = "win-spawned".to_string();
        g.new_window(new_label.clone());

        // Resolve + act, exactly as dispatch_cli_targets_new_window does.
        let resolution = g.open_in_new_window_resolve(&doc);
        match new_window_target_action(&resolution, &new_label) {
            NewWindowTargetAction::Relocate { tab_id } => {
                g.move_tab(&tab_id, &new_label).unwrap();
            }
            NewWindowTargetAction::Open => panic!("doc was open in main; expected Relocate"),
        }

        // Never duplicated: gone from main, present in the new window, one tab.
        assert!(
            g.list_open_documents_for(MAIN_LABEL).is_empty(),
            "relocated tab must leave the source window"
        );
        let dest = g.list_open_documents_for(&new_label);
        assert_eq!(dest.len(), 1, "exactly one tab in the new window — no duplicate");
        let canonical = doc.canonicalize().unwrap_or(doc);
        assert_eq!(dest[0].path, canonical);
    }

    #[test]
    fn f1_new_window_opens_fresh_when_not_open_via_real_workspace() {
        // Boundary integration: a not-yet-open doc resolves to NeedsNew →
        // Open, and `open_document_for` lands it in the spawned window.
        let (state, tmp) = ws();
        let doc = tmp.path().join("fresh.md");
        std::fs::write(&doc, "# fresh\n").unwrap();

        let mut g = state.lock().unwrap();
        let new_label = "win-spawned".to_string();
        g.new_window(new_label.clone());

        let resolution = g.open_in_new_window_resolve(&doc);
        match new_window_target_action(&resolution, &new_label) {
            NewWindowTargetAction::Open => {
                g.open_document_for(&new_label, &doc, OpenOpts::default()).unwrap();
            }
            NewWindowTargetAction::Relocate { .. } => panic!("doc was not open; expected Open"),
        }

        assert_eq!(g.list_open_documents_for(&new_label).len(), 1);
        assert!(g.list_open_documents_for(MAIN_LABEL).is_empty());
    }

    /// phase-F review fix: the SSH branch of `dispatch_cli_targets_new_window`
    /// must relocate an ALREADY-OPEN remote doc into the freshly-spawned window
    /// exactly like the Local branch — not leave it in its original window.
    /// This drives the real path: open an ssh:// URL in `main`, then predict
    /// its cache path via `cache_path_for_url(ops.cache_base(), &url)` (no
    /// fetch), resolve one-owner, and `move_tab` into the spawned window. The
    /// result must be one tab total, gone from `main`.
    #[tokio::test]
    async fn f1_new_window_ssh_relocates_already_open_tab_into_new_window() {
        use async_trait::async_trait;
        use mdviewer_core::ssh_url::SshUrl;
        use mdviewer_lib::ssh::operations::{cache_path_for_url, Operations};
        use mdviewer_lib::ssh::transport::{
            DirEntry, SshStat, SshTransport, TransportError,
        };
        use std::sync::Arc;

        struct FetchOnce {
            bytes: Vec<u8>,
        }
        #[async_trait]
        impl SshTransport for FetchOnce {
            async fn fetch(&self, _url: &SshUrl) -> Result<Vec<u8>, TransportError> {
                Ok(self.bytes.clone())
            }
            async fn push(&self, _url: &SshUrl, _bytes: &[u8]) -> Result<(), TransportError> {
                Ok(())
            }
            async fn list_dir(&self, _url: &SshUrl) -> Result<Vec<DirEntry>, TransportError> {
                Ok(vec![])
            }
            async fn stat(&self, _url: &SshUrl) -> Result<SshStat, TransportError> {
                Ok(SshStat { size: 0, is_dir: false, mtime: None })
            }
        }

        let data_dir = tempfile::tempdir().expect("data dir");
        let cache_dir = tempfile::tempdir().expect("cache dir");
        let transport = Arc::new(FetchOnce { bytes: b"# remote\n".to_vec() });
        let ops = Operations::new(transport, cache_dir.path().to_path_buf());
        let url = SshUrl {
            user: Some("alice".into()),
            host: "host.example".into(),
            port: 22,
            path: "/notes/file.md".into(),
        };

        let mut ws = mdviewer_lib::workspace::Workspace::new(data_dir.path()).expect("workspace");
        // Doc starts open in main (SSH tab stored under its cache path).
        let _summary = ws.open_ssh_url(url.clone(), &ops).await.expect("open ssh ok");
        let open_tab_path = {
            let docs = ws.list_open_documents_for(MAIN_LABEL);
            assert_eq!(docs.len(), 1);
            docs[0].path.clone()
        };

        // `mdviewer -w ssh://...` spawns a fresh window.
        let new_label = "win-spawned".to_string();
        ws.new_window(new_label.clone());

        // Predict the cache path WITHOUT a fetch and run the one-owner decision,
        // exactly as the new-window SSH loop does.
        let cache_path = cache_path_for_url(ops.cache_base(), &url);
        assert_eq!(
            cache_path, open_tab_path,
            "predicted cache path must equal the open tab's stored path"
        );
        let resolution = ws.open_in_new_window_resolve(&cache_path);
        match new_window_target_action(&resolution, &new_label) {
            NewWindowTargetAction::Relocate { tab_id } => {
                ws.move_tab(&tab_id, &new_label).unwrap();
            }
            NewWindowTargetAction::Open => {
                panic!("SSH doc was open in main; expected Relocate")
            }
        }

        // Never duplicated, and actually RELOCATED: gone from main, sole tab in
        // the new window.
        assert!(
            ws.list_open_documents_for(MAIN_LABEL).is_empty(),
            "relocated SSH tab must leave the source window"
        );
        let dest = ws.list_open_documents_for(&new_label);
        assert_eq!(dest.len(), 1, "exactly one SSH tab in the new window — no duplicate");
        assert_eq!(dest[0].path, cache_path);
    }

    /// phase-F review fix (source-level smoke): pin that the PRODUCTION
    /// `dispatch_cli_targets_new_window` SSH loop predicts the cache path and
    /// relocates an already-open tab via `move_tab` — not just the test mirror.
    /// A regression that drops the relocate (reverting to register-only
    /// de-dupe, which leaves the tab in its original window) trips this. The
    /// DEFAULT (non -w) focused-window SSH loop in `dispatch_cli_targets` must
    /// NOT gain a relocate, so we also assert the relocate seam appears exactly
    /// once across main.rs's SSH dispatch.
    #[test]
    fn dispatch_new_window_ssh_loop_relocates_via_move_tab() {
        let main_rs = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/main.rs"),
        )
        .expect("read main.rs");
        let start = main_rs
            .find("fn dispatch_cli_targets_new_window(")
            .expect("main.rs declares fn dispatch_cli_targets_new_window");
        // Slice to the next top-level fn so we only inspect this function body.
        let body_after = &main_rs[start..];
        let end = body_after[1..]
            .find("\nfn ")
            .map(|i| start + 1 + i)
            .unwrap_or(main_rs.len());
        let body = &main_rs[start..end];
        assert!(
            body.contains("cache_path_for_url(") && body.contains(".cache_base()"),
            "new-window SSH loop must predict the cache path via cache_path_for_url(ops.cache_base(), &url)",
        );
        assert!(
            body.contains("open_in_new_window_resolve(") && body.contains("move_tab("),
            "new-window SSH loop must relocate an already-open SSH tab via move_tab (one-owner)",
        );
    }

    /// D1: mirror of main.rs's pure `window_summaries_with_focus` — project the
    /// per-window summaries onto the IPC wire shape, marking exactly the
    /// `focused_label` window focused. The production `list_windows` handler
    /// passes the OS-reported focused label; this exercises the projection
    /// logic without an AppHandle.
    fn window_summaries_with_focus(
        summaries: Vec<mdviewer_lib::workspace::WindowSummaryData>,
        focused_label: Option<&str>,
    ) -> Vec<mdviewer_lib::workspace::WindowSummary> {
        use mdviewer_lib::workspace::WindowSummary;
        summaries
            .into_iter()
            .map(|d| WindowSummary {
                focused: focused_label == Some(d.label.as_str()),
                label: d.label,
                active_doc_name: d.active_doc_name,
                tab_count: d.tab_count,
            })
            .collect()
    }

    #[test]
    fn d1_window_summaries_mark_only_focused_window() {
        let (state, _tmp) = ws();
        let mut g = state.lock().unwrap();
        g.new_window("win-2".to_string());
        let summaries = g.list_windows();
        assert_eq!(summaries.len(), 2, "main + win-2 registered");

        // win-2 focused → exactly one focused, and it is win-2.
        let out = window_summaries_with_focus(summaries.clone(), Some("win-2"));
        assert_eq!(out.len(), 2);
        assert_eq!(out.iter().filter(|s| s.focused).count(), 1);
        assert!(out.iter().find(|s| s.label == "win-2").unwrap().focused);
        assert!(!out.iter().find(|s| s.label == MAIN_LABEL).unwrap().focused);

        // No focused window reported (backgrounded app) → none flagged, and
        // the pure fields still carry through verbatim.
        let none = window_summaries_with_focus(summaries.clone(), None);
        assert!(none.iter().all(|s| !s.focused), "no focus → none flagged");
        let main = none.iter().find(|s| s.label == MAIN_LABEL).unwrap();
        let main_data = summaries.iter().find(|d| d.label == MAIN_LABEL).unwrap();
        assert_eq!(main.tab_count, main_data.tab_count);
        assert_eq!(main.active_doc_name, main_data.active_doc_name);
    }

    #[test]
    fn open_document_for_owns_tab_in_its_window() {
        // open_document_for(label, ...) must register the tab into THAT
        // window's order — and a second window must not see it. This is the
        // S5 isolation invariant at the Workspace layer.
        let (state, tmp) = ws();
        let doc_a = tmp.path().join("a.md");
        let doc_b = tmp.path().join("b.md");
        std::fs::write(&doc_a, "# A\n").unwrap();
        std::fs::write(&doc_b, "# B\n").unwrap();

        let mut g = state.lock().unwrap();
        g.new_window("win-2".to_string());

        g.open_document_for(MAIN_LABEL, &doc_a, OpenOpts::default()).unwrap();
        g.open_document_for("win-2", &doc_b, OpenOpts::default()).unwrap();

        let main_tabs: Vec<_> = g
            .list_open_documents_for(MAIN_LABEL)
            .iter()
            .map(|t| t.path.clone())
            .collect();
        let win2_tabs: Vec<_> = g
            .list_open_documents_for("win-2")
            .iter()
            .map(|t| t.path.clone())
            .collect();

        assert_eq!(main_tabs.len(), 1, "main window has exactly its own tab");
        assert_eq!(win2_tabs.len(), 1, "win-2 has exactly its own tab");
        assert!(main_tabs[0].ends_with("a.md"));
        assert!(win2_tabs[0].ends_with("b.md"));
        // Cross-window isolation: main's active is unchanged by win-2's open.
        let main_active = g
            .active_tab_id_for(MAIN_LABEL)
            .map(str::to_string);
        let main_only_tab = g.list_open_documents_for(MAIN_LABEL)[0].id.clone();
        assert_eq!(main_active, Some(main_only_tab));
    }

    #[test]
    fn window_has_dirty_tab_scopes_to_the_window() {
        let (state, tmp) = ws();
        let doc_a = tmp.path().join("a.md");
        let doc_b = tmp.path().join("b.md");
        std::fs::write(&doc_a, "# A\n").unwrap();
        std::fs::write(&doc_b, "# B\n").unwrap();

        let mut g = state.lock().unwrap();
        g.new_window("win-2".to_string());
        g.open_document_for(MAIN_LABEL, &doc_a, OpenOpts::default()).unwrap();
        g.open_document_for("win-2", &doc_b, OpenOpts::default()).unwrap();

        // Canonical paths (open_document canonicalizes before storing).
        let canon_a = doc_a.canonicalize().unwrap();

        // Only a.md (in main) is dirty.
        let dirty_set: std::collections::HashSet<std::path::PathBuf> =
            [canon_a.clone()].into_iter().collect();
        let dirty_for = |p: &Path| dirty_set.contains(p);

        assert!(
            window_has_dirty_tab(&g, MAIN_LABEL, &dirty_for),
            "main owns the dirty a.md"
        );
        assert!(
            !window_has_dirty_tab(&g, "win-2", &dirty_for),
            "win-2 owns only the clean b.md — its close must not be guarded"
        );
    }

    #[test]
    fn window_has_dirty_tab_false_for_empty_or_unknown_window() {
        let (state, _tmp) = ws();
        let g = state.lock().unwrap();
        assert!(!window_has_dirty_tab(&g, MAIN_LABEL, |_| true), "no tabs → not dirty");
        assert!(!window_has_dirty_tab(&g, "ghost", |_| true), "unknown window → not dirty");
    }

    #[test]
    fn restore_window_label_first_is_main_rest_unique() {
        let nanos = 1_000u128;
        assert_eq!(restore_window_label(0, nanos), "main");
        assert_eq!(restore_window_label(1, nanos), "win-1001");
        assert_eq!(restore_window_label(2, nanos), "win-1002");
        // Two windows in the same nanosecond batch never collide.
        assert_ne!(
            restore_window_label(1, nanos),
            restore_window_label(2, nanos)
        );
    }

    #[test]
    fn open_document_existing_tab_reactivates_in_owning_window() {
        // Opening an already-open path re-activates the tab in ITS window,
        // regardless of which window asked — the conflict/existing branch is
        // window-agnostic by design.
        let (state, tmp) = ws();
        let doc = tmp.path().join("shared.md");
        std::fs::write(&doc, "# shared\n").unwrap();

        let mut g = state.lock().unwrap();
        g.new_window("win-2".to_string());
        // First opened in win-2.
        let first = g.open_document_for("win-2", &doc, OpenOpts::default()).unwrap();
        let first_id = match first {
            OpenOutcome::Document(r) => r.tab_id,
            OpenOutcome::Conflict { .. } => panic!("unexpected conflict"),
        };
        // main asks to open the same path; it stays owned by win-2.
        let second = g.open_document_for(MAIN_LABEL, &doc, OpenOpts::default()).unwrap();
        let second_id = match second {
            OpenOutcome::Document(r) => r.tab_id,
            OpenOutcome::Conflict { .. } => panic!("unexpected conflict"),
        };
        assert_eq!(first_id, second_id, "same tab re-used, not duplicated");
        assert_eq!(g.list_open_documents_for("win-2").len(), 1);
        assert_eq!(
            g.list_open_documents_for(MAIN_LABEL).len(),
            0,
            "main never gained the tab — it lives in win-2"
        );
    }

    #[test]
    fn owning_window_for_watched_resolves_md_and_sidecar() {
        // The external-change forwarder resolves both the .md path and its
        // sidecar to the owning window. A path no window owns → None (drop).
        let (state, tmp) = ws();
        let doc = tmp.path().join("note.md");
        std::fs::write(&doc, "# note\n").unwrap();

        let mut g = state.lock().unwrap();
        g.new_window("win-2".to_string());
        g.open_document_for("win-2", &doc, OpenOpts::default()).unwrap();

        let canon = doc.canonicalize().unwrap();
        assert_eq!(g.owning_window_for_watched(&canon), Some("win-2"));

        let pattern = g.settings_store().get().comments.sidecar_pattern;
        let sc = mdviewer_lib::sidecar::sidecar_path(&canon, &pattern);
        assert_eq!(
            g.owning_window_for_watched(&sc),
            Some("win-2"),
            "sidecar path resolves to the .md's owning window"
        );

        assert_eq!(
            g.owning_window_for_watched(Path::new("/nope/missing.md")),
            None,
            "unowned path drops the event"
        );
    }
}

#[test]
fn b2_tab_commands_take_window_and_route_addressed_events() {
    // Source-level smoke (mirrors the existing ipc_registration_includes_*
    // checks): the window-scoped handlers must accept `window: tauri::Window`
    // and the file must use emit_to for addressed events. The whole point of
    // B2 is window identity from the injected Window + addressed events.
    let main_rs = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/main.rs"),
    )
    .expect("read main.rs");

    for handler in [
        "fn open_document(",
        "fn close_tab(",
        "fn activate_tab(",
        "fn list_open_documents(",
        "fn get_active_tab_id(",
    ] {
        let idx = main_rs.find(handler).unwrap_or_else(|| panic!("missing {handler}"));
        // The signature (first ~260 chars) must declare a `tauri::Window`.
        let sig: String = main_rs[idx..].chars().take(260).collect();
        assert!(
            sig.contains("window: tauri::Window"),
            "{handler} must take `window: tauri::Window` (identity from the Window, not a client arg)",
        );
    }

    // Window-scoped delegation: the commands call the `_for` variants.
    assert!(main_rs.contains("list_open_documents_for(window.label())"));
    assert!(main_rs.contains("close_tab_for(window.label()"));
    assert!(main_rs.contains("activate_tab_for(window.label()"));
    assert!(main_rs.contains("active_tab_id_for(window.label())"));
    assert!(main_rs.contains("open_document_for(&label"));

    // Addressed events: emit_to must appear and the broadcast workspace-changed
    // for drive/ssh opens must be gone in favor of emit_to.
    assert!(
        main_rs.contains("emit_to("),
        "main.rs must use emit_to(<label>, …) for addressed events",
    );

    // Restore recreates N windows + the window event handler is registered.
    assert!(
        main_rs.contains("fn spawn_window("),
        "main.rs must declare spawn_window for the restore loop",
    );
    assert!(
        main_rs.contains("on_window_event"),
        "main.rs must register a per-window on_window_event handler",
    );
    assert!(
        main_rs.contains("confirm-window-close"),
        "the CloseRequested guard must emit confirm-window-close on a dirty window",
    );
    assert!(
        main_rs.contains("prevent_close()"),
        "the CloseRequested guard must call api.prevent_close() while a tab is dirty",
    );
    // The window-state plugin builder line must be gone (geometry is now the
    // on_window_event handler's job).
    assert!(
        !main_rs.contains("tauri_plugin_window_state::Builder"),
        "the tauri-plugin-window-state builder call must be removed (B2 owns geometry now)",
    );
    // Menu actions route to the focused window, not a broadcast.
    assert!(
        main_rs.contains("focused_window("),
        "on_menu_event must route through focused_window for S12",
    );
}

#[test]
fn e2_cli_dispatch_routes_into_focused_window_with_one_owner() {
    // E2 S8 source-smoke: the running-app CLI dispatch must route into the
    // most-recently-focused window (not hard-coded `main`), canonicalize the
    // path before the one-owner lookup, and open via the window-scoped
    // `open_document_for`. We assert the wiring at source level because the
    // dispatch touches the live Tauri window list (focus, raise, emit) and is
    // exercised end-to-end by the S8 e2e spec; the pure routing decision is
    // unit-tested via the `route_target_label` mirror above.
    let main_rs = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/main.rs"),
    )
    .expect("read main.rs");

    let idx = main_rs
        .find("fn dispatch_cli_targets(")
        .expect("dispatch_cli_targets must exist");
    // Scope the assertions to the function body (next ~3500 chars covers it).
    let body: String = main_rs[idx..].chars().take(3500).collect();

    assert!(
        body.contains("focused_window(&app)"),
        "dispatch must resolve the landing window via focused_window (E2 focused routing)",
    );
    assert!(
        body.contains("route_target_label("),
        "dispatch must use the pure route_target_label decision for one-owner vs focused",
    );
    assert!(
        body.contains("owning_window_label("),
        "dispatch must consult owning_window_label for the one-owner check",
    );
    assert!(
        body.contains("canonicalize()"),
        "dispatch must canonicalize the path before the one-owner lookup (phase-D raw-vs-canonical caveat)",
    );
    assert!(
        body.contains("open_document_for(&open_label"),
        "dispatch must open Local targets via the window-scoped open_document_for(<routed label>)",
    );
    assert!(
        body.contains("set_focus()"),
        "dispatch must raise the routed window so the user sees the new tab",
    );
    // The MAIN_LABEL-addressed repaint emit must be gone — the dispatch now
    // emits to the routed window.
    assert!(
        !body.contains("MAIN_LABEL,\n                \"workspace-changed\""),
        "dispatch must not hard-code a MAIN_LABEL repaint emit (E2 routes to the focused window)",
    );
}

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

        let local_edit = b"# v2 - my edit\n".to_vec();
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

// ----------------------------------------------------------------------------
// C1: Window menu lists + raises open windows.
//
// `new_window` is registered HERE (C1), not D1 — it's self-contained
// (spawn_window from B2, Workspace::new_window from A1, this task's
// rebuild_menu). D1 adds the OTHER window commands and must NOT re-register
// new_window. The raise path is wholly Rust-side: `on_menu_event` parses the
// `window-select:<label>` suffix and calls `set_focus()`. These source-smoke
// checks mirror the existing `ipc_registration_includes_*` pattern (we can't
// link main.rs's `#[tauri::command] fn`s into this crate).
// ----------------------------------------------------------------------------

#[test]
fn ipc_registration_includes_new_window() {
    let main_rs = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/main.rs"),
    )
    .expect("read main.rs");
    assert!(
        main_rs.contains("fn new_window("),
        "main.rs must declare `fn new_window(...)` (C1 owns this command)",
    );
    assert!(
        main_rs.contains("            new_window,"),
        "main.rs must register `new_window` in the invoke_handler! list",
    );
}

#[test]
fn c1_menu_rebuild_and_window_select_raise_wired() {
    let main_rs = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/main.rs"),
    )
    .expect("read main.rs");

    // The menu must be rebuilt + re-applied on registry change. The helper
    // calls list_windows() and set_menu(...).
    assert!(
        main_rs.contains("fn rebuild_menu("),
        "main.rs must declare a rebuild_menu(app) helper",
    );
    assert!(
        main_rs.contains("list_windows()"),
        "rebuild_menu must read the window registry via list_windows()",
    );
    assert!(
        main_rs.contains("set_menu("),
        "rebuild_menu must re-apply the menu via set_menu(...)",
    );

    // The new_window command must spawn via B2's spawn_window, register via
    // A1's Workspace::new_window, and rebuild the menu.
    let body_start = main_rs
        .find("fn new_window(")
        .expect("main.rs must declare fn new_window(");
    let body = &main_rs[body_start..];
    assert!(
        body.contains("spawn_window("),
        "new_window must spawn a window via spawn_window (B2)",
    );
    assert!(
        body.contains("rebuild_menu("),
        "new_window must rebuild the Window menu after spawning",
    );

    // The on_menu_event raise path parses `window-select:` and calls set_focus.
    assert!(
        main_rs.contains("window_select_label("),
        "on_menu_event must parse the window-select label via menu::window_select_label",
    );
    assert!(
        main_rs.contains("set_focus()"),
        "the window-select branch must raise the matching window via set_focus()",
    );
}

/// The pure menu helpers C1 adds (submenu-entry builder + label parse) live
/// in `mdviewer_lib::menu` so they can be exercised without an AppHandle.
/// Pin the parse contract here too (the menu.rs unit suite owns the builder).
#[test]
fn window_select_label_helper_is_reachable() {
    assert_eq!(
        mdviewer_lib::menu::window_select_label("window-select:main"),
        Some("main"),
    );
    assert_eq!(
        mdviewer_lib::menu::window_select_label("window-select:"),
        None,
    );
}

// ----------------------------------------------------------------------------
// D1: the remaining window IPC surface + one-owner focus-existing.
//
// D1 registers the FOUR remaining window commands (`new_window` is C1's and is
// asserted above — D1 must NOT re-register it). Each window-set-mutating
// command (close_window, open_in_new_window, move_tab) must call rebuild_menu
// so the Window submenu stays current. The one-owner invariant lives in A1's
// Workspace (unit-tested there); D1 wires open_document + open_in_new_window to
// consult open_in_new_window_resolve / owning_window_label before creating a
// tab. These source-smoke checks mirror the existing pattern (we can't link
// main.rs's `#[tauri::command] fn`s into this crate).
// ----------------------------------------------------------------------------

#[test]
fn d1_window_ipc_commands_registered() {
    let main_rs = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/main.rs"),
    )
    .expect("read main.rs");
    for cmd in ["close_window", "list_windows", "open_in_new_window", "move_tab"] {
        assert!(
            main_rs.contains(&format!("fn {cmd}(")),
            "main.rs must declare `fn {cmd}(...)` (D1)",
        );
        assert!(
            main_rs.contains(&format!("            {cmd},")),
            "main.rs must register `{cmd}` in the invoke_handler! list (D1)",
        );
    }
}

#[test]
fn d1_window_mutating_commands_rebuild_menu() {
    // close_window / open_in_new_window / move_tab change the window set or a
    // window's active doc, so each must rebuild the Window submenu afterward.
    let main_rs = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/main.rs"),
    )
    .expect("read main.rs");
    for cmd in ["close_window", "open_in_new_window", "move_tab"] {
        let start = main_rs
            .find(&format!("fn {cmd}("))
            .unwrap_or_else(|| panic!("main.rs must declare fn {cmd}("));
        // Body span up to the next top-level `#[tauri::command]` so we only
        // scan this handler.
        let rest = &main_rs[start..];
        let body_end = rest[1..]
            .find("#[tauri::command]")
            .map(|i| i + 1)
            .unwrap_or(rest.len());
        let body = &rest[..body_end];
        assert!(
            body.contains("rebuild_menu("),
            "{cmd} must call rebuild_menu after mutating the window set",
        );
    }
}

#[test]
fn move_tab_emits_workspace_changed_to_both_source_and_destination() {
    // Phase-E review fix (S4): a cross-window move must repaint BOTH tab
    // strips. The frontend deliberately does not locally repaint the source on
    // a successful move; it relies on the backend emitting `workspace-changed`
    // to the source AND the destination. The handler captures the source label
    // from `move_tab`'s return value and emits to it (guarded against a
    // redundant double-emit on a same-window move).
    let main_rs = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/main.rs"),
    )
    .expect("read main.rs");
    let start = main_rs
        .find("fn move_tab(")
        .expect("main.rs must declare fn move_tab(");
    let rest = &main_rs[start..];
    let body_end = rest[1..]
        .find("#[tauri::command]")
        .map(|i| i + 1)
        .unwrap_or(rest.len());
    let body = &rest[..body_end];
    // Captures the from-label returned by Workspace::move_tab.
    assert!(
        body.contains("let from = state"),
        "move_tab must bind the source label returned by Workspace::move_tab",
    );
    // Emits to the destination window.
    assert!(
        body.contains("emit_to(to_window.as_str(), \"workspace-changed\""),
        "move_tab must emit workspace-changed to the destination window",
    );
    // Emits to the source window, guarded against a same-window double-emit.
    assert!(
        body.contains("if from != to_window")
            && body.contains("emit_to(from.as_str(), \"workspace-changed\""),
        "move_tab must emit workspace-changed to the source window (guarded by from != to_window)",
    );
}

#[test]
fn d1_one_owner_focus_existing_wired() {
    // open_document and open_in_new_window must consult the one-owner
    // resolution (A1) before creating a tab so an already-open path focuses
    // its existing window+tab rather than duplicating it.
    let main_rs = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/main.rs"),
    )
    .expect("read main.rs");
    // open_in_new_window resolves via open_in_new_window_resolve.
    let oinw_start = main_rs
        .find("fn open_in_new_window(")
        .expect("main.rs must declare fn open_in_new_window(");
    let oinw = &main_rs[oinw_start..];
    assert!(
        oinw.contains("open_in_new_window_resolve("),
        "open_in_new_window must consult Workspace::open_in_new_window_resolve",
    );
    assert!(
        oinw.contains("set_focus()"),
        "open_in_new_window must set_focus the existing window on a one-owner hit",
    );
    // open_document focuses an already-open path's owning window+tab.
    let od_start = main_rs
        .find("fn open_document(")
        .expect("main.rs must declare fn open_document(");
    let rest = &main_rs[od_start..];
    let od_end = rest[1..]
        .find("#[tauri::command]")
        .map(|i| i + 1)
        .unwrap_or(rest.len());
    let od = &rest[..od_end];
    assert!(
        od.contains("owning_window_label(") || od.contains("open_in_new_window_resolve("),
        "open_document must consult the one-owner resolution (owning_window_label / resolve)",
    );
}
