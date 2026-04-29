#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Tauri binary entry: registers all Phase-1 IPC commands (`app_info` plus
//! 13 workspace/comments/render commands) plus the Phase-2 `save_document`
//! and `set_dirty` (B3) and the Phase-3 `diff_md` (C2), `export_document`
//! (C3), and `reload_document` (C2 follow-up) — 19 total at this point.
//!
//! In addition the binary handles a single CLI subcommand:
//!     mdviewer migrate-sidecars <dir>
//! See `migrate_sidecars()` below — this is intentionally NOT a Tauri
//! command. It runs before `tauri::Builder` so it can be invoked from CI
//! on a headless machine without spawning the WebView.
//!
//! Each handler is a thin shim that locks the `Workspace` mutex and delegates
//! to a method on `Workspace` (or one of its sub-stores). No business logic
//! lives here — that keeps `main.rs` testable indirectly by exercising the
//! `Workspace` shapes (see `tests/ipc_registration.rs`) and keeps Phase-2/3
//! command additions (B3 `save_document`, C2 `diff_md`, C3 `migrate_sidecars`)
//! a one-line addition to `invoke_handler!` here.
//!
//! ## Type imports use parent-module paths
//!
//! `document::render_markdown` and the Tauri command `render_markdown` collide
//! at function-name level (Rust E0252). We import the parent module
//! (`document::{self, RenderOptions, RenderResult}`) and call the inner
//! function as `document::render_markdown(...)`. The same pattern applies to
//! `anchor::resolve_anchor`.

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

use mdviewer_lib::{
    // Parent-module imports (`self`) on document/anchor/conflict avoid the
    // E0252 collision that would arise if `anchor::resolve_anchor` /
    // `document::render_markdown` / `conflict::diff_md` were brought in by
    // name alongside the `#[tauri::command] fn`s of the same name. Anchor
    // and ResolveOutcome are imported by name for ergonomic use in command
    // signatures; Hunk likewise.
    anchor::{Anchor, ResolveOutcome},
    build_info,
    comments::{NewComment, NewThread, Thread},
    conflict::{self, Hunk},
    document::{self, RenderOptions, RenderResult},
    settings::Settings,
    watcher::{ExternalChangeEvent, Watcher},
    workspace::{ExportResult, OpenOpts, OpenOutcome, Workspace},
    BuildInfo,
};
use std::path::Path;

type Ws = Mutex<Workspace>;

#[tauri::command]
fn app_info() -> BuildInfo {
    build_info()
}

#[tauri::command]
fn open_document(
    app: tauri::AppHandle,
    state: State<'_, Ws>,
    watcher: State<'_, Mutex<mdviewer_lib::watcher::Watcher>>,
    path: PathBuf,
) -> Result<OpenOutcome, String> {
    let outcome = {
        let mut ws = state.lock().map_err(|e| e.to_string())?;
        let outcome = ws
            .open_document(&path, OpenOpts::default())
            .map_err(|e| e.to_string())?;

        // Register the .md and its sidecar with the watcher so external
        // changes (Issue #1 from Phase-B impl review) actually surface.
        let pattern = ws.settings_store().get().comments.sidecar_pattern.clone();
        if let Ok(mut w) = watcher.lock() {
            let _ = w.watch_md(&path);
            let _ = w.watch_sidecar(&mdviewer_lib::sidecar::sidecar_path(&path, &pattern));
            // Clear the dirty bit on open — a freshly-loaded tab has no
            // unsaved edits.
            w.mark_unsaved(&path, false);
        }
        outcome
    };

    if let OpenOutcome::Conflict {
        tab_id,
        path,
        local,
        incoming,
    } = &outcome
    {
        // Emit the show-conflict event from the IPC layer where AppHandle is
        // in scope. Workspace itself stays handle-free for testability.
        let _ = app.emit(
            "show-conflict",
            serde_json::json!({
                "tab_id": tab_id,
                "path": path,
                "local": local,
                "incoming": incoming,
            }),
        );
    }
    Ok(outcome)
}

#[tauri::command]
fn close_tab(state: State<'_, Ws>, id: String) -> Result<(), String> {
    state
        .lock()
        .map_err(|e| e.to_string())?
        .close_tab(&id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn activate_tab(state: State<'_, Ws>, id: String) -> Result<(), String> {
    state
        .lock()
        .map_err(|e| e.to_string())?
        .activate_tab(&id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_open_documents(state: State<'_, Ws>) -> Vec<String> {
    state
        .lock()
        .unwrap()
        .list_open_documents()
        .iter()
        .map(|t| t.id.clone())
        .collect()
}

#[tauri::command]
fn list_recents(state: State<'_, Ws>) -> Vec<PathBuf> {
    state.lock().unwrap().recents_store().list()
}

#[tauri::command]
fn get_settings(state: State<'_, Ws>) -> Settings {
    state.lock().unwrap().settings_store().get()
}

#[tauri::command]
fn set_settings(state: State<'_, Ws>, settings: Settings) -> Result<(), String> {
    // SettingsStore exposes `update`, not `set`. Overwrite the snapshot via
    // a closure; the store's update impl emits change events for diffed fields.
    state
        .lock()
        .map_err(|e| e.to_string())?
        .settings_store()
        .update(|s| *s = settings)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_threads(state: State<'_, Ws>, tab_id: String) -> Result<Vec<Thread>, String> {
    state
        .lock()
        .map_err(|e| e.to_string())?
        .comments_for(&tab_id)
        .map(|c| c.list_threads().to_vec())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn create_thread(
    state: State<'_, Ws>,
    watcher: State<'_, Mutex<Watcher>>,
    tab_id: String,
    anchor: Anchor,
    body: String,
) -> Result<Thread, String> {
    let mut ws = state.lock().map_err(|e| e.to_string())?;
    let profile = ws.settings_store().get().profile.clone();
    let store = ws.comments_for_mut(&tab_id).map_err(|e| e.to_string())?;
    let thread = store.create_thread(NewThread {
        anchor,
        first_comment: NewComment {
            author: profile.display_name,
            color: profile.color,
            body,
        },
    });
    persist_sidecar(&ws, &watcher, &tab_id)?;
    Ok(thread)
}

#[tauri::command]
fn post_reply(
    state: State<'_, Ws>,
    watcher: State<'_, Mutex<Watcher>>,
    tab_id: String,
    thread_id: String,
    body: String,
) -> Result<(), String> {
    let mut ws = state.lock().map_err(|e| e.to_string())?;
    let profile = ws.settings_store().get().profile.clone();
    let store = ws.comments_for_mut(&tab_id).map_err(|e| e.to_string())?;
    store
        .post_reply(
            &thread_id,
            NewComment {
                author: profile.display_name,
                color: profile.color,
                body,
            },
        )
        .map_err(|e| e.to_string())?;
    persist_sidecar(&ws, &watcher, &tab_id)
}

#[tauri::command]
fn resolve_thread(
    state: State<'_, Ws>,
    watcher: State<'_, Mutex<Watcher>>,
    tab_id: String,
    thread_id: String,
) -> Result<(), String> {
    let mut ws = state.lock().map_err(|e| e.to_string())?;
    let by = ws.settings_store().get().profile.display_name.clone();
    let store = ws.comments_for_mut(&tab_id).map_err(|e| e.to_string())?;
    store
        .resolve_thread(&thread_id, &by)
        .map_err(|e| e.to_string())?;
    persist_sidecar(&ws, &watcher, &tab_id)
}

/// After every comments-mutation IPC the in-memory CommentsStore is
/// authoritative — but to satisfy success-criterion 5 ("exchange via files
/// alone") the on-disk sidecar must follow. Compute the sidecar path from
/// the open tab and the active sidecar_pattern, write the v2 envelope, and
/// prime the watcher's self-write suppression so MDViewer doesn't surface
/// its own write as an external-change event.
fn persist_sidecar(
    ws: &Workspace,
    watcher: &Mutex<Watcher>,
    tab_id: &str,
) -> Result<(), String> {
    let tab = ws.tab(tab_id).ok_or_else(|| "no such tab".to_string())?;
    let pattern = ws.settings_store().get().comments.sidecar_pattern.clone();
    let sc = mdviewer_lib::sidecar::sidecar_path(&tab.path, &pattern);
    let store = ws.comments_for(tab_id).map_err(|e| e.to_string())?;
    let bytes = mdviewer_lib::sidecar::save_sidecar(&sc, store).map_err(|e| e.to_string())?;
    if let Ok(w) = watcher.lock() {
        w.record_self_write(&sc, mdviewer_lib::watcher::quick_hash(&bytes));
    }
    Ok(())
}

#[tauri::command]
fn render_markdown(source: String) -> RenderResult {
    document::render_markdown(&source, &RenderOptions::default())
}

#[tauri::command]
fn save_document(
    state: State<'_, Ws>,
    watcher: State<'_, Mutex<Watcher>>,
    path: PathBuf,
    contents: String,
) -> Result<(), String> {
    // save_document calls back into the watcher AFTER the temp file is
    // fsynced and BEFORE the rename. That closes the race against notify's
    // worker thread unconditionally — even if notify fires the moment the
    // rename completes, the suppression list is already primed.
    let _r = mdviewer_lib::document::save_document(
        &path,
        contents.as_bytes(),
        |p, hash| {
            // record_self_write takes &self; the lock is held only long enough
            // to push into the suppression list, which is non-blocking.
            if let Ok(w) = watcher.lock() {
                w.record_self_write(p, hash);
            }
        },
    )
    .map_err(|e| e.to_string())?;
    {
        let mut ws = state.lock().map_err(|e| e.to_string())?;
        ws.refresh_tab(&path).map_err(|e| e.to_string())?;
        // C2: keep both the open-tab snapshot and the closed_snapshots
        // entry in sync with the bytes we just wrote so a subsequent
        // close+reopen (or external rewrite) can detect divergence.
        ws.prime_saved_snapshot(&path, contents);
    }
    // Successful save clears the dirty bit. The watcher's external-change
    // override (which forces Ask while edits are pending) deactivates here.
    if let Ok(w) = watcher.lock() {
        w.mark_unsaved(&path, false);
    }
    Ok(())
}

/// C2: line-anchored diff between two markdown buffers. Pure function;
/// the IPC handler doesn't need a Workspace lock.
#[tauri::command]
fn diff_md(local: String, incoming: String) -> Vec<Hunk> {
    conflict::diff_md(&local, &incoming)
}

/// Re-read `path` from disk and refresh the matching tab's cached source
/// + render. Wired to Workspace.ts's `external-change` reload listener so
/// a watcher-driven reload actually picks up the new bytes — without this
/// the frontend would re-mount stale cached HTML.
///
/// Returns the freshly-rendered OpenResult so the frontend can update its
/// activeTab cache without a follow-up `open_document` call (which would
/// short-circuit on the existing-tab branch and re-emit the old HTML).
#[tauri::command]
fn reload_document(
    state: State<'_, Ws>,
    path: PathBuf,
) -> Result<mdviewer_lib::workspace::OpenResult, String> {
    let mut ws = state.lock().map_err(|e| e.to_string())?;
    ws.refresh_tab(&path).map_err(|e| e.to_string())?;
    let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());
    let tab = ws
        .list_open_documents()
        .into_iter()
        .find(|t| t.path == canonical)
        .ok_or_else(|| "no open tab for path".to_string())?;
    Ok(mdviewer_lib::workspace::OpenResult {
        tab_id: tab.id.clone(),
        path: tab.path.clone(),
        html: tab.render.html.clone(),
        threads: tab.comments.list_threads().to_vec(),
    })
}

/// C3: copy a tab's `.md` plus its current sidecar (already in v2 form
/// after C1) into `folder` so the user can hand the folder off to a
/// reviewer. Refuses to overwrite a non-empty folder rather than risk
/// stomping unrelated files.
#[tauri::command]
fn export_document(
    state: State<'_, Ws>,
    tab_id: String,
    folder: PathBuf,
) -> Result<ExportResult, String> {
    let ws = state.lock().map_err(|e| e.to_string())?;
    let tab = ws.tab(&tab_id).ok_or_else(|| "no such tab".to_string())?;
    if folder.exists()
        && std::fs::read_dir(&folder)
            .map(|d| d.count())
            .unwrap_or(0)
            > 0
    {
        return Err("export folder is not empty".into());
    }
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;

    let md_name = tab
        .path
        .file_name()
        .ok_or_else(|| "source path has no file name".to_string())?;
    let md_dest = folder.join(md_name);
    std::fs::copy(&tab.path, &md_dest).map_err(|e| e.to_string())?;
    let mut files = vec![md_name.to_string_lossy().into_owned()];

    let pattern = ws.settings_store().get().comments.sidecar_pattern.clone();
    let local_sc = mdviewer_lib::sidecar::sidecar_path(&tab.path, &pattern);
    if local_sc.exists() {
        let sc_name = local_sc
            .file_name()
            .ok_or_else(|| "sidecar path has no file name".to_string())?;
        let sc_dest = folder.join(sc_name);
        std::fs::copy(&local_sc, &sc_dest).map_err(|e| e.to_string())?;
        files.push(sc_name.to_string_lossy().into_owned());
    }

    Ok(ExportResult { folder, files })
}

/// C3: walk `dir` for `*.comments.json` files and rewrite any v1 (Phase-1)
/// sidecars into v2 (Automerge envelope). Idempotent — already-v2 files
/// are skipped. Used both as an in-process helper and as the
/// `migrate-sidecars` CLI subcommand entry point.
fn migrate_sidecars(dir: &Path) -> anyhow::Result<(usize, usize)> {
    use anyhow::Context;
    let mut migrated = 0usize;
    let mut already_v2 = 0usize;
    for entry in walkdir::WalkDir::new(dir) {
        let entry = entry.with_context(|| format!("walk {:?}", dir))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let p = entry.path();
        let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if !name.ends_with(".comments.json") {
            continue;
        }
        let bytes = std::fs::read(p).with_context(|| format!("read {:?}", p))?;
        // Peek at schema_version without parsing the full envelope so a
        // legitimately-v2 file stays untouched (keeps mtimes stable for
        // sync tools and lets the user rerun the CLI safely).
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            if v.get("schema_version").and_then(|x| x.as_u64()) == Some(2) {
                already_v2 += 1;
                continue;
            }
        }
        let store = mdviewer_lib::sidecar::load_sidecar(p)
            .with_context(|| format!("load v1 sidecar {:?}", p))?;
        mdviewer_lib::sidecar::save_sidecar(p, &store)
            .with_context(|| format!("rewrite as v2 {:?}", p))?;
        migrated += 1;
        println!("migrated: {}", p.display());
    }
    Ok((migrated, already_v2))
}

/// Frontend-driven dirty-bit setter. `Edit.ts` calls `set_dirty(path, true)`
/// on first input and `set_dirty(path, false)` after `forceSave`. While the
/// bit is true, the watcher upgrades any external-change action to `Ask`
/// regardless of the configured `editor.external_change_behavior` — this is
/// the unsaved-edits override the design calls out.
#[tauri::command]
fn set_dirty(
    watcher: State<'_, Mutex<Watcher>>,
    path: PathBuf,
    dirty: bool,
) -> Result<(), String> {
    if let Ok(w) = watcher.lock() {
        w.mark_unsaved(&path, dirty);
    }
    Ok(())
}

#[tauri::command]
fn resolve_anchor(
    state: State<'_, Ws>,
    tab_id: String,
    anchor: Anchor,
) -> Result<ResolveOutcome, String> {
    state
        .lock()
        .map_err(|e| e.to_string())?
        .resolve_anchor_for_tab(&tab_id, &anchor)
        .map_err(|e| e.to_string())
}

fn main() {
    // C3: lightweight CLI dispatch before the Tauri runtime spins up. The
    // subcommand intentionally bypasses tauri::Builder so it can be used
    // from CI / scripts on a headless machine without the WebView.
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 3 && args[1] == "migrate-sidecars" {
        let dir = PathBuf::from(&args[2]);
        match migrate_sidecars(&dir) {
            Ok((migrated, already_v2)) => {
                println!("Done. migrated={migrated}, already_v2={already_v2}");
                return;
            }
            Err(e) => {
                eprintln!("migrate-sidecars failed: {e:?}");
                std::process::exit(1);
            }
        }
    }

    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());

    // E2E hook (macOS-friendly via tauri-webdriver). Loaded only when the
    // crate is built with `--features e2e`; release bundles never expose
    // the WebDriver port unless explicitly opted-in.
    #[cfg(feature = "e2e")]
    let builder = builder.plugin(tauri_plugin_webdriver_automation::init());

    builder
        .setup(|app| {
            let data_dir = app.path().app_config_dir()?;
            let env_override = std::env::var("MDVIEWER_DATA_DIR").ok();
            let dir = env_override.map(PathBuf::from).unwrap_or(data_dir);
            let ws = Workspace::new(&dir)?;
            // Snapshot the initial external-change behavior and grab a
            // settings change subscription before we move the workspace
            // into managed state. The watcher applies the snapshot at
            // construction; the settings subscription forwarder thread
            // re-applies it on every later settings update so toggles
            // from the Settings screen take effect immediately.
            let initial_behavior = ws.settings_store().get().editor.external_change_behavior;
            let settings_rx = ws.settings_store().subscribe();
            app.manage(Mutex::new(ws));

            // Construct the file watcher and register it as managed state
            // alongside the workspace. B3's `save_document` IPC handler
            // looks it up by `State<'_, Mutex<Watcher>>`; without this
            // explicit `manage` call B3 would fail at runtime with
            // "no managed state of type Mutex<Watcher>".
            let app_handle = app.handle().clone();
            let (tx, rx) = std::sync::mpsc::channel::<ExternalChangeEvent>();
            let mut watcher = Watcher::new(tx)?;
            watcher.set_external_change_behavior(initial_behavior);
            app.manage(Mutex::new(watcher));

            // Forward watcher events to the frontend on a dedicated thread.
            // The receiver loop ends when the sender side is dropped (i.e.
            // when the managed `Watcher` is dropped on app shutdown).
            std::thread::spawn(move || {
                for ev in rx {
                    let _ = app_handle.emit("external-change", &ev);
                }
            });

            // Re-apply external-change behavior on settings updates. This
            // thread sleeps on the mpsc receiver until SettingsStore::update
            // emits a `ChangeEvent::Editor`; on each tick we read the
            // current value and push it into the watcher's snapshot.
            let settings_app = app.handle().clone();
            std::thread::spawn(move || {
                use mdviewer_lib::settings::ChangeEvent;
                for ev in settings_rx {
                    if !matches!(ev, ChangeEvent::Editor) {
                        continue;
                    }
                    let ws_state = settings_app.state::<Mutex<Workspace>>();
                    let new_behavior = ws_state
                        .lock()
                        .ok()
                        .map(|ws| ws.settings_store().get().editor.external_change_behavior);
                    if let Some(b) = new_behavior {
                        let watcher_state = settings_app.state::<Mutex<Watcher>>();
                        if let Ok(mut w) = watcher_state.lock() {
                            w.set_external_change_behavior(b);
                        };
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            open_document,
            close_tab,
            activate_tab,
            list_open_documents,
            list_recents,
            get_settings,
            set_settings,
            list_threads,
            create_thread,
            post_reply,
            resolve_thread,
            render_markdown,
            resolve_anchor,
            save_document,
            set_dirty,
            diff_md,
            export_document,
            reload_document,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
