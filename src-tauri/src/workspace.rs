//! Workspace tab manager.
//!
//! Owns the in-memory state for an MDViewer session: the settings store, the
//! recents store, and a map of open `Tab`s keyed by an opaque `tab-{nanos}`
//! id. The Tauri runtime holds one of these behind a `Mutex` (wired in A8b);
//! tests construct bare instances with their own `data_dir` for isolation —
//! see the `Avoid` notes in this task's spec for why we don't expose a global
//! singleton.
//!
//! The IPC layer (A8b) is responsible for IPC commands and emitting events;
//! this module exposes the pure-Rust building blocks. `OpenOutcome` is a
//! tagged enum (`kind: "document" | "conflict"`) so the frontend can match on
//! a single shape — Phase-1 always emits `Document`; Phase-3's C2 widens
//! `open_document` to detect divergence vs `last_saved_snapshot` and emit
//! `Conflict { local, incoming }` instead.

use crate::anchor::{self, Anchor, ResolveOutcome};
use crate::comments::{CommentsStore, Thread};
use crate::doc_prefs::DocPrefsStore;
use crate::document::{render_markdown, RenderOptions, RenderResult};
use crate::drive::api::DriveApi;
use crate::drive::comments::IdMap;
use crate::drive::queue::DriveQueue;
use crate::drive::{DriveCollaborator, DriveStatus, TabBackend};
use crate::recents::RecentsStore;
use crate::sidecar::{load_sidecar, sidecar_path};
use crate::settings::SettingsStore;
use anyhow::{Context, Result};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Wire-shaped projection of `Tab` for `list_open_documents`. The frontend
/// needs both the opaque id (for activate/close) and the on-disk path (for
/// the tab label). Returning bare ids was the regression where tab labels
/// rendered the UUID instead of the filename.
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct TabSummary {
    pub id: String,
    pub path: PathBuf,
}

pub struct Tab {
    pub id: String,
    pub path: PathBuf,
    pub source: String,
    pub render: RenderResult,
    pub comments: CommentsStore,
    /// Bytes most recently written by `save_document` (B3) or read at open.
    /// Used by A8b's open-time conflict detection: when the disk bytes differ
    /// from this snapshot, the IPC layer emits `show-conflict`.
    pub last_saved_snapshot: Option<String>,
    /// A7: which backend services this tab. Computed at open time via
    /// `Tab::compute_backend(path, drive_connected)` and recomputed on
    /// connect/disconnect transitions (Local↔DriveDesktop in place; DriveApi
    /// is set by B2's `drive_open_url` flow and never downgraded by A7).
    pub backend: TabBackend,
    /// A7: Drive file id for tabs whose `backend == DriveApi`. `None` for
    /// Local and DriveDesktop tabs — the latter resolve their file_id on
    /// demand via the `file_id` resolver. Populated by B2 once `drive_open_url`
    /// returns a resolved file_id.
    pub file_id: Option<String>,
}

impl Tab {
    /// Compute the backend for a freshly-opened tab.
    ///
    /// Returns `Local` whenever Drive is disconnected (regardless of path
    /// shape) so the rest of the workspace doesn't have to special-case the
    /// "feature available but offline" branch. When connected, `Local` paths
    /// outside any known Drive Desktop mount stay `Local`; paths under a
    /// recognized mount upgrade to `DriveDesktop`. `DriveApi` is never the
    /// default — it's exclusively set by B2's `drive_open_url` flow, which
    /// resolves a Drive URL to a file_id and stamps the backend at construction.
    pub fn compute_backend(path: &Path, drive_connected: bool) -> TabBackend {
        if !drive_connected {
            return TabBackend::Local;
        }
        let home = std::env::var("HOME")
            .ok()
            .or_else(|| std::env::var("USERPROFILE").ok());
        if crate::drive::detect::is_drive_desktop_path(
            path,
            std::env::consts::OS,
            home.as_deref(),
        )
        .is_some()
        {
            TabBackend::DriveDesktop
        } else {
            TabBackend::Local
        }
    }
}

#[derive(Default, Clone, Copy)]
pub struct OpenOpts {
    pub force_reload: bool,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct OpenResult {
    pub tab_id: String,
    pub path: PathBuf,
    pub html: String,
    /// Raw markdown source. Needed by Edit mode (B4) which mounts a
    /// textarea seeded with this; the View↔Edit toggle silently no-ops
    /// when source is missing.
    pub source: String,
    pub threads: Vec<Thread>,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum OpenOutcome {
    Document(OpenResult),
    /// `tab_id` is the id of the open tab if one exists for `path`, or a
    /// freshly-minted placeholder when no tab is currently mounted (the
    /// closed-and-reopened branch). Frontend consumers should treat the
    /// latter as opaque — calling `activate_tab` on a placeholder id
    /// will fail with "no such tab" because the conflict surfaces
    /// **before** any tab is registered.
    Conflict {
        tab_id: String,
        path: PathBuf,
        local: String,    // last-saved bytes (the user's view of "mine")
        incoming: String, // what's on disk now
    },
}

/// C3: result of `export_document` — the destination folder plus the
/// filenames that landed in it. The share dialog displays these so the
/// user can confirm the export before sharing the folder by hand.
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ExportResult {
    pub folder: PathBuf,
    pub files: Vec<String>,
}

pub struct Workspace {
    settings: SettingsStore,
    recents: RecentsStore,
    /// A3 (font-size phase): per-document font-size overrides, keyed by
    /// canonical path. Owned by Workspace so the IPC handlers borrow a
    /// single shared store — multiple stores would race on the same JSON
    /// file. See `src/doc_prefs.rs` for the on-disk schema.
    doc_prefs: DocPrefsStore,
    /// Persists open-tab list + active tab across restarts. Drives the
    /// "restore previous session" startup mode. Updated eagerly on every
    /// open/close so a crash doesn't lose the state. See `src/session.rs`.
    session: crate::session::SessionStore,
    tabs: HashMap<String, Tab>,
    order: Vec<String>,
    active: Option<String>,
    /// C2: persists each path's last-saved bytes across `close_tab` so a
    /// subsequent open of the same path can detect external divergence.
    /// Without this, closing a tab would erase the snapshot needed for the
    /// reopen-time conflict check.
    closed_snapshots: HashMap<PathBuf, String>,
    /// A7: captured copy of the `data_dir` argument passed to
    /// `Workspace::new`, re-exposed under the name `config_dir` to match the
    /// path-naming used throughout `drive/queue.rs`, `drive/comments.rs`, and
    /// `drive/cache.rs`. The Workspace constructor previously didn't store
    /// `data_dir` because A1/A6 tasks open the existing per-store JSON files
    /// directly. Drive queues + id_maps are created **lazily** at runtime, so
    /// the path is stashed here for later. Constructor signature is unchanged.
    /// Reads land in B2 (`drive_open_url` lazy queue + id_map opens); the
    /// allow(dead_code) keeps A7 builds quiet until B2 ships.
    #[allow(dead_code)]
    pub(crate) config_dir: PathBuf,
    /// A7: `Some` once `drive_connect` succeeds, `None` otherwise. Single
    /// shared API handle (Arc-wrappable for the polling task) so token
    /// refresh is visible everywhere without rebuilding the reqwest client.
    pub(crate) drive_api: Option<Arc<DriveApi>>,
    /// A7: one queue per open Drive tab, keyed by `file_id`. Created lazily
    /// on the first offline write; persisted to
    /// `<config_dir>/drive_queue/<file_id>.json`.
    pub(crate) drive_queues: HashMap<String, DriveQueue>,
    /// A7: one id_map per open Drive tab, keyed by `file_id`. Persisted to
    /// `<config_dir>/drive_id_map/<file_id>.json`. `Arc<Mutex<_>>` so the
    /// polling task and the IPC writer can both update without holding the
    /// Workspace lock for the whole API call duration. The Arc lets B6's
    /// `spawn_replay_all` fan-out clone handles to each per-file replay
    /// task without re-borrowing Workspace; the accessor `id_maps_arc_clone`
    /// returns a shallow-cloned `HashMap` of those Arcs.
    pub(crate) id_maps: HashMap<String, Arc<Mutex<IdMap>>>,
    /// A7: last status snapshot emitted to the frontend; the polling loop
    /// diffs the next snapshot against this and only emits on transitions
    /// (avoids broadcasting a heartbeat on every poll cycle).
    pub(crate) last_drive_status: Option<DriveStatus>,
}

impl Workspace {
    pub fn new(data_dir: &Path) -> Result<Self> {
        Ok(Self {
            settings: SettingsStore::open(data_dir)?,
            recents: RecentsStore::open(data_dir)?,
            doc_prefs: DocPrefsStore::open(data_dir)?,
            session: crate::session::SessionStore::open(data_dir)?,
            tabs: HashMap::new(),
            order: Vec::new(),
            active: None,
            closed_snapshots: HashMap::new(),
            // A7: stash data_dir for lazy Drive queue/id_map opens later.
            config_dir: data_dir.to_path_buf(),
            drive_api: None,
            drive_queues: HashMap::new(),
            id_maps: HashMap::new(),
            last_drive_status: None,
        })
    }

    /// A7: read-only accessor for the captured `data_dir`. Used by Drive
    /// queue / id_map lazy-open call sites to avoid re-passing the path
    /// through every IPC handler signature. B2 is the first caller — until
    /// then the allow(dead_code) keeps the warning surface clean.
    #[allow(dead_code)]
    pub(crate) fn config_dir(&self) -> &Path {
        &self.config_dir
    }

    /// A7: shallow-clone the per-file_id `Arc<Mutex<IdMap>>` handles so
    /// callers (B6's `spawn_replay_all`) can fan out replay work without
    /// holding the Workspace lock for the duration of any Drive API
    /// roundtrip. The Arcs share the underlying `Mutex<IdMap>` with
    /// `self.id_maps`, so writes the replay task makes are visible to the
    /// next IPC writer. Public so B6 (which lives in `drive::queue`) and
    /// integration tests can both consume it.
    pub fn id_maps_arc_clone(&self) -> HashMap<String, Arc<Mutex<IdMap>>> {
        self.id_maps.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    /// A7: collect the `file_id`s of every currently-open tab whose backend
    /// is Drive (DriveDesktop or DriveApi). Used by the polling loop to
    /// decide whether to fan out a poll round and to enumerate the targets.
    /// Tabs without a `file_id` (DriveDesktop tabs whose lazy resolution
    /// hasn't run yet) are skipped — they'll be picked up on the next poll
    /// after B2 resolves their id.
    pub fn drive_tab_file_ids(&self) -> Vec<String> {
        self.tabs
            .values()
            .filter(|t| matches!(t.backend, TabBackend::DriveDesktop | TabBackend::DriveApi))
            .filter_map(|t| t.file_id.clone())
            .collect()
    }

    /// A7: build the current `DriveStatus` snapshot from settings + queue
    /// totals. The `pending_count` here is the **count of files with pending
    /// writes** — i.e., the number of non-empty `DriveQueue`s, NOT the total
    /// op count across them. `DriveQueue` does not currently expose a `len()`
    /// accessor and the spec doesn't require op-level granularity for the
    /// status badge, so per-file granularity is sufficient. Caller diffs
    /// against `self.last_drive_status` to decide whether to emit
    /// `drive-status-changed`.
    pub fn drive_status(&self) -> DriveStatus {
        let s = self.settings.get();
        // Count of files with pending writes (not the total op count across
        // those files). See the doc-comment above for why per-file
        // granularity is sufficient for the status badge.
        let pending: u32 = self
            .drive_queues
            .values()
            .map(|q| if q.is_empty() { 0u32 } else { 1u32 })
            .sum();
        DriveStatus {
            connected: s.cloud.drive.connected,
            account_email: s.cloud.drive.account_email.clone(),
            // `online` is a polling-loop concern (last poll succeeded vs
            // network failure). Until B6 wires real network-state tracking,
            // we mirror `connected` so the UI shows a meaningful badge.
            online: s.cloud.drive.connected,
            pending_count: pending,
        }
    }

    /// A7: walk every open tab and re-pick its `backend` to reflect a
    /// connect/disconnect transition. `Local` ↔ `DriveDesktop` flip in place
    /// based on the new `drive_connected` flag (and the cached path —
    /// disk-shape doesn't change between transitions). `DriveApi` tabs are
    /// **not** downgraded — they go read-only and prompt the user to
    /// reconnect rather than re-opening their underlying file_id as Local.
    pub fn recompute_backends_after_connect_change(&mut self, drive_connected: bool) {
        for tab in self.tabs.values_mut() {
            if matches!(tab.backend, TabBackend::DriveApi) {
                continue;
            }
            tab.backend = Tab::compute_backend(&tab.path, drive_connected);
        }
    }

    /// A7: stub for B2's `drive_resolve_path` IPC handler. Returns a Drive
    /// `file_id` for a local path under a Drive Desktop mount; B2 fills in
    /// the resolver wiring (it needs an authenticated `DriveApi`). The
    /// placeholder error is intentional — exposing this handler in A7 keeps
    /// the IPC surface stable so the frontend can compile against it.
    pub fn drive_resolve_path(&self, _local_path: &str) -> Result<String> {
        // placeholder error string; B2 fills in the real implementation
        anyhow::bail!("not yet implemented")
    }

    /// A7: stub for B2's `drive_get_collaborators` IPC handler. Returns the
    /// list of `DriveCollaborator`s for `file_id`. B2 calls
    /// `drive_api.list_permissions(file_id)`.
    pub fn drive_get_collaborators(&self, _file_id: &str) -> Result<Vec<DriveCollaborator>> {
        // placeholder error string; B2 fills in the real implementation
        anyhow::bail!("not yet implemented")
    }

    /// A7: connect-time stub. B1/B2 fills in the OAuth loopback flow + token
    /// persistence. The IPC handler in main.rs calls this and emits
    /// `drive-status-changed`; the body here just flips the settings flag so
    /// the rest of the IPC surface (drive_status, drive_tab_file_ids) sees a
    /// consistent connected state from the very first call after B1 lands.
    pub fn drive_connect(&mut self, _app: &tauri::AppHandle) -> Result<()> {
        anyhow::bail!("not yet implemented")
    }

    /// A7: disconnect drops the API handle, recomputes backends so any
    /// `DriveDesktop` tabs degrade back to `Local`, and clears the cached
    /// last-status snapshot so the next status check emits a fresh
    /// `drive-status-changed`. `DriveApi` tabs are not touched here —
    /// they're held for B2 to surface a reconnect prompt.
    pub fn drive_disconnect(&mut self) {
        self.drive_api = None;
        // Pass `false` explicitly: the disconnect intent is unambiguous and
        // we must not depend on a settings round-trip (the settings flag may
        // not have been flipped yet at the time this is called, which would
        // leave DriveDesktop tabs incorrectly connected).
        self.recompute_backends_after_connect_change(false);
        self.last_drive_status = None;
    }

    /// A7: per-file polling step. B6 fills in the actual list_comments call
    /// and the merge into the local `CommentsStore`. We expose the signature
    /// here so the polling loop's body in `run_polling_loop` can compile
    /// against a stable shape.
    pub fn drive_poll_one(&mut self, _file_id: &str, _api: &DriveApi) -> Result<()> {
        // B6 wires this — placeholder body just succeeds so the polling loop
        // doesn't error out on every iteration in A7-only builds.
        Ok(())
    }

    pub fn session_store(&self) -> &crate::session::SessionStore {
        &self.session
    }

    /// Snapshot the current open-tab list and active tab into the session
    /// store. Called by `open_document`, `close_tab`, and `activate_tab`
    /// so the on-disk session.json always reflects the live state.
    fn persist_session(&self) {
        let open_tabs: Vec<PathBuf> = self
            .order
            .iter()
            .filter_map(|id| self.tabs.get(id).map(|t| t.path.clone()))
            .collect();
        let active_tab = self
            .active
            .as_ref()
            .and_then(|id| self.tabs.get(id))
            .map(|t| t.path.clone());
        if let Err(e) = self.session.save(open_tabs, active_tab) {
            // Session is best-effort — never let a save failure block
            // open / close / activate flow. Log and move on.
            tracing::warn!(?e, "session.json save failed");
        }
    }

    pub fn open_document(&mut self, path: &Path, _opts: OpenOpts) -> Result<OpenOutcome> {
        let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());

        // Detach the existing-tab snapshot before any &mut self mutation.
        // Borrow-checker pattern: we clone every field we need into owned
        // values, drop the immutable borrow with `;`, then take the mutable
        // borrow on `self.active`.
        let existing = self.find_by_path(&canonical).map(|(id, tab)| {
            (
                id,
                tab.path.clone(),
                tab.render.html.clone(),
                tab.source.clone(),
                tab.comments.list_threads().to_vec(),
                tab.last_saved_snapshot.clone(),
            )
        });
        if let Some((id, p, html, source, threads, snapshot)) = existing {
            // C2: re-opening an already-open tab still has to surface
            // divergence. If disk bytes differ from the in-memory snapshot,
            // emit Conflict instead of silently activating the stale tab.
            if let Some(snap) = snapshot {
                if let Ok(disk) = std::fs::read_to_string(&canonical) {
                    if disk != snap {
                        return Ok(OpenOutcome::Conflict {
                            tab_id: id,
                            path: canonical,
                            local: snap,
                            incoming: disk,
                        });
                    }
                }
            }
            self.active = Some(id.clone());
            self.persist_session();
            return Ok(OpenOutcome::Document(OpenResult {
                tab_id: id,
                path: p,
                html,
                source,
                threads,
            }));
        }

        let source = std::fs::read_to_string(&canonical)
            .with_context(|| format!("read {:?}", canonical))?;

        // C2: a closed-and-reopened path with a divergent on-disk copy
        // returns Conflict before the new tab is even constructed. The
        // snapshot stays in `closed_snapshots` until the user resolves via
        // the Conflict view; the resulting save_document call overwrites
        // it via prime_saved_snapshot.
        if let Some(prior) = self.closed_snapshots.get(&canonical).cloned() {
            if prior != source {
                let id = format!(
                    "tab-{:x}",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos()
                );
                return Ok(OpenOutcome::Conflict {
                    tab_id: id,
                    path: canonical,
                    local: prior,
                    incoming: source,
                });
            }
        }

        let s = self.settings.get();
        let opts = RenderOptions {
            syntax_highlighting: s.editor.syntax_highlighting,
            mermaid_enabled: s.editor.mermaid_enabled,
        };
        let render = render_markdown(&source, &opts);

        let sc_path = sidecar_path(&canonical, &s.comments.sidecar_pattern);
        let comments = load_sidecar(&sc_path).unwrap_or_else(|_| CommentsStore::new());

        let id = format!(
            "tab-{:x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );

        let result = OpenResult {
            tab_id: id.clone(),
            path: canonical.clone(),
            html: render.html.clone(),
            source: source.clone(),
            threads: comments.list_threads().to_vec(),
        };

        // A7: pick the initial backend from settings.cloud.drive.connected +
        // path shape. `file_id` starts None on Local/DriveDesktop tabs; B2's
        // `drive_open_url` flow stamps it for DriveApi tabs at construction.
        let drive_connected = s.cloud.drive.connected;
        let backend = Tab::compute_backend(&canonical, drive_connected);
        self.tabs.insert(
            id.clone(),
            Tab {
                id: id.clone(),
                path: canonical.clone(),
                source: source.clone(),
                render,
                comments,
                last_saved_snapshot: Some(source),
                backend,
                file_id: None,
            },
        );
        self.order.push(id.clone());
        self.active = Some(id.clone());
        let _ = self.recents.push(&canonical);
        self.persist_session();
        Ok(OpenOutcome::Document(result))
    }

    /// Re-read `path` from disk, re-render with the current settings, and
    /// replace the cached `source` / `render` / `last_saved_snapshot` on the
    /// matching tab. Called from B3's `save_document` IPC handler so that
    /// after the user's bytes hit disk the in-memory tab stays in sync —
    /// otherwise A10's anchor resolution would still be working off the
    /// pre-save snapshot.
    ///
    /// Returns an error if no tab is open for `path`. The tab is located by
    /// canonical path (matching how `open_document` stores it).
    pub fn refresh_tab(&mut self, path: &Path) -> Result<()> {
        let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        let source = std::fs::read_to_string(&canonical)
            .with_context(|| format!("read {:?}", canonical))?;
        let s = self.settings.get();
        let opts = RenderOptions {
            syntax_highlighting: s.editor.syntax_highlighting,
            mermaid_enabled: s.editor.mermaid_enabled,
        };
        let render = render_markdown(&source, &opts);
        let tab = self
            .tabs
            .values_mut()
            .find(|t| t.path == canonical)
            .ok_or_else(|| anyhow::anyhow!("no open tab for path {:?}", canonical))?;
        tab.source = source.clone();
        tab.render = render;
        tab.last_saved_snapshot = Some(source);
        Ok(())
    }

    pub fn close_tab(&mut self, id: &str) -> Result<()> {
        // C2: stash the last-saved bytes keyed by path so the next open of
        // this path can detect divergence from disk. Tabs without a snapshot
        // (theoretically impossible — every open path primes one — but
        // defensive) just don't seed the map.
        if let Some(tab) = self.tabs.remove(id) {
            if let Some(snap) = tab.last_saved_snapshot {
                self.closed_snapshots.insert(tab.path, snap);
            }
        }
        self.order.retain(|x| x != id);
        if self.active.as_deref() == Some(id) {
            self.active = self.order.last().cloned();
        }
        self.persist_session();
        Ok(())
    }

    /// C2: clears the closed-tab snapshot for `path` after the user resolves
    /// a conflict (Finish merge in Conflict.ts → save_document → here). The
    /// IPC handler also calls this whenever save_document succeeds for an
    /// already-open tab so the snapshot stays in sync with the new bytes.
    pub fn prime_saved_snapshot(&mut self, path: &Path, contents: String) {
        let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        if let Some(tab) = self.tabs.values_mut().find(|t| t.path == canonical) {
            tab.last_saved_snapshot = Some(contents.clone());
        }
        self.closed_snapshots.insert(canonical, contents);
    }

    pub fn activate_tab(&mut self, id: &str) -> Result<()> {
        if !self.tabs.contains_key(id) {
            anyhow::bail!("no such tab");
        }
        self.active = Some(id.into());
        self.persist_session();
        Ok(())
    }

    pub fn list_open_documents(&self) -> Vec<&Tab> {
        self.order.iter().filter_map(|id| self.tabs.get(id)).collect()
    }

    pub fn active_tab_id(&self) -> Option<&str> {
        self.active.as_deref()
    }

    fn find_by_path(&self, p: &Path) -> Option<(String, &Tab)> {
        self.tabs
            .iter()
            .find(|(_, t)| t.path == p)
            .map(|(id, t)| (id.clone(), t))
    }

    pub fn settings_store(&self) -> &SettingsStore {
        &self.settings
    }
    pub fn settings_store_mut(&mut self) -> &mut SettingsStore {
        &mut self.settings
    }
    pub fn recents_store(&self) -> &RecentsStore {
        &self.recents
    }

    /// A3: read-only accessor for the `get_doc_pref` IPC handler.
    pub fn doc_prefs(&self) -> &DocPrefsStore {
        &self.doc_prefs
    }

    /// A3: writable accessor for the `set_doc_pref` / `delete_doc_pref` IPC
    /// handlers. The handlers must go through this single store rather than
    /// constructing their own — otherwise concurrent saves would race on the
    /// same `doc_prefs.json` file.
    pub fn doc_prefs_mut(&mut self) -> &mut DocPrefsStore {
        &mut self.doc_prefs
    }

    /// C3: read-only accessor for the export_document IPC handler. Pairs
    /// with comments_for / comments_for_mut; the share/export flow needs
    /// the path and source bytes off the tab without going through a
    /// per-field API surface.
    pub fn tab(&self, id: &str) -> Option<&Tab> {
        self.tabs.get(id)
    }

    pub fn comments_for(&self, tab_id: &str) -> Result<&CommentsStore> {
        self.tabs
            .get(tab_id)
            .map(|t| &t.comments)
            .ok_or_else(|| anyhow::anyhow!("no such tab: {tab_id}"))
    }

    pub fn comments_for_mut(&mut self, tab_id: &str) -> Result<&mut CommentsStore> {
        self.tabs
            .get_mut(tab_id)
            .map(|t| &mut t.comments)
            .ok_or_else(|| anyhow::anyhow!("no such tab: {tab_id}"))
    }

    /// Phase-2 (B1): exact-quote search with fuzzy fallback. The confidence
    /// threshold is read from `settings.comments.reattachment_confidence`
    /// (1..=100, default 75). Anchors below the threshold come back as
    /// `Orphan`. The IPC command surface is unchanged — only the body that
    /// dispatches through `anchor::resolve_anchor_with_threshold` is widened.
    pub fn resolve_anchor_for_tab(&self, tab_id: &str, a: &Anchor) -> Result<ResolveOutcome> {
        let tab = self
            .tabs
            .get(tab_id)
            .ok_or_else(|| anyhow::anyhow!("no such tab: {tab_id}"))?;
        let threshold = self.settings.get().comments.reattachment_confidence;
        Ok(anchor::resolve_anchor_with_threshold(&tab.source, a, threshold))
    }
}

/// A7: Drive polling loop. Runs as a Tokio task spawned on the first
/// successful `drive_connect`. Idles when no Drive tab is open (sleeps a
/// short interval and re-checks) so an offline workspace never burns
/// battery. Wakes up every `poll_interval_active_secs` (focused) or
/// `poll_interval_unfocused_secs` (background) and fans out a per-file_id
/// poll bounded by an 8-permit semaphore. The std-Mutex Workspace lock is
/// only acquired inside `spawn_blocking` so the async reactor never stalls.
///
/// The loop emits `drive-status-changed` only when the new status snapshot
/// differs from the previous one — heartbeats are filtered out at the
/// `Workspace::drive_status` accessor level (B6 will tighten this once the
/// status fields include real online / pending counts).
///
/// Cancellation: this loop currently runs until the process exits. B1 must
/// thread a cancel signal (recommended: `tokio::sync::watch::Receiver<bool>`
/// passed in alongside `app`) so drive_disconnect can stop polling cleanly.
pub async fn run_polling_loop(app: tauri::AppHandle) {
    use std::time::Duration;
    use tauri::Manager;
    loop {
        // Snapshot just the data the loop needs out of the std-mutex on a
        // blocking thread, then drop the lock immediately. The async body
        // never holds a std-mutex across an `.await`.
        let app_for_state = app.clone();
        let snapshot = tokio::task::spawn_blocking(move || {
            let state = app_for_state.state::<std::sync::Mutex<Workspace>>();
            let ws = state.lock().expect("workspace lock poisoned");
            let s = ws.settings_store().get();
            let focused = app_for_state
                .get_webview_window("main")
                .map(|w| w.is_focused().unwrap_or(false))
                .unwrap_or(false);
            let interval = Duration::from_secs(if focused {
                s.cloud.drive.poll_interval_active_secs
            } else {
                s.cloud.drive.poll_interval_unfocused_secs
            });
            (interval, ws.drive_tab_file_ids(), ws.drive_api.clone())
        })
        .await
        .expect("spawn_blocking joined");
        let (interval, drive_tabs, api_opt) = snapshot;

        if drive_tabs.is_empty() {
            // No work — sleep a short fixed interval so the next opened
            // Drive tab is picked up promptly without spinning.
            tokio::time::sleep(Duration::from_secs(2)).await;
            continue;
        }
        let Some(api) = api_opt else {
            tokio::time::sleep(interval).await;
            continue;
        };

        // Cap concurrent in-flight requests at 8 so a workspace with many
        // Drive tabs doesn't trip Drive's per-second quota.
        //
        // TODO(B6): for the semaphore to provide real concurrency, B6 must
        // snapshot the per-file inputs (file_id, etag, last_fetched), DROP
        // the workspace lock, then do the reqwest call, then re-acquire the
        // lock to merge results into id_maps/cache_meta. Holding state.lock()
        // across drive_poll_one (as the body below does today) would
        // serialize all 8 permits to 1.
        let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(8));
        let mut tasks = Vec::new();
        for fid in drive_tabs {
            let app2 = app.clone();
            let api2 = api.clone();
            let sem = semaphore.clone();
            tasks.push(tokio::spawn(async move {
                let _permit = sem.acquire().await.unwrap();
                // The per-poll Drive call uses `reqwest::blocking`; wrap it
                // in spawn_blocking so the async reactor isn't held up.
                let _ = tokio::task::spawn_blocking(move || {
                    let state = app2.state::<std::sync::Mutex<Workspace>>();
                    let mut ws = state.lock().expect("workspace lock poisoned");
                    if let Err(e) = ws.drive_poll_one(&fid, &api2) {
                        tracing::debug!("drive poll {} failed: {}", fid, e);
                    }
                    // TODO(B6): replay queues here
                    let snapshot = ws.drive_status();
                    let changed = ws
                        .last_drive_status
                        .as_ref()
                        .map(|prev| {
                            // Diff on the wire-relevant fields so a
                            // pending_count tick or an online ↔ offline flip
                            // both fire an event, but a pure heartbeat does
                            // not. The DriveStatus struct doesn't derive
                            // PartialEq because Option<String> + bool fields
                            // make a hand-written diff cheaper to read.
                            prev.connected != snapshot.connected
                                || prev.online != snapshot.online
                                || prev.pending_count != snapshot.pending_count
                                || prev.account_email != snapshot.account_email
                        })
                        .unwrap_or(true);
                    if changed {
                        ws.last_drive_status = Some(snapshot.clone());
                        let _ = tauri::Emitter::emit(&app2, "drive-status-changed", &snapshot);
                    }
                })
                .await;
            }));
        }
        for t in tasks {
            let _ = t.await;
        }
        tokio::time::sleep(interval).await;
    }
}
