//! Append-only NDJSON queue at `<config_dir>/drive_queue/<file_id>.json`.
//!
//! Records offline comment ops (create thread, post reply, delete) so they
//! can be drained FIFO when the user reconnects. Why NDJSON instead of a
//! single JSON array:
//!
//! - **Append-safety.** `OpenOptions::append` + `writeln!` is atomic at the
//!   line level on POSIX (`O_APPEND` writes never interleave below
//!   PIPE_BUF), and concurrent writers from different threads land on
//!   distinct lines. A whole-file rewrite would race on every append.
//! - **Crash-tolerance.** A truncated tail line is just one lost op (which
//!   the user can re-issue manually); a truncated JSON array is unparseable
//!   and would lose every queued op since the last successful write.
//! - **Greppability.** The file is human-debuggable from a terminal,
//!   important when the support story is "send us drive_queue/<file>.json".
//!
//! `drain()` reads under the in-process mutex, then truncates the file. The
//! mutex protects against concurrent drains within the same process; cross-
//! process safety is out of scope (only the running mdviewer instance writes
//! to its own config dir).

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum QueueOp {
    /// User created a new comment thread while offline. `local_id` is the
    /// CRDT id assigned at create time; on replay we POST to Drive and
    /// record `local_id → drive_id` in the IdMap (see comments.rs).
    CreateThread {
        local_id: String,
        content: String,
        quoted: String,
    },
    /// User deleted a Drive-imported comment. `drive_id` is required since
    /// only Drive-side comments are deletable through this op.
    DeleteComment { drive_id: String },
    /// User replied to a Drive-side thread. `parent_drive_id` keys the
    /// Drive POST; `local_reply_id` lets the IdMap record the new reply id
    /// once Drive returns it.
    CreateReply {
        parent_drive_id: String,
        content: String,
        local_reply_id: String,
    },
}

pub struct DriveQueue {
    path: PathBuf,
    /// In-process serialization for `append`/`drain`. Cross-process safety
    /// is out of scope (single-instance app via tauri-plugin-single-instance).
    lock: Mutex<()>,
}

impl DriveQueue {
    /// Open (or implicitly create on first append) the queue file for a
    /// given Drive file id under `<config_dir>/drive_queue/<file_id>.json`.
    pub fn open(config_dir: &Path, file_id: &str) -> Self {
        let mut p = config_dir.to_path_buf();
        p.push("drive_queue");
        let _ = std::fs::create_dir_all(&p);
        p.push(format!("{}.json", file_id));
        Self {
            path: p,
            lock: Mutex::new(()),
        }
    }

    /// Append a single op as one NDJSON line. Returns the underlying I/O
    /// error if the file system is full or the user revokes write access
    /// to the config dir mid-session — the caller should surface the error
    /// to the status pill rather than silently dropping the op.
    pub fn append(&self, op: QueueOp) -> std::io::Result<()> {
        let _g = self.lock.lock().unwrap();
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        let line = serde_json::to_string(&op).unwrap();
        writeln!(f, "{}", line)?;
        Ok(())
    }

    /// Read every queued op in append order, then truncate the file. Returns
    /// an empty Vec when the file is missing (cold start) or already empty.
    /// Malformed lines are silently skipped — they're recoverable only by
    /// hand-editing the file, and blocking replay on a single bad line would
    /// strand every subsequent op.
    pub fn drain(&self) -> std::io::Result<Vec<QueueOp>> {
        let _g = self.lock.lock().unwrap();
        if !self.path.exists() {
            return Ok(vec![]);
        }
        let f = File::open(&self.path)?;
        let r = BufReader::new(f);
        let mut ops = Vec::new();
        for line in r.lines() {
            let line = line?;
            if line.is_empty() {
                continue;
            }
            if let Ok(op) = serde_json::from_str::<QueueOp>(&line) {
                ops.push(op);
            }
        }
        // Truncate by overwriting with empty; cheap on small files and
        // avoids an extra `remove_file`/`create_new` round-trip.
        std::fs::write(&self.path, b"")?;
        Ok(ops)
    }

    /// True when the queue file is missing or zero-bytes. Cheap probe used
    /// by the status pill to decide whether to render the "Pending" badge.
    pub fn is_empty(&self) -> bool {
        let _g = self.lock.lock().unwrap();
        std::fs::metadata(&self.path)
            .map(|m| m.len() == 0)
            .unwrap_or(true)
    }
}
