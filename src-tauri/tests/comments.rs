use mdviewer_lib::anchor::Anchor;
use mdviewer_lib::comments::{
    merge_stores, ChangeEvent, CommentsStore, NewComment, NewThread, Thread,
};

fn anchor() -> Anchor {
    Anchor {
        start: 0,
        end: 5,
        exact: "Hello".into(),
        prefix: "".into(),
        suffix: " world".into(),
    }
}

#[test]
fn create_thread_returns_full_thread_and_lists_it() {
    let mut store = CommentsStore::new();
    let t = store.create_thread(NewThread {
        anchor: anchor(),
        first_comment: NewComment {
            author: "Alice".into(),
            color: "#f80".into(),
            body: "looks good".into(),
        },
    });
    let threads = store.list_threads();
    assert_eq!(threads.len(), 1);
    assert_eq!(threads[0].id, t.id);
    assert_eq!(t.comments.len(), 1);
    assert_eq!(t.comments[0].body, "looks good");
    assert!(!t.resolved);
}

#[test]
fn post_reply_appends_to_thread() {
    let mut store = CommentsStore::new();
    let t = store.create_thread(NewThread {
        anchor: anchor(),
        first_comment: NewComment {
            author: "Alice".into(),
            color: "#f80".into(),
            body: "first".into(),
        },
    });
    store
        .post_reply(
            &t.id,
            NewComment {
                author: "Bob".into(),
                color: "#08f".into(),
                body: "second".into(),
            },
        )
        .unwrap();
    let reloaded = store.get_thread(&t.id).unwrap();
    assert_eq!(reloaded.comments.len(), 2);
    assert_eq!(reloaded.comments[1].body, "second");
}

#[test]
fn resolve_sets_resolved_at_and_resolved_by() {
    let mut store = CommentsStore::new();
    let t = store.create_thread(NewThread {
        anchor: anchor(),
        first_comment: NewComment {
            author: "Alice".into(),
            color: "#f80".into(),
            body: "x".into(),
        },
    });
    store.resolve_thread(&t.id, "Alice").unwrap();
    let reloaded = store.get_thread(&t.id).unwrap();
    assert!(reloaded.resolved);
    assert_eq!(reloaded.resolved_by.as_deref(), Some("Alice"));
    assert!(reloaded.resolved_at.is_some());
}

#[test]
fn change_events_fire_on_mutations() {
    let mut store = CommentsStore::new();
    let rx = store.subscribe();
    let _ = store.create_thread(NewThread {
        anchor: anchor(),
        first_comment: NewComment {
            author: "Alice".into(),
            color: "#f80".into(),
            body: "x".into(),
        },
    });
    assert!(rx.try_recv().is_ok());
}

#[test]
fn default_constructor_yields_empty_store() {
    // Exercises the `Default` impl so consumers that hold a `CommentsStore`
    // inside a struct can `#[derive(Default)]` it without writing custom code.
    let store: CommentsStore = Default::default();
    assert!(store.list_threads().is_empty());
}

#[test]
fn post_reply_unknown_thread_returns_error() {
    let mut store = CommentsStore::new();
    let err = store
        .post_reply(
            "nonexistent",
            NewComment {
                author: "Alice".into(),
                color: "#f80".into(),
                body: "x".into(),
            },
        )
        .unwrap_err();
    assert!(err.contains("thread not found"));
}

#[test]
fn resolve_thread_unknown_id_returns_error() {
    let mut store = CommentsStore::new();
    let err = store.resolve_thread("nonexistent", "Alice").unwrap_err();
    assert!(err.contains("thread not found"));
}

#[test]
fn delete_thread_removes_id_and_emits_change_event() {
    // Verifies the mdviewer_lib re-export of CommentsStore::delete_thread —
    // a regression where `pub use crate::comments::*` drops the new method
    // would surface here (the crate-internal test in
    // crates/mdviewer-core/tests/comments_smoke.rs wouldn't catch a missing
    // Tauri-side re-export). Also confirms `ChangeEvent::ThreadDeleted`
    // fires so subscribers can react.
    let mut store = CommentsStore::new();
    let rx = store.subscribe();
    let t = store.create_thread(NewThread {
        anchor: anchor(),
        first_comment: NewComment {
            author: "Alice".into(),
            color: "#f80".into(),
            body: "to be deleted".into(),
        },
    });
    // Drain the ThreadCreated event before we look for ThreadDeleted.
    let _ = rx.recv();

    store.delete_thread(&t.id).expect("delete known id");
    assert!(store.list_threads().is_empty());
    let ev = rx.recv().expect("delete should emit");
    assert!(matches!(ev, ChangeEvent::ThreadDeleted));
}

#[test]
fn delete_thread_unknown_id_returns_error() {
    let mut store = CommentsStore::new();
    let err = store.delete_thread("nonexistent").unwrap_err();
    assert!(err.contains("thread not found"));
}

#[test]
fn get_thread_returns_none_for_unknown_id() {
    let store = CommentsStore::new();
    assert!(store.get_thread("missing").is_none());
}

#[test]
fn replace_all_swaps_threads_and_emits_bulk() {
    let mut store = CommentsStore::new();
    let _ = store.create_thread(NewThread {
        anchor: anchor(),
        first_comment: NewComment {
            author: "Alice".into(),
            color: "#f80".into(),
            body: "first".into(),
        },
    });
    let rx = store.subscribe();
    let replacement: Vec<Thread> = Vec::new();
    store.replace_all(replacement);
    assert!(store.list_threads().is_empty());
    assert_eq!(rx.try_recv().ok(), Some(ChangeEvent::Bulk));
}

#[test]
fn dropped_subscriber_is_pruned_silently() {
    // Cover the `subs.retain(...)` branch that drops senders whose receiver
    // has been dropped: the next emit should not panic and surviving
    // subscribers must still get the event.
    let mut store = CommentsStore::new();
    let dead_rx = store.subscribe();
    drop(dead_rx);
    let live_rx = store.subscribe();
    let _ = store.create_thread(NewThread {
        anchor: anchor(),
        first_comment: NewComment {
            author: "Alice".into(),
            color: "#f80".into(),
            body: "x".into(),
        },
    });
    assert!(live_rx.try_recv().is_ok());
}

#[test]
fn post_reply_emits_reply_event() {
    let mut store = CommentsStore::new();
    let t = store.create_thread(NewThread {
        anchor: anchor(),
        first_comment: NewComment {
            author: "Alice".into(),
            color: "#f80".into(),
            body: "first".into(),
        },
    });
    let rx = store.subscribe();
    store
        .post_reply(
            &t.id,
            NewComment {
                author: "Bob".into(),
                color: "#08f".into(),
                body: "reply".into(),
            },
        )
        .unwrap();
    assert_eq!(rx.try_recv().ok(), Some(ChangeEvent::ReplyPosted));
}

#[test]
fn merge_order_independent() {
    // The CRDT promise: applying ops {A, B} or {B, A} converges to the same
    // end-state. If a regression in Automerge usage (e.g. wrong actor IDs)
    // duplicated or dropped a thread, this test would fail.
    let mut a = CommentsStore::new();
    a.create_thread(NewThread {
        anchor: anchor(),
        first_comment: NewComment {
            author: "A".into(),
            color: "#f80".into(),
            body: "from A".into(),
        },
    });
    let mut b = CommentsStore::new();
    b.create_thread(NewThread {
        anchor: anchor(),
        first_comment: NewComment {
            author: "B".into(),
            color: "#08f".into(),
            body: "from B".into(),
        },
    });

    let ab = merge_stores(&a, &b);
    let ba = merge_stores(&b, &a);
    assert_eq!(ab.list_threads().len(), 2);
    assert_eq!(ba.list_threads().len(), 2);

    // Sort by id so we compare order-independently.
    let mut ab_ids: Vec<_> = ab.list_threads().iter().map(|t| t.id.clone()).collect();
    let mut ba_ids: Vec<_> = ba.list_threads().iter().map(|t| t.id.clone()).collect();
    ab_ids.sort();
    ba_ids.sort();
    assert_eq!(ab_ids, ba_ids);
}

#[test]
fn merge_stores_preserves_both_sides_threads() {
    let mut a = CommentsStore::new();
    let ta = a.create_thread(NewThread {
        anchor: anchor(),
        first_comment: NewComment {
            author: "Alice".into(),
            color: "#f80".into(),
            body: "alice's note".into(),
        },
    });
    let mut b = CommentsStore::new();
    let tb = b.create_thread(NewThread {
        anchor: anchor(),
        first_comment: NewComment {
            author: "Bob".into(),
            color: "#08f".into(),
            body: "bob's note".into(),
        },
    });

    let merged = merge_stores(&a, &b);
    let ids: Vec<&str> = merged.list_threads().iter().map(|t| t.id.as_str()).collect();
    assert!(ids.contains(&ta.id.as_str()));
    assert!(ids.contains(&tb.id.as_str()));
    // Comment bodies must round-trip too.
    let bodies: Vec<&str> = merged
        .list_threads()
        .iter()
        .flat_map(|t| t.comments.iter().map(|c| c.body.as_str()))
        .collect();
    assert!(bodies.contains(&"alice's note"));
    assert!(bodies.contains(&"bob's note"));
}

#[test]
fn resolve_thread_emits_resolved_event() {
    let mut store = CommentsStore::new();
    let t = store.create_thread(NewThread {
        anchor: anchor(),
        first_comment: NewComment {
            author: "Alice".into(),
            color: "#f80".into(),
            body: "x".into(),
        },
    });
    let rx = store.subscribe();
    store.resolve_thread(&t.id, "Alice").unwrap();
    assert_eq!(rx.try_recv().ok(), Some(ChangeEvent::ThreadResolved));
}
