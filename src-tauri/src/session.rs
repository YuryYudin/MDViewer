//! Session store — per-window open tabs + active tab + geometry persisted
//! across app restarts.
//!
//! Drives the "restore where I left off" startup option. On every
//! `Workspace::open_document` / `close_tab` / window spawn/close / move /
//! resize, the workspace pushes its per-window snapshot list into this
//! store; `<data_dir>/session.json` mirrors that state. On startup, when
//! `Settings.appearance.startup_mode == "restore"`, `main.rs` (B2) reads
//! the stored windows and recreates each one before mounting the workspace.
//!
//! # On-disk schema (`03-session-schema-v2.md`)
//!
//! v2 is a versioned struct: `{ version: 2, windows: [WindowSession, …] }`.
//! Each `WindowSession` carries its left-to-right `tabs`, its `active` tab
//! (one of `tabs`, or `None`), and an optional `geometry` (position + size
//! in logical pixels; `None` ⇒ let the OS place the window).
//!
//! The legacy v1 shape (`{ open_tabs, active_tab }`, no `version`) is still
//! read: it migrates into a single `main`-equivalent window with `geometry:
//! None`. The first save after launch rewrites the file as v2.
//!
//! # Why a separate file
//!
//! Settings are saved on user action (rare); session is updated on every
//! tab open/close (frequent). Sharing a TOML file with settings would
//! make every tab-open serialize the entire settings struct and race
//! with user-driven saves. A separate JSON file matches the recents.json
//! pattern and is easy to inspect when debugging.
//!
//! # Why eager (write on every change), not lazy (write on shutdown)
//!
//! Restore-on-launch is most valuable precisely when the app crashed —
//! that's when the user wants their tabs back. Writing only on a clean
//! shutdown loses the state in exactly the case where it's needed.
//! Eager writes are cheap (a small JSON blob) and the cost is amortized
//! over the user's typing speed.
//!
//! # Why we own geometry directly (no `tauri-plugin-window-state`)
//!
//! B3 removes the window-state plugin; `session.json` becomes the single
//! source of truth for window placement. Two placement mechanisms would
//! race (the plugin restores on window create; we restore in the boot
//! loop), so we keep it all here and never read/write `window-state.json`.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use crate::recents::canonical_or_self;
use crate::workspace::WindowGeometry;

/// The current on-disk schema version. Bumped only on a breaking change to
/// the [`SessionV2`] shape; a file whose `version` is greater than this is
/// treated as "from a newer build" and ignored (empty-session fallback).
pub const SESSION_VERSION: u32 = 2;

/// Legacy v1 on-disk shape. Retained **only** so a file written by a build
/// before multi-window can be read and migrated; never written anymore.
/// `active_tab` may be one of the entries in `open_tabs`, or `None`.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Session {
    pub open_tabs: Vec<PathBuf>,
    pub active_tab: Option<PathBuf>,
}

/// One window's restorable state: its left-to-right tab paths, the active
/// tab (one of `tabs`, or `None` when the window is empty / on the
/// StartPage), and an optional geometry. `geometry` defaults to `None` so
/// a v1→v2 migration (which has no per-window geometry) round-trips.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WindowSession {
    pub tabs: Vec<PathBuf>,
    pub active: Option<PathBuf>,
    #[serde(default)]
    pub geometry: Option<WindowGeometry>,
}

/// The v2 on-disk shape. `version` discriminates v1 vs v2 (absent ⇒ v1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionV2 {
    pub version: u32,
    pub windows: Vec<WindowSession>,
}

impl Default for SessionV2 {
    /// The empty-session default: one empty window on the StartPage. This
    /// is what boot falls back to for "no file", malformed JSON, an
    /// unknown future `version`, or an explicit empty `windows: []`.
    fn default() -> Self {
        SessionV2 {
            version: SESSION_VERSION,
            windows: vec![WindowSession {
                tabs: Vec::new(),
                active: None,
                geometry: None,
            }],
        }
    }
}

/// A rectangle describing the union of all connected monitors' work areas,
/// in logical pixels. B2 computes the real bounds from the Tauri monitor
/// list at restore time; tests inject a synthetic rect so they don't need a
/// physical display. Used by [`clamp_geometry`] to decide whether a saved
/// window rect is entirely off-screen.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VirtualScreenBounds {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

/// Clamp a saved window rect against the current virtual-screen bounds.
///
/// If `geo` overlaps `bounds` at all (even a single pixel), it is returned
/// unchanged — the user may have intentionally tucked a window against an
/// edge. Only when `geo` is *entirely* outside `bounds` (e.g. it was on an
/// unplugged monitor) do we shift it so its title bar lands inside the
/// nearest visible edge, preserving the window's width/height. This keeps
/// the window grabbable instead of stranding it off-screen.
pub fn clamp_geometry(geo: WindowGeometry, bounds: VirtualScreenBounds) -> WindowGeometry {
    let geo_right = geo.x.saturating_add(geo.w as i32);
    let geo_bottom = geo.y.saturating_add(geo.h as i32);
    let bounds_right = bounds.x.saturating_add(bounds.w as i32);
    let bounds_bottom = bounds.y.saturating_add(bounds.h as i32);

    // Overlap test: two rects overlap iff each axis' intervals overlap.
    let overlaps_x = geo.x < bounds_right && geo_right > bounds.x;
    let overlaps_y = geo.y < bounds_bottom && geo_bottom > bounds.y;
    if overlaps_x && overlaps_y {
        return geo;
    }

    // Entirely outside: clamp the top-left so the whole window fits inside
    // the bounds when possible (so the title bar is reachable). The max
    // valid x keeps the right edge within bounds; never push below bounds.x.
    let max_x = bounds_right.saturating_sub(geo.w as i32).max(bounds.x);
    let max_y = bounds_bottom.saturating_sub(geo.h as i32).max(bounds.y);
    let new_x = geo.x.clamp(bounds.x, max_x);
    let new_y = geo.y.clamp(bounds.y, max_y);
    WindowGeometry {
        x: new_x,
        y: new_y,
        w: geo.w,
        h: geo.h,
    }
}

pub struct SessionStore {
    path: PathBuf,
    inner: RwLock<SessionV2>,
}

impl SessionStore {
    /// Open (or create) the session store rooted at `data_dir`.
    ///
    /// Version-tolerant load: the file is parsed as a `serde_json::Value`
    /// and branched on `version`:
    ///   * absent ⇒ legacy v1 → migrated into a single window;
    ///   * `2` ⇒ parsed as [`SessionV2`];
    ///   * `> 2` or any parse error ⇒ the empty-session default.
    ///
    /// Per restored window, missing local paths are pruned (the existence
    /// check is skipped for synthetic `drive-api://` paths, which round-trip
    /// and are reopened via `drive_open_url` at restore time), and an
    /// `active` that isn't in `tabs` is repaired to the first tab (or `None`
    /// when the window has no tabs). Restore is best-effort: I/O or parse
    /// failures never crash boot, they fall back to the empty default.
    pub fn open(data_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(data_dir).context("create data dir")?;
        let path = data_dir.join("session.json");
        let session = if path.exists() {
            match std::fs::read_to_string(&path) {
                Ok(bytes) => load_from_str(&bytes).unwrap_or_else(|| {
                    tracing::warn!(?path, "session.json unreadable/unknown; starting empty");
                    SessionV2::default()
                }),
                Err(e) => {
                    tracing::warn!(?path, ?e, "could not read session.json; starting empty");
                    SessionV2::default()
                }
            }
        } else {
            SessionV2::default()
        };
        Ok(Self {
            path,
            inner: RwLock::new(session),
        })
    }

    /// Snapshot the current in-memory session (v2 shape).
    pub fn get(&self) -> SessionV2 {
        self.inner.read().unwrap().clone()
    }

    /// Read-only accessor for the restored windows, in order.
    pub fn windows(&self) -> Vec<WindowSession> {
        self.inner.read().unwrap().windows.clone()
    }

    /// Replace the saved session with the given per-window list and write it
    /// to disk as v2. Local paths are canonicalized via the shared
    /// [`canonical_or_self`] helper so the keys agree with the recents and
    /// doc-prefs stores; synthetic `drive-api://` paths are left verbatim
    /// (canonicalizing them would mangle the scheme). Each window's `active`
    /// is repaired to one of its `tabs` (or `None`). The disk write happens
    /// while the lock is held so concurrent updates serialize and the file
    /// always reflects the most-recent in-memory state.
    pub fn save_windows(&self, windows: Vec<WindowSession>) -> Result<()> {
        let normalized: Vec<WindowSession> = windows
            .into_iter()
            .map(|w| {
                let tabs: Vec<PathBuf> = w.tabs.iter().map(|p| canonicalize_path(p)).collect();
                let active = w
                    .active
                    .map(|p| canonicalize_path(&p))
                    .filter(|p| tabs.iter().any(|t| t == p));
                WindowSession {
                    tabs,
                    active,
                    geometry: w.geometry,
                }
            })
            .collect();
        let session = SessionV2 {
            version: SESSION_VERSION,
            windows: normalized,
        };
        let mut guard = self.inner.write().unwrap();
        *guard = session.clone();
        let bytes = serde_json::to_string_pretty(&session).context("serialize session.json")?;
        std::fs::write(&self.path, bytes).context("write session.json")?;
        Ok(())
    }

    /// Clear the session — writes `{ version: 2, windows: [] }`. The next
    /// `open` of an empty `windows` array falls back to the empty-session
    /// default (one empty window).
    pub fn clear(&self) -> Result<()> {
        self.save_windows(Vec::new())
    }
}

/// Canonicalize a local path, but leave synthetic `drive-api://` paths
/// alone — they aren't real filesystem paths and `canonical_or_self` would
/// strip/duplicate the scheme.
fn canonicalize_path(p: &Path) -> PathBuf {
    if is_synthetic(p) {
        p.to_path_buf()
    } else {
        canonical_or_self(p)
    }
}

/// True for synthetic paths that don't live on the local filesystem and so
/// must skip both the `exists()` prune and canonicalization. Today that's
/// only the Drive-API URL-paste scheme; matching `main.rs`'s restore guard.
fn is_synthetic(p: &Path) -> bool {
    p.to_string_lossy().starts_with("drive-api://")
}

/// Version-tolerant parse of a `session.json` body into the in-memory v2
/// shape, applying migration / prune / active-repair. Returns `None` for a
/// malformed body or an unknown future `version` so the caller can log and
/// fall back to the empty default. Split out so the load path is unit-
/// testable without touching the filesystem.
fn load_from_str(bytes: &str) -> Option<SessionV2> {
    let value: serde_json::Value = serde_json::from_str(bytes).ok()?;
    let version = value.get("version").and_then(|v| v.as_u64());
    let windows = match version {
        // Absent `version` ⇒ legacy v1. Migrate into a single window.
        None => {
            let v1: Session = serde_json::from_value(value).ok()?;
            vec![WindowSession {
                tabs: v1.open_tabs,
                active: v1.active_tab,
                geometry: None,
            }]
        }
        // Current schema.
        Some(v) if v as u32 == SESSION_VERSION => {
            let v2: SessionV2 = serde_json::from_value(value).ok()?;
            v2.windows
        }
        // A version from a newer build (or a nonsense value): ignore.
        Some(_) => return None,
    };
    // Empty `windows: []` (and a v1 file that migrates to nothing) is
    // treated as "no session" → fall back to the one-empty-window default
    // so boot always has a window to show on the StartPage.
    if windows.is_empty() {
        return Some(SessionV2::default());
    }
    Some(SessionV2 {
        version: SESSION_VERSION,
        windows: windows.into_iter().map(prune_and_repair_window).collect(),
    })
}

/// Prune nonexistent local paths from a window and repair its `active`.
/// Synthetic `drive-api://` paths skip the existence check (they round-trip
/// and are reopened via `drive_open_url`). After pruning, `active` is kept
/// only if it survived; otherwise it repairs to the first remaining tab, or
/// `None` when the window ends up empty.
fn prune_and_repair_window(w: WindowSession) -> WindowSession {
    let tabs: Vec<PathBuf> = w
        .tabs
        .into_iter()
        .filter(|p| is_synthetic(p) || p.exists())
        .collect();
    let active = w
        .active
        .filter(|p| tabs.iter().any(|t| t == p))
        .or_else(|| tabs.first().cloned());
    WindowSession {
        tabs,
        active,
        geometry: w.geometry,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn touch(dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, "x").unwrap();
        p
    }

    fn geo(x: i32, y: i32, w: u32, h: u32) -> WindowGeometry {
        WindowGeometry { x, y, w, h }
    }

    #[test]
    fn open_returns_empty_when_no_file() {
        let dir = tempdir().unwrap();
        let store = SessionStore::open(dir.path()).unwrap();
        let s = store.get();
        // Empty-session default: exactly one empty window.
        assert_eq!(s.version, SESSION_VERSION);
        assert_eq!(s.windows.len(), 1);
        assert!(s.windows[0].tabs.is_empty());
        assert!(s.windows[0].active.is_none());
        assert!(s.windows[0].geometry.is_none());
    }

    #[test]
    fn save_windows_then_open_round_trips() {
        let dir = tempdir().unwrap();
        let a = touch(dir.path(), "a.md");
        let b = touch(dir.path(), "b.md");
        let c = touch(dir.path(), "c.md");
        {
            let store = SessionStore::open(dir.path()).unwrap();
            store
                .save_windows(vec![
                    WindowSession {
                        tabs: vec![a.clone(), b.clone()],
                        active: Some(b.clone()),
                        geometry: Some(geo(0, 0, 1280, 800)),
                    },
                    WindowSession {
                        tabs: vec![c.clone()],
                        active: Some(c.clone()),
                        geometry: Some(geo(1280, 0, 900, 700)),
                    },
                ])
                .unwrap();
        }
        let reopened = SessionStore::open(dir.path()).unwrap();
        let s = reopened.get();
        assert_eq!(s.windows.len(), 2);
        // basename-compare (canonical_or_self may rewrite /var → /private/var).
        assert_eq!(s.windows[0].tabs[0].file_name().unwrap(), "a.md");
        assert_eq!(s.windows[0].tabs[1].file_name().unwrap(), "b.md");
        assert_eq!(s.windows[0].active.as_ref().unwrap().file_name().unwrap(), "b.md");
        assert_eq!(s.windows[0].geometry, Some(geo(0, 0, 1280, 800)));
        assert_eq!(s.windows[1].tabs[0].file_name().unwrap(), "c.md");
        assert_eq!(s.windows[1].geometry, Some(geo(1280, 0, 900, 700)));
    }

    #[test]
    fn v2_round_trips_losslessly() {
        let dir = tempdir().unwrap();
        let a = touch(dir.path(), "a.md");
        let store = SessionStore::open(dir.path()).unwrap();
        store
            .save_windows(vec![WindowSession {
                tabs: vec![a.clone()],
                active: Some(a.clone()),
                geometry: Some(geo(10, 20, 640, 480)),
            }])
            .unwrap();
        let s1 = store.windows();
        // Re-save the canonicalized form: must remain byte-stable.
        store.save_windows(s1.clone()).unwrap();
        let s2 = store.windows();
        assert_eq!(s1, s2);
    }

    #[test]
    fn v1_file_migrates_to_single_main_window() {
        let dir = tempdir().unwrap();
        let a = touch(dir.path(), "a.md");
        let b = touch(dir.path(), "b.md");
        // Write a legacy v1 file (no `version` key).
        let v1 = serde_json::json!({
            "open_tabs": [a.to_string_lossy(), b.to_string_lossy()],
            "active_tab": b.to_string_lossy(),
        });
        std::fs::write(
            dir.path().join("session.json"),
            serde_json::to_string_pretty(&v1).unwrap(),
        )
        .unwrap();

        let store = SessionStore::open(dir.path()).unwrap();
        let s = store.get();
        assert_eq!(s.version, SESSION_VERSION);
        assert_eq!(s.windows.len(), 1, "v1 migrates to exactly one window");
        assert_eq!(s.windows[0].tabs.len(), 2);
        assert_eq!(s.windows[0].tabs[0].file_name().unwrap(), "a.md");
        assert_eq!(s.windows[0].tabs[1].file_name().unwrap(), "b.md");
        assert_eq!(s.windows[0].active.as_ref().unwrap().file_name().unwrap(), "b.md");
        assert!(s.windows[0].geometry.is_none(), "migrated window has no geometry");
    }

    #[test]
    fn corrupt_json_yields_empty_session() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("session.json"), "{not json").unwrap();
        let store = SessionStore::open(dir.path()).unwrap();
        let s = store.get();
        assert_eq!(s.windows.len(), 1);
        assert!(s.windows[0].tabs.is_empty());
    }

    #[test]
    fn unknown_future_version_falls_back() {
        let dir = tempdir().unwrap();
        let future = serde_json::json!({
            "version": 99,
            "windows": [{ "tabs": ["/whatever.md"], "active": null, "geometry": null }],
        });
        std::fs::write(
            dir.path().join("session.json"),
            serde_json::to_string(&future).unwrap(),
        )
        .unwrap();
        let store = SessionStore::open(dir.path()).unwrap();
        let s = store.get();
        // Newer-build file is ignored → empty-session default.
        assert_eq!(s.windows.len(), 1);
        assert!(s.windows[0].tabs.is_empty());
        assert!(s.windows[0].active.is_none());
    }

    #[test]
    fn empty_windows_array_treated_as_no_session() {
        let dir = tempdir().unwrap();
        let empty = serde_json::json!({ "version": 2, "windows": [] });
        std::fs::write(
            dir.path().join("session.json"),
            serde_json::to_string(&empty).unwrap(),
        )
        .unwrap();
        // A v2 file with `windows: []` is treated as "no session" → the
        // one-empty-window default so boot always has a window to show.
        let store = SessionStore::open(dir.path()).unwrap();
        let s = store.get();
        assert_eq!(s.windows.len(), 1, "empty windows array falls back to one window");
        assert!(s.windows[0].tabs.is_empty());
        assert!(s.windows[0].active.is_none());
    }

    #[test]
    fn clear_reopens_as_empty_session() {
        let dir = tempdir().unwrap();
        let a = touch(dir.path(), "a.md");
        let store = SessionStore::open(dir.path()).unwrap();
        store
            .save_windows(vec![WindowSession {
                tabs: vec![a.clone()],
                active: Some(a.clone()),
                geometry: None,
            }])
            .unwrap();
        store.clear().unwrap();
        // In-memory after clear: empty windows.
        assert!(store.get().windows.is_empty());
        // Reopen falls back to the one-empty-window default.
        let reopened = SessionStore::open(dir.path()).unwrap();
        let s = reopened.get();
        assert_eq!(s.windows.len(), 1);
        assert!(s.windows[0].tabs.is_empty());
    }

    #[test]
    fn open_prunes_missing_paths() {
        let dir = tempdir().unwrap();
        let a = touch(dir.path(), "a.md");
        let ghost = dir.path().join("ghost.md");
        {
            let store = SessionStore::open(dir.path()).unwrap();
            store
                .save_windows(vec![WindowSession {
                    tabs: vec![a.clone(), ghost.clone()],
                    active: Some(ghost.clone()),
                    geometry: None,
                }])
                .unwrap();
        }
        // Delete the file that did exist so both paths are ghosts at load.
        std::fs::remove_file(&a).unwrap();
        let reopened = SessionStore::open(dir.path()).unwrap();
        let s = reopened.get();
        assert!(s.windows[0].tabs.is_empty(), "all ghosts pruned");
        assert!(s.windows[0].active.is_none(), "active falls back to None when empty");
    }

    #[test]
    fn synthetic_drive_paths_survive_prune() {
        // drive-api:// paths don't exist on disk but must round-trip — the
        // boot loop skips them and reopens via drive_open_url.
        let dir = tempdir().unwrap();
        let drive = PathBuf::from("drive-api://abc123");
        let store = SessionStore::open(dir.path()).unwrap();
        store
            .save_windows(vec![WindowSession {
                tabs: vec![drive.clone()],
                active: Some(drive.clone()),
                geometry: None,
            }])
            .unwrap();
        // Re-open: the synthetic path must NOT be pruned by the exists() check.
        let reopened = SessionStore::open(dir.path()).unwrap();
        let s = reopened.get();
        assert_eq!(s.windows[0].tabs, vec![drive.clone()]);
        assert_eq!(s.windows[0].active, Some(drive));
    }

    #[test]
    fn active_not_in_tabs_is_repaired() {
        // A v2 file whose `active` isn't in `tabs` repairs to the first tab.
        let dir = tempdir().unwrap();
        let a = touch(dir.path(), "a.md");
        let b = touch(dir.path(), "b.md");
        let v2 = serde_json::json!({
            "version": 2,
            "windows": [{
                "tabs": [a.to_string_lossy(), b.to_string_lossy()],
                "active": "/not/one/of/the/tabs.md",
                "geometry": null,
            }],
        });
        std::fs::write(
            dir.path().join("session.json"),
            serde_json::to_string(&v2).unwrap(),
        )
        .unwrap();
        let store = SessionStore::open(dir.path()).unwrap();
        let s = store.get();
        assert_eq!(
            s.windows[0].active.as_ref().unwrap().file_name().unwrap(),
            "a.md",
            "active repairs to the first tab"
        );
    }

    #[test]
    fn active_repairs_to_none_when_window_empty() {
        // active set but tabs empty (after prune) → active becomes None.
        let dir = tempdir().unwrap();
        let v2 = serde_json::json!({
            "version": 2,
            "windows": [{
                "tabs": [],
                "active": "/gone.md",
                "geometry": null,
            }],
        });
        std::fs::write(
            dir.path().join("session.json"),
            serde_json::to_string(&v2).unwrap(),
        )
        .unwrap();
        let store = SessionStore::open(dir.path()).unwrap();
        let s = store.get();
        assert!(s.windows[0].tabs.is_empty());
        assert!(s.windows[0].active.is_none(), "active repairs to None when no tabs");
    }

    #[test]
    fn save_windows_drops_active_when_not_in_tabs() {
        // Defensive: a caller passing an active that isn't in tabs writes
        // None rather than a dangling reference.
        let dir = tempdir().unwrap();
        let a = touch(dir.path(), "a.md");
        let b = touch(dir.path(), "b.md");
        let store = SessionStore::open(dir.path()).unwrap();
        store
            .save_windows(vec![WindowSession {
                tabs: vec![a.clone()],
                active: Some(b.clone()),
                geometry: None,
            }])
            .unwrap();
        let s = store.get();
        assert_eq!(s.windows[0].tabs.len(), 1);
        assert!(s.windows[0].active.is_none());
    }

    #[test]
    fn offscreen_geometry_is_clamped() {
        // Virtual screen at origin, 1920x1080.
        let bounds = VirtualScreenBounds { x: 0, y: 0, w: 1920, h: 1080 };

        // Entirely off to the right+down (e.g. an unplugged second monitor):
        // clamped so the whole window fits, title bar reachable.
        let off = geo(5000, 4000, 800, 600);
        let clamped = clamp_geometry(off, bounds);
        assert_eq!(clamped.w, 800, "width preserved");
        assert_eq!(clamped.h, 600, "height preserved");
        assert_eq!(clamped.x, 1920 - 800, "right edge pulled into bounds");
        assert_eq!(clamped.y, 1080 - 600, "bottom edge pulled into bounds");
        // The clamped rect now overlaps the bounds.
        assert!(clamped.x < 1920 && clamped.x + clamped.w as i32 > 0);

        // Entirely off to the left (negative): clamp x up to bounds.x.
        let off_left = geo(-2000, 100, 400, 300);
        let cl = clamp_geometry(off_left, bounds);
        assert_eq!(cl.x, 0, "negative x clamped to bounds.x");
        assert_eq!(cl.y, 100, "y already inside is preserved");
    }

    #[test]
    fn partial_overlap_geometry_unchanged() {
        let bounds = VirtualScreenBounds { x: 0, y: 0, w: 1920, h: 1080 };
        // Hangs off the right edge but a sliver still overlaps → unchanged.
        let partial = geo(1900, 500, 400, 300);
        assert_eq!(clamp_geometry(partial, bounds), partial);
        // A normal fully-inside window is unchanged.
        let inside = geo(100, 100, 800, 600);
        assert_eq!(clamp_geometry(inside, bounds), inside);
        // Edge-touching at the top-left corner counts as overlap.
        let corner = geo(-100, -100, 200, 200);
        assert_eq!(clamp_geometry(corner, bounds), corner);
    }
}
