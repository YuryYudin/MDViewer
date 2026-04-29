//! File watcher backed by `notify::RecommendedWatcher`.
//!
//! The watcher tracks each open `.md` plus its sidecar (one notify handle per
//! path, NonRecursive) and emits a typed [`ExternalChangeEvent`] on each
//! external write. The event's `action` field is derived from the per-file
//! dirty bit and the user's [`ExternalChangeBehavior`] setting:
//!
//! - `Ask`     -> `ExternalChange::Ask`
//! - `Reload`  -> `ExternalChange::Reload` (unless dirty -> `Ask`)
//! - `Ignore`  -> event is suppressed entirely (unless dirty -> `Ask`)
//!
//! Self-write suppression is driven by [`Watcher::record_self_write`], which
//! B3's `save_document` IPC handler calls right before flushing to disk. The
//! suppression list keeps `(path, content_hash, Instant)` triples with a
//! 10-second TTL — long enough that filesystem coalescing won't lose the
//! match, short enough that an actual external write a few seconds later
//! still fires.
//!
//! ## Why std::sync (not tokio)
//!
//! notify's worker thread cannot block on a tokio mutex without poisoning the
//! runtime. The whole watcher state hides behind `Arc<std::sync::Mutex<_>>`
//! and the event sink is a `std::sync::mpsc::Sender` — runtime-agnostic and
//! safe to lock from notify's native thread. main.rs spawns a forwarder
//! thread that pulls from the receiver and calls `app.emit(...)`.

use crate::settings::ExternalChangeBehavior;
use anyhow::Result;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher as NotifyWatcher};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

/// Which kind of file an event refers to. `.md` external changes route into
/// `document.rs`; sidecar changes route through `sidecar.rs`'s auto-merge
/// policy. Collapsing the two would force the consumer to re-derive which
/// is which from the path and risk applying the wrong policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WatchedKind {
    Markdown,
    Sidecar,
}

/// What the frontend should do with this external change. Mirrors
/// [`ExternalChangeBehavior`] but with `Ignore` collapsed (those events
/// never make it onto the channel in the first place).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExternalChange {
    Ask,
    Reload,
}

/// Event payload forwarded to the frontend over `app.emit("external-change",
/// ev)`. Serializable so Tauri can hand it to JS as JSON.
#[derive(Debug, Clone, Serialize)]
pub struct ExternalChangeEvent {
    pub path: PathBuf,
    pub kind: WatchedKind,
    pub action: ExternalChange,
}

/// One entry in the self-write suppression list. Populated by B3's
/// `save_document` via [`Watcher::record_self_write`] and matched on
/// `(path, content_hash)` within a 10-second TTL.
#[derive(Debug, Clone)]
struct SelfWrite {
    path: PathBuf,
    content_hash: u64,
    at: std::time::Instant,
}

/// Mutable state accessed from both the public API and notify's worker
/// thread. All fields live behind a single mutex so the worker callback
/// only takes one lock per event.
#[derive(Default)]
struct State {
    behavior: Option<ExternalChangeBehavior>,
    md_paths: HashSet<PathBuf>,
    sidecar_paths: HashSet<PathBuf>,
    /// Per-file dirty bit. A `true` here forces the action to `Ask`
    /// regardless of the global behavior setting.
    unsaved: HashMap<PathBuf, bool>,
    /// Self-write suppression list. Trimmed on every `record_self_write`.
    self_writes: Vec<SelfWrite>,
}

/// How long a self-write entry stays in the suppression list. Long enough
/// that filesystem coalescing won't lose the match between save and the
/// resulting notify event, short enough that an actual external write a
/// few seconds later still fires.
const SELF_WRITE_TTL: std::time::Duration = std::time::Duration::from_secs(10);

/// Window for self-write matching inside the notify callback. Tighter than
/// [`SELF_WRITE_TTL`] because the callback should fire within a second or
/// two of the save; anything older is almost certainly an external write
/// that happens to share the hash by coincidence.
const SELF_WRITE_MATCH_WINDOW: std::time::Duration = std::time::Duration::from_secs(2);

pub struct Watcher {
    inner: RecommendedWatcher,
    state: Arc<Mutex<State>>,
}

impl Watcher {
    /// Construct a new watcher whose events flow into `out`. The notify
    /// worker thread is started immediately; it terminates when this struct
    /// is dropped.
    pub fn new(out: Sender<ExternalChangeEvent>) -> Result<Self> {
        let state = Arc::new(Mutex::new(State::default()));
        let st = state.clone();
        let watcher = RecommendedWatcher::new(
            move |res: notify::Result<Event>| {
                let Ok(event) = res else {
                    return;
                };
                if !matches!(
                    event.kind,
                    EventKind::Modify(_) | EventKind::Create(_)
                ) {
                    return;
                }
                let s = st.lock().unwrap();
                for path in event.paths {
                    // Canonicalize the event path to match how the public API
                    // stored it. notify usually reports already-canonical paths
                    // on macOS but not always on Linux/Windows; the explicit
                    // canonicalize keeps the lookup stable across platforms.
                    let path = canonical(&path);
                    let kind = if s.md_paths.contains(&path) {
                        WatchedKind::Markdown
                    } else if s.sidecar_paths.contains(&path) {
                        WatchedKind::Sidecar
                    } else {
                        continue;
                    };

                    // Self-write suppression: if the on-disk content hash
                    // matches a recent record_self_write entry for this path,
                    // the change came from our own save_document and should
                    // not surface as an external change.
                    if let Ok(bytes) = std::fs::read(&path) {
                        let hash = quick_hash(&bytes);
                        if s.self_writes.iter().any(|sw| {
                            sw.path == path
                                && sw.content_hash == hash
                                && sw.at.elapsed() < SELF_WRITE_MATCH_WINDOW
                        }) {
                            continue;
                        }
                    }

                    let dirty = *s.unsaved.get(&path).unwrap_or(&false);
                    let action = if dirty {
                        // Unsaved-edits override: always Ask, regardless of
                        // the configured behavior. Never silently overwrite
                        // unsaved work.
                        ExternalChange::Ask
                    } else {
                        match s.behavior {
                            Some(ExternalChangeBehavior::Ask) | None => ExternalChange::Ask,
                            Some(ExternalChangeBehavior::Reload) => ExternalChange::Reload,
                            Some(ExternalChangeBehavior::Ignore) => continue,
                        }
                    };
                    let _ = out.send(ExternalChangeEvent {
                        path: path.clone(),
                        kind,
                        action,
                    });
                }
            },
            notify::Config::default(),
        )?;
        Ok(Self {
            inner: watcher,
            state,
        })
    }

    /// Update the global external-change behavior. Wired up to settings
    /// change events in main.rs so the watcher reacts live to user toggles.
    pub fn set_external_change_behavior(&mut self, b: ExternalChangeBehavior) {
        self.state.lock().unwrap().behavior = Some(b);
    }

    /// Begin watching `p` as a markdown document. Future modifications will
    /// surface as `ExternalChangeEvent { kind: Markdown, .. }`.
    pub fn watch_md(&mut self, p: &Path) -> Result<()> {
        self.inner.watch(p, RecursiveMode::NonRecursive)?;
        let key = canonical(p);
        self.state.lock().unwrap().md_paths.insert(key);
        Ok(())
    }

    /// Begin watching `p` as a sidecar JSON file. Future modifications will
    /// surface as `ExternalChangeEvent { kind: Sidecar, .. }`.
    pub fn watch_sidecar(&mut self, p: &Path) -> Result<()> {
        self.inner.watch(p, RecursiveMode::NonRecursive)?;
        let key = canonical(p);
        self.state.lock().unwrap().sidecar_paths.insert(key);
        Ok(())
    }

    /// Update the dirty bit for `p`. While `dirty` is true, external
    /// changes to `p` always surface as `ExternalChange::Ask` regardless
    /// of the configured behavior.
    pub fn mark_unsaved(&self, p: &Path, dirty: bool) {
        let key = canonical(p);
        self.state.lock().unwrap().unsaved.insert(key, dirty);
    }

    /// Record that we just wrote `hash` to `p` ourselves. The next notify
    /// event for `p` whose on-disk hash matches `hash` will be suppressed.
    ///
    /// `pub` (not `pub(crate)`) so integration tests under `src-tauri/tests/`
    /// — which live in their own crate — can drive the suppression list
    /// directly. B3's `save_document` IPC handler also calls this.
    pub fn record_self_write(&self, p: &Path, hash: u64) {
        let mut s = self.state.lock().unwrap();
        s.self_writes.push(SelfWrite {
            path: canonical(p),
            content_hash: hash,
            at: std::time::Instant::now(),
        });
        // Trim TTL-expired entries so the list doesn't grow unbounded
        // across a long session of frequent saves.
        s.self_writes.retain(|sw| sw.at.elapsed() < SELF_WRITE_TTL);
    }
}

/// Canonicalize a path so notify's worker thread (which normalizes through
/// the real filesystem) and the public API (which receives whatever path
/// the caller passed) agree on identity. macOS `/var/folders -> /private/var/folders`
/// is the canonical example: tests pass `/var/...`, FSEvents reports
/// `/private/var/...`, and a naive `HashSet<PathBuf>` compare misses.
///
/// Falls back to the original path when canonicalization fails (e.g. the
/// file was deleted between watch and event); the worst case is one missed
/// suppression, which surfaces as a stray Ask the user can dismiss.
fn canonical(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// Cheap content hash used by self-write suppression. Not cryptographic —
/// `DefaultHasher` is plenty for matching "did we just write this?" within
/// a 2-second window.
///
/// `pub` (not `pub(crate)`) so B3's tests in `src-tauri/tests/` can compute
/// the same hash they're about to record.
pub fn quick_hash(bytes: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}
