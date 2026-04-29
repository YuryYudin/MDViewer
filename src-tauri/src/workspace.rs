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
use crate::document::{render_markdown, RenderOptions, RenderResult};
use crate::recents::RecentsStore;
use crate::sidecar::{load_sidecar, sidecar_path};
use crate::settings::SettingsStore;
use anyhow::{Context, Result};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

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
    pub threads: Vec<Thread>,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum OpenOutcome {
    Document(OpenResult),
    Conflict {
        tab_id: String,
        path: PathBuf,
        local: String,    // last-saved bytes (the user's view of "mine")
        incoming: String, // what's on disk now
    },
}

pub struct Workspace {
    settings: SettingsStore,
    recents: RecentsStore,
    tabs: HashMap<String, Tab>,
    order: Vec<String>,
    active: Option<String>,
    /// C2: persists each path's last-saved bytes across `close_tab` so a
    /// subsequent open of the same path can detect external divergence.
    /// Without this, closing a tab would erase the snapshot needed for the
    /// reopen-time conflict check.
    closed_snapshots: HashMap<PathBuf, String>,
}

impl Workspace {
    pub fn new(data_dir: &Path) -> Result<Self> {
        Ok(Self {
            settings: SettingsStore::open(data_dir)?,
            recents: RecentsStore::open(data_dir)?,
            tabs: HashMap::new(),
            order: Vec::new(),
            active: None,
            closed_snapshots: HashMap::new(),
        })
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
                tab.comments.list_threads().to_vec(),
                tab.last_saved_snapshot.clone(),
            )
        });
        if let Some((id, p, html, threads, snapshot)) = existing {
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
            return Ok(OpenOutcome::Document(OpenResult {
                tab_id: id,
                path: p,
                html,
                threads,
            }));
        }

        let source = std::fs::read_to_string(&canonical)
            .with_context(|| format!("read {:?}", canonical))?;

        // C2: a closed-and-reopened path with a divergent on-disk copy
        // returns Conflict before the new tab is even constructed. The
        // snapshot is consumed (removed) — the user resolves via the
        // Conflict view, which calls save_document and re-primes it.
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
            threads: comments.list_threads().to_vec(),
        };

        self.tabs.insert(
            id.clone(),
            Tab {
                id: id.clone(),
                path: canonical.clone(),
                source: source.clone(),
                render,
                comments,
                last_saved_snapshot: Some(source),
            },
        );
        self.order.push(id.clone());
        self.active = Some(id.clone());
        let _ = self.recents.push(&canonical);
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
