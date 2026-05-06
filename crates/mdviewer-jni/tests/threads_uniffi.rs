//! D1 smoke tests for the UniFFI-exposed thread mutation API.
//!
//! These exercise the wrappers in `mdviewer_core::uniffi_bindings`:
//! `create_thread`, `post_reply`, `resolve_thread`, `unresolve_thread`,
//! `merge_stores`. They run as part of `cargo test -p mdviewer-jni`
//! because that crate enables the `uniffi` cargo feature; desktop's
//! `cargo test -p mdviewer` deliberately does not.
//!
//! The Kotlin smoke (D5/D6) covers the full UDL -> generated bindings ->
//! Kotlin call path; the tests here pin the Rust-side wrapper bodies the
//! UniFFI scaffolding dispatches to.

use mdviewer_core::uniffi_bindings::{
    create_thread, load_sidecar_bytes, merge_stores, post_reply, resolve_thread,
    save_sidecar_bytes, unresolve_thread, Anchor, CoreError, NewComment, NewThread,
};

fn anchor(text: &str) -> Anchor {
    Anchor {
        selector_text: text.into(),
        context_before: String::new(),
        context_after: String::new(),
        char_start: 0,
        char_end: text.len() as u32,
    }
}

fn new_thread(text: &str, body: &str) -> NewThread {
    NewThread {
        anchor: anchor(text),
        body: body.into(),
        author_id: "u1".into(),
        author_name: "U1".into(),
        author_color: "#000".into(),
    }
}

fn new_comment(body: &str) -> NewComment {
    NewComment {
        body: body.into(),
        author_id: "u2".into(),
        author_name: "U2".into(),
        author_color: "#fff".into(),
    }
}

#[test]
fn create_post_resolve_round_trip() {
    let store = load_sidecar_bytes(Vec::new()).expect("load empty");

    let thread =
        create_thread(store.clone(), new_thread("hi", "first")).expect("create thread");
    assert_eq!(
        thread.comments.len(),
        1,
        "newly created thread carries its first comment"
    );

    let reply =
        post_reply(store.clone(), thread.id.clone(), new_comment("reply")).expect("post reply");
    assert_eq!(reply.body, "reply");

    resolve_thread(store.clone(), thread.id.clone()).expect("resolve thread");

    let threads = store.threads();
    assert_eq!(threads.len(), 1, "store still has exactly one thread");
    let updated = &threads[0];
    assert_eq!(updated.id, thread.id);
    assert!(updated.resolved, "thread should now be marked resolved");
    assert_eq!(
        updated.comments.len(),
        2,
        "first comment + reply should both survive the resolve"
    );
}

#[test]
fn unresolve_thread_clears_resolved_flag() {
    let store = load_sidecar_bytes(Vec::new()).expect("load empty");
    let thread = create_thread(store.clone(), new_thread("hi", "x")).expect("create");
    resolve_thread(store.clone(), thread.id.clone()).expect("resolve");
    assert!(store.threads()[0].resolved);
    unresolve_thread(store.clone(), thread.id.clone()).expect("unresolve");
    assert!(!store.threads()[0].resolved, "unresolve must flip the flag");
}

#[test]
fn post_reply_unknown_thread_yields_not_found() {
    let store = load_sidecar_bytes(Vec::new()).expect("load empty");
    let err = post_reply(store, "no-such-thread".into(), new_comment("x"))
        .expect_err("missing thread must return Err");
    assert!(
        matches!(err, CoreError::NotFound(_)),
        "expected NotFound, got {err:?}"
    );
}

#[test]
fn resolve_unknown_thread_yields_not_found() {
    let store = load_sidecar_bytes(Vec::new()).expect("load empty");
    let err = resolve_thread(store, "no-such-thread".into())
        .expect_err("missing thread must return Err");
    assert!(
        matches!(err, CoreError::NotFound(_)),
        "expected NotFound, got {err:?}"
    );
}

#[test]
fn unresolve_unknown_thread_yields_not_found() {
    let store = load_sidecar_bytes(Vec::new()).expect("load empty");
    let err = unresolve_thread(store, "no-such-thread".into())
        .expect_err("missing thread must return Err");
    assert!(
        matches!(err, CoreError::NotFound(_)),
        "expected NotFound, got {err:?}"
    );
}

#[test]
fn merge_unions_local_and_incoming_threads() {
    // Two stores created independently, each with one thread. After
    // merge_stores the union has both threads.
    let local = load_sidecar_bytes(Vec::new()).expect("load empty local");
    let incoming = load_sidecar_bytes(Vec::new()).expect("load empty incoming");
    let _ta = create_thread(local.clone(), new_thread("local", "local"))
        .expect("create local thread");
    let _tb = create_thread(incoming.clone(), new_thread("incoming", "incoming"))
        .expect("create incoming thread");

    let merged = merge_stores(local, incoming);
    assert_eq!(
        merged.threads().len(),
        2,
        "merge must preserve threads from both sides"
    );
}

#[test]
fn locally_posted_thread_survives_merge_with_empty_incoming() {
    // Captures the spec's "locally-posted-not-yet-flushed threads survive
    // an incoming sidecar that lacks them" requirement: simulate an
    // incoming sidecar fetched fresh (no local thread) and confirm the
    // local thread is not lost when we merge against it.
    let local = load_sidecar_bytes(Vec::new()).expect("load empty local");
    let local_thread = create_thread(local.clone(), new_thread("local", "local"))
        .expect("create local thread");

    // Round-trip the empty incoming through save/load to mimic a fetch.
    let empty_bytes = save_sidecar_bytes(
        load_sidecar_bytes(Vec::new()).expect("load empty"),
    )
    .expect("save empty");
    let incoming = load_sidecar_bytes(empty_bytes).expect("reload empty incoming");

    let merged = merge_stores(local, incoming);
    let merged_threads = merged.threads();
    assert_eq!(merged_threads.len(), 1, "local thread must survive merge");
    assert_eq!(merged_threads[0].id, local_thread.id);
}
