//! Smoke test: round-trip a CommentsStore through Automerge in-crate.

use mdviewer_core::anchor::Anchor;
use mdviewer_core::comments::{
    store_from_automerge, store_to_automerge, CommentsStore, NewComment, NewThread,
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
