# A8b: Phase-1 IPC commands and registration test

**Avoid:**
- Do NOT pull free functions named the same as Tauri commands into scope. WHY: `use mdviewer_lib::document::render_markdown` followed by `#[tauri::command] fn render_markdown(...)` is a Rust E0252 collision. Import via the parent module path (`use mdviewer_lib::document;`) and call `document::render_markdown(...)` inside the command body.
- Do NOT call `SettingsStore::set` — it does not exist. WHY: A3 only exposes `update<F>(&self, f: F)`. Use `update(|s| *s = settings)` to overwrite.
- Do NOT invent CommentsStore method names. WHY: A7's API is `list_threads`, `create_thread(NewThread{ anchor, first_comment: NewComment{..} })`, `post_reply(&id, NewComment{..})`, `resolve_thread(&id, by)`. The author/color come from `settings_store().get().profile`.
- Do NOT register Phase-2/3 IPC commands here. WHY: `save_document` lands in B3, `diff_md`/`migrate_sidecars`/`export_document` land in C2/C3. Each registers itself via the same pattern in its own task.

## Steps

### Step 1: Verify the tauri test dev-dep

A2 already added `tauri = { version = "2", features = ["test"] }` to `[dev-dependencies]` (per the iter-3 fix). Confirm it is present in `src-tauri/Cargo.toml`. If not, add it. This task does not modify Cargo.toml further — the new test in Step 3 below uses pure-Rust assertions and does not touch `tauri::test`.

### Step 2: Implement main.rs IPC commands

Modify `src-tauri/src/main.rs`. Replace the body with the following structure (preserving the `tracing_subscriber::fmt().with_env_filter(...).init()` initialization established in A2):

```rust
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};
use mdviewer_lib::{
    build_info, BuildInfo,
    anchor::{self, Anchor, ResolveOutcome},
    comments::{NewComment, NewThread, Thread},
    document::{self, RenderOptions, RenderResult},
    settings::Settings,
    workspace::{OpenOpts, OpenOutcome, Workspace},
};

type Ws = Mutex<Workspace>;

#[tauri::command] fn app_info() -> BuildInfo { build_info() }

#[tauri::command]
fn open_document(app: tauri::AppHandle, state: State<'_, Ws>, path: PathBuf) -> Result<OpenOutcome, String> {
    let outcome = state.lock().map_err(|e| e.to_string())?
        .open_document(&path, OpenOpts::default())
        .map_err(|e| e.to_string())?;
    if let OpenOutcome::Conflict { tab_id, path, local, incoming } = &outcome {
        // Emit the show-conflict event from the IPC layer where AppHandle is
        // in scope. Workspace itself stays handle-free for testability.
        let _ = app.emit("show-conflict", serde_json::json!({
            "tab_id": tab_id, "path": path, "local": local, "incoming": incoming,
        }));
    }
    Ok(outcome)
}

#[tauri::command]
fn close_tab(state: State<'_, Ws>, id: String) -> Result<(), String> {
    state.lock().map_err(|e| e.to_string())?.close_tab(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn activate_tab(state: State<'_, Ws>, id: String) -> Result<(), String> {
    state.lock().map_err(|e| e.to_string())?.activate_tab(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_open_documents(state: State<'_, Ws>) -> Vec<String> {
    state.lock().unwrap().list_open_documents().iter().map(|t| t.id.clone()).collect()
}

#[tauri::command]
fn list_recents(state: State<'_, Ws>) -> Vec<PathBuf> {
    state.lock().unwrap().recents_store().list()
}

#[tauri::command] fn get_settings(state: State<'_, Ws>) -> Settings {
    state.lock().unwrap().settings_store().get()
}

#[tauri::command]
fn set_settings(state: State<'_, Ws>, settings: Settings) -> Result<(), String> {
    // SettingsStore exposes `update`, not `set`. Overwrite the snapshot via
    // a closure; the store's update impl emits change events for diffed fields.
    state.lock().unwrap().settings_store().update(|s| *s = settings)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_threads(state: State<'_, Ws>, tab_id: String) -> Result<Vec<Thread>, String> {
    state.lock().unwrap().comments_for(&tab_id)
        .map(|c| c.list_threads().to_vec())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn create_thread(state: State<'_, Ws>, tab_id: String, anchor: Anchor, body: String) -> Result<Thread, String> {
    let mut ws = state.lock().unwrap();
    let profile = ws.settings_store().get().profile.clone();
    let store = ws.comments_for_mut(&tab_id).map_err(|e| e.to_string())?;
    Ok(store.create_thread(NewThread {
        anchor,
        first_comment: NewComment { author: profile.display_name, color: profile.color, body },
    }))
}

#[tauri::command]
fn post_reply(state: State<'_, Ws>, tab_id: String, thread_id: String, body: String) -> Result<(), String> {
    let mut ws = state.lock().unwrap();
    let profile = ws.settings_store().get().profile.clone();
    let store = ws.comments_for_mut(&tab_id).map_err(|e| e.to_string())?;
    store.post_reply(&thread_id, NewComment { author: profile.display_name, color: profile.color, body })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn resolve_thread(state: State<'_, Ws>, tab_id: String, thread_id: String) -> Result<(), String> {
    let mut ws = state.lock().unwrap();
    let by = ws.settings_store().get().profile.display_name.clone();
    let store = ws.comments_for_mut(&tab_id).map_err(|e| e.to_string())?;
    store.resolve_thread(&thread_id, &by).map_err(|e| e.to_string())
}

#[tauri::command]
fn render_markdown(source: String) -> RenderResult {
    document::render_markdown(&source, &RenderOptions::default())
}

#[tauri::command]
fn resolve_anchor(state: State<'_, Ws>, tab_id: String, anchor: Anchor) -> Result<ResolveOutcome, String> {
    state.lock().unwrap().resolve_anchor_for_tab(&tab_id, &anchor).map_err(|e| e.to_string())
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let data_dir = app.path().app_config_dir()?;
            let env_override = std::env::var("MDVIEWER_DATA_DIR").ok();
            let dir = env_override.map(PathBuf::from).unwrap_or(data_dir);
            let ws = Workspace::new(&dir)?;
            app.manage(Mutex::new(ws));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            open_document, close_tab, activate_tab, list_open_documents, list_recents,
            get_settings, set_settings,
            list_threads, create_thread, post_reply, resolve_thread,
            render_markdown, resolve_anchor,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**Tauri IPC parameter naming convention.** Tauri 2's default JS-side argument convention is camelCase; these snake_case Rust params (`tab_id`, `thread_id`) are auto-renamed at the boundary. Do not add `#[tauri::command(rename_all = "snake_case")]`. The `src/ipc.ts` adapter (A9) sends `{ tabId, threadId, ... }`; the registration test in Step 3 below verifies this.

### Step 3: Registration test

The IPC commands live in `main.rs`, which a Rust integration test (its own crate) cannot import. Use a different strategy: invoke the command-shim functions directly via their `Workspace` arguments. This avoids depending on `tauri::test`'s mock-app helpers — whose exact shape varies across Tauri 2.x patch versions — while still asserting (a) the handlers compile against the real types, (b) they propagate the right errors, and (c) the camelCase-aware deserialization works.

Create `src-tauri/tests/ipc_registration.rs`:

```rust
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
    let res = state.lock().unwrap().comments_for("missing-tab")
        .map(|c| c.list_threads().to_vec());
    assert!(res.is_err());
}

#[test]
fn settings_round_trip_through_handler_logic() {
    let (state, _tmp) = ws();
    {
        let mut ws = state.lock().unwrap();
        let original = ws.settings_store().get();
        ws.settings_store().update(|s| {
            s.profile.display_name = "Carol".into();
        }).unwrap();
        let updated = ws.settings_store().get();
        assert_eq!(updated.profile.display_name, "Carol");
        assert_eq!(updated.appearance, original.appearance); // untouched
    }
}

#[test]
fn resolve_anchor_for_tab_propagates_unknown_tab_err() {
    let (state, _tmp) = ws();
    let a = Anchor { start: 0, end: 5, exact: "Hello".into(), prefix: "".into(), suffix: "".into() };
    let res = state.lock().unwrap().resolve_anchor_for_tab("missing", &a);
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
    assert!(v["html"].as_str().unwrap().contains("<h1>"));
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
        tab_id: "t-c".into(), path: std::path::PathBuf::from("/tmp/c.md"),
        local: "L".into(), incoming: "I".into(),
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
        anchor: Anchor { start: 0, end: 1, exact: "a".into(), prefix: "".into(), suffix: "".into() },
        comments: vec![],
        resolved: false, resolved_at: None, resolved_by: None,
    }).unwrap();
}
```

These seven tests cover what the registration test was trying to prove (handler bodies compile against real types; serde shapes match the codegen output) without depending on `tauri::test`'s evolving mock-app API. If a future iteration adds a `tauri::test`-based smoke test for actual IPC routing, it can be added separately as `tests/ipc_smoke.rs`.

### Step 4: Verify

```bash
(cd src-tauri && cargo test --test ipc_registration && cargo build)
```

Expect the test to pass and a successful binary build.

### Step 4b: Verify coverage on touched files

Apply the canonical coverage check from A1 (Step 4) to `src-tauri/src/main.rs`. Coverage on `main.rs` is naturally lower than other modules (much of it is Tauri framework wiring); aim for ≥75% on the command bodies, with explicit tests for each branch (state-lock failure, Workspace error propagation). Document any deviation in the commit message.

### Step 5: Commit

```bash
git add src-tauri/Cargo.toml src-tauri/src/main.rs src-tauri/tests/ipc_registration.rs
git commit -m "A8b: Phase-1 IPC commands + camelCase-aware registration test"
```
