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
use mdviewer_core::ssh_url::SshUrl;
use serde::Serialize;
use std::borrow::Cow;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// A8: tab location discriminator at the open/save dispatch boundary.
///
/// Per the design "additive refactor" rule: this enum is exposed at
/// `open_ssh_url` and the save-dispatch layer only. The internal
/// `Tab.path: PathBuf` (consumed by the watcher, renderer, autosave pump,
/// and conflict dialog) continues to be a local-fs path — for `Ssh`
/// locations it points at the cache mirror under
/// `<cache>/host_port_user/<remote-path>`.
///
/// Why not push `LocationKind` into every field that today carries a
/// PathBuf: the watcher and renderer have no concept of "the remote
/// truth"; they observe the on-disk cache file. Widening their argument
/// types serves no purpose and explodes the diff. The dispatch site is
/// the natural boundary because that's where we choose Local vs Ssh
/// transport semantics.
#[derive(Debug, Clone)]
pub enum LocationKind {
    Local(PathBuf),
    Ssh(SshUrl),
}

impl LocationKind {
    /// The local-fs path the watcher / renderer / autosave pump should
    /// consume. `Local` returns the path verbatim (no allocation); `Ssh`
    /// computes the cache mirror via `ssh::operations::cache_path_for_url`
    /// and returns it as `Cow::Owned`. Callers that need a `&Path` can
    /// `&*` the `Cow`.
    pub fn local_path<'a>(&'a self, ssh_cache_base: &Path) -> Cow<'a, Path> {
        match self {
            LocationKind::Local(p) => Cow::Borrowed(p.as_path()),
            LocationKind::Ssh(url) => {
                Cow::Owned(crate::ssh::operations::cache_path_for_url(ssh_cache_base, url))
            }
        }
    }

    /// A8 (Step 7): autosave-dispatch tier picker. Returns
    /// `(interval_ms, enabled)` for this tab's autosave pump. Local tabs
    /// keep the legacy `auto_save` + `auto_save_debounce_ms` knobs; SSH
    /// tabs read the independent `autosave.ssh_interval_ms` +
    /// `autosave.ssh_enabled` fields (Decision 6 — a metered link must be
    /// togglable without losing local autosave).
    ///
    /// The actual autosave pump lives in the TS frontend (`Edit.ts`); the
    /// Rust helper exists so the future autosave-dispatch IPC (or a
    /// per-tab Settings query) has a typed seam that the frontend can
    /// call into without re-implementing the branching logic on either
    /// side.
    pub fn autosave_settings(&self, editor: &crate::settings::EditorSettings) -> (u32, bool) {
        match self {
            LocationKind::Local(_) => (editor.auto_save_debounce_ms, editor.auto_save),
            LocationKind::Ssh(_) => (editor.autosave.ssh_interval_ms, editor.autosave.ssh_enabled),
        }
    }
}

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

/// A8: per-tab SSH state stashed at `open_ssh_url` time. Keyed on the tab id
/// in `Workspace.ssh_tabs`. Saved separately from `Tab` because the rest of
/// the workspace (watcher / renderer / autosave / save-dispatch for Local
/// and Drive backends) is PathBuf-shaped — only the SSH-aware code paths
/// (save-back, session restore, future A9 IPC commands) need to recover
/// the original `SshUrl` and the open-time hash.
///
/// The previous implementation dropped both values via `let _ = url` /
/// `let _ = outcome.sha256` to silence dead-code warnings, but those are
/// exactly the values that:
///   * save-back needs (the `SshUrl` to push to, the open-time hash to
///     diff against the remote in the pre-save recheck — see
///     `Operations::save_back`'s `on_open_sha` argument), and
///   * conflict detection needs (the open-time hash IS the
///     `ConflictSource::SshHashMismatch` discriminator's evidence).
#[derive(Debug, Clone)]
pub struct SshTabState {
    pub url: SshUrl,
    pub last_open_sha256: [u8; 32],
}

/// A1 (multi-window): the label of the first window. Spawned windows get
/// `win-{nanos}`; the first window keeps the stable `"main"` label so the
/// v1→v2 session migration and the delegating single-window wrappers
/// (`open_document`, `close_tab`, …) have a known target. Window identity is
/// a `String` label, never a client-supplied id — see the design's "Key
/// Decisions".
pub const MAIN_LABEL: &str = "main";

/// A1: per-window position + size in logical pixels. Persisted to
/// `session.json` v2 (`03-session-schema-v2.md`) and used at restore to
/// place each window. `None` ⇒ let the OS place it.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, serde::Deserialize)]
pub struct WindowGeometry {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

/// A1: a registered window in the workspace. Holds the window's stable label
/// and its last-known geometry. The window's tab list + active tab live in
/// the workspace's per-window `order`/`active` maps keyed by this label —
/// there is a single mutex-guarded `Workspace` with a window-keyed view over
/// one global tab map (per-window `Workspace` instances were rejected; see
/// the task "Avoid" notes).
#[derive(Debug, Clone)]
pub struct WindowEntry {
    pub label: String,
    pub geometry: Option<WindowGeometry>,
}

/// A1: wire-shaped per-window summary for `list_windows` / `new_window` /
/// `detach_tab`. The IPC layer (B2) adds the `focused` flag from the live
/// window list; the pure-Rust core only knows `label` / `active_doc_name` /
/// `tab_count`.
#[derive(Debug, Clone, PartialEq)]
pub struct WindowSummaryData {
    pub label: String,
    pub active_doc_name: Option<String>,
    pub tab_count: u32,
}

/// D1: wire-shaped per-window summary returned by the `list_windows` IPC
/// command. Mirrors [`WindowSummaryData`] (the pure-core projection) and adds
/// the `focused` flag the IPC layer fills from the live Tauri window list —
/// the pure core can't know which native window the OS currently has focused.
/// Crosses IPC, so it carries `#[derive(ts_rs::TS)]` and is exported into
/// `src/types-generated.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct WindowSummary {
    pub label: String,
    pub active_doc_name: Option<String>,
    pub tab_count: u32,
    pub focused: bool,
}

/// A1: result of `open_in_new_window_resolve` — the one-owner decision the
/// IPC layer (B2) acts on. `Existing` means `path` is already open in a
/// window; the caller focuses that window+tab. `NeedsNew` means no tab owns
/// `path`; the caller spawns a new window and opens it there.
#[derive(Debug, Clone, PartialEq)]
pub enum OneOwnerResolution {
    Existing { label: String, tab_id: String },
    NeedsNew,
}

/// A1: per-window snapshot used to build the v2 session payload
/// (`03-session-schema-v2.md`). `persist_session` collects one of these per
/// registered window. B1 swaps the `SessionStore` to a v2 shape that
/// consumes these; B2 calls the v2 save. A1 keeps the existing v1 save path.
#[derive(Debug, Clone, PartialEq)]
pub struct WindowSnapshot {
    pub label: String,
    pub tabs: Vec<PathBuf>,
    pub active: Option<PathBuf>,
    pub geometry: Option<WindowGeometry>,
}

pub struct Tab {
    pub id: String,
    pub path: PathBuf,
    /// A1 (multi-window): which window owns this tab. Defaults to
    /// `MAIN_LABEL` at every construction site for now; B2 threads the real
    /// caller label through `open_document`/`drive_open_url`/`open_ssh_url`.
    /// `move_tab`/`detach_tab` edit this field — a cross-window move is a
    /// label edit over the single global tab map, never a serialize-out/in.
    pub window_label: String,
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
    /// The on-disk copy changed since open but the tab has **no unsaved
    /// edits**, and `external_change_behavior` is `Ask`. There is nothing to
    /// merge (the in-memory copy is identical to the last-saved bytes), so the
    /// frontend should surface the lightweight "changed on disk — reload?"
    /// banner rather than the 3-way merge. The IPC layer translates this into
    /// an `external-change` (ask) event plus a `Document` carrying the current
    /// content, so the view stays put until the user chooses to reload.
    ExternalReload { tab_id: String, path: PathBuf },
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
    /// A1 (multi-window): the window registry. One entry per open window;
    /// seeded with a single `"main"` entry in `Workspace::new`. A zero-tab
    /// window keeps its registry entry (it shows the StartPage) — windows
    /// are only dropped by `close_window`.
    windows: Vec<WindowEntry>,
    /// A1: per-window left-to-right tab order, keyed by window label. The
    /// global `tabs` map is the single owner of every `Tab`; `order[label]`
    /// is the window's view over it. A cross-window move edits `Tab.window_label`
    /// and shuffles ids between two `order` vecs without touching `tabs`.
    order: HashMap<String, Vec<String>>,
    /// A1: per-window active tab, keyed by window label. `None` ⇒ the window
    /// shows the StartPage (no active tab). Repaired by `close_tab_for` and
    /// `move_tab` to the next remaining tab in the window's order.
    active: HashMap<String, Option<String>>,
    /// A1: most-recently-focused window label. Seeded `"main"`; updated by
    /// the IPC focus handler (B2) via `set_mrf_label`. Used to route a
    /// file-association/CLI open with no explicit window to the window the
    /// user last touched.
    mrf_label: String,
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
    /// A8: per-tab SSH state keyed by tab id. Populated by `open_ssh_url`
    /// with the parsed `SshUrl` and `OpenOutcome.sha256`; consumed by the
    /// future B5 save-back path (which needs the URL to push to and the
    /// open-time hash for the pre-save remote-drift recheck) and by future
    /// A9 IPC surfaces (per-tab SSH metadata queries, session restore).
    /// Cleared in `close_tab` so a closed-and-reopened SSH tab doesn't
    /// pick up stale state. See `SshTabState` for the rationale.
    pub(crate) ssh_tabs: HashMap<String, SshTabState>,
}

/// Canonicalize a path for tab-lookup comparison, falling back to the path
/// as-given when canonicalization fails (e.g. the path doesn't exist on disk).
///
/// Tab-path lookups must canonicalize BOTH the query and each stored
/// `Tab.path`. Local-file tabs store a canonical path (`open_document`
/// canonicalizes on store), but SSH tabs store the raw cache path
/// un-canonicalized. On Linux `/tmp` is not a symlink so raw == canonical and
/// raw-to-raw comparison happened to match; on macOS (`/tmp` → `/private/tmp`,
/// `/var` → `/private/var`) and Windows the raw stored SSH path differs from
/// `canonicalize(query)`, so a raw comparison MISSED the existing SSH tab and
/// the one-owner/relocate flow silently failed. Canonicalizing both sides is
/// idempotent for already-canonical local paths (no behavior change) and fixes
/// the SSH case without touching how tabs are stored.
fn canon(p: &Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}

impl Workspace {
    pub fn new(data_dir: &Path) -> Result<Self> {
        Ok(Self {
            settings: SettingsStore::open(data_dir)?,
            recents: RecentsStore::open(data_dir)?,
            doc_prefs: DocPrefsStore::open(data_dir)?,
            session: crate::session::SessionStore::open(data_dir)?,
            tabs: HashMap::new(),
            // A1: seed one "main" window with empty order/active. Every
            // workspace boots with exactly one window on the StartPage.
            windows: vec![WindowEntry {
                label: MAIN_LABEL.to_string(),
                geometry: None,
            }],
            order: {
                let mut m = HashMap::new();
                m.insert(MAIN_LABEL.to_string(), Vec::new());
                m
            },
            active: {
                let mut m = HashMap::new();
                m.insert(MAIN_LABEL.to_string(), None);
                m
            },
            mrf_label: MAIN_LABEL.to_string(),
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
            // A8: no SSH tabs at construction time; populated by open_ssh_url.
            ssh_tabs: HashMap::new(),
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
        self.drive_open_url_for(MAIN_LABEL, url)
    }

    /// B2: window-scoped Drive open. Same as `drive_open_url` but the new
    /// DriveApi tab is owned by `label` and registered into that window's
    /// order/active. The file_id de-dupe still spans all windows — a Drive
    /// file already open in any window re-surfaces its existing tab.
    pub fn drive_open_url_for(
        &mut self,
        label: &str,
        url: &str,
    ) -> Result<TabSummary, crate::drive::DriveError> {
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
            render_line_breaks: s.editor.render_line_breaks,
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
            // B2: owned by the calling window's label.
            window_label: label.to_string(),
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
        let label = tab.window_label.clone();
        self.tabs.insert(id.clone(), tab);
        self.order.entry(label.clone()).or_default().push(id.clone());
        self.active.insert(label, Some(id));
        // Mirror the open_document/close_tab/activate_tab pattern so the
        // restored-session list picks up Drive-opened tabs across restarts.
        self.persist_session();
        Ok(summary)
    }

    /// A8: open an `ssh://` markdown document by URL.
    ///
    /// Mirrors `drive_open_url` for the SSH transport: fetch the remote
    /// bytes via `Operations::open_url` (which hashes them + mirrors them
    /// to the cache mirror under `<cache>/host_port_user/<path>`), then
    /// register a new tab whose `Tab.path` points at the cache mirror.
    /// The watcher, renderer, autosave pump, and conflict dialog continue
    /// to consume the cache PathBuf — the `LocationKind::Ssh(url)`
    /// discriminator lives at the save-dispatch boundary (see Decision 6).
    ///
    /// The open-time `sha256` is what `Operations::save_back` later
    /// compares against to detect remote drift and surface a
    /// `ConflictSource::SshHashMismatch`. Phase-3 keeps that hash on the
    /// tab via a separate `ssh_state` map keyed by tab id (B5's wiring);
    /// this method itself just gets the tab onto the cache mirror.
    pub async fn open_ssh_url(
        &mut self,
        url: SshUrl,
        ops: &crate::ssh::operations::Operations,
    ) -> Result<TabSummary, crate::ssh::transport::TransportError> {
        let outcome = ops.open_url(&url).await?;
        Ok(self.register_ssh_tab_from_outcome(url, outcome))
    }

    /// A9: synchronous half of `open_ssh_url`. The IPC handler in `main.rs`
    /// holds a `std::sync::Mutex<Workspace>` which cannot be held across the
    /// `.await` on `ops.open_url(...)` (the guard isn't `Send`). The handler
    /// therefore runs the async fetch lock-free, then calls this method
    /// under the re-acquired lock to register the new tab.
    ///
    /// Pre-condition: `outcome` must come from `Operations::open_url(&url)`
    /// (the cache mirror is keyed on the URL, so handing a mismatched pair
    /// would land the bytes under a wrong path). The combined async path
    /// (`open_ssh_url`) is the single internal call site that ensures the
    /// pre-condition; tests can construct an `Operations` with a fake
    /// transport and reach the same shape through `open_ssh_url`.
    pub fn register_ssh_tab_from_outcome(
        &mut self,
        url: SshUrl,
        outcome: crate::ssh::operations::OpenOutcome,
    ) -> TabSummary {
        self.register_ssh_tab_from_outcome_for(MAIN_LABEL, url, outcome)
    }

    /// B2: window-scoped SSH tab registration. Same as
    /// `register_ssh_tab_from_outcome` but the new tab is owned by `label`
    /// and registered into that window's order/active. Cache-path de-dupe
    /// still spans all windows.
    pub fn register_ssh_tab_from_outcome_for(
        &mut self,
        label: &str,
        url: SshUrl,
        outcome: crate::ssh::operations::OpenOutcome,
    ) -> TabSummary {
        // De-dupe against an already-open tab on the same cache path. The
        // cache mirror is deterministic for a given (host, port, user,
        // path) tuple so two `open_ssh_url` calls for the same URL collapse
        // onto a single tab — matching `drive_open_url`'s file_id de-dupe.
        if let Some(existing) = self
            .tabs
            .values()
            .find(|t| t.path == outcome.cache_path)
        {
            return existing.summary();
        }

        let source = String::from_utf8_lossy(&outcome.bytes).into_owned();
        let s = self.settings.get();
        let opts = RenderOptions {
            syntax_highlighting: s.editor.syntax_highlighting,
            mermaid_enabled: s.editor.mermaid_enabled,
            render_line_breaks: s.editor.render_line_breaks,
        };
        let render = render_markdown(&source, &opts);

        // Sidecar load: comments live alongside the source in the cache
        // mirror (the canonical sidecar resolver runs on the cache path
        // exactly as for local files). Phase-3's CRDT-merge push runs at
        // save time via `Operations::save_sidecar` against the remote.
        let sc_path = sidecar_path(&outcome.cache_path, &s.comments.sidecar_pattern);
        let comments = load_sidecar(&sc_path).unwrap_or_else(|_| CommentsStore::new());

        let id = format!(
            "tab-{:x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let tab = Tab {
            id: id.clone(),
            // B2: owned by the calling window's label.
            window_label: label.to_string(),
            path: outcome.cache_path.clone(),
            source: source.clone(),
            render,
            comments,
            last_saved_snapshot: Some(source),
            // SSH tabs do NOT route through any Drive backend — pin them to
            // Local so the existing save dispatch's Drive paths short-circuit.
            // The LocationKind enum at the IPC save boundary is what selects
            // the SSH save path (`Operations::save_back`); Tab.backend is the
            // legacy Drive discriminator and Local is the right default here.
            backend: TabBackend::Local,
            file_id: None,
            etag: None,
        };
        let summary = tab.summary();
        let label = tab.window_label.clone();
        self.tabs.insert(id.clone(), tab);
        self.order.entry(label.clone()).or_default().push(id.clone());
        self.active.insert(label, Some(id.clone()));
        // A8 review-cycle-1 fix: stash the `SshUrl` and the open-time
        // `OpenOutcome.sha256` per tab so the future B5 save-back path can
        // recover both. The previous `let _ = url; let _ = outcome.sha256;`
        // dropped exactly the values save-back, conflict detection, and
        // session restore need.
        self.ssh_tabs.insert(
            id,
            SshTabState {
                url,
                last_open_sha256: outcome.sha256,
            },
        );
        // Suppress the cache-path entry from the recents list — surfacing
        // the local mirror would mislead the user; they pasted an ssh:// URL,
        // not a local path. A future task can teach Recents about SshUrl
        // entries; for now the URL-paste flow is the only entry point.
        self.persist_session();
        summary
    }

    /// A8 review-cycle-1: read-only accessor for the per-tab SSH state
    /// stashed by `open_ssh_url`. Returns `None` for non-SSH tabs (Local /
    /// DriveDesktop / DriveApi) and for unknown tab ids. The future A9 IPC
    /// commands and B5 save-back path both call through here so they don't
    /// have to know the field name.
    pub fn ssh_state(&self, tab_id: &str) -> Option<&SshTabState> {
        self.ssh_tabs.get(tab_id)
    }

    /// Phase-A impl-review fix: mutable accessor for the per-tab SSH state.
    /// `save_document`'s SSH branch needs this to advance
    /// `last_open_sha256` after `Operations::save_back` reports `Saved` —
    /// otherwise the next save would re-diff against the original open-time
    /// hash and either spuriously flag a conflict (if a peer ever lands
    /// changes that match our last push) or silently push over a peer edit
    /// that landed after ours.
    pub fn ssh_state_mut(&mut self, tab_id: &str) -> Option<&mut SshTabState> {
        self.ssh_tabs.get_mut(tab_id)
    }

    /// B5 dispatch path — uploads `local` to Drive with `If-Match: etag`.
    /// On a 412 (PreconditionFailed) the helper fetches the remote bytes
    /// and surfaces a `SaveError::Conflict { local, remote, source: DriveApiEtag }`
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
            .ok_or(SaveError::Drive(crate::drive::DriveError::NotConnected))?
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
                Err(SaveError::Conflict {
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
    /// `SaveError::Conflict { source: DriveDesktopWatcher }` carrying
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
                Err(SaveError::Conflict {
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
        // Production wrapper: snapshot → OAuth → apply, all in one method.
        // The IPC handler in main.rs uses the three-phase split below to
        // drop the workspace lock around the blocking OAuth call so the
        // app doesn't freeze for up to 5 minutes while the user consents.
        let prep = self.drive_connect_prep();
        let outcome = drive_connect_oauth(prep, default_open_url)?;
        self.drive_connect_apply(app, outcome)
    }

    /// Bug-2 fix (lock-across-blocking-IO): snapshot the inputs the OAuth
    /// phase needs while we hold the workspace lock, so the IPC handler can
    /// drop the lock before invoking `drive_connect_oauth`. Without this,
    /// `Workspace::drive_connect` held `state.lock()` across the up-to-5-min
    /// `run_loopback_flow`, freezing every other IPC call.
    pub fn drive_connect_prep(&self) -> DriveConnectPrep {
        let s = self.settings.get();
        DriveConnectPrep {
            byo_client_id: s.cloud.drive.custom_oauth_client_id.clone(),
            config_dir: self.config_dir.clone(),
        }
    }

    /// Apply the OAuth result: persist refresh token, populate DriveApi,
    /// flip settings, recompute backends, spawn polling. Held under the
    /// re-acquired workspace lock by the IPC handler.
    pub fn drive_connect_apply(
        &mut self,
        app: &tauri::AppHandle,
        outcome: DriveOauthOutcome,
    ) -> Result<()> {
        // Shared state mutation (no polling spawn).
        self.drive_connect_apply_no_spawn(outcome)?;

        // Spawn polling with cancel handle. Production-only — the test
        // seams use `drive_connect_for_test` which skips the spawn and
        // manually initializes polling_cancel.
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(true);
        self.polling_cancel = Some(cancel_tx);
        tauri::async_runtime::spawn(run_polling_loop_with_cancel(
            app.clone(),
            cancel_rx,
        ));
        Ok(())
    }

    /// D2 + Bug-2: test-only OAuth pipeline. Production goes through
    /// `Workspace::drive_connect` (which uses the prep/oauth/apply split so
    /// the IPC handler can drop the workspace lock around the blocking
    /// OAuth call). This helper keeps the test seams (`drive_connect_for_test`,
    /// `drive_connect_capture_auth_url_for_test`) running synchronously
    /// against a stub OAuth server without the lock-management ceremony.
    /// The state mutation half is shared via `drive_connect_apply_no_spawn`.
    fn drive_connect_inner(
        &mut self,
        open_url: impl FnOnce(&str) + Send + 'static,
    ) -> Result<()> {
        let prep = self.drive_connect_prep();
        let outcome = drive_connect_oauth(prep, open_url)?;
        self.drive_connect_apply_no_spawn(outcome)
    }

    /// Apply the OAuth result without spawning the polling task. Test
    /// seams (`drive_connect_for_test`) call this and then manually
    /// initialize `polling_cancel` so the disconnect-cancel path stays
    /// observable. Production via `drive_connect_apply` adds the spawn.
    fn drive_connect_apply_no_spawn(&mut self, outcome: DriveOauthOutcome) -> Result<()> {
        if let Some(refresh) = outcome.refresh_token.as_ref() {
            let key = crate::drive::keyring::vault_key();
            if let Ok(store) = crate::drive::tokens::TokenStore::open_for_test(
                self.config_dir.join("drive_tokens.bin"),
                &key,
            ) {
                if let Err(e) =
                    crate::drive::tokens::save_refresh_token(&store, &outcome.email, refresh)
                {
                    tracing::warn!(?e, "drive: refresh token persist failed");
                }
            }
        }
        let api = std::sync::Arc::new(
            crate::drive::api::DriveApi::with_token(outcome.access_token),
        );
        self.drive_api = Some(api);
        let email = outcome.email;
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
    /// B2: public entry to the eager session save. The `on_window_event`
    /// geometry handler calls this after `set_window_geometry` so a window
    /// move/resize lands in session.json without waiting for the next
    /// open/close. Delegates to the private `persist_session`.
    pub fn persist_session_public(&self) {
        self.persist_session();
    }

    fn persist_session(&self) {
        // A1/B1: build per-window snapshots and save them via the v2 store.
        // One `WindowSession` per registered window, in registry order, each
        // carrying its left-to-right tab paths, its active tab's path, and
        // its last-known geometry. B2 extends the call sites that feed live
        // window geometry; the store canonicalizes local paths and repairs
        // each window's `active` on write.
        let windows: Vec<crate::session::WindowSession> = self
            .window_snapshots()
            .into_iter()
            .map(|w| crate::session::WindowSession {
                tabs: w.tabs,
                active: w.active,
                geometry: w.geometry,
            })
            .collect();
        if let Err(e) = self.session.save_windows(windows) {
            // Session is best-effort — never let a save failure block
            // open / close / activate flow. Log and move on.
            tracing::warn!(?e, "session.json save failed");
        }
    }

    /// A1: build the per-window session snapshot list (the v2 payload shape,
    /// `03-session-schema-v2.md`). One `WindowSnapshot` per registered
    /// window, in registry order, each carrying its left-to-right tab paths,
    /// its active tab's path (if any), and its last-known geometry. B1's
    /// `SessionStore` v2 + B2's v2-save consume this directly.
    pub fn window_snapshots(&self) -> Vec<WindowSnapshot> {
        self.windows
            .iter()
            .map(|w| {
                let tabs: Vec<PathBuf> = self
                    .order
                    .get(&w.label)
                    .map(|ids| {
                        ids.iter()
                            .filter_map(|id| self.tabs.get(id).map(|t| t.path.clone()))
                            .collect()
                    })
                    .unwrap_or_default();
                let active = self
                    .active
                    .get(&w.label)
                    .and_then(|a| a.as_ref())
                    .and_then(|id| self.tabs.get(id))
                    .map(|t| t.path.clone());
                WindowSnapshot {
                    label: w.label.clone(),
                    tabs,
                    active,
                    geometry: w.geometry,
                }
            })
            .collect()
    }

    /// A1 single-window delegating wrapper. Opens in the `main` window.
    /// Kept so callers that don't carry a window label (tests, the CLI /
    /// session-restore boot path that targets `main`) keep working.
    pub fn open_document(&mut self, path: &Path, opts: OpenOpts) -> Result<OpenOutcome> {
        // The label-free wrapper has no watcher to consult for the dirty bit;
        // it's used by tests and the CLI/session-restore boot path, none of
        // which carry unsaved editor state, so `dirty = false` (never merge).
        self.open_document_for(MAIN_LABEL, path, opts, false)
    }

    /// B2: window-scoped open. Identical to the single-window `open_document`
    /// except the freshly-created tab is owned by `label` and registered into
    /// that window's `order`/`active` (instead of always `MAIN_LABEL`). The
    /// already-open and conflict branches are unchanged — an existing tab
    /// re-activates within its own owning window regardless of which window
    /// asked. `label` should be a registered window; an unregistered label
    /// still opens (the `order`/`active` entries are created on demand) which
    /// matches `new_window`'s lazy-entry behavior.
    pub fn open_document_for(
        &mut self,
        label: &str,
        path: &Path,
        _opts: OpenOpts,
        dirty: bool,
    ) -> Result<OpenOutcome> {
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
        if let Some((id, p, mut html, mut source, mut threads, snapshot)) = existing {
            // Re-opening an already-open tab whose on-disk copy changed since
            // we loaded it. A 3-way merge is ONLY warranted when the user has
            // unsaved local edits to protect (`dirty`) — otherwise the
            // in-memory copy is identical to the last-saved bytes and there is
            // nothing to merge. With no edits we defer to the user's
            // `external_change_behavior`: silently reload, prompt (Ask), or
            // keep the current view (Ignore). This is the fix for the
            // "reload offered a bogus merge even though I changed nothing" bug.
            if let Some(snap) = snapshot {
                if let Ok(disk) = std::fs::read_to_string(&canonical) {
                    if disk != snap {
                        if dirty {
                            return Ok(OpenOutcome::Conflict {
                                tab_id: id,
                                path: canonical,
                                local: snap,
                                incoming: disk,
                            });
                        }
                        use crate::settings::ExternalChangeBehavior as B;
                        match self.settings.get().editor.external_change_behavior {
                            B::Reload => {
                                // Pull the new bytes in and return them so the
                                // reopen shows the current content.
                                self.refresh_tab(&canonical)?;
                                if let Some(t) = self.tabs.get(&id) {
                                    html = t.render.html.clone();
                                    source = t.source.clone();
                                    threads = t.comments.list_threads().to_vec();
                                }
                            }
                            B::Ask => {
                                // Activate the tab (so it's current) and let the
                                // IPC layer raise the reload banner.
                                let win = self
                                    .tabs
                                    .get(&id)
                                    .map(|t| t.window_label.clone())
                                    .unwrap_or_else(|| MAIN_LABEL.to_string());
                                self.active.insert(win, Some(id.clone()));
                                self.persist_session();
                                return Ok(OpenOutcome::ExternalReload {
                                    tab_id: id,
                                    path: canonical,
                                });
                            }
                            // Ignore: fall through and re-activate the stale
                            // cached content untouched.
                            B::Ignore => {}
                        }
                    }
                }
            }
            // A1: activate within the tab's owning window. open_document
            // currently always targets MAIN_LABEL (B2 threads the caller
            // window); read the label off the tab so a moved tab still
            // activates in the right window.
            let label = self
                .tabs
                .get(&id)
                .map(|t| t.window_label.clone())
                .unwrap_or_else(|| MAIN_LABEL.to_string());
            self.active.insert(label, Some(id.clone()));
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

        // A closed tab has no live editor and therefore no unsaved edits to
        // protect, so a closed-and-reopened path is always opened with the
        // current on-disk content — never a merge. (Previously this returned
        // Conflict whenever the disk copy differed from the bytes captured at
        // close, which surfaced a bogus 3-way merge on a plain reopen of a
        // file that had simply changed on disk meanwhile.)
        let s = self.settings.get();
        let opts = RenderOptions {
            syntax_highlighting: s.editor.syntax_highlighting,
            mermaid_enabled: s.editor.mermaid_enabled,
            render_line_breaks: s.editor.render_line_breaks,
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
                // B2: the tab is owned by the calling window's label.
                window_label: label.to_string(),
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
        // B2: register into the calling window's order + make it active there.
        self.order
            .entry(label.to_string())
            .or_default()
            .push(id.clone());
        self.active.insert(label.to_string(), Some(id.clone()));
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
            render_line_breaks: s.editor.render_line_breaks,
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

    /// A1: single-window delegating wrapper. Closes a tab in the `main`
    /// window. Kept so existing tests + the (B2-pending) IPC layer keep
    /// compiling until B2 rewires them to `close_tab_for(window_label, id)`.
    pub fn close_tab(&mut self, id: &str) -> Result<()> {
        self.close_tab_for(MAIN_LABEL, id)
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

    /// A1: single-window delegating wrapper over `activate_tab_for(main, id)`.
    pub fn activate_tab(&mut self, id: &str) -> Result<()> {
        self.activate_tab_for(MAIN_LABEL, id)
    }

    /// A1: single-window delegating wrapper over `list_open_documents_for(main)`.
    pub fn list_open_documents(&self) -> Vec<&Tab> {
        self.list_open_documents_for(MAIN_LABEL)
    }

    /// A1: single-window delegating wrapper over `active_tab_id_for(main)`.
    pub fn active_tab_id(&self) -> Option<&str> {
        self.active_tab_id_for(MAIN_LABEL)
    }

    // === A1 (multi-window): window registry + window-scoped methods ===

    /// Register a new window with the given `label`, empty order/active, no
    /// geometry, and return its summary. Idempotent on an existing label
    /// (re-registering "main" is a no-op rather than duplicating the entry).
    pub fn new_window(&mut self, label: String) -> WindowSummaryData {
        if !self.windows.iter().any(|w| w.label == label) {
            self.windows.push(WindowEntry {
                label: label.clone(),
                geometry: None,
            });
            self.order.entry(label.clone()).or_default();
            self.active.entry(label.clone()).or_insert(None);
        }
        self.window_summary(&label)
    }

    /// Close a window: drop every tab it owns from the global tab map (and
    /// their per-tab SSH state), then remove the window's registry entry +
    /// order/active slots. Persists session. No-op-safe if the label is
    /// already gone.
    pub fn close_window(&mut self, label: &str) {
        let ids: Vec<String> = self
            .order
            .get(label)
            .cloned()
            .unwrap_or_default();
        for id in ids {
            // Drop the tab, seeding closed_snapshots so a later reopen can
            // still detect divergence (mirrors close_tab_for).
            if let Some(tab) = self.tabs.remove(&id) {
                if let Some(snap) = tab.last_saved_snapshot {
                    self.closed_snapshots.insert(tab.path, snap);
                }
            }
            self.ssh_tabs.remove(&id);
        }
        self.windows.retain(|w| w.label != label);
        self.order.remove(label);
        self.active.remove(label);
        // If the most-recently-focused window just closed, fall back to the
        // first remaining window (or "main" if somehow none remain).
        if self.mrf_label == label {
            self.mrf_label = self
                .windows
                .first()
                .map(|w| w.label.clone())
                .unwrap_or_else(|| MAIN_LABEL.to_string());
        }
        self.persist_session();
    }

    /// All registered windows as wire-shaped summaries, in registry order.
    pub fn list_windows(&self) -> Vec<WindowSummaryData> {
        self.windows
            .iter()
            .map(|w| self.window_summary(&w.label))
            .collect()
    }

    /// One-owner resolution for "open in new window": if `path` is already
    /// open in any window, return `Existing { label, tab_id }` so the caller
    /// focuses that window+tab; otherwise `NeedsNew` so it spawns a window.
    /// Matches `open_document`'s canonicalization so the path comparison
    /// lines up with how tabs store their path.
    pub fn open_in_new_window_resolve(&mut self, path: &Path) -> OneOwnerResolution {
        let canonical = canon(path);
        match self.tabs.values().find(|t| canon(&t.path) == canonical) {
            Some(tab) => OneOwnerResolution::Existing {
                label: tab.window_label.clone(),
                tab_id: tab.id.clone(),
            },
            None => OneOwnerResolution::NeedsNew,
        }
    }

    /// Move `tab_id` to `to_window` (must be a registered label). Reassigns
    /// the tab's `window_label`, removes it from the source `order` (repairing
    /// the source active to the next remaining tab, or `None` — the source
    /// window stays open on the StartPage, NOT auto-closed), and appends it
    /// to the destination `order` as the destination's active tab. Errors if
    /// `tab_id` is unknown or `to_window` is not registered.
    ///
    /// Returns the source window label the tab was moved away from (its owner
    /// before the reassign). The IPC layer needs this to emit
    /// `workspace-changed` to BOTH the source and destination windows so both
    /// tab strips repaint (design S4) — the frontend deliberately does not
    /// locally repaint the source on a successful move. For a same-window move
    /// the returned label equals `to_window`.
    pub fn move_tab(&mut self, tab_id: &str, to_window: &str) -> Result<String> {
        if !self.tabs.contains_key(tab_id) {
            anyhow::bail!("no such tab: {tab_id}");
        }
        if !self.windows.iter().any(|w| w.label == to_window) {
            anyhow::bail!("no such window: {to_window}");
        }
        let from = self
            .tabs
            .get(tab_id)
            .map(|t| t.window_label.clone())
            .expect("tab existence checked above");
        if from == to_window {
            // Moving within the same window: make it active, no order churn.
            self.active.insert(to_window.to_string(), Some(tab_id.to_string()));
            self.persist_session();
            return Ok(from);
        }
        // Reassign the owning label.
        if let Some(tab) = self.tabs.get_mut(tab_id) {
            tab.window_label = to_window.to_string();
        }
        // Remove from source order + repair source active.
        if let Some(src_order) = self.order.get_mut(&from) {
            src_order.retain(|x| x != tab_id);
            if self.active.get(&from).and_then(|a| a.as_deref()) == Some(tab_id) {
                let next = src_order.last().cloned();
                self.active.insert(from.clone(), next);
            }
        }
        // Append to destination order + make active there.
        self.order
            .entry(to_window.to_string())
            .or_default()
            .push(tab_id.to_string());
        self.active.insert(to_window.to_string(), Some(tab_id.to_string()));
        self.persist_session();
        Ok(from)
    }

    /// The window label that currently owns `tab_id`, or `None` if no such
    /// tab exists. G1's `detach_tab` IPC reads this BEFORE detaching so it can
    /// repaint the SOURCE window's tab strip (the tab leaves it) — the
    /// `Workspace::detach_tab` return value is the NEW window's summary, not
    /// the source label.
    pub fn window_label_for_tab(&self, tab_id: &str) -> Option<&str> {
        self.tabs.get(tab_id).map(|t| t.window_label.as_str())
    }

    /// Detach `tab_id` into a brand-new window labeled `new_label`: register
    /// the window then `move_tab` the tab into it as its sole tab. Returns
    /// the new window's summary. Errors if `tab_id` is unknown.
    pub fn detach_tab(&mut self, tab_id: &str, new_label: String) -> Result<WindowSummaryData> {
        if !self.tabs.contains_key(tab_id) {
            anyhow::bail!("no such tab: {tab_id}");
        }
        self.new_window(new_label.clone());
        self.move_tab(tab_id, &new_label)?;
        Ok(self.window_summary(&new_label))
    }

    /// The tabs of window `label`, in left-to-right order. Empty for an
    /// unknown or zero-tab window.
    pub fn list_open_documents_for(&self, label: &str) -> Vec<&Tab> {
        self.order
            .get(label)
            .map(|ids| ids.iter().filter_map(|id| self.tabs.get(id)).collect())
            .unwrap_or_default()
    }

    /// The active tab id of window `label`, or `None` if it shows the
    /// StartPage / is unknown.
    pub fn active_tab_id_for(&self, label: &str) -> Option<&str> {
        self.active.get(label).and_then(|a| a.as_deref())
    }

    /// Activate tab `id` within window `label`. Errors if `id` isn't a tab
    /// of that window (a window may only activate its own tabs).
    pub fn activate_tab_for(&mut self, label: &str, id: &str) -> Result<()> {
        let owns = self
            .order
            .get(label)
            .map(|ids| ids.iter().any(|x| x == id))
            .unwrap_or(false);
        if !owns {
            anyhow::bail!("no such tab in window {label}: {id}");
        }
        self.active.insert(label.to_string(), Some(id.to_string()));
        self.persist_session();
        Ok(())
    }

    /// Close tab `id` within window `label`. Mirrors the global `close_tab`
    /// (closed_snapshots + ssh_tabs cleanup) scoped to that window's
    /// order/active. Closing the last tab leaves the window open on the
    /// StartPage (active=None) — the window is NOT auto-closed.
    pub fn close_tab_for(&mut self, label: &str, id: &str) -> Result<()> {
        // C2: stash the last-saved bytes keyed by path so the next open of
        // this path can detect divergence from disk.
        if let Some(tab) = self.tabs.remove(id) {
            if let Some(snap) = tab.last_saved_snapshot {
                self.closed_snapshots.insert(tab.path, snap);
            }
        }
        // A8: clear the per-tab SSH state (no-op for non-SSH tabs).
        self.ssh_tabs.remove(id);
        if let Some(order) = self.order.get_mut(label) {
            order.retain(|x| x != id);
            if self.active.get(label).and_then(|a| a.as_deref()) == Some(id) {
                let next = order.last().cloned();
                self.active.insert(label.to_string(), next);
            }
        }
        self.persist_session();
        Ok(())
    }

    /// Watcher routing: the `window_label` of the tab that owns `path`, or
    /// `None` if no tab is open for it. The watcher uses this to address an
    /// external-change event to the window that has the file open. Compares
    /// against `Tab.path` as stored (callers should pass a canonicalized
    /// path to match `open_document`'s storage).
    pub fn owning_window_label(&self, path: &Path) -> Option<&str> {
        let canonical = canon(path);
        self.tabs
            .values()
            .find(|t| canon(&t.path) == canonical)
            .map(|t| t.window_label.as_str())
    }

    /// B2 watcher routing for a watched-file event. Resolves `path` (which may
    /// be either a tab's `.md` OR that document's sidecar) to the owning
    /// window's label, so the external-change forwarder can `emit_to` the one
    /// window that has the file open. A sidecar path is matched by computing
    /// each open tab's sidecar path under the active `sidecar_pattern` and
    /// comparing — this keeps sidecar auto-reload events addressed to the
    /// right window instead of being dropped because no tab's `.md` equals the
    /// sidecar path. Returns `None` (drop the event) when no open tab owns
    /// either the path or its sidecar.
    pub fn owning_window_for_watched(&self, path: &Path) -> Option<&str> {
        // Direct .md match first (the common case).
        if let Some(label) = self.owning_window_label(path) {
            return Some(label);
        }
        // Otherwise treat `path` as a sidecar and match it against each tab's
        // computed sidecar path.
        let pattern = self.settings.get().comments.sidecar_pattern;
        self.tabs
            .values()
            .find(|t| sidecar_path(&t.path, &pattern) == path)
            .map(|t| t.window_label.as_str())
    }

    /// Record a window's last-known geometry (position + size). Persisted to
    /// session v2 via `window_snapshots`. No-op for an unknown label.
    pub fn set_window_geometry(&mut self, label: &str, geo: WindowGeometry) {
        if let Some(w) = self.windows.iter_mut().find(|w| w.label == label) {
            w.geometry = Some(geo);
        }
    }

    /// Set the most-recently-focused window label (the IPC focus handler
    /// calls this). Routes a window-less open to the user's last window.
    pub fn set_mrf_label(&mut self, label: &str) {
        self.mrf_label = label.to_string();
    }

    /// The most-recently-focused window label.
    pub fn mrf_label(&self) -> &str {
        &self.mrf_label
    }

    /// Build the wire-shaped summary for one window: tab count + the active
    /// tab's file name (the StartPage shows `None`). Returns a zero-count
    /// summary for an unknown label so `new_window`/`list_windows` callers
    /// always get a value.
    fn window_summary(&self, label: &str) -> WindowSummaryData {
        let tab_count = self
            .order
            .get(label)
            .map(|ids| ids.len() as u32)
            .unwrap_or(0);
        let active_doc_name = self
            .active
            .get(label)
            .and_then(|a| a.as_ref())
            .and_then(|id| self.tabs.get(id))
            .and_then(|t| {
                t.path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
            });
        WindowSummaryData {
            label: label.to_string(),
            active_doc_name,
            tab_count,
        }
    }

    fn find_by_path(&self, p: &Path) -> Option<(String, &Tab)> {
        let canonical = canon(p);
        self.tabs
            .iter()
            .find(|(_, t)| canon(&t.path) == canonical)
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

/// Bug-2 fix: snapshot of inputs the OAuth phase needs. Built from
/// `Workspace::drive_connect_prep` while the workspace lock is held, then
/// passed to `drive_connect_oauth` which runs without any lock.
pub struct DriveConnectPrep {
    pub byo_client_id: Option<String>,
    pub config_dir: std::path::PathBuf,
}

/// Result of the OAuth phase. `drive_connect_apply` consumes this under the
/// re-acquired workspace lock to populate DriveApi + persist tokens.
pub struct DriveOauthOutcome {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub email: String,
}

/// Bug-2 fix: standalone OAuth phase that does NOT require the workspace
/// lock. The IPC handler in main.rs calls this between the prep snapshot
/// and the apply step. Bug-1 fix is also enforced here (PLACEHOLDER check).
pub fn drive_connect_oauth(
    prep: DriveConnectPrep,
    open_url: impl FnOnce(&str) + Send + 'static,
) -> Result<DriveOauthOutcome> {
    let mut builder = crate::drive::auth::AuthBuilder::new();
    if let Some(byo) = prep.byo_client_id.as_deref() {
        builder = builder.with_byo_client_id(Some(byo));
    }

    // Bug-1 fix: clear error before the 5-min OAuth timeout if the binary
    // was built without MDVIEWER_DEFAULT_CLIENT_ID and the user hasn't
    // supplied a BYO client_id. Suppressed when MDVIEWER_DRIVE_AUTH_BASE
    // is set (e2e/test harness).
    if builder.resolved_client_id().starts_with("PLACEHOLDER_")
        && std::env::var("MDVIEWER_DRIVE_AUTH_BASE").is_err()
    {
        return Err(anyhow::anyhow!(
            "Drive integration needs a Google OAuth client ID. Either rebuild with \
             MDVIEWER_DEFAULT_CLIENT_ID set, or paste your own client_id under \
             Settings → Drive → Advanced (Bring-Your-Own client_id)."
        ));
    }

    let token = crate::drive::auth::run_loopback_flow(
        builder,
        std::time::Duration::from_secs(300),
        open_url,
    )
    .map_err(|e| anyhow::anyhow!("OAuth failed: {}", e))?;

    let email = token
        .id_token
        .as_deref()
        .and_then(crate::drive::auth::extract_email_from_id_token)
        .unwrap_or_else(|| "unknown@drive.local".into());

    let _ = prep.config_dir; // captured for symmetry; apply() uses self.config_dir
    Ok(DriveOauthOutcome {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        email,
    })
}

/// D2: production browser-opener used by `drive_connect`. Fires the
/// platform-default URL handler asynchronously so the OAuth-loopback
/// thread doesn't block on the spawn. Errors are swallowed: the loopback
/// listener will time out (5 minutes) and surface the original "OAuth
/// failed" error if the browser never came up.
pub fn default_open_url(url: &str) {
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
/// matches on this and turns `Conflict` into a `SaveOutcome::Conflict`
/// payload that the existing diff-merge view can render. `Io` and `Drive`
/// surface as plain `Err(String)` so the existing toast path picks them up.
///
/// A8 rename: was `SaveError::DriveConflict`. The variant gained SSH callers
/// in A8 — the "Drive" prefix is now misleading. The `source` field
/// disambiguates which transport flagged the conflict (DriveApi 412,
/// DriveDesktop watcher mismatch, SSH hash mismatch) so wireframe 07's
/// banner copy can be picked accordingly.
#[derive(Debug)]
pub enum SaveError {
    Io(std::io::Error),
    Drive(crate::drive::DriveError),
    /// Both the user's local bytes and the freshly-fetched remote bytes
    /// the conflict diff needs. `source` disambiguates the transport that
    /// detected the divergence so the frontend banner picks the right copy.
    Conflict {
        local: Vec<u8>,
        remote: Vec<u8>,
        source: ConflictSource,
    },
}

#[derive(Debug, Clone)]
pub enum ConflictSource {
    DriveApiEtag,
    DriveDesktopWatcher,
    /// A8: SSH save-back detected the remote bytes changed since open
    /// (the open-time `sha256` no longer matches the freshly-fetched
    /// remote bytes). The Conflict view shows an "ssh://" banner copy.
    SshHashMismatch,
}

impl ConflictSource {
    /// Canonical wire-format string for the conflict source. The frontend
    /// `Conflict.ts` view's `ConflictSource` TS literal type matches these
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
            Self::SshHashMismatch => "SshHashMismatch",
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
    ///   rely on B5 plumbing the Tauri-managed Watcher in.
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
                render_line_breaks: false,
            },
        );
        self.tabs.insert(
            id.clone(),
            Tab {
                id: id.clone(),
                window_label: MAIN_LABEL.to_string(),
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
        self.order
            .entry(MAIN_LABEL.to_string())
            .or_default()
            .push(id.clone());
        self.active.insert(MAIN_LABEL.to_string(), Some(id.clone()));
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
            OpenOutcome::ExternalReload { .. } => {
                panic!("test_open_drive_desktop_tab: expected Document, got ExternalReload")
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
    use super::{ConflictSource, LocationKind, SaveError};
    use mdviewer_core::ssh_url::SshUrl;
    use std::path::{Path, PathBuf};

    /// A8: a `SaveError::Conflict { source: SshHashMismatch, .. }` constructed
    /// by the (future) SSH save dispatch must surface the wire string
    /// `"SshHashMismatch"` through `source.to_wire()` so the IPC layer's
    /// `emit_drive_conflict` and the `SaveOutcome::Conflict` payload both
    /// carry the same discriminator the Conflict.ts banner-copy switch keys
    /// off. This pins the variant→wire contract for the SSH branch the way
    /// `conflict_source_wire_format_is_stable` does for the Drive branches.
    #[test]
    fn save_error_conflict_with_ssh_source_emits_ssh_wire_string() {
        let err = SaveError::Conflict {
            local: b"hello local".to_vec(),
            remote: b"hello remote".to_vec(),
            source: ConflictSource::SshHashMismatch,
        };
        // Destructure rather than `if let` so a future variant rename (e.g.
        // a second renaming of `Conflict`) fails the test loudly instead of
        // silently falling through to the no-op branch.
        let SaveError::Conflict { source, local, remote } = err else {
            panic!("constructed SaveError::Conflict must match the Conflict variant");
        };
        assert_eq!(source.to_wire(), "SshHashMismatch");
        assert_eq!(local, b"hello local");
        assert_eq!(remote, b"hello remote");
    }

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
        // A8: SSH adds a third variant — keep this assertion adjacent so a
        // future contributor adding another ConflictSource value is forced
        // to also extend the wire-format contract.
        assert_eq!(
            ConflictSource::SshHashMismatch.to_wire(),
            "SshHashMismatch"
        );
        // Display impl must agree with to_wire so callers can use either spelling.
        assert_eq!(format!("{}", ConflictSource::DriveApiEtag), "DriveApiEtag");
        assert_eq!(
            format!("{}", ConflictSource::DriveDesktopWatcher),
            "DriveDesktopWatcher"
        );
        assert_eq!(
            format!("{}", ConflictSource::SshHashMismatch),
            "SshHashMismatch"
        );
    }

    /// A8: `LocationKind::Local` exposes its PathBuf verbatim — the
    /// watcher/renderer/autosave pump all consume the borrowed `&Path` for
    /// local tabs without an allocation. The `ssh_cache_base` argument is
    /// unused on this branch.
    #[test]
    fn location_kind_local_returns_path_verbatim() {
        let p = PathBuf::from("/tmp/notes.md");
        let loc = LocationKind::Local(p.clone());
        let resolved = loc.local_path(Path::new("/should/not/matter"));
        assert_eq!(&*resolved, p.as_path());
    }

    /// A8: `LocationKind::Ssh` resolves to the cache mirror computed by
    /// `ssh::operations::cache_path_for_url`. This is what the watcher /
    /// renderer / autosave pump consume — they never see the `SshUrl`
    /// directly. Per the design "additive refactor" note: keeping the cache
    /// path as the only `&Path` consumers see is what lets the rest of the
    /// Workspace stay PathBuf-shaped.
    #[test]
    fn location_kind_ssh_resolves_via_cache_path() {
        let url = SshUrl {
            user: Some("alice".into()),
            host: "host.example".into(),
            port: 22,
            path: "/notes/file.md".into(),
        };
        let loc = LocationKind::Ssh(url.clone());
        let base = Path::new("/cache/base");
        let resolved = loc.local_path(base);
        // Must match `cache_path_for_url` exactly — it's the watcher's
        // local-fs cursor for the remote file.
        let expected = crate::ssh::operations::cache_path_for_url(base, &url);
        assert_eq!(&*resolved, expected.as_path());
    }

    /// A8 (Step 7): the autosave dispatch picks the SSH tier knobs for
    /// `LocationKind::Ssh` and the legacy local knobs for `LocationKind::Local`.
    /// The Decision-6 invariant: SSH-tier autosave is independently toggleable
    /// (a metered link should be turn-off-able without losing local autosave).
    #[test]
    fn location_kind_autosave_settings_branch_by_kind() {
        let settings = crate::settings::EditorSettings {
            default_open_mode: "viewer".into(),
            auto_save: true,
            auto_save_debounce_ms: 750,
            external_change_behavior: crate::settings::ExternalChangeBehavior::Ask,
            syntax_highlighting: true,
            mermaid_enabled: false,
            show_whitespace: false,
            word_wrap: true,
            render_line_breaks: true,
            autosave: crate::settings::AutosaveSettings {
                ssh_interval_ms: 30_000,
                ssh_enabled: false,
            },
        };

        let local = LocationKind::Local(PathBuf::from("/tmp/x.md"));
        let (interval, enabled) = local.autosave_settings(&settings);
        assert_eq!(interval, 750);
        assert!(enabled);

        let ssh = LocationKind::Ssh(SshUrl {
            user: None,
            host: "h".into(),
            port: 22,
            path: "/x.md".into(),
        });
        let (interval_s, enabled_s) = ssh.autosave_settings(&settings);
        assert_eq!(interval_s, 30_000);
        assert!(!enabled_s, "SSH-tier autosave honors its independent toggle");
    }

    // === A8 review-cycle-1 fix #1: open_ssh_url unit coverage ===
    //
    // The fake transport here is a deterministic stand-in for the real
    // `SshTransport` impl — fetch returns canned bytes (and a deterministic
    // hash via the default `sha256` impl); push records the bytes for
    // assertion but is not exercised by `open_url`. Same shape as the
    // FakeTransport in ssh::operations::tests, redefined locally because
    // that one lives behind a `mod tests` boundary.
    //
    // Each test gets its own tempdir so the cache mirror writes don't
    // collide and the on-disk path stays under our control (no real
    // network, no real filesystem outside the tempdir).

    use crate::ssh::operations::Operations;
    use crate::ssh::transport::{DirEntry, SshStat, SshTransport, TransportError};
    use sha2::{Digest, Sha256};
    use std::sync::{Arc, Mutex as StdMutex};

    struct OpenUrlFake {
        bytes: Vec<u8>,
        push_calls: StdMutex<u32>,
    }

    impl OpenUrlFake {
        fn new(bytes: Vec<u8>) -> Arc<Self> {
            Arc::new(Self {
                bytes,
                push_calls: StdMutex::new(0),
            })
        }
    }

    #[async_trait::async_trait]
    impl SshTransport for OpenUrlFake {
        async fn fetch(&self, _url: &SshUrl) -> Result<Vec<u8>, TransportError> {
            Ok(self.bytes.clone())
        }
        async fn push(&self, _url: &SshUrl, _bytes: &[u8]) -> Result<(), TransportError> {
            *self.push_calls.lock().unwrap() += 1;
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

    fn sha256_of(bytes: &[u8]) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(bytes);
        h.finalize().into()
    }

    /// `open_ssh_url` must wire the cache-mirror PathBuf onto the new tab's
    /// summary (so the watcher / renderer / autosave pump see the right
    /// on-disk cursor) AND stash the parsed `SshUrl` in `ssh_state(tab_id)`
    /// so save-back can recover it. This is the central regression test
    /// for the review-cycle-1 fix: the previous `let _ = url` dropped the
    /// URL on the floor.
    #[tokio::test]
    async fn open_ssh_url_stamps_location_kind_on_tab() {
        let data_dir = tempfile::tempdir().expect("workspace data dir");
        let cache_dir = tempfile::tempdir().expect("ssh cache dir");
        let mut ws = super::Workspace::new(data_dir.path()).expect("new workspace");
        let url = sample_ssh_url();
        let bytes = b"# remote\n".to_vec();
        let fake = OpenUrlFake::new(bytes.clone());
        let ops = Operations::new(fake.clone(), cache_dir.path().to_path_buf());

        let summary = ws
            .open_ssh_url(url.clone(), &ops)
            .await
            .expect("open_ssh_url ok");

        // Tab summary path points at the cache mirror — same shape the
        // watcher/renderer/autosave layer expects.
        let expected_cache =
            crate::ssh::operations::cache_path_for_url(cache_dir.path(), &url);
        assert_eq!(summary.path, expected_cache);
        // And the SshUrl is recoverable via the per-tab state map.
        let state = ws
            .ssh_state(&summary.id)
            .expect("ssh_state populated for an SSH tab");
        assert_eq!(state.url, url);
    }

    /// Two `open_ssh_url` calls for the same URL must return the same tab
    /// id (cache-path de-dupe) and must leave the existing per-tab SSH
    /// state untouched. Mirrors `drive_open_url`'s file_id de-dupe.
    #[tokio::test]
    async fn open_ssh_url_dedupes_by_url_when_called_twice() {
        let data_dir = tempfile::tempdir().unwrap();
        let cache_dir = tempfile::tempdir().unwrap();
        let mut ws = super::Workspace::new(data_dir.path()).unwrap();
        let url = sample_ssh_url();
        let fake = OpenUrlFake::new(b"# remote\n".to_vec());
        let ops = Operations::new(fake.clone(), cache_dir.path().to_path_buf());

        let first = ws.open_ssh_url(url.clone(), &ops).await.unwrap();
        let original_state = ws.ssh_state(&first.id).cloned().expect("first stash");
        let second = ws.open_ssh_url(url.clone(), &ops).await.unwrap();

        assert_eq!(first.id, second.id, "same URL must collapse onto one tab");
        let post_state = ws.ssh_state(&first.id).expect("state preserved");
        assert_eq!(
            post_state.url, original_state.url,
            "de-dupe must not overwrite the stashed URL",
        );
        assert_eq!(
            post_state.last_open_sha256, original_state.last_open_sha256,
            "de-dupe must not overwrite the stashed open-time hash",
        );
    }

    /// The open-time `sha256` is what `Operations::save_back` later
    /// compares against to detect remote drift (its `on_open_sha` argument).
    /// `open_ssh_url` must stash it verbatim. Asserting against
    /// `sha256_of(bytes)` pins the contract: the hash the transport hands
    /// back IS the hash that lands in `ssh_state(...)`.
    #[tokio::test]
    async fn open_ssh_url_stashes_sha256_for_conflict_detection() {
        let data_dir = tempfile::tempdir().unwrap();
        let cache_dir = tempfile::tempdir().unwrap();
        let mut ws = super::Workspace::new(data_dir.path()).unwrap();
        let url = sample_ssh_url();
        let bytes = b"original-bytes".to_vec();
        let fake = OpenUrlFake::new(bytes.clone());
        let ops = Operations::new(fake.clone(), cache_dir.path().to_path_buf());

        let summary = ws.open_ssh_url(url, &ops).await.unwrap();
        let state = ws.ssh_state(&summary.id).expect("stash present");
        assert_eq!(
            state.last_open_sha256,
            sha256_of(&bytes),
            "stashed hash must match the transport-reported open-time hash",
        );
    }

    // === A1 (multi-window): window-aware state + registry tests ===

    use super::{OneOwnerResolution, WindowGeometry, Workspace, MAIN_LABEL};

    /// Write a markdown file under `dir` and open it into the `main` window,
    /// returning the new tab id. Shared by the A1 window tests so each gets a
    /// real on-disk path (open_document canonicalizes + reads).
    fn open_md(ws: &mut Workspace, dir: &Path, name: &str, body: &str) -> String {
        let p = dir.join(name);
        std::fs::write(&p, body).expect("write md");
        match ws
            .open_document(&p, super::OpenOpts::default())
            .expect("open_document ok")
        {
            super::OpenOutcome::Document(r) => r.tab_id,
            super::OpenOutcome::Conflict { .. } => panic!("unexpected conflict"),
            super::OpenOutcome::ExternalReload { .. } => panic!("unexpected external reload"),
        }
    }

    /// Reopen-after-external-change behavior. The 3-way merge must only fire
    /// when the tab has unsaved local edits (`dirty`); with no edits the open
    /// path honors `external_change_behavior` instead of forcing a bogus merge.
    #[test]
    fn reopen_after_external_change_reloads_when_not_dirty() {
        use super::OpenOutcome;
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new_for_test(dir.path());
        ws.settings_store()
            .update(|s| {
                s.editor.external_change_behavior =
                    crate::settings::ExternalChangeBehavior::Reload
            })
            .unwrap();
        let p = dir.path().join("doc.md");
        std::fs::write(&p, "# original").unwrap();
        open_md(&mut ws, dir.path(), "doc.md", "# original");

        // A third party rewrites the file.
        std::fs::write(&p, "# changed externally").unwrap();

        // Reopen with no unsaved edits → fresh content, never a conflict.
        let outcome = ws
            .open_document_for(MAIN_LABEL, &p, super::OpenOpts::default(), false)
            .expect("reopen ok");
        match outcome {
            OpenOutcome::Document(r) => {
                assert!(
                    r.source.contains("changed externally"),
                    "expected reloaded content, got: {}",
                    r.source
                );
            }
            other => panic!("expected Document reload, got {other:?}"),
        }
    }

    #[test]
    fn reopen_after_external_change_asks_when_not_dirty_and_behavior_ask() {
        use super::OpenOutcome;
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new_for_test(dir.path());
        // Default behavior is Ask, but set it explicitly for clarity.
        ws.settings_store()
            .update(|s| {
                s.editor.external_change_behavior =
                    crate::settings::ExternalChangeBehavior::Ask
            })
            .unwrap();
        let p = dir.path().join("doc.md");
        std::fs::write(&p, "# original").unwrap();
        open_md(&mut ws, dir.path(), "doc.md", "# original");
        std::fs::write(&p, "# changed externally").unwrap();

        let outcome = ws
            .open_document_for(MAIN_LABEL, &p, super::OpenOpts::default(), false)
            .expect("reopen ok");
        assert!(
            matches!(outcome, OpenOutcome::ExternalReload { .. }),
            "Ask + no edits should prompt to reload, not merge; got {outcome:?}"
        );
    }

    #[test]
    fn reopen_after_external_change_conflicts_only_when_dirty() {
        use super::OpenOutcome;
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new_for_test(dir.path());
        let p = dir.path().join("doc.md");
        std::fs::write(&p, "# original").unwrap();
        open_md(&mut ws, dir.path(), "doc.md", "# original");
        std::fs::write(&p, "# changed externally").unwrap();

        // dirty = true → unsaved edits to protect → genuine merge.
        let outcome = ws
            .open_document_for(MAIN_LABEL, &p, super::OpenOpts::default(), true)
            .expect("reopen ok");
        match outcome {
            OpenOutcome::Conflict { local, incoming, .. } => {
                assert!(local.contains("original"));
                assert!(incoming.contains("changed externally"));
            }
            other => panic!("expected Conflict when dirty, got {other:?}"),
        }
    }

    #[test]
    fn reopen_with_no_disk_change_returns_document() {
        use super::OpenOutcome;
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new_for_test(dir.path());
        let p = dir.path().join("doc.md");
        std::fs::write(&p, "# original").unwrap();
        open_md(&mut ws, dir.path(), "doc.md", "# original");

        // No external change: even dirty, reopening just activates the tab.
        let outcome = ws
            .open_document_for(MAIN_LABEL, &p, super::OpenOpts::default(), true)
            .expect("reopen ok");
        assert!(
            matches!(outcome, OpenOutcome::Document(_)),
            "no divergence should never conflict; got {outcome:?}"
        );
    }

    /// Per-window `order`/`active` are isolated: a tab opened in `main` and a
    /// tab moved into a second window each show only in their own window's
    /// list, and the global `tabs` map keeps both.
    #[test]
    fn per_window_isolation() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new_for_test(dir.path());
        let a = open_md(&mut ws, dir.path(), "a.md", "# a");
        let b = open_md(&mut ws, dir.path(), "b.md", "# b");

        let summary = ws.new_window("win-1".to_string());
        assert_eq!(summary.label, "win-1");
        assert_eq!(summary.tab_count, 0);

        ws.move_tab(&b, "win-1").expect("move ok");

        let main_ids: Vec<&str> = ws
            .list_open_documents_for(MAIN_LABEL)
            .iter()
            .map(|t| t.id.as_str())
            .collect();
        let win1_ids: Vec<&str> = ws
            .list_open_documents_for("win-1")
            .iter()
            .map(|t| t.id.as_str())
            .collect();
        assert_eq!(main_ids, vec![a.as_str()], "main keeps only a");
        assert_eq!(win1_ids, vec![b.as_str()], "win-1 owns b");
        // Global tab map still owns both tabs.
        assert!(ws.tab(&a).is_some());
        assert!(ws.tab(&b).is_some());
        // The moved tab carries the new window label.
        assert_eq!(ws.tab(&b).unwrap().window_label, "win-1");
    }

    /// move_tab reassigns the label, repairs the source active to the next
    /// remaining tab, and makes the moved tab active in the destination.
    #[test]
    fn move_tab_reassigns_and_repairs_source_active() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new_for_test(dir.path());
        let a = open_md(&mut ws, dir.path(), "a.md", "# a");
        let b = open_md(&mut ws, dir.path(), "b.md", "# b");
        // b is active in main (last opened).
        assert_eq!(ws.active_tab_id_for(MAIN_LABEL), Some(b.as_str()));

        ws.new_window("win-1".to_string());
        let from = ws.move_tab(&b, "win-1").expect("move ok");

        // move_tab returns the source window label it moved the tab away from
        // (b was opened in main). The IPC layer relies on this to emit
        // workspace-changed to the source as well as the destination (S4).
        assert_eq!(from, MAIN_LABEL, "returns the original owning window");
        // Source active repaired to the next remaining tab (a).
        assert_eq!(ws.active_tab_id_for(MAIN_LABEL), Some(a.as_str()));
        // Destination active is the moved tab.
        assert_eq!(ws.active_tab_id_for("win-1"), Some(b.as_str()));
        // Label reassigned.
        assert_eq!(ws.tab(&b).unwrap().window_label, "win-1");

        // Unknown tab / unknown window error out.
        assert!(ws.move_tab("nope", "win-1").is_err());
        assert!(ws.move_tab(&a, "ghost-window").is_err());
    }

    /// Moving the *last* tab out of a window leaves that window registered
    /// with active=None (StartPage) — it is NOT auto-closed.
    #[test]
    fn move_last_tab_leaves_source_on_startpage() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new_for_test(dir.path());
        let a = open_md(&mut ws, dir.path(), "a.md", "# a");

        ws.new_window("win-1".to_string());
        ws.move_tab(&a, "win-1").expect("move ok");

        // Main window still registered, now empty + StartPage.
        assert!(
            ws.list_windows().iter().any(|w| w.label == MAIN_LABEL),
            "source window stays registered",
        );
        assert!(ws.list_open_documents_for(MAIN_LABEL).is_empty());
        assert_eq!(ws.active_tab_id_for(MAIN_LABEL), None);
    }

    /// open_in_new_window_resolve focuses an existing tab when the path is
    /// already open (one-owner), else returns NeedsNew.
    #[test]
    fn open_in_new_window_resolve_focus_existing() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new_for_test(dir.path());
        let pa = dir.path().join("a.md");
        std::fs::write(&pa, "# a").unwrap();
        let a = open_md(&mut ws, dir.path(), "a.md", "# a");

        // Already-open path → focus existing window+tab.
        match ws.open_in_new_window_resolve(&pa) {
            OneOwnerResolution::Existing { label, tab_id } => {
                assert_eq!(label, MAIN_LABEL);
                assert_eq!(tab_id, a);
            }
            OneOwnerResolution::NeedsNew => panic!("expected Existing for an open path"),
        }

        // Unknown path → NeedsNew.
        let pb = dir.path().join("never-opened.md");
        std::fs::write(&pb, "# b").unwrap();
        assert_eq!(
            ws.open_in_new_window_resolve(&pb),
            OneOwnerResolution::NeedsNew,
        );
    }

    /// Closing the last tab in a window keeps the window open on the
    /// StartPage (active=None), mirroring today's single-window behavior.
    #[test]
    fn last_tab_close_keeps_window() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new_for_test(dir.path());
        let a = open_md(&mut ws, dir.path(), "a.md", "# a");

        ws.close_tab_for(MAIN_LABEL, &a).expect("close ok");

        assert!(
            ws.list_windows().iter().any(|w| w.label == MAIN_LABEL),
            "window survives last-tab-close",
        );
        assert!(ws.list_open_documents_for(MAIN_LABEL).is_empty());
        assert_eq!(ws.active_tab_id_for(MAIN_LABEL), None);
    }

    /// close_window drops the window's tabs from the global map and removes
    /// its registry entry / order / active slots.
    #[test]
    fn close_window_drops_tabs_and_registry_entry() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new_for_test(dir.path());
        let a = open_md(&mut ws, dir.path(), "a.md", "# a");
        ws.new_window("win-1".to_string());
        let b = open_md(&mut ws, dir.path(), "b.md", "# b");
        ws.move_tab(&b, "win-1").expect("move ok");

        ws.close_window("win-1");

        assert!(
            !ws.list_windows().iter().any(|w| w.label == "win-1"),
            "registry entry removed",
        );
        // The window's tab is dropped from the global map.
        assert!(ws.tab(&b).is_none(), "closed window's tab removed");
        // The other window is untouched.
        assert!(ws.tab(&a).is_some());
        assert!(ws.list_windows().iter().any(|w| w.label == MAIN_LABEL));
    }

    /// owning_window_label routes a path to the window_label of the tab that
    /// owns it — the watcher uses this to address external-change events to
    /// the right window.
    #[test]
    fn path_to_owning_window_resolves() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new_for_test(dir.path());
        let pa = dir.path().join("a.md");
        std::fs::write(&pa, "# a").unwrap();
        let _a = open_md(&mut ws, dir.path(), "a.md", "# a");
        let b = open_md(&mut ws, dir.path(), "b.md", "# b");
        ws.new_window("win-1".to_string());
        ws.move_tab(&b, "win-1").expect("move ok");

        let canonical_a = pa.canonicalize().unwrap_or(pa.clone());
        assert_eq!(ws.owning_window_label(&canonical_a), Some(MAIN_LABEL));
        let pb = dir.path().join("b.md").canonicalize().unwrap();
        assert_eq!(ws.owning_window_label(&pb), Some("win-1"));
        // Unknown path → None.
        assert_eq!(
            ws.owning_window_label(Path::new("/nonexistent/x.md")),
            None,
        );
    }

    /// detach_tab spawns a new window and moves the tab into it as the sole
    /// tab; geometry/mrf setters round-trip; window_snapshots reflect state.
    #[test]
    fn detach_tab_and_geometry_and_mrf_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new_for_test(dir.path());
        let _a = open_md(&mut ws, dir.path(), "a.md", "# a");
        let b = open_md(&mut ws, dir.path(), "b.md", "# b");

        let summary = ws.detach_tab(&b, "win-detach".to_string()).expect("detach ok");
        assert_eq!(summary.label, "win-detach");
        assert_eq!(summary.tab_count, 1);
        assert_eq!(ws.tab(&b).unwrap().window_label, "win-detach");
        assert_eq!(ws.active_tab_id_for("win-detach"), Some(b.as_str()));

        // Geometry setter is reflected in window_snapshots.
        let geo = WindowGeometry { x: 10, y: 20, w: 800, h: 600 };
        ws.set_window_geometry("win-detach", geo);
        let snaps = ws.window_snapshots();
        let snap = snaps.iter().find(|s| s.label == "win-detach").unwrap();
        assert_eq!(snap.geometry, Some(geo));
        assert_eq!(snap.tabs.len(), 1);

        // MRF setter round-trips.
        assert_eq!(ws.mrf_label(), MAIN_LABEL);
        ws.set_mrf_label("win-detach");
        assert_eq!(ws.mrf_label(), "win-detach");
    }

    /// Closing the most-recently-focused window falls the mrf label back to
    /// the first remaining window so a window-less open still has a target.
    #[test]
    fn close_window_repoints_mrf_to_first_remaining() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new_for_test(dir.path());
        ws.new_window("win-1".to_string());
        ws.set_mrf_label("win-1");
        assert_eq!(ws.mrf_label(), "win-1");

        ws.close_window("win-1");

        // Falls back to the first remaining window (main).
        assert_eq!(ws.mrf_label(), MAIN_LABEL);
    }

    /// Closing the last remaining window empties the registry and repoints the
    /// mrf label to the documented `MAIN_LABEL` fallback (the
    /// `windows.first()` is `None` branch in `close_window`). The other
    /// close_window tests always leave "main" surviving, so this is the only
    /// test that exercises the empty-registry path directly.
    #[test]
    fn close_last_window_empties_registry_and_repoints_mrf() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new_for_test(dir.path());
        // new_for_test seeds a single "main" window; close it while it's the
        // only window.
        assert_eq!(ws.list_windows().len(), 1);

        ws.close_window(MAIN_LABEL);

        assert!(ws.list_windows().is_empty(), "registry is empty");
        assert_eq!(
            ws.mrf_label(),
            MAIN_LABEL,
            "mrf falls back to MAIN_LABEL when no windows remain",
        );
    }

    /// move_tab into the tab's own window just re-activates it (no order
    /// churn, no error) — the same-window short-circuit branch.
    #[test]
    fn move_tab_into_same_window_just_activates() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new_for_test(dir.path());
        let a = open_md(&mut ws, dir.path(), "a.md", "# a");
        let b = open_md(&mut ws, dir.path(), "b.md", "# b");
        // b is active; move a (same window) → a becomes active, order intact.
        let from = ws.move_tab(&a, MAIN_LABEL).expect("same-window move ok");

        // A same-window move returns to_window as the from-label so the IPC
        // layer's `from != to_window` guard suppresses the redundant emit.
        assert_eq!(from, MAIN_LABEL, "same-window move returns to_window");
        assert_eq!(ws.active_tab_id_for(MAIN_LABEL), Some(a.as_str()));
        let ids: Vec<&str> = ws
            .list_open_documents_for(MAIN_LABEL)
            .iter()
            .map(|t| t.id.as_str())
            .collect();
        assert_eq!(ids, vec![a.as_str(), b.as_str()], "order unchanged");
    }

    /// detach_tab on an unknown tab errors before registering the window.
    #[test]
    fn detach_unknown_tab_errors() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new_for_test(dir.path());
        assert!(ws.detach_tab("nope", "win-x".to_string()).is_err());
        assert!(
            !ws.list_windows().iter().any(|w| w.label == "win-x"),
            "failed detach must not leave a dangling window",
        );
    }

    /// `close_tab` must clear the per-tab SSH state. Without this, a
    /// closed-and-reopened SSH tab could pick up stale state from the
    /// previous open (different URL, different open-time hash) and the
    /// save-back path would diff against the wrong baseline.
    #[tokio::test]
    async fn close_tab_clears_ssh_state() {
        let data_dir = tempfile::tempdir().unwrap();
        let cache_dir = tempfile::tempdir().unwrap();
        let mut ws = super::Workspace::new(data_dir.path()).unwrap();
        let url = sample_ssh_url();
        let fake = OpenUrlFake::new(b"# remote\n".to_vec());
        let ops = Operations::new(fake.clone(), cache_dir.path().to_path_buf());

        let summary = ws.open_ssh_url(url, &ops).await.unwrap();
        assert!(ws.ssh_state(&summary.id).is_some(), "open stashes state");
        ws.close_tab(&summary.id).expect("close_tab ok");
        assert!(
            ws.ssh_state(&summary.id).is_none(),
            "close_tab must clear the per-tab SSH state",
        );
    }

    /// Regression for the macOS/Windows SSH one-owner/relocate miss: a tab
    /// stored under one form of a path (here the canonical `realdir/doc.md`)
    /// must be found when the lookup is given a different-but-equivalent form
    /// (here the symlink `link/doc.md`, which canonicalizes to the same real
    /// path). On Linux `/tmp` isn't a symlink so the production SSH-cache miss
    /// never reproduces; this test forces the symlink divergence explicitly so
    /// the canonicalize-both-sides fix is verifiable on Linux. Before the fix
    /// `find_by_path` / `owning_window_label` compared raw-to-raw and missed.
    #[cfg(unix)]
    #[test]
    fn lookup_matches_across_symlinked_path_canonicalization() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = Workspace::new_for_test(dir.path());

        // Real directory holding the doc, plus a sibling symlink to it.
        let realdir = dir.path().join("realdir");
        std::fs::create_dir(&realdir).unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&realdir, &link).unwrap();

        // Open the doc through the REAL path → tab stored canonically.
        let real_doc = realdir.join("doc.md");
        std::fs::write(&real_doc, "# doc").unwrap();
        let tab_id = match ws
            .open_document(&real_doc, super::OpenOpts::default())
            .expect("open_document ok")
        {
            super::OpenOutcome::Document(r) => r.tab_id,
            super::OpenOutcome::Conflict { .. } => panic!("unexpected conflict"),
            super::OpenOutcome::ExternalReload { .. } => panic!("unexpected external reload"),
        };

        // Query via the SYMLINK form — canonicalizes to realdir/doc.md.
        let symlink_doc = link.join("doc.md");
        assert!(
            symlink_doc.canonicalize().unwrap() == real_doc.canonicalize().unwrap(),
            "symlink form must canonicalize to the real form for this test to be meaningful",
        );

        // open_in_new_window_resolve → Existing (same tab).
        match ws.open_in_new_window_resolve(&symlink_doc) {
            OneOwnerResolution::Existing { label, tab_id: found } => {
                assert_eq!(label, MAIN_LABEL);
                assert_eq!(found, tab_id);
            }
            OneOwnerResolution::NeedsNew => {
                panic!("expected Existing for a symlink-equivalent open path")
            }
        }

        // owning_window_label → the owning label.
        assert_eq!(
            ws.owning_window_label(&symlink_doc),
            Some(MAIN_LABEL),
            "owning_window_label must match across symlink canonicalization",
        );

        // find_by_path → the same tab id.
        assert_eq!(
            ws.find_by_path(&symlink_doc).map(|(id, _)| id),
            Some(tab_id),
            "find_by_path must match across symlink canonicalization",
        );
    }
}
