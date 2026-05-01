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
    /// B2: Drive resource ETag for `backend == DriveApi` tabs. `None` for
    /// Local + DriveDesktop tabs and as the initial value on a freshly-
    /// opened DriveApi tab; populated by `drive_open_url` from
    /// `download_to_cache`'s outcome and refreshed by B5's `save_drive_api_tab`
    /// success path. Source of truth for the `If-Match` header on the next
    /// save. Optional so it can't conflict with non-Drive callers and so
    /// existing literal constructors only need a single `etag: None` field
    /// added.
    pub etag: Option<String>,
}

impl Tab {
    /// Wire-shaped projection used by `drive_open_url` (and any future
    /// caller that needs the same `(id, path)` envelope `list_open_documents`
    /// emits). Lives on `Tab` so the IPC layer doesn't have to duplicate
    /// the field-mapping every place it produces a TabSummary.
    pub fn summary(&self) -> TabSummary {
        TabSummary {
            id: self.id.clone(),
            path: self.path.clone(),
        }
    }

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
    /// B2 (groundwork for B5): optional internal watcher for the
    /// `save_drive_desktop_tab` flow. The production binary's main.rs holds
    /// its own `Mutex<Watcher>` for external-change events (registered as
    /// Tauri managed state); Workspace's copy is **only** used by Drive
    /// Desktop save-conflict detection (`note_open` at tab-open time +
    /// `compare_for_save` at save time). The two watchers don't share
    /// `State`, but the snapshot map B4 added lives inside the watcher
    /// instance — keeping both calls on the same `Workspace.watcher`
    /// instance is the only requirement.
    ///
    /// `None` when the workspace was constructed via the production
    /// `Workspace::new` (B5 will widen the constructor to plumb one
    /// through); `Some` after `new_for_test` so integration tests can
    /// exercise the save path without a Tauri handle.
    pub(crate) watcher: Option<crate::watcher::Watcher>,
    /// D2: cancel signal for the polling task spawned by `drive_connect`.
    /// `Some(tx)` while polling is active; `drive_disconnect` calls
    /// `.take()` on this and drops the sender, which wakes the
    /// polling-loop's `cancel_rx.changed()` await with an `Err`. The watch
    /// channel is initialized with `true` so `*cancel_rx.borrow()` reads as
    /// "still alive" until disconnect drops the sender.
    pub(crate) polling_cancel: Option<tokio::sync::watch::Sender<bool>>,
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
            // B2: production builds use main.rs's own Mutex<Watcher>; the
            // workspace-internal slot stays None until B5 plumbs an instance
            // in for the DriveDesktop save-conflict flow.
            watcher: None,
            // D2: no polling task exists until drive_connect spawns one;
            // drive_disconnect takes() this back to None.
            polling_cancel: None,
        })
    }

    /// A7: read-only accessor for the captured `data_dir`. Used by Drive
    /// queue / id_map lazy-open call sites to avoid re-passing the path
    /// through every IPC handler signature. B6 promoted this to `pub` so
    /// the `drive_connect` IPC handler can pass the path into
    /// `spawn_replay_all` without a second managed-state slot.
    pub fn config_dir(&self) -> &Path {
        &self.config_dir
    }

    /// B6: shallow-clone the `Arc<DriveApi>` (when connected) so callers
    /// like `drive_connect`'s replay fan-out can hand the API to a Tokio
    /// task without holding the Workspace lock through any HTTP roundtrip.
    /// Returns `None` before the first successful connect.
    pub fn drive_api_arc(&self) -> Option<Arc<DriveApi>> {
        self.drive_api.clone()
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

    /// D2: resolve a local Drive Desktop path → Drive `file_id` by routing
    /// through the `file_id::resolve_file_id` helper, which queries
    /// `files.list?q="name='<basename>' and trashed=false"` against the
    /// authenticated `DriveApi`. Returns `DriveError::NotConnected` when
    /// no API is populated, `DriveError::Ambiguous(n)` when the name
    /// matches multiple files (the caller surfaces a disambiguation
    /// picker), and `DriveError::Api(_)` when the path doesn't live under
    /// a known Drive Desktop mount.
    pub fn drive_resolve_path(
        &self,
        local_path: &str,
    ) -> Result<String, crate::drive::DriveError> {
        let api = self
            .drive_api
            .as_ref()
            .ok_or(crate::drive::DriveError::NotConnected)?
            .clone();
        // The file_id resolver is generic over a `FileIdBackend` trait;
        // wrap the live DriveApi in a thin adapter that calls
        // `files.list?q=...` and returns the raw JSON body.
        struct ApiBackend(std::sync::Arc<crate::drive::api::DriveApi>);
        impl crate::drive::file_id::FileIdBackend for ApiBackend {
            fn files_list(
                &self,
                q: &str,
            ) -> Result<String, crate::drive::DriveError> {
                self.0.files_list_raw(q)
            }
        }
        let backend = ApiBackend(api);
        let home = std::env::var("HOME")
            .ok()
            .or_else(|| std::env::var("USERPROFILE").ok());
        let path = std::path::Path::new(local_path);
        match crate::drive::file_id::resolve_file_id(
            path,
            std::env::consts::OS,
            home.as_deref(),
            &backend,
        )? {
            crate::drive::file_id::FileIdResolution::Resolved(id) => Ok(id),
            crate::drive::file_id::FileIdResolution::Ambiguous(matches) => {
                Err(crate::drive::DriveError::Ambiguous(matches.len()))
            }
            crate::drive::file_id::FileIdResolution::TooManyMatches {
                total_estimate,
                ..
            } => Err(crate::drive::DriveError::Ambiguous(total_estimate)),
        }
    }

    /// B2: open a Drive markdown document by URL paste. Parses the URL into
    /// a `file_id`, de-dupes against any already-open DriveApi tab on that
    /// file_id (returns the existing handle in that case), then fetches
    /// metadata, downloads to cache, and registers a new DriveApi-backed
    /// tab. The fresh tab carries the resource ETag from the download so
    /// the next save can build an `If-Match` header without a cache_meta
    /// roundtrip.
    ///
    /// Comments are intentionally NOT fetched here — the polling loop's
    /// first iteration populates them. This keeps the URL-paste flow snappy
    /// and unifies the comment-load path with the steady-state behavior.
    pub fn drive_open_url(&mut self, url: &str) -> Result<TabSummary, crate::drive::DriveError> {
        let file_id = crate::drive::parse_drive_url(url)?;

        // De-dupe: if an existing DriveApi tab already references this
        // file_id, return its summary instead of opening a duplicate.
        // Iterates `.values()` because `self.tabs` is a HashMap keyed by
        // tab id, not by file_id.
        if let Some(existing) = self.tabs.values().find(|t| {
            matches!(t.backend, TabBackend::DriveApi)
                && t.file_id.as_deref() == Some(file_id.as_str())
        }) {
            return Ok(existing.summary());
        }

        let api = self
            .drive_api
            .as_ref()
            .ok_or(crate::drive::DriveError::NotConnected)?
            .clone();
        let meta = api.files_get_metadata(&file_id)?;
        let cfg = self.config_dir.clone();
        let outcome =
            crate::drive::files::download_to_cache(&api, &cfg, &file_id, &meta.name)?;

        // Read the freshly-downloaded body so the in-memory tab carries the
        // same source the editor will display. Treat read failures as a
        // generic Drive Api error — the file just hit the cache, so a
        // failure here points at a real fs problem.
        let source = std::fs::read_to_string(&outcome.cache_path)
            .map_err(|e| crate::drive::DriveError::Api(e.to_string()))?;
        let s = self.settings.get();
        let opts = RenderOptions {
            syntax_highlighting: s.editor.syntax_highlighting,
            mermaid_enabled: s.editor.mermaid_enabled,
        };
        let render = render_markdown(&source, &opts);

        let id = format!(
            "tab-{:x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        // Use a synthetic `drive-api://<file_id>` path so a subsequent
        // `Workspace::open_document(cache_path)` (e.g. session restore or
        // file-association launch) doesn't collide with this tab's slot in
        // `find_by_path`. The cache file is reachable through `outcome.cache_path`
        // and persisted in cache_meta — Tab.path doesn't need to point at it.
        // Matches the `test_open_drive_api_tab` helper's path shape.
        let synthetic_path = std::path::PathBuf::from(format!("drive-api://{}", file_id));
        let tab = Tab {
            id: id.clone(),
            path: synthetic_path,
            source: source.clone(),
            render,
            // Empty comments at open — the polling loop populates them on
            // the next tick. See the doc-comment above for why.
            comments: CommentsStore::new(),
            last_saved_snapshot: Some(source),
            backend: TabBackend::DriveApi,
            file_id: Some(file_id),
            etag: Some(outcome.etag.clone()),
        };
        let summary = tab.summary();
        self.tabs.insert(id.clone(), tab);
        self.order.push(id.clone());
        self.active = Some(id);
        // Mirror the open_document/close_tab/activate_tab pattern so the
        // restored-session list picks up Drive-opened tabs across restarts.
        self.persist_session();
        Ok(summary)
    }

    /// B5 dispatch path — uploads `local` to Drive with `If-Match: etag`.
    /// On a 412 (PreconditionFailed) the helper fetches the remote bytes
    /// and surfaces a `SaveError::DriveConflict { local, remote, source: DriveApiEtag }`
    /// so the IPC layer can route it into the existing diff-merge view.
    /// On success the new ETag is returned (the IPC handler then refreshes
    /// the tab's `etag` field so the next round picks up the latest value).
    pub fn save_drive_api_tab(
        &mut self,
        tab_id: &str,
        local: &[u8],
        etag: &str,
    ) -> Result<String, SaveError> {
        let api = self
            .drive_api
            .as_ref()
            .ok_or_else(|| SaveError::Drive(crate::drive::DriveError::NotConnected))?
            .clone();
        let file_id = self
            .tabs
            .get(tab_id)
            .and_then(|t| t.file_id.clone())
            .ok_or_else(|| SaveError::Drive(crate::drive::DriveError::Api("no file_id".into())))?;
        match crate::drive::files::upload_with_etag(&api, &file_id, local, etag) {
            Ok(crate::drive::files::UploadOutcome::Updated { new_etag }) => Ok(new_etag),
            Err(crate::drive::DriveError::PreconditionFailed) => {
                let resp = api
                    .raw_get_media(&file_id)
                    .map_err(SaveError::Drive)?;
                let remote = resp
                    .bytes()
                    .map_err(|e| SaveError::Drive(crate::drive::DriveError::Network(e.to_string())))?
                    .to_vec();
                Err(SaveError::DriveConflict {
                    local: local.to_vec(),
                    remote,
                    source: ConflictSource::DriveApiEtag,
                })
            }
            Err(e) => Err(SaveError::Drive(e)),
        }
    }

    /// B5 dispatch path for `DriveDesktop` tabs — calls the watcher's
    /// `compare_for_save` (B4 API) to decide whether the on-disk file
    /// diverged from the open-time snapshot. On `Unchanged` we write the
    /// new bytes locally (atomic-ish via `std::fs::write`) and re-prime
    /// the watcher's snapshot for the next save. On `Changed` we surface
    /// `SaveError::DriveConflict { source: DriveDesktopWatcher }` carrying
    /// both the user's local bytes and the freshly-read remote bytes so
    /// the existing diff-merge view can render them.
    ///
    /// The DriveDesktop case has no ETag — the local Drive Desktop client
    /// owns the cloud sync; this method only mediates the local
    /// last-writer-wins. `record_self_write` is intentionally NOT used
    /// here: B5 routes through this path explicitly so the watcher's
    /// external-change notification is not relevant (the user just wrote
    /// the file themselves).
    pub fn save_drive_desktop_tab(
        &mut self,
        tab_id: &str,
        local: &[u8],
    ) -> Result<(), SaveError> {
        let path = self
            .tabs
            .get(tab_id)
            .map(|t| t.path.clone())
            .ok_or_else(|| {
                SaveError::Drive(crate::drive::DriveError::Api("no such tab".into()))
            })?;
        let watcher = self.watcher.as_ref().ok_or_else(|| {
            SaveError::Drive(crate::drive::DriveError::Api(
                "workspace has no watcher; B5 wires this in production".into(),
            ))
        })?;
        match watcher.compare_for_save(&path).map_err(SaveError::Io)? {
            crate::watcher::CompareForSave::Unchanged => {
                std::fs::write(&path, local).map_err(SaveError::Io)?;
                // Re-prime the open-time snapshot so the next save's
                // compare_for_save baseline is the bytes we just wrote.
                watcher.note_open(&path).map_err(SaveError::Io)?;
                if let Some(tab) = self.tabs.get_mut(tab_id) {
                    if let Ok(s) = std::str::from_utf8(local) {
                        tab.last_saved_snapshot = Some(s.to_string());
                        tab.source = s.to_string();
                    }
                }
                Ok(())
            }
            crate::watcher::CompareForSave::Changed { .. } => {
                let remote = std::fs::read(&path).map_err(SaveError::Io)?;
                Err(SaveError::DriveConflict {
                    local: local.to_vec(),
                    remote,
                    source: ConflictSource::DriveDesktopWatcher,
                })
            }
        }
    }

    /// D2: list current Drive collaborators for `file_id` by routing
    /// through `DriveApi::list_permissions`. Returns
    /// `DriveError::NotConnected` when the API is not populated;
    /// `DriveError::Api(_)` when the underlying HTTP call fails.
    pub fn drive_get_collaborators(
        &self,
        file_id: &str,
    ) -> Result<Vec<DriveCollaborator>, crate::drive::DriveError> {
        let api = self
            .drive_api
            .as_ref()
            .ok_or(crate::drive::DriveError::NotConnected)?;
        api.list_permissions(file_id)
    }

    /// D2: drive_connect end-to-end.
    ///
    /// 1. Build the OAuth `AuthBuilder` from settings (BYO client_id wins
    ///    over the shipped default).
    /// 2. Run the loopback PKCE flow — production opens the system browser
    ///    via `default_open_url`; the test seam (`drive_connect_for_test`)
    ///    swaps in a worker thread that fires the consent redirect back at
    ///    the loopback listener.
    /// 3. Persist the refresh token under `<config_dir>/drive_tokens.bin`
    ///    using the in-process facade in `drive::tokens` (production swaps
    ///    in Stronghold; the public API is identical so this code path
    ///    doesn't change when the swap lands).
    /// 4. Initialize a shared `DriveApi` with the access token and stash
    ///    it in `self.drive_api`.
    /// 5. Flip `settings.cloud.drive.connected` + `account_email`.
    /// 6. Recompute every open tab's backend so Local→DriveDesktop in-place
    ///    upgrades take effect (DriveApi tabs are not downgraded).
    /// 7. Initialize the `polling_cancel` watch channel and spawn the
    ///    polling task with a cancel handle.
    ///
    /// The caller must NOT hold the workspace mutex across this method —
    /// `run_loopback_flow` blocks for up to 5 minutes while the user
    /// clicks through OAuth. The IPC handler in main.rs already drops the
    /// state lock around the call (it's the `&mut self` borrow that holds
    /// the lock; the IPC handler scope ends after the borrow returns).
    pub fn drive_connect(&mut self, app: &tauri::AppHandle) -> Result<()> {
        self.drive_connect_inner(default_open_url)?;
        // Spawn the polling task with a cancel handle. The watch channel
        // initial value is `true` so `*cancel_rx.borrow()` reads as "still
        // alive"; drive_disconnect drops the sender to signal cancellation.
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(true);
        self.polling_cancel = Some(cancel_tx);
        tauri::async_runtime::spawn(run_polling_loop_with_cancel(
            app.clone(),
            cancel_rx,
        ));
        Ok(())
    }

    /// D2: shared OAuth + token-persist + DriveApi-populate pipeline.
    /// Production callers go through `drive_connect`; tests use
    /// `drive_connect_for_test` which supplies a worker-thread opener that
    /// simulates the user-consent redirect.
    fn drive_connect_inner(
        &mut self,
        open_url: impl FnOnce(&str) + Send + 'static,
    ) -> Result<()> {
        let settings_snapshot = self.settings.get();
        let mut builder = crate::drive::auth::AuthBuilder::new();
        if let Some(byo) = settings_snapshot.cloud.drive.custom_oauth_client_id.as_ref() {
            builder = builder.with_byo_client_id(Some(byo));
        }

        // 5-minute timeout matches Google's default consent window. The
        // closure synchronously opens the browser; the loopback listener
        // recv-loops until the redirect arrives or the timeout elapses.
        let token = crate::drive::auth::run_loopback_flow(
            builder,
            std::time::Duration::from_secs(300),
            open_url,
        )
        .map_err(|e| anyhow::anyhow!("OAuth failed: {}", e))?;

        // Extract the email claim from the id_token. Falls back to a
        // sentinel string when the id_token is missing or malformed —
        // production always receives an id_token because the consent URL
        // includes the `openid email` scopes.
        let email = token
            .id_token
            .as_deref()
            .and_then(crate::drive::auth::extract_email_from_id_token)
            .unwrap_or_else(|| "unknown@drive.local".into());

        // Persist the refresh token (when present — Google only returns it
        // on the first consent for a given client_id).
        if let Some(refresh) = token.refresh_token.as_ref() {
            // The Stronghold plugin's path lives in the production binary;
            // for the in-process facade we derive the snapshot path from
            // self.config_dir (mirrors the test harness in
            // `drive_tokens.rs`). Failures here are NOT fatal — connect
            // should still succeed against the live API even if disk
            // persistence drops the token.
            let key = crate::drive::keyring::vault_key();
            if let Ok(store) = crate::drive::tokens::TokenStore::open_for_test(
                self.config_dir.join("drive_tokens.bin"),
                &key,
            ) {
                if let Err(e) =
                    crate::drive::tokens::save_refresh_token(&store, &email, refresh)
                {
                    tracing::warn!(?e, "drive: refresh token persist failed");
                }
            }
        }

        // Initialize the shared DriveApi BEFORE recomputing backends — A7's
        // recompute writes Local→DriveDesktop in place but doesn't touch
        // DriveApi, so it doesn't actually need the API populated; the
        // ordering is defensive (and matches the spec's `Avoid` note).
        let api = std::sync::Arc::new(
            crate::drive::api::DriveApi::with_token(token.access_token),
        );
        self.drive_api = Some(api);

        self.settings.update(|s| {
            s.cloud.drive.connected = true;
            s.cloud.drive.account_email = Some(email);
        })?;

        self.recompute_backends_after_connect_change(true);
        Ok(())
    }

    /// A7+D2: disconnect drops the API handle, signals the polling task to
    /// cancel, recomputes backends so any `DriveDesktop` tabs degrade back
    /// to `Local`, and clears the cached last-status snapshot so the next
    /// status check emits a fresh `drive-status-changed`. `DriveApi` tabs
    /// are not touched here — they're held so the user can be prompted to
    /// reconnect (D-task TBD).
    pub fn drive_disconnect(&mut self) {
        // D2: drop the cancel sender so the polling task's
        // `cancel_rx.changed().await` resolves with Err and the loop exits.
        // `.take()` rather than `.send(false)` because dropping the sender
        // signals cancellation to every clone of the Receiver — sending
        // false is redundant and can race against an already-dropped rx.
        if let Some(tx) = self.polling_cancel.take() {
            // Best-effort flip-then-drop: subscribers awaiting `.changed()`
            // wake on either the value transition or the sender drop.
            let _ = tx.send(false);
            drop(tx);
        }
        self.drive_api = None;
        // Pass `false` explicitly: the disconnect intent is unambiguous and
        // we must not depend on a settings round-trip (the settings flag may
        // not have been flipped yet at the time this is called, which would
        // leave DriveDesktop tabs incorrectly connected).
        self.recompute_backends_after_connect_change(false);
        self.last_drive_status = None;
    }

    /// D2: per-file polling step. Fetches Drive's comment list for
    /// `file_id` (with the `If-None-Match` etag from `cache_meta` so 304s
    /// short-circuit cleanly), translates each Drive comment into a local
    /// `Thread`, and merges the threads into the matching tab's
    /// `CommentsStore`.
    ///
    /// Errors:
    ///   - `DriveError::NotConnected` when `self.drive_api` is None.
    ///   - `DriveError::Api(_)` for any underlying HTTP failure surfaced
    ///     by `list_comments`.
    ///
    /// 304 responses surface as an empty `comments` Vec (the
    /// `drive::api::list_comments` mapper handles the status code), in
    /// which case the merge is a no-op.
    pub fn drive_poll_one(
        &mut self,
        file_id: &str,
    ) -> Result<(), crate::drive::DriveError> {
        let api = self
            .drive_api
            .as_ref()
            .ok_or(crate::drive::DriveError::NotConnected)?
            .clone();

        let cache_meta =
            crate::drive::cache::load_cache_meta(self.config_dir(), file_id);
        let etag_owned = cache_meta.as_ref().map(|m| m.etag.clone());
        let prior_sha = cache_meta
            .as_ref()
            .map(|m| m.content_sha256.clone())
            .unwrap_or_default();

        let resp = api.list_comments(&crate::drive::api::ListCommentsArgs {
            file_id,
            start_modified_time: None,
            if_none_match: etag_owned.as_deref(),
        })?;

        // D2 review fix: persist cache_meta with the response's ETag and a
        // fresh `last_fetched` BEFORE the empty-comments early return so the
        // next poll can replay `If-None-Match` and trust the 304 fast path.
        // Skipped when the response had no ETag header — that covers both
        // `list_comments`'s synthetic 304 short-circuit (it returns
        // `response_etag: None`) and stub servers that omit the header. We
        // preserve `content_sha256` from the prior cache_meta because the
        // poller never touches the file body — only the file-download path
        // (`drive::files::download_into_cache`) computes that hash.
        if let Some(new_etag) = resp.response_etag.as_deref() {
            let new_meta = crate::drive::cache::CacheMeta {
                etag: new_etag.to_string(),
                last_fetched: crate::drive::files::now_rfc3339(),
                content_sha256: prior_sha,
            };
            if let Err(e) = crate::drive::cache::save_cache_meta(
                self.config_dir(),
                file_id,
                &new_meta,
            ) {
                // cache_meta is a best-effort optimization — a write
                // failure shouldn't block the merge or surface to the
                // caller. The next poll will simply re-fetch unconditionally.
                tracing::warn!(?e, file_id, "drive_poll_one cache_meta save failed");
            }
        }

        if resp.comments.is_empty() {
            return Ok(());
        }

        // Find the matching tab and merge each translated thread into its
        // CommentsStore. Threads with the same id replace existing entries
        // so a re-poll with updated content (new replies, resolved flag)
        // overwrites cleanly.
        let tab_id = self
            .tabs
            .values()
            .find(|t| t.file_id.as_deref() == Some(file_id))
            .map(|t| t.id.clone());
        let Some(tab_id) = tab_id else {
            // No matching open tab — drop the merge silently. The next
            // open of this file_id will see the comments via a fresh poll.
            return Ok(());
        };

        if let Some(tab) = self.tabs.get_mut(&tab_id) {
            // Build a new threads vec with the existing entries first,
            // then overlay each fetched thread by id (replace if present,
            // append otherwise). This preserves any local-only threads
            // while honoring server state for shared ones.
            let mut threads = tab.comments.list_threads().to_vec();
            for drive_comment in &resp.comments {
                if let Some(new_thread) =
                    crate::drive::comments::from_drive_comment(drive_comment)
                {
                    if let Some(slot) =
                        threads.iter_mut().find(|t| t.id == new_thread.id)
                    {
                        *slot = new_thread;
                    } else {
                        threads.push(new_thread);
                    }
                }
            }
            tab.comments.replace_all(threads);
        }

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
                // B2: DriveApi tabs set this from download_to_cache's outcome;
                // Local + DriveDesktop tabs leave it None — they have no
                // ETag concept.
                etag: None,
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

    /// B2: mutable accessor for the post-save etag refresh path. The
    /// `save_document` IPC handler in main.rs needs to update `tab.etag`
    /// after a successful DriveApi upload — without exposing `tabs`
    /// directly, this accessor is the narrow API for that single mutation.
    pub fn tab_mut(&mut self, id: &str) -> Option<&mut Tab> {
        self.tabs.get_mut(id)
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

/// D2: production browser-opener used by `drive_connect`. Fires the
/// platform-default URL handler asynchronously so the OAuth-loopback
/// thread doesn't block on the spawn. Errors are swallowed: the loopback
/// listener will time out (5 minutes) and surface the original "OAuth
/// failed" error if the browser never came up.
fn default_open_url(url: &str) {
    #[cfg(target_os = "macos")]
    let res = std::process::Command::new("open").arg(url).spawn();
    #[cfg(target_os = "linux")]
    let res = std::process::Command::new("xdg-open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let res = std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn();
    if let Err(e) = res {
        tracing::warn!(?e, "drive: failed to open browser for OAuth");
    }
}

/// D2 test helper: build an `open_url` closure that, instead of opening a
/// browser, parses the authorize URL it receives and fires the consent
/// redirect back at the loopback listener as a worker-thread HTTP GET.
/// The returned closure also stashes the authorize URL into `captured` so
/// the BYO-client-id flow can assert on the `client_id` query parameter.
///
/// Lives in workspace.rs (rather than a `#[cfg(test)]` module) so the
/// integration test crates under `src-tauri/tests/` can drive
/// `drive_connect_for_test` without copy-pasting the redirect-firing
/// boilerplate into every test.
pub(crate) fn make_test_opener(
    captured: std::sync::Arc<std::sync::Mutex<Option<String>>>,
) -> impl FnOnce(&str) + Send + 'static {
    move |auth_url: &str| {
        *captured.lock().unwrap() = Some(auth_url.to_string());
        let url_owned = auth_url.to_string();
        std::thread::spawn(move || {
            // Brief delay so the loopback listener's recv-loop is parked
            // when the redirect arrives — without it the thread can race
            // ahead and the listener's first `recv_timeout` returns Ok(None)
            // before the GET is even queued.
            std::thread::sleep(std::time::Duration::from_millis(50));
            let parsed = match url::Url::parse(&url_owned) {
                Ok(u) => u,
                Err(_) => return,
            };
            let q: std::collections::HashMap<_, _> =
                parsed.query_pairs().into_owned().collect();
            let redirect = match q.get("redirect_uri").cloned() {
                Some(r) => r,
                None => return,
            };
            let state = q.get("state").cloned().unwrap_or_default();
            let target = format!("{}/?code=test-code&state={}", redirect, state);
            let _ = reqwest::blocking::Client::new()
                .get(&target)
                .timeout(std::time::Duration::from_secs(2))
                .send();
        });
    }
}

/// B2 (groundwork for B5): typed save-path error. The dispatch in main.rs
/// matches on this and turns `DriveConflict` into a `SaveOutcome::Conflict`
/// payload that the existing diff-merge view can render. `Io` and `Drive`
/// surface as plain `Err(String)` so the existing toast path picks them up.
#[derive(Debug)]
pub enum SaveError {
    Io(std::io::Error),
    Drive(crate::drive::DriveError),
    /// Both the user's local bytes and the freshly-fetched remote bytes
    /// the conflict diff needs. `source` disambiguates the two Drive code
    /// paths (DriveApi 412 vs DriveDesktop watcher mismatch) so wireframe
    /// 07's banner copy can be picked accordingly.
    DriveConflict {
        local: Vec<u8>,
        remote: Vec<u8>,
        source: ConflictSource,
    },
}

#[derive(Debug, Clone)]
pub enum ConflictSource {
    DriveApiEtag,
    DriveDesktopWatcher,
}

impl ConflictSource {
    /// Canonical wire-format string for the Drive conflict source. The frontend
    /// `Conflict.ts` view's `DriveConflictSource` TS literal type matches these
    /// strings exactly — the diff-merge banner copy switch keys off them.
    ///
    /// We deliberately avoid `format!("{:?}", source)` (which Phase B's first
    /// implementation review flagged as fragile): a future `#[derive(Debug)]`
    /// rename would silently break the wire format. The `to_wire` indirection
    /// makes the contract explicit and unit-testable in this same module.
    pub fn to_wire(&self) -> &'static str {
        match self {
            Self::DriveApiEtag => "DriveApiEtag",
            Self::DriveDesktopWatcher => "DriveDesktopWatcher",
        }
    }
}

impl std::fmt::Display for ConflictSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.to_wire())
    }
}

/// Test helpers exposed at `pub` (rather than `#[cfg(test)]`) so the
/// integration test crates under `src-tauri/tests/` — which are separate
/// crates from `mdviewer_lib` and so don't see `cfg(test)` items — can
/// stand up Workspaces with stubbed Drive state. Production callers must
/// not invoke any of the `*_for_test` / `test_*` methods; the naming
/// convention is the contract.
impl Workspace {
    /// Test-only constructor that wraps `Workspace::new` with `expect`. The
    /// real constructor returns `anyhow::Result` because `SettingsStore::open`
    /// can fail on disk I/O — tests can panic on that branch since they
    /// always pass a fresh tempdir.
    ///
    /// Also wires an internal `Watcher` (with an mpsc sender that's
    /// immediately dropped) so the `save_drive_desktop_tab` flow has a
    /// `compare_for_save` target without forcing every test to construct
    /// + manage one. Production callers go through `Workspace::new` and
    /// rely on B5 plumbing the Tauri-managed Watcher in.
    pub fn new_for_test(config_dir: &std::path::Path) -> Self {
        let mut ws = Self::new(config_dir).expect("Workspace::new for tests");
        // Drop the receiver immediately — the watcher's notify thread will
        // silently fail to send on every event, which is fine for tests
        // that only exercise the snapshot map (note_open / compare_for_save).
        let (tx, _rx) = std::sync::mpsc::channel();
        ws.watcher = Some(crate::watcher::Watcher::new(tx).expect("Watcher::new for tests"));
        ws
    }

    /// Test-only setter so integration tests can inject a stub `DriveApi`
    /// (one whose base URL points at `MDVIEWER_DRIVE_API_BASE` → `tiny_http`
    /// stub server) without going through the full OAuth flow.
    pub fn set_drive_api_for_test(&mut self, api: std::sync::Arc<crate::drive::api::DriveApi>) {
        self.drive_api = Some(api);
    }

    /// D2 test seam: run the full `drive_connect` OAuth + token-persist +
    /// DriveApi-populate pipeline without spawning the polling task (the
    /// production path needs a real `tauri::AppHandle` for that). The
    /// internal opener is a worker thread that simulates the user-consent
    /// redirect by parsing the authorize URL it receives, extracting the
    /// `redirect_uri` + `state` query parameters, and firing an HTTP GET
    /// at the loopback listener with `?code=test-code&state=<state>`.
    /// `polling_cancel` is initialized so `drive_disconnect` can still
    /// exercise the cancel-signal path without an active polling task.
    pub fn drive_connect_for_test(&mut self) -> anyhow::Result<()> {
        let captured = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
        self.drive_connect_inner(make_test_opener(captured.clone()))?;
        // Initialize polling_cancel so drive_disconnect's cancel-signal
        // path is observable from tests. Production goes through
        // drive_connect which spawns the polling task; the test seam keeps
        // the channel but skips the spawn.
        let (cancel_tx, _cancel_rx) = tokio::sync::watch::channel(true);
        self.polling_cancel = Some(cancel_tx);
        Ok(())
    }

    /// D2 test seam: like `drive_connect_for_test`, but additionally
    /// returns the captured authorize URL so tests can assert on the
    /// `client_id` query parameter (the BYO-client-id wiring contract).
    pub fn drive_connect_capture_auth_url_for_test(
        &mut self,
    ) -> anyhow::Result<Option<String>> {
        let captured = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
        self.drive_connect_inner(make_test_opener(captured.clone()))?;
        let (cancel_tx, _cancel_rx) = tokio::sync::watch::channel(true);
        self.polling_cancel = Some(cancel_tx);
        let url = captured.lock().unwrap().clone();
        Ok(url)
    }

    /// D2 test seam: subscribe to the polling-cancel watch channel so
    /// tests can observe the signal sent by `drive_disconnect`. Returns
    /// `None` when no polling task is registered (i.e., `drive_connect`
    /// has not been called).
    pub fn polling_cancel_rx_for_test(
        &self,
    ) -> Option<tokio::sync::watch::Receiver<bool>> {
        self.polling_cancel.as_ref().map(|tx| tx.subscribe())
    }

    /// Test-only constructor for a DriveApi-backed tab. Used by B5's
    /// drive_save_conflict tests so they can stand up a tab with a known
    /// `file_id` + initial etag without round-tripping through
    /// `drive_open_url` (which would need a stub server).
    pub fn test_open_drive_api_tab(&mut self, file_id: &str, content: &str) -> String {
        let id = format!("tab-test-{}", file_id);
        let render = render_markdown(
            content,
            &RenderOptions {
                syntax_highlighting: false,
                mermaid_enabled: false,
            },
        );
        self.tabs.insert(
            id.clone(),
            Tab {
                id: id.clone(),
                path: std::path::PathBuf::from(format!("drive-api://{}", file_id)),
                source: content.into(),
                render,
                comments: CommentsStore::new(),
                last_saved_snapshot: Some(content.into()),
                backend: TabBackend::DriveApi,
                file_id: Some(file_id.into()),
                etag: None,
            },
        );
        self.order.push(id.clone());
        self.active = Some(id.clone());
        id
    }

    /// Test-only constructor for a DriveDesktop-backed tab. Used by B5's
    /// `drive_save_conflict` tests to stand up a tab pointing at a real
    /// on-disk file and capture the open-time `(mtime, sha256)` snapshot
    /// via the workspace's internal watcher (`new_for_test` initializes one).
    /// The returned tab id can then be passed to `save_drive_desktop_tab`
    /// to exercise the watcher-backed save-conflict path end-to-end.
    pub fn test_open_drive_desktop_tab(&mut self, path: &std::path::Path) -> String {
        // Round-trip through open_document so the canonicalization path,
        // sidecar load, and tab-id minting match the production shape.
        let outcome = self
            .open_document(path, OpenOpts::default())
            .expect("test_open_drive_desktop_tab: open_document failed");
        let id = match outcome {
            OpenOutcome::Document(r) => r.tab_id,
            OpenOutcome::Conflict { .. } => {
                panic!("test_open_drive_desktop_tab: expected Document, got Conflict")
            }
        };
        // Force the backend to DriveDesktop regardless of detect path —
        // tests use arbitrary tempdirs that don't match Drive Desktop
        // mount heuristics.
        if let Some(tab) = self.tabs.get_mut(&id) {
            tab.backend = TabBackend::DriveDesktop;
        }
        // Capture the open-time snapshot so a subsequent
        // `save_drive_desktop_tab` can call `compare_for_save` against it.
        if let Some(w) = self.watcher.as_ref() {
            w.note_open(path)
                .expect("test_open_drive_desktop_tab: watcher.note_open failed");
        }
        id
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
/// Cancellation: prefer `run_polling_loop_with_cancel` for new spawns. It wraps
/// this loop in a tokio::select! against a watch::Receiver<bool>; drop the
/// matching Sender (or send false) to terminate. drive_connect already does
/// this — the bare run_polling_loop is kept only for future direct callers.
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
        // CURRENT LIMITATION: the body below holds the workspace lock across
        // `drive_poll_one`, which serializes all 8 permits down to 1. The
        // semaphore is kept (rather than removed) so that a future restructure
        // — snapshot per-file inputs (file_id, etag, last_fetched), drop the
        // lock, do the reqwest call, re-acquire to merge results into
        // id_maps/cache_meta — gets the cap "for free" without re-introducing
        // the bound. Treat the 8-permit cap as documenting future intent: it
        // *will* bound concurrency once the lock pattern is lifted; today it
        // bounds future-concurrent calls only.
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
                    // D2: drive_poll_one now reads `self.drive_api` rather
                    // than taking a passed-in `&DriveApi`. The api2 clone is
                    // still used below for the offline-queue replay path.
                    let _api_keepalive = &api2;
                    let poll_ok = match ws.drive_poll_one(&fid) {
                        Ok(()) => true,
                        Err(e) => {
                            tracing::debug!("drive poll {} failed: {}", fid, e);
                            false
                        }
                    };
                    // B6: replay any offline-queued ops for this file_id
                    // when the poll succeeded — this catches connectivity
                    // blips that don't go through `drive_connect`. Snapshot
                    // the (config_dir, id_map_arc) under the lock, then
                    // drop it before the API roundtrip so other IPC
                    // handlers aren't blocked. We deliberately re-`open`
                    // the queue from the same path rather than holding a
                    // `&DriveQueue` across the lock drop — DriveQueue is a
                    // path + per-process Mutex<()>, and its append/drain
                    // both rely on `O_APPEND` atomicity at the file layer,
                    // so two handles for the same path are safe in-process.
                    if poll_ok {
                        let cfg = ws.config_dir().to_path_buf();
                        let id_map = ws
                            .id_maps_arc_clone()
                            .get(&fid)
                            .cloned();
                        drop(ws);
                        if let Some(map) = id_map {
                            let q = crate::drive::queue::DriveQueue::open(&cfg, &fid);
                            if !q.is_empty() {
                                if let Err(e) =
                                    crate::drive::queue::replay(&q, &api2, &fid, &map)
                                {
                                    tracing::debug!(
                                        "drive replay {} pending: {:?}",
                                        fid,
                                        e
                                    );
                                }
                            }
                        }
                        // Re-acquire the lock for the status diff below.
                        ws = state.lock().expect("workspace lock poisoned");
                    }
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

/// D2: cancel-aware wrapper around `run_polling_loop`. Runs the loop and
/// the cancel-watcher in a `tokio::select!` — when `cancel_rx.changed()`
/// resolves (either because the value flipped or because the sender was
/// dropped by `drive_disconnect`), the loop is aborted at the next
/// suspension point.
pub async fn run_polling_loop_with_cancel(
    app: tauri::AppHandle,
    mut cancel_rx: tokio::sync::watch::Receiver<bool>,
) {
    tokio::select! {
        _ = run_polling_loop(app) => {
            // run_polling_loop never returns naturally — it's an infinite
            // loop. Reaching this branch means the inner task was somehow
            // cancelled (e.g. runtime shutdown).
        }
        _ = async move {
            // Wait for cancellation: either the value flips off, or the
            // sender is dropped. Both surface as the next .changed() call
            // resolving (the latter as Err, which we just exit on).
            loop {
                if cancel_rx.changed().await.is_err() {
                    break;
                }
                if !*cancel_rx.borrow() {
                    break;
                }
            }
        } => {
            tracing::debug!("drive: polling loop cancelled");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ConflictSource;

    /// Phase B integration review fix #5: the diff-merge view's banner-copy
    /// switch keys off these literal strings. A future variant rename or a
    /// derived-Debug shape change must NOT change the wire format silently —
    /// this assertion is what makes that contract checkable.
    #[test]
    fn conflict_source_wire_format_is_stable() {
        assert_eq!(ConflictSource::DriveApiEtag.to_wire(), "DriveApiEtag");
        assert_eq!(
            ConflictSource::DriveDesktopWatcher.to_wire(),
            "DriveDesktopWatcher"
        );
        // Display impl must agree with to_wire so callers can use either spelling.
        assert_eq!(format!("{}", ConflictSource::DriveApiEtag), "DriveApiEtag");
        assert_eq!(
            format!("{}", ConflictSource::DriveDesktopWatcher),
            "DriveDesktopWatcher"
        );
    }
}
