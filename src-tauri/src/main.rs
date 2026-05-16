#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Tauri binary entry: registers all Phase-1 IPC commands (`app_info` plus
//! 13 workspace/comments/render commands) plus the Phase-2 `save_document`
//! and `set_dirty` (B3) and the Phase-3 `diff_md` (C2), `export_document`
//! (C3), and `reload_document` (C2 follow-up), plus the seven new Drive
//! commands (`drive_connect`, `drive_disconnect`, `drive_status`,
//! `drive_open_url`, `drive_resolve_path`, `drive_get_collaborators`,
//! `is_drive_desktop_path`) added in A7 — 30+ commands at this point.
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
use std::sync::{Arc, Mutex};
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
    doc_prefs::DocPref,
    document::{self, RenderOptions, RenderResult},
    drive::{DriveCollaborator, DriveStatus},
    settings::{drive_kill_switch_active, Settings},
    watcher::{ExternalChangeEvent, Watcher},
    cli, menu,
    workspace::{ExportResult, OpenOpts, OpenOutcome, TabSummary, Workspace},
    BuildInfo,
};
use std::path::Path;

// macOS-only: the CLI symlink installer is a no-op on other platforms
// (deb/rpm/msi handle it via the package manager) so the import is gated.
#[cfg(target_os = "macos")]
use mdviewer_lib::cli_install;

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
fn list_open_documents(state: State<'_, Ws>) -> Vec<TabSummary> {
    state
        .lock()
        .unwrap()
        .list_open_documents()
        .iter()
        .map(|t| TabSummary {
            id: t.id.clone(),
            path: t.path.clone(),
        })
        .collect()
}

/// Return the id of the currently-active tab, or None if no tab is
/// active (StartPage state). The WebView's Workspace uses this on boot
/// to align its `state.activeId` with Rust's authoritative active tab —
/// without it, the session-restore boot path would default to the first
/// open tab even when Rust restored a different active tab from
/// session.json.
#[tauri::command]
fn get_active_tab_id(state: State<'_, Ws>) -> Option<String> {
    state
        .lock()
        .ok()
        .and_then(|ws| ws.active_tab_id().map(|s| s.to_string()))
}

#[tauri::command]
fn list_recents(state: State<'_, Ws>) -> Vec<mdviewer_lib::recents::RecentEntry> {
    state.lock().unwrap().recents_store().list_with_mtime()
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

/// Drop a thread from the sidecar. Mirrors `resolve_thread`'s shape but
/// calls `delete_thread` on the store; the persisted sidecar is rewritten
/// so the deletion survives a restart and is visible to other tabs that
/// re-read the file. Wired to the orphan-list "Delete" button on the
/// frontend (`mdviewer:delete-thread` flow, wireframe 09).
#[tauri::command]
fn delete_thread(
    state: State<'_, Ws>,
    watcher: State<'_, Mutex<Watcher>>,
    tab_id: String,
    thread_id: String,
) -> Result<(), String> {
    let mut ws = state.lock().map_err(|e| e.to_string())?;
    let store = ws.comments_for_mut(&tab_id).map_err(|e| e.to_string())?;
    store
        .delete_thread(&thread_id)
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

/// B2: rewritten save_document handler. Takes `(tab_id, body)` and
/// dispatches on `tab.backend`:
///
/// * `Local` — atomic write via `document::save_document` + watcher self-
///   write priming + tab-snapshot refresh, exactly as the previous
///   `save_document(path, contents)` handler did.
/// * `DriveApi` — uploads via `Workspace::save_drive_api_tab` with the
///   tab's stashed ETag for `If-Match`. Success refreshes `tab.etag`;
///   a 412 surfaces as `SaveOutcome::Conflict` for the diff-merge view.
/// * `DriveDesktop` — placeholder branch; B5 wires the watcher
///   `compare_for_save` path here once B4's helpers land.
///
/// Returns the typed `SaveOutcome` enum (distinct from the existing
/// `document::SaveResult` struct, which counts bytes + hashes for the
/// on-disk write helper). Frontend callers in `src/views/Edit.ts` and
/// `src/views/Conflict.ts` route the `Conflict` arm into the existing
/// diff-merge UI.
#[tauri::command]
fn save_document(
    state: State<'_, Ws>,
    watcher: State<'_, Mutex<Watcher>>,
    app: tauri::AppHandle,
    tab_id: String,
    body: String,
) -> Result<mdviewer_lib::document::SaveOutcome, String> {
    use mdviewer_lib::document::SaveOutcome;
    use mdviewer_lib::drive::TabBackend;
    use mdviewer_lib::workspace::SaveError;

    // Snapshot just the per-tab fields we need under a short critical
    // section, then drop the immutable borrow before re-entering Workspace
    // mutably. Avoids a mid-function lock upgrade.
    let (tab_backend, tab_path, tab_etag) = {
        let ws = state.lock().map_err(|e| e.to_string())?;
        let tab = ws
            .tab(&tab_id)
            .ok_or_else(|| format!("tab not found: {tab_id}"))?;
        (tab.backend, tab.path.clone(), tab.etag.clone())
    };

    // Phase B implementation review fix #1: when a Drive save returns
    // SaveOutcome::Conflict, *also* fan out the diff payload as a
    // `show-conflict` Tauri event so Workspace.ts mounts the diff-merge view
    // even when the calling TS code (Edit.ts autosave) discards the
    // outcome. The event mirrors the open_document conflict event shape but
    // adds a `source` discriminator so wireframe-07's banner picks the
    // right copy. The handler still returns SaveOutcome to the caller so
    // Conflict.ts (Finish merge → saveDocument) can keep using it.
    //
    // A8: emit the new `source` field name (was `drive_source` pre-A8); the
    // TS-side Workspace.ts listener accepts both spellings during the
    // bring-up so an A8/A9 cross-merge doesn't drop conflicts on the floor.
    let emit_drive_conflict = |local: &[u8], remote: &[u8], source: &mdviewer_lib::workspace::ConflictSource| {
        let _ = app.emit(
            "show-conflict",
            serde_json::json!({
                "tab_id": tab_id,
                "path": tab_path,
                "local": String::from_utf8_lossy(local),
                "incoming": String::from_utf8_lossy(remote),
                "source": source.to_wire(),
            }),
        );
    };

    match tab_backend {
        TabBackend::Local => {
            // Existing local save path — atomic write + watcher self-write
            // priming + tab-snapshot refresh, matching the previous
            // `save_document(path, contents)` handler one-for-one.
            mdviewer_lib::document::save_document(
                &tab_path,
                body.as_bytes(),
                |p, hash| {
                    if let Ok(w) = watcher.lock() {
                        w.record_self_write(p, hash);
                    }
                },
            )
            .map_err(|e| e.to_string())?;
            {
                let mut ws = state.lock().map_err(|e| e.to_string())?;
                ws.refresh_tab(&tab_path).map_err(|e| e.to_string())?;
                ws.prime_saved_snapshot(&tab_path, body);
            }
            if let Ok(w) = watcher.lock() {
                w.mark_unsaved(&tab_path, false);
            }
            Ok(SaveOutcome::Ok { etag: None })
        }
        TabBackend::DriveApi => {
            // The stashed ETag is the source of truth for If-Match. A
            // missing ETag is a programming error — DriveApi tabs are
            // populated with `Some(etag)` at `drive_open_url` construction
            // time and refreshed on every successful save. Erroring here
            // surfaces the bug locally instead of pretending an empty
            // string is a valid precondition the Drive backend will reject.
            let etag = tab_etag
                .ok_or_else(|| "DriveApi tab missing etag — re-open from URL".to_string())?;
            let mut ws = state.lock().map_err(|e| e.to_string())?;
            match ws.save_drive_api_tab(&tab_id, body.as_bytes(), &etag) {
                Ok(new_etag) => {
                    if let Some(t) = ws.tab_mut(&tab_id) {
                        t.etag = Some(new_etag.clone());
                        t.last_saved_snapshot = Some(body.clone());
                        t.source = body;
                    }
                    Ok(SaveOutcome::Ok { etag: Some(new_etag) })
                }
                Err(SaveError::Conflict { local, remote, source }) => {
                    // Drop the lock before emitting — the listener may
                    // re-enter via setActive → ipc.diffMd which itself
                    // doesn't take Workspace, but there's no benefit to
                    // holding it during the round-trip.
                    drop(ws);
                    emit_drive_conflict(&local, &remote, &source);
                    Ok(SaveOutcome::Conflict {
                        local: String::from_utf8_lossy(&local).into_owned(),
                        remote: String::from_utf8_lossy(&remote).into_owned(),
                        drive_source: Some(source.to_wire().to_string()),
                    })
                }
                Err(e) => Err(format!("{:?}", e)),
            }
        }
        TabBackend::DriveDesktop => {
            // Routes through `Workspace::save_drive_desktop_tab`, which
            // calls B4's `compare_for_save` to detect external changes.
            // On `Unchanged` the bytes land via `std::fs::write`; on
            // `Changed` the user's local edits + the freshly-read remote
            // bytes surface as `SaveOutcome::Conflict { drive_source:
            // Some("DriveDesktopWatcher") }` for the diff-merge view.
            //
            // Until B5 plumbs the Tauri-managed Watcher into the Workspace
            // constructor, `save_drive_desktop_tab` errors out with
            // "workspace has no watcher" — production DriveDesktop saves
            // are gated on that wiring landing.
            let mut ws = state.lock().map_err(|e| e.to_string())?;
            match ws.save_drive_desktop_tab(&tab_id, body.as_bytes()) {
                Ok(()) => Ok(SaveOutcome::Ok { etag: None }),
                Err(SaveError::Conflict { local, remote, source }) => {
                    drop(ws);
                    emit_drive_conflict(&local, &remote, &source);
                    Ok(SaveOutcome::Conflict {
                        local: String::from_utf8_lossy(&local).into_owned(),
                        remote: String::from_utf8_lossy(&remote).into_owned(),
                        drive_source: Some(source.to_wire().to_string()),
                    })
                }
                Err(e) => Err(format!("{:?}", e)),
            }
        }
    }
}

/// C2: line-anchored diff between two markdown buffers. Pure function;
/// the IPC handler doesn't need a Workspace lock.
#[tauri::command]
fn diff_md(local: String, incoming: String) -> Vec<Hunk> {
    conflict::diff_md(&local, &incoming)
}

/// Import comments from `incoming_path` into the active tab's CommentsStore
/// using `merge_stores` (CRDT union with per-thread comment-list union for
/// threads present on both sides). Persists the merged sidecar to disk via
/// `save_sidecar` so the new state survives a restart.
///
/// Used by the Share/Receive flow (wireframe 10) and by spec 06's auto-merge
/// scenario where a counterpart's sidecar arrives separately from the
/// markdown file.
#[tauri::command]
fn import_comments(
    state: State<'_, Ws>,
    watcher: State<'_, Mutex<Watcher>>,
    tab_id: String,
    incoming_path: PathBuf,
) -> Result<(), String> {
    use mdviewer_lib::comments::merge_stores;
    use mdviewer_lib::sidecar::{load_sidecar, sidecar_path};
    let mut ws = state.lock().map_err(|e| e.to_string())?;
    let incoming = load_sidecar(&incoming_path).map_err(|e| e.to_string())?;
    let pattern = ws.settings_store().get().comments.sidecar_pattern.clone();
    let tab_path = ws
        .tab(&tab_id)
        .ok_or_else(|| "no such tab".to_string())?
        .path
        .clone();
    let local = ws.comments_for(&tab_id).map_err(|e| e.to_string())?;
    let merged = merge_stores(local, &incoming);
    let sc = sidecar_path(&tab_path, &pattern);
    let bytes = mdviewer_lib::sidecar::save_sidecar(&sc, &merged).map_err(|e| e.to_string())?;
    if let Ok(w) = watcher.lock() {
        w.record_self_write(&sc, mdviewer_lib::watcher::quick_hash(&bytes));
    }
    // Replace the tab's in-memory store with the merged one.
    let store = ws.comments_for_mut(&tab_id).map_err(|e| e.to_string())?;
    store.replace_all(merged.list_threads().to_vec());
    Ok(())
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
        source: tab.source.clone(),
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

// ----------------------------------------------------------------------------
// A3: per-document font-size IPC commands.
//
// The frontend wrappers (A4) call these to read/write/reset the per-document
// override stored in `<data_dir>/doc_prefs.json`. All three are thin shims
// over `Workspace::doc_prefs()` / `doc_prefs_mut()` — the single store lives
// on Workspace so concurrent IPC calls don't race on the JSON file.
// ----------------------------------------------------------------------------

#[tauri::command]
fn get_doc_pref(state: State<'_, Ws>, path: String) -> Option<DocPref> {
    state.lock().ok()?.doc_prefs().load(Path::new(&path))
}

#[tauri::command]
fn set_doc_pref(state: State<'_, Ws>, path: String, pref: DocPref) {
    // Defense-in-depth clamp: the design specifies the IPC handler silently
    // coerces font_size_px into 10..=24 before persisting. The TS clamp is
    // the user-facing bound; this Rust clamp guards against fuzzed or
    // hand-edited invoke payloads. Errors are swallowed (no toaster on a
    // transient disk hiccup) — see the design doc's `Avoid` notes for A3.
    let mut pref = pref;
    pref.font_size_px = pref.font_size_px.clamp(10, 24);
    if let Ok(mut ws) = state.lock() {
        let _ = ws.doc_prefs_mut().save(Path::new(&path), pref);
    }
}

#[tauri::command]
fn delete_doc_pref(state: State<'_, Ws>, path: String) {
    if let Ok(mut ws) = state.lock() {
        let _ = ws.doc_prefs_mut().delete(Path::new(&path));
    }
}

/// Open an http/https URL in the user's default system browser.
///
/// Used by the rendered-document link interceptor (Document.ts): clicks on
/// `<a>` elements bubble through a confirmation modal that calls this IPC
/// when the user picks "Open in browser". Restricted to `http`/`https` so
/// we never shell out for `file://`, `javascript:`, custom-scheme, or any
/// other URL the user could be tricked into clicking.
#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let lowered = url.to_ascii_lowercase();
    if !lowered.starts_with("http://") && !lowered.starts_with("https://") {
        return Err("only http/https URLs may be opened externally".into());
    }
    let result = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(&url).spawn()
    } else if cfg!(target_os = "windows") {
        // `cmd /c start "" "<url>"` — the empty quoted string is a window
        // title placeholder so the URL itself isn't consumed as the title.
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &url])
            .spawn()
    } else {
        // Linux / BSD / other Unix — xdg-open is the desktop-spec entry point.
        std::process::Command::new("xdg-open").arg(&url).spawn()
    };
    result.map(|_| ()).map_err(|e| e.to_string())
}

// ----------------------------------------------------------------------------
// A7: Drive integration IPC commands.
//
// Seven new commands plumb the Drive feature surface into the frontend. All
// take `State<'_, Ws>` matching the existing convention; mutating handlers
// `lock().unwrap()` the std-Mutex (consistent with every other command in
// this file). `drive_open_url` is intentionally a stub here — B2 fills it
// in once the file_id resolver + tab-creation flow are wired. The other six
// either delegate to Workspace (drive_status, drive_resolve_path,
// drive_get_collaborators, drive_connect, drive_disconnect) or are pure
// helpers (`is_drive_desktop_path`).
// ----------------------------------------------------------------------------

/// C5: human-readable error returned when the user has explicitly opted
/// out of the Drive surface via `cloud.drive.feature_enabled = false` in
/// their settings.toml. Surfaced on `drive_connect` and `drive_open_url`
/// so the kill-switch is felt at the user-visible boundaries — the
/// frontend's notify hook turns this into a toast on the Connect button
/// and on a pasted Drive URL.
const DRIVE_KILL_SWITCH_MSG: &str =
    "Drive integration is disabled in your settings (cloud.drive.feature_enabled = false). \
     Re-enable it from Settings → Drive integration to use Connect or Open from Drive.";

#[tauri::command]
async fn drive_connect(
    state: State<'_, Ws>,
    app: tauri::AppHandle,
) -> Result<DriveStatus, String> {
    // Bug-2 fix (lock-across-blocking-IO): drop the workspace lock around
    // the up-to-5-minute OAuth flow. Previously this handler held
    // `state.lock()` across `Workspace::drive_connect` which calls the
    // blocking `auth::run_loopback_flow` — every other IPC stalled until
    // the user either consented or the timeout fired, freezing the app.
    //
    // Three-phase pattern: snapshot under lock → OAuth lock-free → apply
    // under re-acquired lock.
    let prep = {
        let ws = state.lock().map_err(|e| e.to_string())?;
        // C5 kill-switch: short-circuit before any OAuth round-trip.
        if drive_kill_switch_active(&ws.settings_store().get()) {
            return Err(DRIVE_KILL_SWITCH_MSG.to_string());
        }
        ws.drive_connect_prep()
    }; // workspace lock released

    // Bug-1 surface: drive_connect_oauth returns a clear error when the
    // resolved client_id is the PLACEHOLDER built into the binary and the
    // user hasn't supplied a BYO override.
    let outcome = mdviewer_lib::workspace::drive_connect_oauth(
        prep,
        mdviewer_lib::workspace::default_open_url,
    )
    .map_err(|e| e.to_string())?;

    let mut ws = state.lock().map_err(|e| e.to_string())?;
    ws.drive_connect_apply(&app, outcome).map_err(|e| e.to_string())?;
    let st = ws.drive_status();
    let _ = app.emit("drive-status-changed", &st);
    // B6: snapshot the per-file_id queue list + id_map handles + the
    // drive_api Arc under the existing lock, then drop the lock and spawn
    // an async fan-out that drains every queue without holding Workspace
    // through the API roundtrips.
    if let Some(api) = ws.drive_api_arc() {
        let cfg = ws.config_dir().to_path_buf();
        let queues: Vec<(String, std::path::PathBuf)> = ws
            .drive_tab_file_ids()
            .into_iter()
            .map(|fid| (fid, cfg.clone()))
            .collect();
        let id_maps = ws.id_maps_arc_clone();
        drop(ws);
        mdviewer_lib::drive::queue::spawn_replay_all(app.clone(), api, queues, id_maps);
    }
    Ok(st)
}

#[tauri::command]
async fn drive_disconnect(
    state: State<'_, Ws>,
    app: tauri::AppHandle,
) -> Result<DriveStatus, String> {
    let mut ws = state.lock().map_err(|e| e.to_string())?;
    ws.drive_disconnect();
    let st = ws.drive_status();
    let _ = app.emit("drive-status-changed", &st);
    Ok(st)
}

#[tauri::command]
fn drive_status(state: State<'_, Ws>) -> DriveStatus {
    state.lock().unwrap().drive_status()
}

#[tauri::command]
async fn drive_open_url(
    state: State<'_, Ws>,
    app: tauri::AppHandle,
    url: String,
) -> Result<TabSummary, String> {
    let mut ws = state.lock().map_err(|e| e.to_string())?;
    // C5 kill-switch: short-circuit before parsing or hitting Drive so a
    // user who has explicitly opted out gets the same friendly error here
    // as they do on Connect. Mirrors the guard at the top of drive_connect.
    if drive_kill_switch_active(&ws.settings_store().get()) {
        return Err(DRIVE_KILL_SWITCH_MSG.to_string());
    }
    let summary = ws.drive_open_url(&url).map_err(|e| e.to_string())?;
    drop(ws);
    // Phase B implementation review fix #3: emit `workspace-changed` so
    // main.ts's tab list / document body refresh path runs after a Drive
    // tab opens. Mirrors the pattern used by `open_document` (and the
    // single-instance / RunEvent::Opened paths) — without this, the new
    // tab is created on the Rust side but the WebView never repaints.
    let _ = app.emit("workspace-changed", ());
    Ok(summary)
}

#[tauri::command]
fn drive_resolve_path(state: State<'_, Ws>, local_path: String) -> Result<String, String> {
    state
        .lock()
        .map_err(|e| e.to_string())?
        .drive_resolve_path(&local_path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn drive_get_collaborators(
    state: State<'_, Ws>,
    file_id: String,
) -> Result<Vec<DriveCollaborator>, String> {
    state
        .lock()
        .map_err(|e| e.to_string())?
        .drive_get_collaborators(&file_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn is_drive_desktop_path(path: String) -> bool {
    // Pure helper consumed by C2's DriveDetectToast — no auth, no workspace
    // state. Lives in main.rs alongside the other Drive IPC commands so all
    // registration happens in one place.
    let home = std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok());
    mdviewer_lib::drive::detect::is_drive_desktop_path(
        Path::new(&path),
        std::env::consts::OS,
        home.as_deref(),
    )
    .is_some()
}

// ----------------------------------------------------------------------------
// A9: SSH IPC commands.
//
// `ssh_open_url` parallels `drive_open_url`: parse the URL, fetch + cache the
// remote bytes, register a tab. `ssh_password_response` is the frontend's reply
// channel for askpass prompts — it forwards the user's value (or `None` for
// cancel) into the shared `AskpassInbox`, which the Unix askpass server (A6)
// and the Windows russh auth callback (A5) both await on.
//
// Both handlers go through the `SshAppState` managed state, which holds:
//   * `ops`   — `Arc<Operations>` with the per-platform transport baked in
//   * `inbox` — `Arc<AskpassInbox>` shared with the askpass listener / russh
// ----------------------------------------------------------------------------

/// Shared SSH state stashed in Tauri's managed-state container at startup.
/// One instance is constructed in `setup()` and reused for every SSH IPC
/// invocation. The transport baked into `ops` differs per platform; both
/// platforms route askpass replies through the same `inbox`.
///
/// `_auth_ctx` and (on Unix) `_askpass_server` are held here purely for
/// lifetime: dropping the `SshAppState` at app shutdown drops them in
/// order — server first (closes the socket cleanly), then auth context
/// (releases the resolved helper path and the mpsc sender).
pub struct SshAppState {
    pub ops: Arc<mdviewer_lib::ssh::operations::Operations>,
    pub inbox: Arc<mdviewer_lib::ssh::auth::AskpassInbox>,
    /// Hold-onto field — the transport's `Arc<AuthContext>` aliases this.
    /// Keeping it alive in SshAppState matches the desired "app-lifetime"
    /// scope without `Box::leak`.
    _auth_ctx: Arc<mdviewer_lib::ssh::auth::AuthContext>,
    /// Unix-only: lives for the lifetime of the app so the askpass socket
    /// (held inside a tempdir leaked by `start_listener`) is reachable
    /// from every spawned ssh process. The Receiver inside is currently
    /// unused at the AppState level (each helper connection resolves
    /// directly via the inbox); future code may forward those events to
    /// the frontend modal.
    #[cfg(unix)]
    _askpass_server: Mutex<mdviewer_lib::ssh::askpass::AskpassServer>,
}

#[tauri::command]
async fn ssh_open_url(
    state: State<'_, Ws>,
    ssh: State<'_, SshAppState>,
    app: tauri::AppHandle,
    url: String,
) -> Result<mdviewer_lib::workspace::TabSummary, String> {
    let parsed = mdviewer_core::ssh_url::parse(&url).map_err(|e| e.to_string())?;
    // Async fetch FIRST without holding the workspace mutex. The IPC
    // handler runs on a Tauri worker; holding a `std::sync::MutexGuard`
    // across `.await` would fail the Send bound. Mirrors the three-phase
    // pattern used by `drive_connect` (snapshot → IO → apply).
    let outcome = ssh
        .ops
        .open_url(&parsed)
        .await
        .map_err(|e| e.to_string())?;
    // Sync registration: re-acquire the lock and stash the tab.
    let summary = {
        let mut ws = state.lock().map_err(|e| e.to_string())?;
        ws.register_ssh_tab_from_outcome(parsed, outcome)
    };
    // Mirror `drive_open_url`'s frontend nudge so main.ts repaints the tab
    // strip + active document once the new tab lands.
    let _ = app.emit("workspace-changed", ());
    Ok(summary)
}

#[tauri::command]
fn ssh_password_response(
    ssh: State<'_, SshAppState>,
    req_id: String,
    value: Option<String>,
) -> Result<(), String> {
    // `AskpassInbox::respond` is synchronous (oneshot::Sender::send doesn't
    // await), so this whole handler is sync. The Tauri-side `State<'_, T>`
    // borrow lifetime doesn't survive a `.await` either, so dropping `async`
    // also tightens the lifetime contract — no risk of the state guard being
    // held across an await point that doesn't exist.
    // Unknown req_ids silently no-op — see the auth.rs unit suite.
    ssh.inbox.respond(&req_id, value);
    Ok(())
}

/// Dispatch a heterogeneous list of CLI targets onto the workspace. Used by
/// (a) the single-instance plugin callback and (b) macOS's
/// `RunEvent::Opened` hook — both sync contexts that may receive a mix of
/// `Local` paths and `Ssh` URLs.
///
/// Local targets open through `Workspace::open_document` under a brief
/// workspace lock; SSH targets spawn an async task that fetches via
/// `Operations::open_url` lock-free, then re-acquires the lock to register
/// the tab. The two paths are independent: an SSH fetch failure for one
/// URL doesn't block another URL from succeeding.
fn dispatch_cli_targets(
    app: tauri::AppHandle,
    targets: Vec<cli::OpenTarget>,
    source_label: &'static str,
) {
    // First pass: open Local tabs synchronously under a single workspace
    // lock acquisition. We deliberately don't .await inside this scope.
    let mut deferred_ssh: Vec<mdviewer_core::ssh_url::SshUrl> = Vec::new();
    let ws_state = app.state::<Mutex<Workspace>>();
    if let Ok(mut ws) = ws_state.lock() {
        for target in targets {
            match target {
                cli::OpenTarget::Local(path) => {
                    match ws.open_document(&path, OpenOpts::default()) {
                        Ok(_) => tracing::info!(
                            "opened from {}: {}",
                            source_label,
                            path.display()
                        ),
                        Err(e) => tracing::warn!(
                            "{} open failed for {}: {e:?}",
                            source_label,
                            path.display()
                        ),
                    }
                }
                cli::OpenTarget::Ssh(url) => deferred_ssh.push(url),
            }
        }
    }

    // Second pass: each SSH target spawns a Tauri-runtime task so the
    // synchronous caller (the single-instance plugin callback, the
    // RunEvent::Opened branch) returns immediately and the async fetch
    // happens off the event loop.
    for url in deferred_ssh {
        let app_handle = app.clone();
        // Display impl on SshUrl renders the canonical
        // `ssh://[user@]host[:port]/path` form — same shape A2 pinned.
        let url_label = url.to_string();
        tauri::async_runtime::spawn(async move {
            let ssh_state = app_handle.state::<SshAppState>();
            let outcome = match ssh_state.ops.open_url(&url).await {
                Ok(o) => o,
                Err(e) => {
                    tracing::warn!(
                        "{} SSH open failed for {}: {e:?}",
                        source_label,
                        url_label
                    );
                    return;
                }
            };
            let ws_state = app_handle.state::<Mutex<Workspace>>();
            if let Ok(mut ws) = ws_state.lock() {
                let _ = ws.register_ssh_tab_from_outcome(url, outcome);
                tracing::info!("opened SSH from {}: {}", source_label, url_label);
            }
            let _ = app_handle.emit("workspace-changed", ());
        });
    }
}

/// macOS-only: shell out to `osascript` to install or remove the
/// `/usr/local/bin/mdviewer` symlink, then surface a native dialog with the
/// result. Cancellations stay silent so a user who clicks Cancel on the
/// admin prompt isn't nagged with a confirmation popup. Spawns nothing
/// itself — call from a worker thread, because the AppleScript
/// `with administrator privileges` blocks until the user dismisses the
/// auth dialog.
#[cfg(target_os = "macos")]
fn handle_cli_install_click(app: &tauri::AppHandle, menu_id: &str) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

    let is_install = menu_id == menu::MENU_ID_INSTALL_CLI;

    let outcome = if is_install {
        cli_install::install_symlink().map(Some)
    } else {
        cli_install::uninstall_symlink().map(|()| None)
    };

    match outcome {
        Ok(Some(path)) => {
            app.dialog()
                .message(format!(
                    "`mdviewer` is now available on your PATH at {}.\n\nYou can now run `mdviewer file.md` from any terminal.",
                    path.display()
                ))
                .title("Command line tool installed")
                .kind(MessageDialogKind::Info)
                .blocking_show();
        }
        Ok(None) => {
            app.dialog()
                .message(format!(
                    "Removed {}.",
                    cli_install::SYMLINK_PATH
                ))
                .title("Command line tool uninstalled")
                .kind(MessageDialogKind::Info)
                .blocking_show();
        }
        Err(cli_install::CliInstallError::Cancelled) => {
            // User dismissed the admin prompt. No-op.
        }
        Err(cli_install::CliInstallError::Failed(msg)) => {
            tracing::warn!("cli_install {} failed: {msg}", if is_install { "install" } else { "uninstall" });
            let action = if is_install { "install" } else { "uninstall" };
            app.dialog()
                .message(format!(
                    "Failed to {action} the command line tool:\n\n{msg}"
                ))
                .title("Command line tool")
                .kind(MessageDialogKind::Error)
                .blocking_show();
        }
    }
}

/// macOS-only: first-launch nudge to install the `mdviewer` PATH symlink.
/// Skips silently when (a) a symlink already exists at the canonical path,
/// or (b) the user has already seen and answered this prompt for the
/// current `CURRENT_CLI_INSTALL_PROMPT_VERSION`.
///
/// Three terminal states for the user's answer:
///
/// 1. "Install" → admin auth prompt → on success, record seen-for and
///    show a confirmation. On admin-prompt cancel, leave seen-for unset
///    (they didn't really decide). On failure, record seen-for so we
///    don't loop on a broken environment, and surface the error.
/// 2. "Not now" → record seen-for. The menu still offers install/uninstall.
/// 3. Dialog dismissed without answering (rare; users normally pick a
///    button) → leave seen-for unset, ask again next launch.
#[cfg(target_os = "macos")]
fn run_first_run_cli_prompt(app: &tauri::AppHandle) {
    use mdviewer_lib::settings::CURRENT_CLI_INSTALL_PROMPT_VERSION;
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    let ws_state = app.state::<Mutex<Workspace>>();
    let seen_for = match ws_state.lock() {
        Ok(ws) => ws
            .settings_store()
            .get()
            .onboarding
            .cli_install_prompt_seen_for
            .clone(),
        Err(_) => return,
    };

    // `symlink_metadata` (not `metadata`) so a dangling symlink still counts
    // as "something is here" — we don't want to clobber a user's broken-by-
    // upgrade symlink without their consent.
    let symlink_present = std::path::Path::new(cli_install::SYMLINK_PATH)
        .symlink_metadata()
        .is_ok();

    if !cli_install::should_show_first_run_prompt(
        &seen_for,
        CURRENT_CLI_INSTALL_PROMPT_VERSION,
        symlink_present,
    ) {
        return;
    }

    let mark_seen = || {
        if let Ok(ws) = ws_state.lock() {
            let _ = ws.settings_store().update(|s| {
                s.onboarding.cli_install_prompt_seen_for =
                    CURRENT_CLI_INSTALL_PROMPT_VERSION.to_string();
            });
        }
    };

    let install_chosen = app
        .dialog()
        .message(
            "MDViewer can install an 'mdviewer' command in your PATH so you can open files from the terminal:\n\n\
             mdviewer notes.md\n\n\
             You'll be asked for your administrator password.\n\
             You can change this later from the MDViewer menu.",
        )
        .title("Install command line tool?")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Install".into(),
            "Not now".into(),
        ))
        .kind(MessageDialogKind::Info)
        .blocking_show();

    if !install_chosen {
        // User picked "Not now" — they answered, so don't pester again.
        mark_seen();
        return;
    }

    match cli_install::install_symlink() {
        Ok(path) => {
            mark_seen();
            app.dialog()
                .message(format!(
                    "'mdviewer' is now available on your PATH at {}.",
                    path.display()
                ))
                .title("Command line tool installed")
                .kind(MessageDialogKind::Info)
                .blocking_show();
        }
        Err(cli_install::CliInstallError::Cancelled) => {
            // Admin prompt cancelled. They didn't really commit either way;
            // ask again next launch so a typo on the password isn't a
            // permanent decision.
        }
        Err(cli_install::CliInstallError::Failed(msg)) => {
            tracing::warn!("first-run cli install failed: {msg}");
            mark_seen();
            app.dialog()
                .message(format!(
                    "Failed to install command line tool:\n\n{msg}\n\nYou can retry from the MDViewer menu."
                ))
                .title("Install failed")
                .kind(MessageDialogKind::Error)
                .blocking_show();
        }
    }
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
        // Single-instance plugin must be registered FIRST so its second-
        // invocation handler runs before the rest of the app initializes.
        // The callback receives `(app, argv, _cwd)` from the second
        // invocation, parses the argv via `cli::parse_positional_args`
        // (the same code path Phase 1 uses at boot), opens each path on
        // the running Workspace, and re-focuses the main window.
        // Without this, `mdviewer foo.md` while the app is already
        // running spawns a duplicate window on Win/Linux and bounces
        // the Dock icon on macOS without doing anything useful.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let targets = cli::parse_positional_args(&argv);
            if !targets.is_empty() {
                dispatch_cli_targets(
                    app.clone(),
                    targets,
                    "second invocation",
                );
                let _ = app.emit("workspace-changed", ());
            }
            // Bring the main window forward so the user sees the new tab
            // even if the existing window was hidden behind another app.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // D1: register the Stronghold plugin so future IPC handlers can
        // persist OAuth refresh tokens at rest. The password-hash function
        // delegates the actual key material to `drive::keyring::vault_key()`
        // — a 32-byte key derived from a per-machine random salt held in
        // the OS keyring (with a documented obfuscation-only fallback when
        // no keyring is reachable). The user-supplied `password` argument
        // is mixed into the SHA-256 so distinct passwords still yield
        // distinct vault keys, which lets a future per-account flow open
        // separate Stronghold snapshots without colliding.
        //
        // We never panic on registration: a Stronghold init failure (e.g.
        // a corrupt iota_stronghold runtime in CI) shouldn't tank boot —
        // we log a warning and continue. Production tauri::Builder::run
        // surfaces real failures via the standard plugin error path; the
        // log line gives operators a breadcrumb if Drive features later
        // refuse to persist tokens.
        .plugin(tauri_plugin_stronghold::Builder::new(|password| {
            use sha2::{Digest, Sha256};
            let key = mdviewer_lib::drive::keyring::vault_key();
            let mut hasher = Sha256::new();
            hasher.update(b"mdviewer-stronghold-v1");
            hasher.update(key);
            hasher.update(password.as_bytes());
            hasher.finalize().to_vec()
        }).build())
        // Persist window state (position + size, plus maximized/fullscreen
        // flags) across restarts. The plugin saves on close and restores
        // on launch — first-run picks up the defaults from
        // `tauri.conf.json::app.windows[0]`. Tracked to the app config dir
        // (`window-state.json`), which our `MDVIEWER_DATA_DIR` override
        // already redirects for the e2e suite.
        .plugin(tauri_plugin_window_state::Builder::default().build());

    // E2E hook (macOS-friendly via tauri-webdriver). Loaded only when the
    // crate is built with `--features e2e`; release bundles never expose
    // the WebDriver port unless explicitly opted-in.
    #[cfg(feature = "e2e")]
    let builder = builder.plugin(tauri_plugin_webdriver_automation::init());

    builder
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();

            // macOS-only: the shell-tool installer items are handled
            // entirely Rust-side (osascript admin prompt → result dialog)
            // so they never reach the frontend bridge. Run on a worker
            // thread because `osascript with administrator privileges`
            // blocks until the user dismisses the auth dialog and we
            // don't want to stall the menu callback.
            #[cfg(target_os = "macos")]
            if id == menu::MENU_ID_INSTALL_CLI || id == menu::MENU_ID_UNINSTALL_CLI {
                let app = app.clone();
                let id_owned = id.to_string();
                std::thread::spawn(move || {
                    handle_cli_install_click(&app, &id_owned);
                });
                return;
            }

            // Native menu clicks → tauri event the WebView listener
            // translates into the existing mdviewer:* CustomEvents. The
            // pure id↔action mapping lives in `mdviewer_lib::menu` so it
            // can be unit-tested without an AppHandle.
            if let Some(action) = menu::menu_id_to_action(id) {
                let _ = app.emit(menu::MENU_EVENT, action);
            }
        })
        .setup(|app| {
            // Build and attach the native menu before the workspace setup
            // — `set_menu` is cheap and does not depend on workspace state.
            // Failure to build the menu shouldn't take down the app, so we
            // log and continue with the platform default.
            match menu::build(app.handle()) {
                Ok(m) => {
                    if let Err(e) = app.set_menu(m) {
                        tracing::warn!("set_menu failed: {e:?}");
                    }
                }
                Err(e) => tracing::warn!("menu::build failed: {e:?}"),
            }

            let data_dir = app.path().app_config_dir()?;
            let env_override = std::env::var("MDVIEWER_DATA_DIR").ok();
            let dir = env_override.map(PathBuf::from).unwrap_or(data_dir);
            let mut ws = Workspace::new(&dir)?;

            // A9: SSH state — `Operations` + `AskpassInbox`. The Operations
            // handle is shared (Arc) across IPC handlers + the CLI-dispatch
            // path; the inbox is shared with the askpass listener (Unix) /
            // russh auth callback (Windows). Constructed before any CLI
            // SSH opens fire below so `ws.open_ssh_url(...)` can reach the
            // same Operations the later IPC handlers will use.
            let ssh_state = build_ssh_app_state(app, &dir)?;
            let ssh_ops = ssh_state.ops.clone();

            // CLI positional args take precedence over the saved session —
            // a user invoking `mdviewer notes.md` is expressing intent for
            // *this* launch and shouldn't have the saved tabs loaded too.
            // The session restore branch only runs when argv brought no
            // paths AND the user has opted into restore mode.
            let cli_targets =
                cli::parse_positional_args(&std::env::args().collect::<Vec<_>>());
            // A9: argv now contains a mix of `OpenTarget::Local(path)` and
            // `OpenTarget::Ssh(url)`. Local opens go through `open_document`
            // synchronously; SSH opens drive `open_ssh_url(url, &ops)` via
            // `block_on` because `ws` is still owned directly here (the
            // managed-state hand-off via `app.manage(...)` lives further
            // down). Each target's failure is logged and the rest still
            // load — same UX as the prior single-variant loop.
            if !cli_targets.is_empty() {
                for target in cli_targets {
                    match target {
                        cli::OpenTarget::Local(path) => {
                            match ws.open_document(&path, OpenOpts::default()) {
                                Ok(_) => tracing::info!(
                                    "opened from CLI: {}",
                                    path.display()
                                ),
                                Err(e) => tracing::warn!(
                                    "CLI arg open failed for {}: {e:?}",
                                    path.display()
                                ),
                            }
                        }
                        cli::OpenTarget::Ssh(url) => {
                            // SshUrl's Display impl is the canonical formatter
                            // (A2). format_ssh_label was a stale dupe.
                            let url_label = url.to_string();
                            let res = tauri::async_runtime::block_on(
                                ws.open_ssh_url(url.clone(), &ssh_ops),
                            );
                            match res {
                                Ok(_) => tracing::info!(
                                    "opened SSH from CLI: {}",
                                    url_label
                                ),
                                Err(e) => tracing::warn!(
                                    "CLI SSH open failed for {}: {e:?}",
                                    url_label
                                ),
                            }
                        }
                    }
                }
            } else if matches!(
                ws.settings_store().get().appearance.startup_mode,
                mdviewer_lib::settings::StartupMode::Restore
            ) {
                // Replay the saved session — open each remembered tab in
                // order, then re-activate the previously-active tab. A
                // failure on any single path is logged and skipped (the
                // file may have moved/been deleted since last launch);
                // the rest still load. SessionStore::open already pruned
                // missing paths at load time, so this is defense in depth.
                let saved = ws.session_store().get();
                let active_target = saved.active_tab.clone();
                for path in saved.open_tabs {
                    // Skip synthetic `drive-api://<file_id>` paths — those
                    // tabs are reopened via `drive_open_url` (which the user
                    // re-pastes), not the local-fs `open_document` flow.
                    // Without this guard, `open_document` would try to
                    // canonicalize + read the synthetic path and fail noisily.
                    if path.to_string_lossy().starts_with("drive-api://") {
                        continue;
                    }
                    match ws.open_document(&path, OpenOpts::default()) {
                        Ok(_) => tracing::info!("restored from session: {}", path.display()),
                        Err(e) => tracing::warn!(
                            "session restore failed for {}: {e:?}",
                            path.display()
                        ),
                    }
                }
                // open_document leaves the LAST opened tab active; if the
                // saved session pinned a different one, switch to it.
                if let Some(target_path) = active_target {
                    let canonical = target_path
                        .canonicalize()
                        .unwrap_or_else(|_| target_path.clone());
                    let target_id = ws
                        .list_open_documents()
                        .iter()
                        .find(|t| t.path == canonical)
                        .map(|t| t.id.clone());
                    if let Some(id) = target_id {
                        let _ = ws.activate_tab(&id);
                    }
                }
            }
            // Snapshot the initial external-change behavior and grab a
            // settings change subscription before we move the workspace
            // into managed state. The watcher applies the snapshot at
            // construction; the settings subscription forwarder thread
            // re-applies it on every later settings update so toggles
            // from the Settings screen take effect immediately.
            let initial_behavior = ws.settings_store().get().editor.external_change_behavior;
            let settings_rx = ws.settings_store().subscribe();
            app.manage(Mutex::new(ws));
            // SSH managed state goes in alongside the workspace so any IPC
            // handler that takes `State<'_, SshAppState>` finds it. The
            // Operations Arc carried inside `ssh_state` is the same one
            // `ssh_ops` cloned earlier for the CLI-dispatch path.
            app.manage(ssh_state);

            // macOS-only: first-launch CLI-install nudge. Spawned on a
            // worker so neither the Tauri event loop nor app startup
            // blocks on the dialog (or, if the user picks "Install",
            // on the admin auth prompt that follows). The 600ms delay
            // lets the main window appear first so the dialog has a
            // visible parent context — without it the dialog can pop
            // before the WebView paints, which feels jarring.
            #[cfg(target_os = "macos")]
            {
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(600));
                    run_first_run_cli_prompt(&app_handle);
                });
            }

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
            get_active_tab_id,
            list_recents,
            get_settings,
            set_settings,
            list_threads,
            create_thread,
            post_reply,
            resolve_thread,
            delete_thread,
            render_markdown,
            resolve_anchor,
            save_document,
            set_dirty,
            diff_md,
            export_document,
            reload_document,
            import_comments,
            get_doc_pref,
            set_doc_pref,
            delete_doc_pref,
            open_external_url,
            // A7: Drive integration (seven new commands).
            drive_connect,
            drive_disconnect,
            drive_status,
            drive_open_url,
            drive_resolve_path,
            drive_get_collaborators,
            is_drive_desktop_path,
            // A9: SSH IPC surface.
            ssh_open_url,
            ssh_password_response,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // macOS-only: Launch Services delivers paths via RunEvent::Opened
            // when the user (a) drags a .md onto the Dock icon, (b) double-
            // clicks one in Finder while the app is already running, or
            // (c) picks "Open With → MDViewer" from a Finder context menu.
            // Without this hook the URLs would fall on the floor.
            //
            // Cold-start file-association launches still go through the
            // CLI argv path (Phase 1) — Launch Services puts the paths
            // there for the first invocation.
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = event {
                let targets = cli::urls_to_paths(&urls);
                if targets.is_empty() {
                    return;
                }
                dispatch_cli_targets(app.clone(), targets, "RunEvent::Opened");
                // Tell the WebView to re-fetch the open-doc list and re-paint
                // its tab strip. main.ts listens for this event and calls
                // workspace.refresh().
                let _ = app.emit("workspace-changed", ());
            }
            // Suppress the "unused" warnings on non-macOS platforms.
            #[cfg(not(any(target_os = "macos", target_os = "ios")))]
            { let _ = (app, event); }
        });
}

/// A9: assemble the shared `SshAppState`.
///
/// `Operations` wraps a per-platform `SshTransport` impl plus the on-disk
/// cache base for fetched bytes. `AskpassInbox` mediates between askpass
/// producers (Unix listener / Windows russh callback) and the frontend
/// modal that resolves each prompt via the `ssh_password_response` IPC
/// command.
///
/// Cache base: honors the `MDVIEWER_REMOTE_CACHE_DIR` env override (used
/// by the e2e suite) and otherwise falls back to the Tauri-provided
/// cache directory. Mirrors the same env-override pattern `MDVIEWER_DATA_DIR`
/// uses for the workspace data dir.
///
/// Unix path: starts the askpass socket listener so the helper bin can
/// connect back when `ssh` invokes it via `SSH_ASKPASS`. The socket path
/// returned by the listener is stashed in the `AuthContext` consulted at
/// per-command env-installation time (B5 will thread that context into
/// the per-command transport call); the inbox is also stashed in the
/// returned `SshAppState` so the frontend modal can resolve pending
/// prompts.
///
/// Windows path: no socket — `russh` calls back into the inbox directly
/// from the auth dance (see `AuthStrategy::WindowsCallback`). The
/// `AuthStrategy` is computed once via the auth `probe` and baked into
/// the `WindowsTransport` constructor.
fn build_ssh_app_state(
    app: &tauri::App,
    data_dir: &std::path::Path,
) -> Result<SshAppState, Box<dyn std::error::Error>> {
    use mdviewer_lib::ssh::auth::{AskpassInbox, AuthContext};
    use mdviewer_lib::ssh::operations::Operations;

    let cache_base = {
        let cache_dir = app
            .path()
            .app_cache_dir()
            .unwrap_or_else(|_| data_dir.to_path_buf());
        Operations::resolve_cache_base(cache_dir)
    };

    let inbox = Arc::new(AskpassInbox::new());
    // Resolve the helper binary's installed path. Tauri's externalBin
    // declaration in `tauri.conf.json` places `mdviewer-askpass-<triple>`
    // next to the main binary at build time (renamed to `mdviewer-askpass`
    // on macOS .app bundles and Linux .deb/.AppImage payloads); resolving
    // against `resource_dir()` works for both dev (cargo target) and
    // installed builds. The helper is invoked by `ssh` via SSH_ASKPASS;
    // its path needs to be absolute because `ssh` execs it with no PATH
    // lookup.
    let askpass_helper_path = app
        .path()
        .resource_dir()
        .map(|d| d.join("mdviewer-askpass"))
        .unwrap_or_else(|_| std::path::PathBuf::from("mdviewer-askpass"));
    // Per-platform transport construction. The Unix branch starts the
    // askpass listener whose socket path the per-command transport call
    // bakes into `SSH_ASKPASS` + `MDVIEWER_ASKPASS_SOCKET` env vars; the
    // Windows branch hands the inbox to the russh auth callback. The
    // `tauri::async_runtime::block_on` call below starts the listener on
    // the runtime that backs every other async IPC handler, so the
    // socket survives the `setup()` return.
    #[cfg(unix)]
    let askpass_server = tauri::async_runtime::block_on(
        mdviewer_lib::ssh::askpass::start_listener(inbox.clone()),
    )?;
    #[cfg(unix)]
    let askpass_socket = askpass_server.socket_path.clone();
    #[cfg(not(unix))]
    let askpass_socket = std::path::PathBuf::new();

    // Build one AuthContext shared by everything below. The transport
    // (Unix) and the Windows russh auth callback both capture clones of
    // the same `Arc<AuthContext>` so a single user-side state (inbox,
    // helper path, socket path, mpsc sender) drives every connection.
    let (askpass_tx, _askpass_rx) = tokio::sync::mpsc::channel(8);
    let auth_ctx = Arc::new(AuthContext {
        askpass_helper_path,
        askpass_socket,
        askpass_tx,
        inbox: inbox.clone(),
    });

    let transport: Arc<dyn mdviewer_lib::ssh::transport::SshTransport> = {
        #[cfg(unix)]
        {
            // Unix transport stashes the AuthContext so each per-command
            // spawn can install SSH_ASKPASS + MDVIEWER_ASKPASS_SOCKET env
            // vars (Decision 5 — no silent agent-only degradation).
            Arc::new(mdviewer_lib::ssh::transport_unix::UnixTransport::with_auth_context(
                auth_ctx.clone(),
            ))
        }
        #[cfg(windows)]
        {
            // Windows bakes the resolved AuthStrategy into the transport
            // at construction: the russh auth callback uses the inbox +
            // mpsc sender to drive password prompts via the same flow.
            let strategy = mdviewer_lib::ssh::auth::probe(&auth_ctx);
            Arc::new(mdviewer_lib::ssh::transport_windows::WindowsTransport::new(
                strategy,
            ))
        }
    };

    let ops = Arc::new(Operations::new(transport, cache_base));
    Ok(SshAppState {
        ops,
        inbox,
        _auth_ctx: auth_ctx,
        #[cfg(unix)]
        _askpass_server: Mutex::new(askpass_server),
    })
}
