//! Smoke test: round-trip a CommentsStore through Automerge in-crate.

use mdviewer_core::anchor::Anchor;
use mdviewer_core::comments::{
    merge_stores_bytes, store_from_automerge, store_to_automerge, CommentsStore, NewComment,
    NewThread,
};

#[test]
fn round_trip_through_automerge_preserves_threads() {
    let mut store = CommentsStore::new();
    let new_thread = NewThread {
        anchor: Anchor {
            start: 0,
            end: 1,
            exact: "x".into(),
            prefix: "".into(),
            suffix: "".into(),
        },
        first_comment: NewComment {
            author: "U".into(),
            color: "#000".into(),
            body: "body".into(),
        },
    };
    let _ = store.create_thread(new_thread);

    let bytes = store_to_automerge(&store).expect("encode");
    let restored = store_from_automerge(&bytes).expect("decode");

    assert_eq!(store.list_threads().len(), restored.list_threads().len());
    assert_eq!(store.list_threads()[0].id, restored.list_threads()[0].id);
}

#[test]
fn delete_thread_removes_matching_id_and_errors_on_unknown() {
    let mut store = CommentsStore::new();
    let created = store.create_thread(NewThread {
        anchor: Anchor {
            start: 0,
            end: 1,
            exact: "x".into(),
            prefix: "".into(),
            suffix: "".into(),
        },
        first_comment: NewComment {
            author: "U".into(),
            color: "#000".into(),
            body: "body".into(),
        },
    });

    assert_eq!(store.list_threads().len(), 1);
    store.delete_thread(&created.id).expect("delete known id");
    assert!(store.list_threads().is_empty());

    // Re-deleting the same id surfaces the not-found error so the IPC
    // layer can return it to the frontend (e.g. for a stale-id race).
    let err = store
        .delete_thread(&created.id)
        .expect_err("re-delete should fail");
    assert_eq!(err, "thread not found");
}

fn make_anchor(label: &str) -> Anchor {
    Anchor {
        start: 0,
        end: 1,
        exact: label.into(),
        prefix: "".into(),
        suffix: "".into(),
    }
}

fn make_comment(body: &str) -> NewComment {
    NewComment {
        author: "U".into(),
        color: "#000".into(),
        body: body.into(),
    }
}

#[test]
fn merge_stores_bytes_unions_distinct_threads_from_both_sides() {
    // local has one thread, remote has a different thread (distinct ids by
    // construction in `new_id`). After merge, both threads exist.
    let mut local = CommentsStore::new();
    let _ = local.create_thread(NewThread {
        anchor: make_anchor("local-anchor"),
        first_comment: make_comment("local body"),
    });

    let mut remote = CommentsStore::new();
    let _ = remote.create_thread(NewThread {
        anchor: make_anchor("remote-anchor"),
        first_comment: make_comment("remote body"),
    });

    let local_bytes = store_to_automerge(&local).expect("encode local");
    let remote_bytes = store_to_automerge(&remote).expect("encode remote");

    let merged_bytes =
        merge_stores_bytes(&local_bytes, &remote_bytes).expect("merge_stores_bytes ok");
    let merged = store_from_automerge(&merged_bytes).expect("decode merged");

    assert_eq!(merged.list_threads().len(), 2);
}

#[test]
fn merge_stores_bytes_returns_error_on_garbage_input() {
    let valid = store_to_automerge(&CommentsStore::new()).expect("encode");
    // Garbage bytes are not a valid Automerge document; the function
    // surfaces the error via `?` rather than swallowing it.
    let err = merge_stores_bytes(b"not-automerge", &valid).expect_err("garbage local errors");
    let msg = err.to_string();
    assert!(
        !msg.is_empty(),
        "expected an anyhow error message for garbage input"
    );
}
