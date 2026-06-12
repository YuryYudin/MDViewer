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
use tauri::{Emitter, Manager, Runtime, State, WebviewWindow, WindowEvent};

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
    window: tauri::Window,
    app: tauri::AppHandle,
    state: State<'_, Ws>,
    watcher: State<'_, Mutex<mdviewer_lib::watcher::Watcher>>,
    path: PathBuf,
) -> Result<OpenOutcome, String> {
    let label = window.label().to_string();
    // D1 one-owner: if `path` is already open in a *different* window, focus
    // that window + activate its tab instead of duplicating the document into
    // the calling window. `owning_window_label` is the A1 resolution helper;
    // when it points at another live window we set_focus it and re-target the
    // open into that window so the existing tab is activated (not duplicated).
    let owner: Option<String> = {
        let ws = state.lock().map_err(|e| e.to_string())?;
        ws.owning_window_label(&path).map(|s| s.to_string())
    };
    let open_label = match &owner {
        Some(owner_label) if owner_label != &label => {
            if let Some(win) = app.get_webview_window(owner_label) {
                let _ = win.set_focus();
            }
            owner_label.clone()
        }
        _ => label.clone(),
    };
    let outcome = {
        let mut ws = state.lock().map_err(|e| e.to_string())?;
        let outcome = ws
            .open_document_for(&open_label, &path, OpenOpts::default())
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
        // B2: address the show-conflict event to the window that actually
        // shows the document — `open_label` is the calling window unless D1's
        // one-owner re-targeted the open into the window that already owns the
        // path. Workspace itself stays handle-free for testability.
        let _ = app.emit_to(
            open_label.as_str(),
            "show-conflict",
            serde_json::json!({
                "tab_id": tab_id,
                "path": path,
                "local": local,
                "incoming": incoming,
            }),
        );
    }
    // C1: a freshly-opened doc changes this window's active-doc-name, which is
    // the label shown in the Window submenu — rebuild so the menu reflects it.
    rebuild_menu(&app);
    Ok(outcome)
}

#[tauri::command]
fn close_tab(
    window: tauri::Window,
    app: tauri::AppHandle,
    state: State<'_, Ws>,
    id: String,
) -> Result<(), String> {
    // B2: window identity comes from the injected `tauri::Window`, never a
    // client argument. Close the tab within the calling window's scope.
    state
        .lock()
        .map_err(|e| e.to_string())?
        .close_tab_for(window.label(), &id)
        .map_err(|e| e.to_string())?;
    // C1: closing the active tab changes this window's active-doc-name (or
    // drops it to the StartPage placeholder); rebuild the Window submenu.
    rebuild_menu(&app);
    Ok(())
}

#[tauri::command]
fn activate_tab(
    window: tauri::Window,
    app: tauri::AppHandle,
    state: State<'_, Ws>,
    id: String,
) -> Result<(), String> {
    state
        .lock()
        .map_err(|e| e.to_string())?
        .activate_tab_for(window.label(), &id)
        .map_err(|e| e.to_string())?;
    // C1: the active tab is what the Window submenu names this window after.
    rebuild_menu(&app);
    Ok(())
}

#[tauri::command]
fn list_open_documents(window: tauri::Window, state: State<'_, Ws>) -> Vec<TabSummary> {
    // B2: each window sees only its own tab list, derived from the injected
    // window's label.
    state
        .lock()
        .unwrap()
        .list_open_documents_for(window.label())
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
fn get_active_tab_id(window: tauri::Window, state: State<'_, Ws>) -> Option<String> {
    state
        .lock()
        .ok()
        .and_then(|ws| ws.active_tab_id_for(window.label()).map(|s| s.to_string()))
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
async fn create_thread(
    state: State<'_, Ws>,
    watcher: State<'_, Mutex<Watcher>>,
    ssh: State<'_, SshAppState>,
    tab_id: String,
    anchor: Anchor,
    body: String,
) -> Result<Thread, String> {
    let (thread, bytes, sc_url) = {
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
        let (bytes, sc_url) = persist_sidecar(&ws, &watcher, &tab_id)?;
        (thread, bytes, sc_url)
    };
    push_sidecar_remote(&ssh, sc_url, bytes).await?;
    Ok(thread)
}

#[tauri::command]
async fn post_reply(
    state: State<'_, Ws>,
    watcher: State<'_, Mutex<Watcher>>,
    ssh: State<'_, SshAppState>,
    tab_id: String,
    thread_id: String,
    body: String,
) -> Result<(), String> {
    let (bytes, sc_url) = {
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
        persist_sidecar(&ws, &watcher, &tab_id)?
    };
    push_sidecar_remote(&ssh, sc_url, bytes).await
}

#[tauri::command]
async fn resolve_thread(
    state: State<'_, Ws>,
    watcher: State<'_, Mutex<Watcher>>,
    ssh: State<'_, SshAppState>,
    tab_id: String,
    thread_id: String,
) -> Result<(), String> {
    let (bytes, sc_url) = {
        let mut ws = state.lock().map_err(|e| e.to_string())?;
        let by = ws.settings_store().get().profile.display_name.clone();
        let store = ws.comments_for_mut(&tab_id).map_err(|e| e.to_string())?;
        store
            .resolve_thread(&thread_id, &by)
            .map_err(|e| e.to_string())?;
        persist_sidecar(&ws, &watcher, &tab_id)?
    };
    push_sidecar_remote(&ssh, sc_url, bytes).await
}

/// Drop a thread from the sidecar. Mirrors `resolve_thread`'s shape but
/// calls `delete_thread` on the store; the persisted sidecar is rewritten
/// so the deletion survives a restart and is visible to other tabs that
/// re-read the file. Wired to the orphan-list "Delete" button on the
/// frontend (`mdviewer:delete-thread` flow, wireframe 09).
#[tauri::command]
async fn delete_thread(
    state: State<'_, Ws>,
    watcher: State<'_, Mutex<Watcher>>,
    ssh: State<'_, SshAppState>,
    tab_id: String,
    thread_id: String,
) -> Result<(), String> {
    let (bytes, sc_url) = {
        let mut ws = state.lock().map_err(|e| e.to_string())?;
        let store = ws.comments_for_mut(&tab_id).map_err(|e| e.to_string())?;
        store
            .delete_thread(&thread_id)
            .map_err(|e| e.to_string())?;
        persist_sidecar(&ws, &watcher, &tab_id)?
    };
    push_sidecar_remote(&ssh, sc_url, bytes).await
}

/// After every comments-mutation IPC the in-memory CommentsStore is
/// authoritative — but to satisfy success-criterion 5 ("exchange via files
/// alone") the on-disk sidecar must follow. Compute the sidecar path from
/// the open tab and the active sidecar_pattern, write the v2 envelope, and
/// prime the watcher's self-write suppression so MDViewer doesn't surface
/// its own write as an external-change event.
///
/// Returns the bytes written plus — when the tab originated from
/// `open_ssh_url` — the remote sidecar `SshUrl` next to the remote document.
/// The caller drops the workspace lock and then `await`s the CRDT-merge push
/// to that URL (the local write above is the authoritative on-disk copy; the
/// remote push is what makes SSH comments travel with the document).
fn persist_sidecar(
    ws: &Workspace,
    watcher: &Mutex<Watcher>,
    tab_id: &str,
) -> Result<(Vec<u8>, Option<mdviewer_core::ssh_url::SshUrl>), String> {
    let tab = ws.tab(tab_id).ok_or_else(|| "no such tab".to_string())?;
    let pattern = ws.settings_store().get().comments.sidecar_pattern.clone();
    let sc = mdviewer_lib::sidecar::sidecar_path(&tab.path, &pattern);
    let store = ws.comments_for(tab_id).map_err(|e| e.to_string())?;
    let bytes = mdviewer_lib::sidecar::save_sidecar(&sc, store).map_err(|e| e.to_string())?;
    if let Ok(w) = watcher.lock() {
        w.record_self_write(&sc, mdviewer_lib::watcher::quick_hash(&bytes));
    }
    // SSH tabs are pinned to TabBackend::Local; `ssh_state` presence is the
    // marker that this tab came from a remote `ssh://` open (same discriminator
    // `save_document` uses). Compute the remote sidecar URL next to the doc.
    let sc_url = ws
        .ssh_state(tab_id)
        .map(|s| mdviewer_core::ssh_url::sidecar_url(&s.url, &pattern));
    Ok((bytes, sc_url))
}

/// Push a locally-persisted sidecar to its remote counterpart when the tab is
/// SSH-backed. No-op for local tabs. Awaited by the comment-mutation commands
/// after the workspace lock is dropped so the `MutexGuard` never crosses the
/// `.await` (Send bound on the Tauri worker future).
async fn push_sidecar_remote(
    ssh: &SshAppState,
    sc_url: Option<mdviewer_core::ssh_url::SshUrl>,
    bytes: Vec<u8>,
) -> Result<(), String> {
    if let Some(url) = sc_url {
        ssh.ops
            .save_sidecar(&url, &bytes)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn render_markdown(source: String, state: State<'_, Ws>) -> RenderResult {
    // Honor the user's editor render settings (matches the Workspace open
    // path). Previously this stand-alone command used RenderOptions::default(),
    // ignoring syntax_highlighting / mermaid_enabled / render_line_breaks — so
    // edit-mode live preview could render differently from the opened document.
    let s = state.lock().unwrap().settings_store().get();
    document::render_markdown(
        &source,
        &RenderOptions {
            syntax_highlighting: s.editor.syntax_highlighting,
            mermaid_enabled: s.editor.mermaid_enabled,
            render_line_breaks: s.editor.render_line_breaks,
        },
    )
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
async fn save_document(
    window: tauri::Window,
    state: State<'_, Ws>,
    watcher: State<'_, Mutex<Watcher>>,
    ssh: State<'_, SshAppState>,
    app: tauri::AppHandle,
    tab_id: String,
    body: String,
) -> Result<mdviewer_lib::document::SaveOutcome, String> {
    // B2: address conflict events to the window that asked to save.
    let window_label = window.label().to_string();
    use mdviewer_lib::document::SaveOutcome;
    use mdviewer_lib::drive::TabBackend;
    use mdviewer_lib::ssh::operations::SaveBackOutcome;
    use mdviewer_lib::workspace::{ConflictSource, SaveError};

    // Snapshot just the per-tab fields we need under a short critical
    // section, then drop the immutable borrow before re-entering Workspace
    // mutably. Avoids a mid-function lock upgrade.
    //
    // Phase-A impl-review fix: also snapshot ssh_state(tab_id) here. The
    // SSH branch below routes through Operations::save_back lock-free, so
    // we must read both the URL and the open-time hash before releasing
    // the lock — re-acquiring just to read them after the .await would
    // mean holding the std::sync::MutexGuard across the await point and
    // failing the Send bound for the Tauri worker future.
    let (tab_backend, tab_path, tab_etag, ssh_info) = {
        let ws = state.lock().map_err(|e| e.to_string())?;
        let tab = ws
            .tab(&tab_id)
            .ok_or_else(|| format!("tab not found: {tab_id}"))?;
        let backend = tab.backend;
        let path = tab.path.clone();
        let etag = tab.etag.clone();
        // ssh_state(&tab_id) is the discriminator for the SSH branch.
        // SSH tabs are pinned to TabBackend::Local (A8) so we can't use
        // tab.backend to detect them — only ssh_state's presence tells us
        // the tab originated from `open_ssh_url`.
        let ssh = ws.ssh_state(&tab_id).map(|s| (s.url.clone(), s.last_open_sha256));
        (backend, path, etag, ssh)
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
        let _ = app.emit_to(
            window_label.as_str(),
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

    // Phase-A impl-review fix: SSH branch must run BEFORE the existing
    // tab.backend match. SSH tabs are pinned to TabBackend::Local (A8), so
    // dispatching on backend alone silently hits the local-write path and
    // bypasses Operations::save_back entirely — the remote file never
    // updates and SshHashMismatch conflict detection is unreachable. The
    // ssh_state(&tab_id) check is the marker the integration tests
    // (`src-tauri/tests/ipc_registration.rs::ssh_save_dispatch`) pin on.
    if let Some((url, last_sha)) = ssh_info {
        // Lock-free .await — the workspace lock was dropped above so the
        // std::sync::MutexGuard doesn't cross the await point. This pushes the
        // document BODY; the comment sidecar is pushed separately on every
        // comment mutation (create/post/resolve/delete_thread →
        // push_sidecar_remote → Operations::save_sidecar) and pulled on open
        // (ssh_open_url → Operations::pull_sidecar).
        let outcome = ssh
            .ops
            .save_back(&url, body.as_bytes(), &last_sha)
            .await
            .map_err(|e| e.to_string())?;
        return match outcome {
            SaveBackOutcome::Saved { new_sha256 } => {
                // Re-acquire the lock briefly to advance the per-tab
                // open-time hash. The next save will diff against the bytes
                // we just pushed — without this update, every subsequent
                // save would re-flag the same successful push as a
                // conflict (the remote bytes now match new_sha256, not
                // last_sha).
                let mut ws = state.lock().map_err(|e| e.to_string())?;
                if let Some(s) = ws.ssh_state_mut(&tab_id) {
                    s.last_open_sha256 = new_sha256;
                }
                // Mirror the Local arm's tab-snapshot refresh so the
                // editor's dirty-bit clears and the cache mirror's source
                // string stays in sync with what was just pushed.
                if let Some(t) = ws.tab_mut(&tab_id) {
                    t.last_saved_snapshot = Some(body.clone());
                    t.source = body;
                }
                Ok(SaveOutcome::Ok { etag: None })
            }
            SaveBackOutcome::Conflict { local, remote } => {
                let source = ConflictSource::SshHashMismatch;
                emit_drive_conflict(&local, &remote, &source);
                Ok(SaveOutcome::Conflict {
                    local: String::from_utf8_lossy(&local).into_owned(),
                    remote: String::from_utf8_lossy(&remote).into_owned(),
                    drive_source: Some(source.to_wire().to_string()),
                })
            }
        };
    }

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
    window: tauri::Window,
    state: State<'_, Ws>,
    app: tauri::AppHandle,
    url: String,
) -> Result<TabSummary, String> {
    let label = window.label().to_string();
    let mut ws = state.lock().map_err(|e| e.to_string())?;
    // C5 kill-switch: short-circuit before parsing or hitting Drive so a
    // user who has explicitly opted out gets the same friendly error here
    // as they do on Connect. Mirrors the guard at the top of drive_connect.
    if drive_kill_switch_active(&ws.settings_store().get()) {
        return Err(DRIVE_KILL_SWITCH_MSG.to_string());
    }
    // B2: open the Drive tab in the calling window's scope.
    let summary = ws.drive_open_url_for(&label, &url).map_err(|e| e.to_string())?;
    drop(ws);
    // B2: address `workspace-changed` to the calling window so only its
    // tab strip / document body repaints. Broadcasting would force every
    // window to re-fetch its (unchanged) list.
    let _ = app.emit_to(label.as_str(), "workspace-changed", ());
    // C1: the new Drive tab is now this window's active doc — refresh the
    // Window submenu so its entry names the freshly-opened file.
    rebuild_menu(&app);
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
    window: tauri::Window,
    state: State<'_, Ws>,
    ssh: State<'_, SshAppState>,
    app: tauri::AppHandle,
    url: String,
) -> Result<mdviewer_lib::workspace::TabSummary, String> {
    let label = window.label().to_string();
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
    // Pull the remote comment sidecar (if any) into the cache mirror so the
    // opened tab shows comments saved next to the remote document — the
    // counterpart to the CRDT-merge push on comment mutations. Best-effort:
    // a sidecar fetch failure must not block opening the document itself
    // (the body already fetched successfully above).
    {
        let pattern = state
            .lock()
            .map_err(|e| e.to_string())?
            .settings_store()
            .get()
            .comments
            .sidecar_pattern
            .clone();
        let sc_url = mdviewer_core::ssh_url::sidecar_url(&parsed, &pattern);
        let cache_sc = mdviewer_lib::sidecar::sidecar_path(&outcome.cache_path, &pattern);
        if let Err(e) = ssh.ops.pull_sidecar(&sc_url, &cache_sc).await {
            tracing::warn!("remote sidecar pull failed for {sc_url}: {e}");
        }
    }
    // Sync registration: re-acquire the lock and stash the tab in the
    // calling window's scope.
    let summary = {
        let mut ws = state.lock().map_err(|e| e.to_string())?;
        ws.register_ssh_tab_from_outcome_for(&label, parsed, outcome)
    };
    // B2: address the frontend nudge to the calling window so only its tab
    // strip + active document repaint once the new tab lands.
    let _ = app.emit_to(label.as_str(), "workspace-changed", ());
    // C1: the new SSH tab is now this window's active doc — refresh the
    // Window submenu so its entry names the freshly-opened file.
    rebuild_menu(&app);
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

/// B1 wire DTO: a flat camelCase shape for one directory entry returned by
/// `ssh_list_dir`. The OpenRemoteDialog (B2) renders these directly into the
/// file-picker tree — name + is-dir flag (folder icon) + size (badge). The
/// underlying `mdviewer_lib::ssh::transport::DirEntry` is intentionally NOT
/// re-used at the IPC boundary: the dialog wants `isDir` (camelCase), and
/// the snake_case raw struct would force every renderer site to re-key.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DirEntryWire {
    name: String,
    is_dir: bool,
    size: u64,
}

/// B1: list a remote directory for the OpenRemoteDialog's tree view.
///
/// Parses the URL with the canonical core parser, calls
/// `Operations::list_dir`, and flattens each `DirEntry` into the camelCase
/// wire DTO. Transport errors propagate as their `Display` text — the
/// dialog's state-C surface renders that verbatim (Permission denied,
/// Host key has changed, etc.) per wireframe-02.
///
/// Pattern matches `ssh_open_url` in this file: parse → IO → return.
/// Holds no workspace lock; the underlying transport may take seconds
/// over a flaky link.
#[tauri::command]
async fn ssh_list_dir(
    ssh: State<'_, SshAppState>,
    url: String,
) -> Result<Vec<DirEntryWire>, String> {
    let parsed = mdviewer_core::ssh_url::parse(&url).map_err(|e| e.to_string())?;
    let entries = ssh
        .ops
        .list_dir(&parsed)
        .await
        .map_err(|e| e.to_string())?;
    Ok(entries
        .into_iter()
        .map(|e| DirEntryWire {
            name: e.name,
            is_dir: e.is_dir,
            size: e.size,
        })
        .collect())
}

/// E2: choose the window a CLI / file-association target should open into.
///
/// Pure decision over `(focused, owner)`:
/// * `owner` — the label of the window that *already* owns this document
///   (from a CANONICALIZED `owning_window_label` lookup), if any. One-owner
///   wins: re-route into the existing owner so the target is focused +
///   activated in place rather than duplicated into a second window.
/// * `focused` — the most-recently-focused window's label (resolved by the
///   caller from `focused_window(app)` / `mrf_label()`); the default landing
///   site for a not-yet-open document.
///
/// Factored out of `dispatch_cli_targets` so the routing rule is unit-tested
/// without a live Tauri runtime (the lock/window-raise plumbing around it is
/// framework-adjacent and covered by the source-smoke + e2e gates).
fn route_target_label(focused: &str, owner: Option<&str>) -> String {
    match owner {
        Some(owner_label) => owner_label.to_string(),
        None => focused.to_string(),
    }
}

/// F1: the action a single Local target takes when `mdviewer -w <path>` spawns
/// a fresh window `new_label`. One-owner is honored with a CANONICALIZED
/// lookup, so an already-open document is never duplicated into the new
/// window:
///
/// * `Relocate { tab_id }` — the path is already open in some OTHER window;
///   the existing tab is MOVED (via `Workspace::move_tab`) into `new_label`
///   rather than re-opened. This is the never-duplicate guarantee.
/// * `Open` — the path is not open anywhere yet (or the only place it's open
///   is the freshly-spawned `new_label` itself, which can't happen on a first
///   spawn but is treated as a no-relocate so a re-dispatch stays idempotent);
///   open it fresh into `new_label`.
///
/// Pure over `(resolution, new_label)` — `resolution` is the output of
/// `Workspace::open_in_new_window_resolve(canonical_path)`, which already does
/// the canonicalized one-owner lookup — so the relocate-vs-open rule is
/// unit-tested without a live Tauri runtime.
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
        // Already open elsewhere → relocate the existing tab into the new
        // window (never duplicate). If it's somehow already owned by the
        // new window, opening fresh is a no-op-equivalent and avoids a
        // self-move, so fall through to `Open`.
        OneOwnerResolution::Existing { label, tab_id } if label != new_label => {
            NewWindowTargetAction::Relocate {
                tab_id: tab_id.clone(),
            }
        }
        _ => NewWindowTargetAction::Open,
    }
}

/// F1: running-app dispatch for `mdviewer -w [targets]` — SPAWN a fresh window
/// and route every target into it, raising it. Honors one-owner with a
/// canonicalized lookup: a target already open in another window is RELOCATED
/// into the new window (via `Workspace::move_tab`), never duplicated. With zero
/// targets the new window opens on an empty StartPage (`mdviewer -w`).
///
/// Reuses E2's `spawn_window` + the C1 `Workspace::new_window` registration +
/// `register_window_event_handler` lifecycle wiring (same shape as the
/// `open_in_new_window` IPC command), so the new window renders / persists
/// geometry / guards dirty-close exactly like every other spawned window.
///
/// SSH targets follow `dispatch_cli_targets`'s deferred-async pattern: the
/// fetch happens off the event loop, then the tab is registered into the
/// already-spawned new window. The relocate path is Local-only — an SSH URL
/// isn't path-canonicalizable the same way, and SSH tabs are cheap to re-fetch.
fn dispatch_cli_targets_new_window(
    app: tauri::AppHandle,
    targets: Vec<cli::OpenTarget>,
    source_label: &'static str,
) {
    // Spawn the fresh window up front (mirrors `new_window` / `open_in_new_window`
    // label scheme) so every target — relocated or freshly opened — lands in it.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let new_label = format!("win-{nanos}");
    let new_win = match spawn_window(&app, &new_label) {
        Ok(w) => w,
        Err(e) => {
            tracing::warn!("{source_label} -w: spawn_window failed: {e:?}");
            return;
        }
    };

    let mut deferred_ssh: Vec<mdviewer_core::ssh_url::SshUrl> = Vec::new();
    let ws_state = app.state::<Mutex<Workspace>>();
    if let Ok(mut ws) = ws_state.lock() {
        // Register the new window before opening / relocating any tab into it.
        ws.new_window(new_label.clone());
        for target in targets {
            match target {
                cli::OpenTarget::Local(path) => {
                    // `open_in_new_window_resolve` does the canonicalized
                    // one-owner lookup; `new_window_target_action` turns its
                    // result into relocate-vs-open against the new window.
                    let resolution = ws.open_in_new_window_resolve(&path);
                    match new_window_target_action(&resolution, &new_label) {
                        NewWindowTargetAction::Relocate { tab_id } => {
                            match ws.move_tab(&tab_id, &new_label) {
                                Ok(from) => tracing::info!(
                                    "{source_label} -w relocated {} from {} into {}",
                                    path.display(),
                                    from,
                                    new_label
                                ),
                                Err(e) => tracing::warn!(
                                    "{source_label} -w relocate failed for {}: {e:?}",
                                    path.display()
                                ),
                            }
                        }
                        NewWindowTargetAction::Open => {
                            match ws.open_document_for(&new_label, &path, OpenOpts::default()) {
                                Ok(_) => tracing::info!(
                                    "{source_label} -w opened {} into {}",
                                    path.display(),
                                    new_label
                                ),
                                Err(e) => tracing::warn!(
                                    "{source_label} -w open failed for {}: {e:?}",
                                    path.display()
                                ),
                            }
                        }
                    }
                }
                cli::OpenTarget::Ssh(url) => deferred_ssh.push(url),
            }
        }
    }

    // Track lifecycle on the new window (geometry / focus / dirty-close guard)
    // just like `new_window` / the restore loop, refresh its tab strip + the
    // Window submenu, then bring it forward.
    register_window_event_handler(&app, &new_win);
    let _ = app.emit_to(new_label.as_str(), "workspace-changed", ());
    rebuild_menu(&app);
    let _ = new_win.set_focus();

    // SSH targets. Mirror the Local one-owner RELOCATE so `mdviewer -w ssh://...`
    // on an ALREADY-OPEN remote doc moves that tab into the freshly-spawned
    // window instead of leaving it in its original one (the cache-path de-dupe
    // in `register_ssh_tab_from_outcome_for` only collapses duplicates — it
    // never reassigns window_label). The SSH cache path is deterministic for a
    // (host, port, user, path) tuple, so we can predict where the URL WOULD
    // land via `cache_path_for_url` WITHOUT a fetch, then run the same
    // `open_in_new_window_resolve` → `new_window_target_action` one-owner
    // decision the Local branch uses. Only the fetch+register fallback is
    // deferred to an async task; the relocate is a synchronous move under the
    // workspace lock (no network IO).
    for url in deferred_ssh {
        let url_label = url.to_string();
        // Predict the cache path and check one-owner BEFORE any fetch.
        let relocated = {
            let ssh_state = app.state::<SshAppState>();
            let cache_path =
                mdviewer_lib::ssh::operations::cache_path_for_url(ssh_state.ops.cache_base(), &url);
            let ws_state = app.state::<Mutex<Workspace>>();
            let did_relocate = match ws_state.lock() {
                Ok(mut ws) => {
                    let resolution = ws.open_in_new_window_resolve(&cache_path);
                    match new_window_target_action(&resolution, &new_label) {
                        NewWindowTargetAction::Relocate { tab_id } => {
                            match ws.move_tab(&tab_id, &new_label) {
                                Ok(from) => {
                                    tracing::info!(
                                        "{source_label} -w relocated SSH {url_label} from {from} into {new_label}"
                                    );
                                }
                                Err(e) => tracing::warn!(
                                    "{source_label} -w SSH relocate failed for {url_label}: {e:?}"
                                ),
                            }
                            true
                        }
                        NewWindowTargetAction::Open => false,
                    }
                }
                Err(_) => false,
            };
            did_relocate
        };
        if relocated {
            // Already-open tab moved into the new window — repaint + raise, no
            // fetch needed. (The new window was already focused above; a fresh
            // workspace-changed makes its tab strip pick up the moved tab.)
            let _ = app.emit_to(new_label.as_str(), "workspace-changed", ());
            continue;
        }
        // Not open anywhere (or already in the new window): fetch off the event
        // loop, then register into the new window — the original behavior.
        let app_handle = app.clone();
        let landing = new_label.clone();
        tauri::async_runtime::spawn(async move {
            let ssh_state = app_handle.state::<SshAppState>();
            let outcome = match ssh_state.ops.open_url(&url).await {
                Ok(o) => o,
                Err(e) => {
                    tracing::warn!("{source_label} -w SSH open failed for {url_label}: {e:?}");
                    return;
                }
            };
            let ws_state = app_handle.state::<Mutex<Workspace>>();
            if let Ok(mut ws) = ws_state.lock() {
                let _ = ws.register_ssh_tab_from_outcome_for(&landing, url, outcome);
                tracing::info!("{source_label} -w opened SSH {url_label} into {landing}");
            }
            if let Some(win) = app_handle.get_webview_window(&landing) {
                let _ = win.set_focus();
            }
            let _ = app_handle.emit_to(landing.as_str(), "workspace-changed", ());
        });
    }
}

/// F1: route a parsed CLI invocation to the right running-app dispatch.
///
/// * `new_window` set (`mdviewer -w [...]`) → spawn a fresh window and route
///   the targets into it (relocating already-open targets), even when the
///   target list is empty (one empty StartPage window).
/// * `new_window` clear (the default) → E2's focused-window routing; a target
///   list is required, so an empty list is a no-op (nothing to open, no window
///   to spawn).
///
/// Single funnel so every running-app entry point (single-instance callback,
/// e2e side-channel listener) honors the flag identically.
fn dispatch_parsed_cli(
    app: tauri::AppHandle,
    parsed: cli::ParsedArgs,
    source_label: &'static str,
) {
    if parsed.new_window {
        dispatch_cli_targets_new_window(app, parsed.targets, source_label);
    } else if !parsed.targets.is_empty() {
        dispatch_cli_targets(app, parsed.targets, source_label);
    }
}

/// Dispatch a heterogeneous list of CLI targets onto the workspace. Used by
/// (a) the single-instance plugin callback and (b) macOS's
/// `RunEvent::Opened` hook — both sync contexts that may receive a mix of
/// `Local` paths and `Ssh` URLs.
///
/// E2: the running-app dispatch routes targets into the MOST-RECENTLY-FOCUSED
/// window (the one the user is actually looking at) and raises it, rather than
/// always landing them in `main`. One-owner is honored: a target already open
/// in some window focuses that window + activates its tab instead of
/// duplicating. The owner lookup canonicalizes the path first — `open_document`
/// stores canonical paths but `owning_window_label` compares raw, so the
/// phase-D caveat (raw-vs-canonical mismatch) is avoided by canonicalizing
/// before the check, matching `open_in_new_window_resolve`.
///
/// Local targets open through `Workspace::open_document_for(<routed label>)`
/// under a brief workspace lock; SSH targets spawn an async task that fetches
/// via `Operations::open_url` lock-free, then re-acquires the lock to register
/// the tab into the routed window. The two paths are independent: an SSH fetch
/// failure for one URL doesn't block another URL from succeeding.
fn dispatch_cli_targets(
    app: tauri::AppHandle,
    targets: Vec<cli::OpenTarget>,
    source_label: &'static str,
) {
    // Resolve the landing window once: the focused window, falling back to the
    // workspace's most-recently-focused label (and finally any live window).
    // This is the default site for not-yet-open targets; one-owner re-routes
    // per-target below.
    let focused_label = focused_window(&app)
        .map(|w| w.label().to_string())
        .unwrap_or_else(|| mdviewer_lib::workspace::MAIN_LABEL.to_string());

    // First pass: open Local tabs synchronously under a single workspace
    // lock acquisition. We deliberately don't .await inside this scope.
    // Collect the set of windows we routed into so we can raise them after
    // dropping the lock.
    let mut deferred_ssh: Vec<mdviewer_core::ssh_url::SshUrl> = Vec::new();
    let mut raise_labels: Vec<String> = Vec::new();
    let ws_state = app.state::<Mutex<Workspace>>();
    if let Ok(mut ws) = ws_state.lock() {
        for target in targets {
            match target {
                cli::OpenTarget::Local(path) => {
                    // One-owner: canonicalize first (open_document stores
                    // canonical, owning_window_label compares raw) so an
                    // already-open doc resolves to its owning window instead
                    // of a spurious miss → duplicate.
                    let canonical =
                        path.canonicalize().unwrap_or_else(|_| path.clone());
                    let owner = ws.owning_window_label(&canonical).map(|s| s.to_string());
                    let open_label = route_target_label(&focused_label, owner.as_deref());
                    match ws.open_document_for(&open_label, &path, OpenOpts::default()) {
                        Ok(_) => {
                            tracing::info!(
                                "opened from {} into {}: {}",
                                source_label,
                                open_label,
                                path.display()
                            );
                            if !raise_labels.contains(&open_label) {
                                raise_labels.push(open_label);
                            }
                        }
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

    // Raise + repaint the windows we routed Local targets into. Raising brings
    // the focused (or one-owner) window forward so the user sees the new tab.
    for label in &raise_labels {
        if let Some(win) = app.get_webview_window(label) {
            let _ = win.set_focus();
        }
        let _ = app.emit_to(label.as_str(), "workspace-changed", ());
    }

    // Second pass: each SSH target spawns a Tauri-runtime task so the
    // synchronous caller (the single-instance plugin callback, the
    // RunEvent::Opened branch) returns immediately and the async fetch
    // happens off the event loop.
    for url in deferred_ssh {
        let app_handle = app.clone();
        let landing = focused_label.clone();
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
                // E2: register the SSH tab into the focused window (matching
                // the Local-target routing) instead of always `main`.
                let _ = ws.register_ssh_tab_from_outcome_for(&landing, url, outcome);
                tracing::info!(
                    "opened SSH from {} into {}: {}",
                    source_label,
                    landing,
                    url_label
                );
            }
            // E2: raise + repaint the focused window the tab landed in.
            if let Some(win) = app_handle.get_webview_window(&landing) {
                let _ = win.set_focus();
            }
            let _ = app_handle.emit_to(landing.as_str(), "workspace-changed", ());
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

// ----------------------------------------------------------------------------
// B2: multi-window helpers.
//
// These three functions carry the only non-framework logic the window-scoping
// rewrite adds, so they live as free functions that `main.rs`'s setup/event
// wiring calls. `window_has_dirty_tab` and `restore_window_label` are pure and
// unit-tested in `tests/ipc_registration.rs`; `focused_window` and
// `spawn_window` touch the live Tauri window list and are exercised by the
// e2e suite (S5/S7) since they need a real runtime.
// ----------------------------------------------------------------------------

/// B2: does any tab owned by window `label` have unsaved edits?
///
/// Pure over the `(workspace tabs, dirty predicate)` pair so it unit-tests
/// without a live `Watcher`/`AppHandle`. `dirty_for` is the per-path dirty
/// lookup — production passes `|p| watcher.is_unsaved(p)` (the same `unsaved`
/// map `set_dirty` writes); tests pass an in-memory closure. The window's tab
/// set comes from `list_open_documents_for(label)` so a tab moved to another
/// window no longer counts against this one.
fn window_has_dirty_tab(ws: &Workspace, label: &str, dirty_for: impl Fn(&Path) -> bool) -> bool {
    ws.list_open_documents_for(label)
        .iter()
        .any(|t| dirty_for(&t.path))
}

/// B2: the stable label for the `index`-th restored window. The first window
/// reuses the always-present `"main"` label so the v1→v2 migration target and
/// the single-window delegating wrappers keep a known window; every later
/// window gets a unique `win-{nanos+index}` label. `index` is folded into the
/// suffix so two windows restored inside the same nanosecond still differ.
fn restore_window_label(index: usize, nanos: u128) -> String {
    if index == 0 {
        mdviewer_lib::workspace::MAIN_LABEL.to_string()
    } else {
        format!("win-{}", nanos + index as u128)
    }
}

/// B2: the currently-focused webview window, falling back to the workspace's
/// most-recently-focused label (`mrf_label`) when the OS reports none focused
/// (e.g. the app is backgrounded). Used by the menu-action emit so a menu
/// click routes to the window the user is actually looking at instead of
/// broadcasting to every window. Returns `None` only if neither a focused
/// window nor the mrf label resolves to a live window.
fn focused_window<R: Runtime>(app: &impl Manager<R>) -> Option<WebviewWindow<R>> {
    let windows = app.webview_windows();
    if let Some((_, w)) = windows.iter().find(|(_, w)| w.is_focused().unwrap_or(false)) {
        return Some(w.clone());
    }
    // Fallback: the workspace's most-recently-focused label.
    let mrf = app
        .try_state::<Ws>()
        .and_then(|ws| ws.lock().ok().map(|g| g.mrf_label().to_string()));
    if let Some(label) = mrf {
        if let Some(w) = windows.get(&label) {
            return Some(w.clone());
        }
    }
    // Last resort: any window (registry order isn't guaranteed, but a single
    // arbitrary window beats dropping the menu action on the floor).
    windows.into_values().next()
}

/// B2: spawn a fresh webview window with `label`, pointing at the same entry
/// URL the main window uses (the default app index). Returns the live window
/// so the restore loop can apply geometry to it.
fn spawn_window(app: &tauri::AppHandle, label: &str) -> tauri::Result<WebviewWindow> {
    tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::default())
        .title("MDViewer")
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .build()
}

/// C1: rebuild the application menu from the current window registry and
/// re-apply it via `set_menu`. The app menu is set once at boot, so a stale
/// Window submenu would linger after a spawn / close / active-doc-rename
/// unless we re-apply — this is the single re-apply path every registry
/// change funnels through. Best-effort: a missing workspace (shouldn't happen
/// post-setup) falls back to an empty window list, and a `set_menu` failure
/// is logged rather than fatal.
fn rebuild_menu(app: &tauri::AppHandle) {
    let windows = app
        .try_state::<Ws>()
        .and_then(|ws| ws.lock().ok().map(|g| g.list_windows()))
        .unwrap_or_default();
    match menu::build(app, &windows) {
        Ok(m) => {
            if let Err(e) = app.set_menu(m) {
                tracing::warn!("rebuild_menu: set_menu failed: {e:?}");
            }
        }
        Err(e) => tracing::warn!("rebuild_menu: menu::build failed: {e:?}"),
    }
}

/// C1: spawn a fresh StartPage window via the `new_window` IPC command.
///
/// Self-contained per the C1 task brief: it reuses B2's `spawn_window` (so the
/// StartPage renders identically to the main window), registers the new label
/// with the workspace via A1's `Workspace::new_window`, rebuilds the Window
/// submenu so the new window appears in it immediately, and focuses the fresh
/// window. The frontend reaches this via `mdviewer:new-window` → raw
/// `invoke('new_window')` (C2). D1 adds the typed binding + the OTHER window
/// commands and must NOT re-register `new_window`.
#[tauri::command]
fn new_window(app: tauri::AppHandle, state: State<'_, Ws>) -> Result<(), String> {
    // Unique label so two rapid clicks don't collide. Mirrors the restore
    // loop's `win-{nanos}` scheme.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let label = format!("win-{nanos}");
    let window = spawn_window(&app, &label).map_err(|e| e.to_string())?;
    {
        let mut ws = state.lock().map_err(|e| e.to_string())?;
        ws.new_window(label.clone());
    }
    // Track lifecycle (geometry / focus / dirty-close guard) on the new window
    // just like the restore loop does for spawned windows.
    register_window_event_handler(&app, &window);
    // C1: the registry changed — re-apply the menu so the new window's
    // entry appears in the Window submenu.
    rebuild_menu(&app);
    // Bring the fresh StartPage window forward.
    let _ = window.set_focus();
    Ok(())
}

/// G2 (e2e only): spawn a fresh window with the EXACT caller-supplied label.
///
/// Mirrors the production `new_window` command but takes the label as an
/// argument instead of generating `win-{nanos}`, so the multi-window e2e
/// helpers can address a window by a known, stable label
/// (`switchToWindow(label)` keys on it). Reuses the same `spawn_window` +
/// `Workspace::new_window` + `register_window_event_handler` + `rebuild_menu`
/// + `set_focus` lifecycle as `new_window`.
///
/// Gated on `--features e2e` and registered only under the same cfg in the
/// invoke handler, so production (non-e2e) builds neither compile nor expose
/// this command — the only window-spawning IPC they ship is `new_window`.
#[cfg(feature = "e2e")]
#[tauri::command]
fn e2e_create_window(app: tauri::AppHandle, state: State<'_, Ws>, label: String) -> Result<(), String> {
    let window = spawn_window(&app, &label).map_err(|e| e.to_string())?;
    {
        let mut ws = state.lock().map_err(|e| e.to_string())?;
        ws.new_window(label.clone());
    }
    register_window_event_handler(&app, &window);
    rebuild_menu(&app);
    let _ = window.set_focus();
    Ok(())
}

/// D1: project the workspace's pure per-window summaries onto the IPC wire
/// shape, filling each `focused` flag from the live Tauri window list. Pure
/// over `(summaries, focused_label)` so it unit-tests without an `AppHandle`;
/// `list_windows` passes the OS-reported focused label.
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

/// D1: enumerate every registered window as a wire-shaped `WindowSummary`. The
/// pure per-window fields come from `Workspace::list_windows`; the `focused`
/// flag is filled from the live Tauri window list (the OS-reported focused
/// window), which the pure core can't see. No window-set mutation here, so no
/// `rebuild_menu`.
#[tauri::command]
fn list_windows(app: tauri::AppHandle, state: State<'_, Ws>) -> Vec<mdviewer_lib::workspace::WindowSummary> {
    let summaries = state
        .lock()
        .map(|ws| ws.list_windows())
        .unwrap_or_default();
    let focused_label = app
        .webview_windows()
        .iter()
        .find(|(_, w)| w.is_focused().unwrap_or(false))
        .map(|(label, _)| label.clone());
    window_summaries_with_focus(summaries, focused_label.as_deref())
}

/// D1: close the window identified by the injected `tauri::Window` — drop all
/// of its tabs from the workspace registry, then close the native window. The
/// window-set shrinks, so rebuild the Window submenu afterward. Identity comes
/// from the injected window arg, never a client argument (per
/// contracts/02-ipc-window-commands.md).
#[tauri::command]
fn close_window(
    window: tauri::Window,
    app: tauri::AppHandle,
    state: State<'_, Ws>,
) -> Result<(), String> {
    let label = window.label().to_string();
    state.lock().map_err(|e| e.to_string())?.close_window(&label);
    // Close the native window (best-effort — the registry entry is already
    // gone, so a failed OS close just leaves an empty shell).
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.close();
    }
    // The registry shrank — re-apply the menu so the Window submenu drops the
    // closed window's entry.
    rebuild_menu(&app);
    Ok(())
}

/// D1: open `path` in a new window, honoring the one-owner invariant. If the
/// path is already open in any window, focus that window + activate its tab
/// (no duplicate). Otherwise spawn a fresh window and open the document there.
/// Window identity for the new window is derived (a `win-{nanos}` label),
/// never client-supplied. The window set may grow, so rebuild the menu.
#[tauri::command]
fn open_in_new_window(
    app: tauri::AppHandle,
    state: State<'_, Ws>,
    watcher: State<'_, Mutex<mdviewer_lib::watcher::Watcher>>,
    path: PathBuf,
) -> Result<(), String> {
    use mdviewer_lib::workspace::OneOwnerResolution;
    // One-owner resolution: already open → focus the existing window+tab.
    let resolution = {
        let mut ws = state.lock().map_err(|e| e.to_string())?;
        ws.open_in_new_window_resolve(&path)
    };
    match resolution {
        OneOwnerResolution::Existing { label, tab_id } => {
            {
                let mut ws = state.lock().map_err(|e| e.to_string())?;
                ws.activate_tab_for(&label, &tab_id)
                    .map_err(|e| e.to_string())?;
            }
            if let Some(win) = app.get_webview_window(&label) {
                let _ = win.set_focus();
            }
            // Active-doc-name may have changed on the focused window.
            rebuild_menu(&app);
            Ok(())
        }
        OneOwnerResolution::NeedsNew => {
            // Spawn a fresh window (mirrors `new_window`'s label scheme), open
            // the document into it, register lifecycle, and focus it.
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let label = format!("win-{nanos}");
            let new_win = spawn_window(&app, &label).map_err(|e| e.to_string())?;
            {
                let mut ws = state.lock().map_err(|e| e.to_string())?;
                ws.new_window(label.clone());
                ws.open_document_for(&label, &path, OpenOpts::default())
                    .map_err(|e| e.to_string())?;
                // Register the .md + sidecar with the watcher, mirroring
                // open_document so external changes surface for the new window.
                let pattern = ws.settings_store().get().comments.sidecar_pattern.clone();
                if let Ok(mut w) = watcher.lock() {
                    let _ = w.watch_md(&path);
                    let _ = w.watch_sidecar(&mdviewer_lib::sidecar::sidecar_path(&path, &pattern));
                    w.mark_unsaved(&path, false);
                }
            }
            register_window_event_handler(&app, &new_win);
            // The new window now owns the doc — refresh its tab strip + the
            // Window submenu, then bring it forward.
            let _ = app.emit_to(label.as_str(), "workspace-changed", ());
            rebuild_menu(&app);
            let _ = new_win.set_focus();
            Ok(())
        }
    }
}

/// D1: move tab `tab_id` into the window `to_window`. `to_window` is the ONE
/// explicit client-supplied label in the window IPC surface (per
/// contracts/02-ipc-window-commands.md) — the source window is derived from
/// the tab's current owner inside `Workspace::move_tab`. Both source and
/// destination active-doc-names can change, so rebuild the Window submenu and
/// nudge both windows to repaint their tab strips.
#[tauri::command]
fn move_tab(
    app: tauri::AppHandle,
    state: State<'_, Ws>,
    tab_id: String,
    to_window: String,
) -> Result<(), String> {
    let from = state
        .lock()
        .map_err(|e| e.to_string())?
        .move_tab(&tab_id, &to_window)
        .map_err(|e| e.to_string())?;
    // Repaint the destination's tab strip (and focus it forward).
    let _ = app.emit_to(to_window.as_str(), "workspace-changed", ());
    // Repaint the SOURCE window too — its tab strip lost the moved tab and the
    // frontend deliberately doesn't locally repaint on a successful move
    // (design S4). Guard against a redundant double-emit on a same-window move.
    if from != to_window {
        let _ = app.emit_to(from.as_str(), "workspace-changed", ());
    }
    if let Some(win) = app.get_webview_window(&to_window) {
        let _ = win.set_focus();
    }
    // The tab moved between windows — both windows' active-doc-names may have
    // changed, so re-apply the menu.
    rebuild_menu(&app);
    Ok(())
}

/// G1: detach tab `tab_id` into a brand-new window (the drag-off-the-strip
/// gesture, S10). Mints a derived `win-{nanos}` label (never client-supplied,
/// mirroring `new_window` / `open_in_new_window`), spawns the native window,
/// registers its lifecycle, then relocates the tab into it via
/// `Workspace::detach_tab` (spawn-less: it registers the window in the
/// registry and `move_tab`s the tab in).
///
/// Same lesson as the `move_tab` handler fix (S4): the tab leaves its source
/// window, so we must repaint BOTH windows. `Workspace::detach_tab` returns the
/// NEW window's summary, not the source label, so we capture the source via
/// `owning_window_label` BEFORE detaching, then emit `workspace-changed` to the
/// source AND the new window, rebuild the Window submenu (the window set grew),
/// and focus the new window forward.
#[tauri::command]
fn detach_tab(
    app: tauri::AppHandle,
    state: State<'_, Ws>,
    tab_id: String,
) -> Result<(), String> {
    // Derive the new window label up front (matches new_window / open_in_new_window).
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let label = format!("win-{nanos}");

    // Capture the SOURCE window the tab currently lives in BEFORE the move —
    // detach_tab returns the new window's summary, not the source. We need the
    // source label to repaint the strip the tab leaves (S4 dual-emit lesson).
    let source = {
        let ws = state.lock().map_err(|e| e.to_string())?;
        match ws.window_label_for_tab(&tab_id) {
            Some(s) => s.to_string(),
            None => return Err(format!("no such tab: {tab_id}")),
        }
    };

    // Spawn the fresh window + register its lifecycle before mutating the
    // registry, mirroring open_in_new_window's ordering.
    let new_win = spawn_window(&app, &label).map_err(|e| e.to_string())?;
    {
        let mut ws = state.lock().map_err(|e| e.to_string())?;
        ws.detach_tab(&tab_id, label.clone())
            .map_err(|e| e.to_string())?;
    }
    register_window_event_handler(&app, &new_win);

    // Repaint the NEW window (gained the tab) AND the SOURCE window (lost it).
    let _ = app.emit_to(label.as_str(), "workspace-changed", ());
    if source != label {
        let _ = app.emit_to(source.as_str(), "workspace-changed", ());
    }
    // The window set grew + both windows' active-doc-names may have changed.
    rebuild_menu(&app);
    // Bring the freshly-detached window forward.
    let _ = new_win.set_focus();
    Ok(())
}

/// B2: compute the virtual-screen bounds (union work area) from the live
/// monitor list so `clamp_geometry` can pull an off-screen restored window
/// back onto a reachable display. Falls back to a single 1920x1080 origin
/// rect when the monitor list is empty/unavailable (headless CI), which keeps
/// restore best-effort rather than panicking.
fn virtual_screen_bounds(app: &tauri::AppHandle) -> mdviewer_lib::session::VirtualScreenBounds {
    use mdviewer_lib::session::VirtualScreenBounds;
    let monitors = app.available_monitors().unwrap_or_default();
    if monitors.is_empty() {
        return VirtualScreenBounds { x: 0, y: 0, w: 1920, h: 1080 };
    }
    // Union every monitor's logical work rect. Positions are physical px;
    // divide by scale factor to match the logical px geometry persisted in
    // session.json.
    let mut min_x = i32::MAX;
    let mut min_y = i32::MAX;
    let mut max_x = i32::MIN;
    let mut max_y = i32::MIN;
    for m in &monitors {
        let scale = m.scale_factor();
        let pos = m.position();
        let size = m.size();
        let lx = (pos.x as f64 / scale).round() as i32;
        let ly = (pos.y as f64 / scale).round() as i32;
        let lw = (size.width as f64 / scale).round() as i32;
        let lh = (size.height as f64 / scale).round() as i32;
        min_x = min_x.min(lx);
        min_y = min_y.min(ly);
        max_x = max_x.max(lx + lw);
        max_y = max_y.max(ly + lh);
    }
    VirtualScreenBounds {
        x: min_x,
        y: min_y,
        w: (max_x - min_x).max(1) as u32,
        h: (max_y - min_y).max(1) as u32,
    }
}

/// B2: register the per-window lifecycle handler (geometry tracking, focus
/// tracking, dirty-tab close guard) on `window`. Called for the main window
/// and every spawned restore window so all windows behave identically. The
/// `app` handle is captured so the close-request branch can address
/// `confirm-window-close` back to the window and read the managed Workspace +
/// Watcher.
fn register_window_event_handler(app: &tauri::AppHandle, window: &WebviewWindow) {
    let label = window.label().to_string();
    let app = app.clone();
    window.clone().on_window_event(move |event| match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            // Read the window's live logical position + size and feed it into
            // the workspace's per-window geometry, then eagerly persist so a
            // crash doesn't lose the new placement. Best-effort throughout —
            // a failed read just skips this tick.
            if let Some(w) = app.get_webview_window(&label) {
                let scale = w.scale_factor().unwrap_or(1.0);
                if let (Ok(pos), Ok(size)) = (w.outer_position(), w.inner_size()) {
                    let geo = mdviewer_lib::workspace::WindowGeometry {
                        x: (pos.x as f64 / scale).round() as i32,
                        y: (pos.y as f64 / scale).round() as i32,
                        w: (size.width as f64 / scale).round() as u32,
                        h: (size.height as f64 / scale).round() as u32,
                    };
                    if let Some(ws) = app.try_state::<Ws>() {
                        if let Ok(mut g) = ws.lock() {
                            g.set_window_geometry(&label, geo);
                            g.persist_session_public();
                        }
                    }
                }
            }
        }
        WindowEvent::Focused(true) => {
            if let Some(ws) = app.try_state::<Ws>() {
                if let Ok(mut g) = ws.lock() {
                    g.set_mrf_label(&label);
                }
            }
        }
        WindowEvent::CloseRequested { api, .. } => {
            // Guard: if any tab in this window is dirty, prevent the OS
            // titlebar close and let the frontend (C2) run the confirm flow.
            let dirty = {
                let ws = app.try_state::<Ws>();
                let watcher = app.try_state::<Mutex<Watcher>>();
                match (ws, watcher) {
                    (Some(ws), Some(watcher)) => match (ws.lock(), watcher.lock()) {
                        (Ok(g), Ok(w)) => {
                            window_has_dirty_tab(&g, &label, |p| w.is_unsaved(p))
                        }
                        _ => false,
                    },
                    _ => false,
                }
            };
            if dirty {
                api.prevent_close();
                let _ = app.emit_to(label.as_str(), "confirm-window-close", ());
            }
        }
        _ => {}
    });
}

// When invoked from an interactive terminal on Unix, re-spawn self as a
// detached background process so the shell prompt returns immediately
// instead of blocking on the GUI process.
//
// Second-invocation routing is unaffected: the detached child still runs
// `tauri_plugin_single_instance`, which forwards argv to the running
// primary (if any) and exits — meaning `mdviewer foo.md` opens a new tab
// in the existing window and the terminal returns at once. First-launch
// `mdviewer foo.md` likewise returns at once: the parent exits after
// spawn, the child becomes the primary and brings up the window.
//
// Skip detachment when:
//   - we're already the detached child (MDVIEWER_DETACHED set);
//   - neither stdin nor stdout is a TTY (already non-interactive, e.g.
//     launched by a .desktop entry, Launch Services, or systemd);
//   - we couldn't determine our own exe path (fall through to foreground
//     so the user at least sees the window).
//
// Windows is a no-op: release builds use `windows_subsystem = "windows"`
// (see the crate-level attribute at the top of this file), so cmd.exe
// and PowerShell don't wait for the GUI process anyway.
#[cfg(unix)]
fn detach_from_terminal_if_needed() {
    use std::io::IsTerminal;
    use std::os::unix::process::CommandExt;

    if std::env::var_os("MDVIEWER_DETACHED").is_some() {
        return;
    }
    if !std::io::stdin().is_terminal() && !std::io::stdout().is_terminal() {
        return;
    }
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return,
    };
    let argv: Vec<_> = std::env::args_os().skip(1).collect();
    let spawned = std::process::Command::new(exe)
        .args(&argv)
        .env("MDVIEWER_DETACHED", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        // New process group — detaches from the controlling terminal's
        // foreground group so SIGINT/SIGQUIT from the shell don't reach
        // the GUI process.
        .process_group(0)
        .spawn();
    if spawned.is_ok() {
        std::process::exit(0);
    }
}

#[cfg(not(unix))]
fn detach_from_terminal_if_needed() {}

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

    // After the migrate-sidecars CLI subcommand — that path is meant to
    // run synchronously to completion and shouldn't background itself.
    detach_from_terminal_if_needed();

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
            // E2: route the second-instance targets into the MOST-RECENTLY-
            // FOCUSED window (resolved inside `dispatch_cli_targets`), raise
            // that window, and honor one-owner — instead of always landing in
            // `main`. `dispatch_cli_targets` now owns the focus + repaint
            // emit for the window it routed into, so this callback no longer
            // hard-codes `main`.
            let parsed = cli::parse_positional_args(&argv);
            dispatch_parsed_cli(app.clone(), parsed, "second invocation");
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
        }).build());
    // B2: the `tauri-plugin-window-state` builder call was removed here.
    // Window geometry is now persisted by the per-window `on_window_event`
    // handler (Moved/Resized → `set_window_geometry` → session.json) and
    // restored by the per-window restore loop below — that is the sole
    // geometry mechanism now. The Cargo dependency + the
    // `window-state:default` capability permission are dropped by B3 against
    // a tree where this builder line is already gone (clean build).

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

            // C1: dynamic Window-submenu entries carry `window-select:<label>`
            // ids. They are handled wholly Rust-side — parse the `<label>`
            // suffix, look up the live WebviewWindow, and `set_focus()` to
            // raise it. `menu_id_to_action` returns None for these ids (B3) so
            // they never bridge into a frontend action; this branch runs
            // first so the raise is unambiguous.
            if let Some(label) = menu::window_select_label(id) {
                if let Some(win) = app.get_webview_window(label) {
                    let _ = win.set_focus();
                }
                return;
            }

            // Native menu clicks → tauri event the WebView listener
            // translates into the existing mdviewer:* CustomEvents. The
            // pure id↔action mapping lives in `mdviewer_lib::menu` so it
            // can be unit-tested without an AppHandle.
            //
            // B2 (S12): the menu bar is application-global on every platform,
            // so a menu action must target the window the user is looking at
            // — not broadcast to all windows. `focused_window` resolves the
            // live-focused window (falling back to the workspace's
            // most-recently-focused label) and we `emit_to` only that one.
            if let Some(action) = menu::menu_id_to_action(id) {
                if let Some(win) = focused_window(app) {
                    let _ = win.emit(menu::MENU_EVENT, action);
                } else {
                    // No window resolvable (shouldn't happen while a menu is
                    // clickable) — fall back to a broadcast so the action
                    // isn't silently dropped.
                    let _ = app.emit(menu::MENU_EVENT, action);
                }
            }
        })
        .setup(|app| {
            // Build and attach the native menu before the workspace setup
            // — `set_menu` is cheap and does not depend on workspace state.
            // Failure to build the menu shouldn't take down the app, so we
            // log and continue with the platform default.
            // The Window submenu lists open windows; at boot the only window
            // is `main`, but the restore loop below may spawn more — we
            // rebuild after restore via `rebuild_menu`. Build with an empty
            // window list here so the static items still ship even if the
            // workspace isn't reachable yet.
            match menu::build(app.handle(), &[]) {
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
            // E2: `parse_positional_args` now returns `ParsedArgs { targets,
            // new_window }`. Cold-start behavior is UNCHANGED — targets open
            // into `main` (via `open_document`) exactly as before; the
            // `new_window` hint is only consumed by the running-app dispatch
            // (F1 wires the flag). Bind `.targets` so the existing loop is
            // a one-field change.
            let cli_targets =
                cli::parse_positional_args(&std::env::args().collect::<Vec<_>>()).targets;
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
                // B2: per-window session restore. The v2 store carries one
                // `WindowSession` per window (`tabs` / `active` / `geometry`).
                // We:
                //   1. Map each window to a stable label — the first reuses
                //      the already-existing `"main"` window, every later one
                //      spawns a fresh `win-{nanos+index}` window.
                //   2. Apply `clamp_geometry` (against the live monitor work
                //      area) so an off-screen restored window is pulled back.
                //   3. Open each window's tabs in order (skipping synthetic
                //      `drive-api://` paths) owned by that window's label, and
                //      activate the saved `active` tab.
                // A failure on any single path is logged and skipped (the file
                // may have moved/been deleted); the rest still load.
                let saved = ws.session_store().get();
                let app_handle = app.handle().clone();
                let bounds = virtual_screen_bounds(&app_handle);
                let nanos = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos();

                for (idx, win) in saved.windows.iter().enumerate() {
                    let label = restore_window_label(idx, nanos);

                    // Spawn the window (skip idx 0 — `"main"` already exists).
                    if idx > 0 {
                        match spawn_window(&app_handle, &label) {
                            Ok(_) => {
                                ws.new_window(label.clone());
                            }
                            Err(e) => {
                                tracing::warn!(
                                    "restore: spawn window {label} failed: {e:?}; \
                                     folding its tabs into main"
                                );
                                // Fall back to the main window so the tabs
                                // aren't lost if the spawn fails (headless CI).
                            }
                        }
                    }
                    let target_label = if idx > 0
                        && ws.list_windows().iter().any(|w| w.label == label)
                    {
                        label.clone()
                    } else {
                        mdviewer_lib::workspace::MAIN_LABEL.to_string()
                    };

                    // Clamp + place geometry for spawned windows. `main` keeps
                    // whatever tauri.conf.json gave it unless a geometry was
                    // saved; we still apply the clamp so a saved off-screen
                    // main window is pulled back.
                    if let Some(geo) = win.geometry {
                        let clamped = mdviewer_lib::session::clamp_geometry(geo, bounds);
                        if let Some(w) = app_handle.get_webview_window(&target_label) {
                            use tauri::{LogicalPosition, LogicalSize};
                            let _ = w.set_position(LogicalPosition::new(
                                clamped.x as f64,
                                clamped.y as f64,
                            ));
                            let _ = w.set_size(LogicalSize::new(
                                clamped.w as f64,
                                clamped.h as f64,
                            ));
                        }
                        ws.set_window_geometry(&target_label, clamped);
                    }

                    // Open this window's tabs in order.
                    for path in &win.tabs {
                        if path.to_string_lossy().starts_with("drive-api://") {
                            continue;
                        }
                        match ws.open_document_for(&target_label, path, OpenOpts::default()) {
                            Ok(_) => tracing::info!(
                                "restored {} into {}",
                                path.display(),
                                target_label
                            ),
                            Err(e) => tracing::warn!(
                                "session restore failed for {} in {}: {e:?}",
                                path.display(),
                                target_label
                            ),
                        }
                    }

                    // Re-activate the saved active tab within this window.
                    if let Some(target_path) = &win.active {
                        let canonical = target_path
                            .canonicalize()
                            .unwrap_or_else(|_| target_path.clone());
                        let target_id = ws
                            .list_open_documents_for(&target_label)
                            .iter()
                            .find(|t| t.path == canonical)
                            .map(|t| t.id.clone());
                        if let Some(id) = target_id {
                            let _ = ws.activate_tab_for(&target_label, &id);
                        }
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

            // B2: register the per-window lifecycle handler on every live
            // window (the main window + any windows the restore loop spawned).
            // Workspace + Watcher are both managed by now, so the handler's
            // geometry/focus/close-guard branches can reach them. This is the
            // sole geometry-persistence mechanism now that the window-state
            // plugin is gone.
            for (_, win) in app.webview_windows() {
                register_window_event_handler(&app.handle().clone(), &win);
            }

            // C1: the restore loop above may have registered extra windows;
            // rebuild the Window submenu now that the workspace is managed so
            // every restored window appears in the menu from first paint.
            rebuild_menu(&app.handle().clone());

            // Forward watcher events to the frontend. B2: route each event to
            // the window that owns the changed path (resolved via
            // `owning_window_label`) instead of broadcasting; drop the event
            // if no window currently has the file open. The receiver loop
            // ends when the sender side is dropped (managed `Watcher` drop on
            // shutdown).
            std::thread::spawn(move || {
                for ev in rx {
                    let owner = {
                        let ws_state = app_handle.state::<Mutex<Workspace>>();
                        ws_state
                            .lock()
                            .ok()
                            .and_then(|ws| ws.owning_window_for_watched(&ev.path).map(str::to_string))
                    };
                    if let Some(label) = owner {
                        let _ = app_handle.emit_to(label.as_str(), "external-change", &ev);
                    } else {
                        tracing::debug!(
                            "external-change for {:?} dropped: no window owns it",
                            ev.path
                        );
                    }
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

            // E2 (S8): e2e side-channel for the running-app CLI dispatch.
            // The OS can't shell out a second `mdviewer foo.md` invocation
            // under WebDriver, so the e2e spec emits an `e2e-dispatch-cli`
            // event carrying the argv. This listener parses it through the
            // SAME `cli::parse_positional_args` + `dispatch_cli_targets` path
            // the real single-instance callback uses, so the spec exercises
            // the focused-window routing end-to-end. Gated on `--features e2e`
            // (the same gate the WebDriver bridge that exposes `__mdviewerE2E`
            // rides on) so shipped binaries never register this listener — the
            // side-channel is unreachable in production.
            #[cfg(feature = "e2e")]
            {
                use tauri::Listener;
                let dispatch_app = app.handle().clone();
                app.listen("e2e-dispatch-cli", move |event| {
                    // Payload is the argv, e.g. ["mdviewer", "/abs/foo.md"].
                    // The frontend side-channel emits it as a JS string
                    // (`emit('e2e-dispatch-cli', JSON.stringify(args))`), and
                    // Tauri serializes a JS string payload as a JSON STRING —
                    // so `event.payload()` is a quoted, escaped JSON string
                    // (`"[\"mdviewer\",...]"`), NOT a bare JSON array. Decode
                    // the outer string layer first, then the inner array; fall
                    // back to a direct array parse so a future emit of the raw
                    // array (no stringify) still works. This is e2e-harness
                    // scaffolding (gated on `--features e2e`); the production
                    // CLI routing it feeds (`dispatch_parsed_cli`) is unchanged.
                    let raw = event.payload();
                    let argv: Vec<String> = serde_json::from_str::<String>(raw)
                        .ok()
                        .and_then(|inner| serde_json::from_str::<Vec<String>>(&inner).ok())
                        .or_else(|| serde_json::from_str::<Vec<String>>(raw).ok())
                        .unwrap_or_default();
                    let parsed = cli::parse_positional_args(&argv);
                    dispatch_parsed_cli(dispatch_app.clone(), parsed, "e2e dispatch");
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            // C1: spawn a fresh StartPage window. Self-contained (spawn_window
            // B2 + Workspace::new_window A1 + rebuild_menu C1). D1 adds the
            // OTHER window commands and must NOT re-register new_window.
            new_window,
            // G2: e2e-only command to spawn a window with an exact label so
            // the multi-window e2e helpers can address it deterministically.
            // Compiled + registered ONLY under `--features e2e`; absent from
            // production builds.
            #[cfg(feature = "e2e")]
            e2e_create_window,
            // D1: the remaining window IPC surface (new_window is C1's above).
            close_window,
            list_windows,
            open_in_new_window,
            move_tab,
            // G1: detach a tab into a fresh window (drag-off-the-strip, S10).
            detach_tab,
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
            // B1: SSH directory listing for the OpenRemoteDialog.
            ssh_list_dir,
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
                // E2: `dispatch_cli_targets` now routes into the focused
                // window (one-owner honored), raises it, and emits the
                // `workspace-changed` repaint to that window — so we no
                // longer hard-code a `main`-addressed emit here.
                dispatch_cli_targets(app.clone(), targets, "RunEvent::Opened");
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
