//! A6 integration tests: comment translators (drive/comments.rs), append-only
//! offline queue (drive/queue.rs), and per-file cache metadata (drive/cache.rs).
//!
//! These exercise the public surface that B5 (sync engine) and B6 (status pill)
//! consume: round-trip translation that preserves the W3C anchor exact span,
//! FIFO drain semantics for queued offline ops, and ETag/last-fetched cache
//! metadata round-trip.

use mdviewer_lib::anchor::Anchor;
use mdviewer_lib::comments::{Comment, Thread};
use mdviewer_lib::drive::api::{DriveAuthor, DriveCommentResource, QuotedFileContent};
use mdviewer_lib::drive::cache::{load_cache_meta, save_cache_meta, CacheMeta};
use mdviewer_lib::drive::comments::{from_drive_comment, to_drive_comment};
use mdviewer_lib::drive::queue::{DriveQueue, QueueOp};

fn sample_comment(body: &str) -> Comment {
    Comment {
        id: "c-local".into(),
        author: "Alice".into(),
        color: "#abc".into(),
        body: body.into(),
        created_at: "2026-04-30T12:00:00Z".into(),
        ..Default::default()
    }
}

#[test]
fn comment_round_trip_preserves_quoted_content() {
    let thread = Thread {
        id: "local-1".into(),
        anchor: Anchor {
            start: 0,
            end: "the quoted span".len(),
            exact: "the quoted span".into(),
            prefix: String::new(),
            suffix: String::new(),
        },
        comments: vec![sample_comment("first body")],
        resolved: false,
        resolved_at: None,
        resolved_by: None,
    };
    let drive: DriveCommentResource = to_drive_comment(&thread);
    assert_eq!(
        drive.quoted_file_content.as_ref().unwrap().value,
        "the quoted span"
    );
    assert_eq!(drive.content, "first body");
    let local = from_drive_comment(&drive).expect("must parse back");
    assert_eq!(local.anchor.exact, thread.anchor.exact);
    assert_eq!(local.comments.len(), 1);
    assert_eq!(local.comments[0].body, "first body");
}

#[test]
fn comment_without_quoted_content_surfaces_as_orphan() {
    let drive = DriveCommentResource {
        id: Some("DID-1".into()),
        content: "drifting thought".into(),
        quoted_file_content: None,
        modified_time: None,
        replies: vec![],
        resolved: false,
        author: None,
    };
    let local = from_drive_comment(&drive).unwrap();
    assert_eq!(local.anchor.exact, "");
    // The Drive id propagates onto both the thread and the first comment so
    // the offline-queue replay can deduplicate against it.
    assert_eq!(local.id, "DID-1");
    assert_eq!(local.comments[0].drive_id.as_deref(), Some("DID-1"));
}

#[test]
fn comment_translates_replies_with_author_email() {
    let drive = DriveCommentResource {
        id: Some("DID-1".into()),
        content: "first".into(),
        quoted_file_content: Some(QuotedFileContent {
            value: "spanned".into(),
        }),
        modified_time: Some("2026-04-30T11:00:00Z".into()),
        replies: vec![mdviewer_lib::drive::api::DriveReplyResource {
            id: Some("DID-2".into()),
            content: "second".into(),
            modified_time: Some("2026-04-30T11:01:00Z".into()),
            author: Some(DriveAuthor {
                display_name: Some("Bob".into()),
                email_address: Some("bob@example.com".into()),
            }),
        }],
        resolved: false,
        author: Some(DriveAuthor {
            display_name: Some("Alice".into()),
            email_address: Some("alice@example.com".into()),
        }),
    };
    let local = from_drive_comment(&drive).unwrap();
    assert_eq!(local.comments.len(), 2);
    assert_eq!(local.comments[0].author, "Alice");
    assert_eq!(local.comments[0].author_email.as_deref(), Some("alice@example.com"));
    assert_eq!(local.comments[1].author, "Bob");
    assert_eq!(local.comments[1].author_email.as_deref(), Some("bob@example.com"));
    assert_eq!(local.comments[1].drive_id.as_deref(), Some("DID-2"));
}

#[test]
fn queue_replay_preserves_fifo_order_and_drains() {
    let dir = tempfile::tempdir().unwrap();
    let q = DriveQueue::open(dir.path(), "FILEID");
    q.append(QueueOp::CreateThread {
        local_id: "L1".into(),
        content: "first".into(),
        quoted: String::new(),
    })
    .unwrap();
    q.append(QueueOp::CreateThread {
        local_id: "L2".into(),
        content: "second".into(),
        quoted: String::new(),
    })
    .unwrap();
    let drained = q.drain().unwrap();
    let ids: Vec<&str> = drained
        .iter()
        .map(|op| match op {
            QueueOp::CreateThread { local_id, .. } => local_id.as_str(),
            _ => "",
        })
        .collect();
    assert_eq!(ids, vec!["L1", "L2"]);
    // After drain, the file is empty.
    assert!(q.drain().unwrap().is_empty());
    assert!(q.is_empty());
}

#[test]
fn queue_handles_mixed_op_kinds() {
    let dir = tempfile::tempdir().unwrap();
    let q = DriveQueue::open(dir.path(), "FILEID");
    q.append(QueueOp::CreateThread {
        local_id: "L1".into(),
        content: "first".into(),
        quoted: "q".into(),
    })
    .unwrap();
    q.append(QueueOp::CreateReply {
        parent_drive_id: "DID-1".into(),
        content: "reply".into(),
        local_reply_id: "LR1".into(),
    })
    .unwrap();
    q.append(QueueOp::DeleteComment {
        drive_id: "DID-2".into(),
    })
    .unwrap();
    let drained = q.drain().unwrap();
    assert_eq!(drained.len(), 3);
    match &drained[0] {
        QueueOp::CreateThread { local_id, .. } => assert_eq!(local_id, "L1"),
        other => panic!("expected CreateThread, got {other:?}"),
    }
    match &drained[1] {
        QueueOp::CreateReply {
            parent_drive_id, ..
        } => assert_eq!(parent_drive_id, "DID-1"),
        other => panic!("expected CreateReply, got {other:?}"),
    }
    match &drained[2] {
        QueueOp::DeleteComment { drive_id } => assert_eq!(drive_id, "DID-2"),
        other => panic!("expected DeleteComment, got {other:?}"),
    }
}

#[test]
fn cache_meta_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let m = CacheMeta {
        etag: "W/\"abc\"".into(),
        last_fetched: "2026-04-30T12:00:00Z".into(),
        content_sha256: "deadbeef".into(),
    };
    save_cache_meta(dir.path(), "FID", &m).unwrap();
    let r = load_cache_meta(dir.path(), "FID").unwrap();
    assert_eq!(r.etag, m.etag);
    assert_eq!(r.last_fetched, m.last_fetched);
    assert_eq!(r.content_sha256, m.content_sha256);
}

#[test]
fn cache_meta_missing_returns_none() {
    let dir = tempfile::tempdir().unwrap();
    assert!(load_cache_meta(dir.path(), "DOES-NOT-EXIST").is_none());
}

#[test]
fn id_map_round_trip() {
    use mdviewer_lib::drive::comments::{load_id_map, save_id_map, IdMap};
    let dir = tempfile::tempdir().unwrap();
    let mut m = IdMap::default();
    m.map.insert("local-1".into(), "DRIVE-1".into());
    m.map.insert("local-2".into(), "DRIVE-2".into());
    save_id_map(dir.path(), "FID", &m).unwrap();
    let r = load_id_map(dir.path(), "FID");
    assert_eq!(r.map.get("local-1").map(String::as_str), Some("DRIVE-1"));
    assert_eq!(r.map.get("local-2").map(String::as_str), Some("DRIVE-2"));
}

#[test]
fn id_map_missing_loads_empty() {
    use mdviewer_lib::drive::comments::load_id_map;
    let dir = tempfile::tempdir().unwrap();
    let r = load_id_map(dir.path(), "MISSING");
    assert!(r.map.is_empty());
}
