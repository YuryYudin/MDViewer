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

/// Drain the queue and forward every op to Drive in FIFO order. New Drive
/// ids returned by the server are written into `id_map` so subsequent polls
/// don't re-import the same comment as a fresh thread.
///
/// **Failure semantics.** If any op fails (network error, 4xx/5xx after
/// retries) we re-append the failed op AND every op that came after it back
/// onto the queue, in original order, then return the error to the caller.
/// The caller (the polling loop or `spawn_replay_all`) treats the error as a
/// "try again next poll" signal — it must NOT mark the queue drained. The
/// alternative (drop the failed op, keep going) would silently lose user
/// comments, which is the worst possible failure mode for an offline-first
/// feature: the user wrote text, saw it appear, and then it vanished. Better
/// to leave the op on disk forever than to drop it once.
///
/// **Why not retry inside this function?** `DriveApi::send_with_retry`
/// already handles 5xx/429 with exponential backoff (4 attempts). A second
/// retry layer here would multiply the backoff window and stall the polling
/// loop for minutes when the network is genuinely down. Re-queueing instead
/// hands the next attempt to the next poll cycle — which the user can also
/// trigger manually by toggling reconnect.
pub fn replay(
    q: &DriveQueue,
    api: &crate::drive::api::DriveApi,
    file_id: &str,
    id_map: &std::sync::Mutex<crate::drive::comments::IdMap>,
) -> Result<(), crate::drive::DriveError> {
    let ops = q
        .drain()
        .map_err(|e| crate::drive::DriveError::Api(e.to_string()))?;
    let mut iter = ops.into_iter();
    while let Some(op) = iter.next() {
        // On any failure we must re-append the current op + every remaining
        // op (collected via `iter` consuming the rest) before returning.
        // Inlined so each match arm can return early without duplicating the
        // requeue helper's borrows.
        let result: Result<(), crate::drive::DriveError> = match &op {
            QueueOp::CreateThread {
                local_id,
                content,
                quoted,
            } => {
                let body = crate::drive::api::DriveCommentResource {
                    id: None,
                    content: content.clone(),
                    quoted_file_content: Some(crate::drive::api::QuotedFileContent {
                        value: quoted.clone(),
                    }),
                    modified_time: None,
                    replies: vec![],
                    resolved: false,
                    author: None,
                };
                match api.create_comment(file_id, &body) {
                    Ok(resp) => {
                        if let Some(drive_id) = resp.id {
                            id_map
                                .lock()
                                .unwrap()
                                .map
                                .insert(local_id.clone(), drive_id);
                        }
                        Ok(())
                    }
                    Err(e) => Err(e),
                }
            }
            QueueOp::DeleteComment { drive_id } => api.delete_comment(file_id, drive_id),
            QueueOp::CreateReply {
                parent_drive_id,
                content,
                local_reply_id,
            } => {
                let body = crate::drive::api::DriveReplyResource {
                    id: None,
                    content: content.clone(),
                    modified_time: None,
                    author: None,
                };
                match api.create_reply(file_id, parent_drive_id, &body) {
                    Ok(resp) => {
                        if let Some(drive_id) = resp.id {
                            id_map
                                .lock()
                                .unwrap()
                                .map
                                .insert(local_reply_id.clone(), drive_id);
                        }
                        Ok(())
                    }
                    Err(e) => Err(e),
                }
            }
        };

        if let Err(e) = result {
            // Re-queue the failed op and every op behind it so the next
            // replay attempt picks them up. Order is preserved so a
            // create-then-reply pair stays adjacent.
            let mut remaining: Vec<QueueOp> = Vec::new();
            remaining.push(op);
            remaining.extend(iter);
            for r in remaining {
                q.append(r)
                    .map_err(|e| crate::drive::DriveError::Api(e.to_string()))?;
            }
            return Err(e);
        }
    }
    Ok(())
}

/// Async fan-out wrapper used by `drive_connect` (B6) and any other caller
/// that wants to drain every open Drive tab's queue without blocking the
/// IPC thread. Spawns a single Tokio task that walks each `(file_id,
/// config_dir)` pair, opens the queue, and runs `replay()` against the
/// shared `id_map` for that file. Emits a bare `drive-status-changed` nudge
/// after each file_id finishes so the UI status pill counts down live as
/// the queue drains.
///
/// The caller passes a *cloned* HashMap of `Arc<Mutex<IdMap>>` (see
/// `Workspace::id_maps_arc_clone`) so the spawned task never holds the
/// outer Workspace lock through a Drive API roundtrip — long-running
/// network calls would otherwise block every other IPC handler.
///
/// Errors are logged at `debug` level rather than surfaced — the
/// re-queue-on-failure semantics inside `replay()` already preserve the
/// user's data, and the next poll cycle will retry. A loud error log on
/// every offline blip would create noise for no actionable signal.
pub fn spawn_replay_all(
    app: tauri::AppHandle,
    api: std::sync::Arc<crate::drive::api::DriveApi>,
    queues: Vec<(String, std::path::PathBuf)>,
    id_maps: std::collections::HashMap<
        String,
        std::sync::Arc<std::sync::Mutex<crate::drive::comments::IdMap>>,
    >,
) {
    tauri::async_runtime::spawn(async move {
        for (file_id, cfg) in queues {
            // Run the (blocking) replay on a blocking-pool thread so the
            // async reactor isn't held up by reqwest::blocking calls.
            let api_c = api.clone();
            let id_maps_c = id_maps.clone();
            let file_id_c = file_id.clone();
            let cfg_c = cfg.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                let q = DriveQueue::open(&cfg_c, &file_id_c);
                if let Some(map) = id_maps_c.get(&file_id_c) {
                    if let Err(e) = replay(&q, &api_c, &file_id_c, map) {
                        tracing::debug!("replay {} pending: {:?}", file_id_c, e);
                    }
                }
            })
            .await;
            // Nudge the status pill so the per-file pending count counts
            // down as each queue drains. The full DriveStatus snapshot is
            // assembled by the polling loop's diff path; we only signal
            // that *something* changed.
            let _ = tauri::Emitter::emit(&app, "drive-status-changed", ());
        }
    });
}
