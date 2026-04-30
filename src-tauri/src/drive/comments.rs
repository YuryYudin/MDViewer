//! Bidirectional translation between our `Thread`/`Comment` types and Drive's
//! `comments` resource. Maintains a per-file id_map at
//! `<config_dir>/drive_id_map/<file_id>.json` so the offline queue (queue.rs)
//! can replay newly-minted Drive ids back into the in-memory store without
//! re-importing the same thread on the next poll cycle.
//!
//! ## v1 anchor scope
//!
//! Drive exposes both a structured `anchor` (line/length JSON) and the
//! free-form `quotedFileContent.value`. v1 only round-trips the latter — the
//! W3C `exact` span maps cleanly onto `quotedFileContent.value`, while the
//! line+length anchor would need a separate translator that re-derives line
//! offsets from the source text. Comments arriving without a quoted value
//! surface as orphans via the empty-`exact` fallback (the existing anchor
//! resolver already handles that branch).

use crate::anchor::Anchor;
use crate::comments::{Comment, Thread};

use super::api::{DriveAuthor, DriveCommentResource, DriveReplyResource, QuotedFileContent};

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Translate a local `Thread` into a Drive comments-resource for POST. The
/// first comment becomes the parent body; the rest become `replies[]`. The
/// thread's anchor `exact` span rides along as `quotedFileContent.value`.
///
/// Returned resource has `id = None` because the caller is creating a new
/// comment; Drive mints the id on the create response and the caller writes
/// it back into the `IdMap`.
pub fn to_drive_comment(thread: &Thread) -> DriveCommentResource {
    let body = thread
        .comments
        .first()
        .map(|c| c.body.clone())
        .unwrap_or_default();
    let replies: Vec<DriveReplyResource> = thread
        .comments
        .iter()
        .skip(1)
        .map(|c| DriveReplyResource {
            id: c.drive_id.clone(),
            content: c.body.clone(),
            modified_time: Some(c.created_at.clone()),
            author: Some(DriveAuthor {
                display_name: Some(c.author.clone()),
                email_address: c.author_email.clone(),
            }),
        })
        .collect();
    DriveCommentResource {
        id: thread.comments.first().and_then(|c| c.drive_id.clone()),
        content: body,
        quoted_file_content: Some(QuotedFileContent {
            value: thread.anchor.exact.clone(),
        }),
        modified_time: None,
        replies,
        resolved: thread.resolved,
        author: None,
    }
}

/// Translate a Drive comments-resource into a local `Thread`. Returns `Some`
/// for every well-formed input — comments without `quotedFileContent` produce
/// a thread whose `anchor.exact` is empty, which the existing resolver maps
/// to `Orphan` (kept on screen as an "orphan" thread rather than dropped).
///
/// The `color` field stays empty because color is a local-only UI concern
/// (assigned by the comments panel from a per-author palette); the Drive side
/// has no analogue.
pub fn from_drive_comment(d: &DriveCommentResource) -> Option<Thread> {
    let exact = d
        .quoted_file_content
        .as_ref()
        .map(|q| q.value.clone())
        .unwrap_or_default();
    let anchor = Anchor {
        start: 0,
        end: exact.len(),
        exact,
        prefix: String::new(),
        suffix: String::new(),
    };
    let mut comments = Vec::new();
    let author = |a: &Option<DriveAuthor>| -> (String, Option<String>) {
        let a = a.as_ref();
        let dn = a
            .and_then(|x| x.display_name.clone())
            .unwrap_or_else(|| "Unknown".into());
        let em = a.and_then(|x| x.email_address.clone());
        (dn, em)
    };
    let (dn, em) = author(&d.author);
    comments.push(Comment {
        id: d.id.clone().unwrap_or_default(),
        author: dn,
        color: String::new(),
        body: d.content.clone(),
        created_at: d.modified_time.clone().unwrap_or_default(),
        author_email: em,
        drive_id: d.id.clone(),
    });
    for r in &d.replies {
        let (dn, em) = author(&r.author);
        comments.push(Comment {
            id: r.id.clone().unwrap_or_default(),
            author: dn,
            color: String::new(),
            body: r.content.clone(),
            created_at: r.modified_time.clone().unwrap_or_default(),
            author_email: em,
            drive_id: r.id.clone(),
        });
    }
    Some(Thread {
        id: d.id.clone().unwrap_or_default(),
        anchor,
        comments,
        resolved: d.resolved,
        resolved_at: None,
        resolved_by: None,
    })
}

/// Per-file persistent map from local CRDT comment ids to Drive comment ids.
///
/// Persisted across cache wipes — losing this map means a subsequent poll
/// re-imports the comment as a fresh thread (the user sees a duplicate). The
/// id_map directory therefore lives in `<config_dir>/drive_id_map/`, separate
/// from `<config_dir>/drive_cache_meta/` which is allowed to be invalidated
/// whenever the cached document body is recomputed.
#[derive(Default, Clone, serde::Serialize, serde::Deserialize)]
pub struct IdMap {
    pub map: HashMap<String, String>,
}

/// Resolve the absolute path for a given file's id_map JSON. Creates the
/// parent directory eagerly so callers can `save_id_map` without a separate
/// `mkdir` round-trip.
pub fn id_map_path(config_dir: &Path, file_id: &str) -> PathBuf {
    let mut p = config_dir.to_path_buf();
    p.push("drive_id_map");
    let _ = std::fs::create_dir_all(&p);
    p.push(format!("{}.json", file_id));
    p
}

/// Load a file's id_map from disk; missing or malformed → empty map. The
/// silent fallback is intentional: a corrupt id_map would, at worst, cause one
/// duplicate import on the next poll, which the user can resolve by deleting
/// the imported duplicate. Surfacing an error here would block the entire
/// poll cycle.
pub fn load_id_map(config_dir: &Path, file_id: &str) -> IdMap {
    let p = id_map_path(config_dir, file_id);
    std::fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Persist an id_map for a given file. Whole-file rewrite is acceptable here
/// because the map is small (one entry per local comment) and writes happen
/// only at the end of a successful queue replay batch — not on every comment
/// edit. Contrast with `queue.rs`, which is append-only NDJSON precisely
/// because writes are frequent and concurrent.
pub fn save_id_map(config_dir: &Path, file_id: &str, map: &IdMap) -> std::io::Result<()> {
    let p = id_map_path(config_dir, file_id);
    let body = serde_json::to_string(map).unwrap();
    std::fs::write(p, body)
}
