//! Comments store: threads + comments with W3C-anchor selectors.
//!
//! Phase-1 in-memory representation of an entire document's comments.
//! Persistence (`<doc>.md.comments.json`) is layered in `sidecar.rs`. Both
//! modules ship at `schema_version: 1`; C1 will introduce v2 (Automerge) and
//! a one-way migration test from this format.
//!
//! ## Why `std::sync::mpsc` for fan-out
//!
//! Mirrors the pattern in `settings.rs` (A3): runtime-agnostic so the same
//! event stream is consumable from a tokio task (Tauri command), the file
//! watcher worker (B2), and synchronous integration tests. tokio's broadcast
//! channel would force every subscriber onto a tokio runtime — overkill for
//! a UI-side store.

use crate::anchor::Anchor;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::SystemTime;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[ts(export)]
pub struct Comment {
    pub id: String,
    pub author: String,
    pub color: String,
    pub body: String,
    /// RFC3339-ish timestamp; the exact format is opaque to consumers and only
    /// needs to be sortable lexicographically (which the `{secs}Z` form is).
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[ts(export)]
pub struct Thread {
    pub id: String,
    pub anchor: Anchor,
    pub comments: Vec<Comment>,
    #[serde(default)]
    pub resolved: bool,
    #[serde(default)]
    pub resolved_at: Option<String>,
    #[serde(default)]
    pub resolved_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct NewThread {
    pub anchor: Anchor,
    pub first_comment: NewComment,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct NewComment {
    pub author: String,
    pub color: String,
    pub body: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeEvent {
    ThreadCreated,
    ReplyPosted,
    ThreadResolved,
    /// Emitted on bulk replacement (e.g. when sidecar.rs accepts a newer
    /// incoming sidecar via auto-merge `Always`). Subscribers redraw.
    Bulk,
}

/// Outcome of a sidecar merge attempt. Auto-merge `Always` produces
/// `Adopted`; `Ask` / `Manual` produce `AskUser` for the frontend to
/// surface a chooser. Stubbed here as B2's attachment point.
pub enum MergeOutcome {
    Adopted(CommentsStore),
    AskUser {
        local: CommentsStore,
        incoming: CommentsStore,
    },
}

#[derive(Debug)]
pub struct CommentsStore {
    threads: Vec<Thread>,
    // Same runtime-agnostic fan-out as SettingsStore (A3).
    subs: Mutex<Vec<std::sync::mpsc::Sender<ChangeEvent>>>,
}

impl Default for CommentsStore {
    fn default() -> Self {
        Self::new()
    }
}

impl CommentsStore {
    pub fn new() -> Self {
        Self {
            threads: Vec::new(),
            subs: Mutex::new(Vec::new()),
        }
    }

    /// Construct a store seeded with `threads` (used by `sidecar::load_sidecar`).
    pub fn from_threads(threads: Vec<Thread>) -> Self {
        Self {
            threads,
            subs: Mutex::new(Vec::new()),
        }
    }

    /// Subscribe to typed change events. Each subscriber gets its own
    /// `mpsc::Receiver`; senders to dropped receivers are pruned on next emit.
    pub fn subscribe(&self) -> std::sync::mpsc::Receiver<ChangeEvent> {
        let (tx, rx) = std::sync::mpsc::channel();
        self.subs.lock().unwrap().push(tx);
        rx
    }

    fn emit(&self, ev: ChangeEvent) {
        let mut subs = self.subs.lock().unwrap();
        subs.retain(|tx| tx.send(ev).is_ok());
    }

    pub fn list_threads(&self) -> &[Thread] {
        &self.threads
    }

    pub fn get_thread(&self, id: &str) -> Option<&Thread> {
        self.threads.iter().find(|t| t.id == id)
    }

    /// Returns the newly-created Thread by value so the IPC layer (A8b's
    /// `create_thread` command) can ship the full structure to the frontend
    /// without a second `get_thread` call.
    pub fn create_thread(&mut self, n: NewThread) -> Thread {
        let tid = new_id("t-");
        let cid = new_id("c-");
        let t = Thread {
            id: tid,
            anchor: n.anchor,
            comments: vec![Comment {
                id: cid,
                author: n.first_comment.author,
                color: n.first_comment.color,
                body: n.first_comment.body,
                created_at: now_rfc3339(),
            }],
            resolved: false,
            resolved_at: None,
            resolved_by: None,
        };
        self.threads.push(t.clone());
        self.emit(ChangeEvent::ThreadCreated);
        t
    }

    pub fn post_reply(
        &mut self,
        thread_id: &str,
        n: NewComment,
    ) -> Result<(), &'static str> {
        let t = self
            .threads
            .iter_mut()
            .find(|t| t.id == thread_id)
            .ok_or("thread not found")?;
        t.comments.push(Comment {
            id: new_id("c-"),
            author: n.author,
            color: n.color,
            body: n.body,
            created_at: now_rfc3339(),
        });
        self.emit(ChangeEvent::ReplyPosted);
        Ok(())
    }

    pub fn resolve_thread(
        &mut self,
        thread_id: &str,
        by: &str,
    ) -> Result<(), &'static str> {
        let t = self
            .threads
            .iter_mut()
            .find(|t| t.id == thread_id)
            .ok_or("thread not found")?;
        t.resolved = true;
        t.resolved_at = Some(now_rfc3339());
        t.resolved_by = Some(by.into());
        self.emit(ChangeEvent::ThreadResolved);
        Ok(())
    }

    /// Replace all threads atomically (sidecar adoption path). Emits
    /// `ChangeEvent::Bulk` so subscribers redraw rather than diff per-thread.
    pub fn replace_all(&mut self, threads: Vec<Thread>) {
        self.threads = threads;
        self.emit(ChangeEvent::Bulk);
    }
}

fn now_rfc3339() -> String {
    use std::time::{Duration, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO);
    let secs = n.as_secs() as i64;
    // Civil-time conversion using Howard Hinnant's days-from-civil algorithm.
    // Keeps the function dep-free (no chrono/time crate) while still emitting
    // a real RFC3339 timestamp the frontend can pass to `new Date(...)`.
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400) as u32;
    let (year, month, day) = civil_from_days(days);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day / 60) % 60;
    let second = secs_of_day % 60;
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z"
    )
}

/// Days since 1970-01-01 → (year, month, day) in the proleptic Gregorian
/// calendar. Adapted from Howard Hinnant's "chrono-Compatible Low-Level Date
/// Algorithms" (public domain).
fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    let y_adj = if m <= 2 { y + 1 } else { y };
    (y_adj as i32, m, d)
}

// Monotonic counter used by new_id to guarantee uniqueness without depending
// on the system clock's resolution. Tests previously relied on a 1µs sleep,
// which was flaky on coarse-clock hosts; the counter removes that race.
static ID_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn new_id(prefix: &str) -> String {
    use std::sync::atomic::Ordering;
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let seq = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}{n:x}-{seq:x}")
}
