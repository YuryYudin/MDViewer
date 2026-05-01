//! D2 integration tests for `Workspace::drive_poll_one`.
//!
//! The poll method fetches comments for a single file_id via the
//! authenticated `DriveApi`, translates each Drive comment into a local
//! `Thread` (via `drive::comments::from_drive_comment`), and merges the
//! threads into the matching tab's `CommentsStore`. A 304 short-circuits
//! without merging.
//!
//! Tests use the pre-existing `test_open_drive_api_tab` helper to stand up
//! a DriveApi-backed tab with a known `file_id`, then inject a stub
//! `DriveApi` whose `MDVIEWER_DRIVE_API_BASE` redirects to a `tiny_http`
//! stub server that controls the response shape.

mod common;
use common::stub_server;
use mdviewer_lib::drive::api::DriveApi;
use mdviewer_lib::workspace::Workspace;
use serial_test::serial;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tempfile::TempDir;

#[test]
#[serial]
fn drive_poll_one_fetches_and_merges_comments() {
    let dir = TempDir::new().unwrap();
    let file_id = "FID-1";

    // Stub Drive API: GET /drive/v3/files/<file_id>/comments returns one
    // comment payload. The shape mirrors the Drive REST API: a top-level
    // `comments` array containing objects with id, content,
    // quotedFileContent, modifiedTime, author, etc.
    let (base, _h) = stub_server(move |req| {
        let url = req.url().to_string();
        assert!(
            url.contains(&format!("/files/{}/comments", file_id)),
            "expected list_comments path, got {}",
            url
        );
        let body = r#"{
            "comments": [{
                "id": "drive-comment-1",
                "content": "Looks good!",
                "modifiedTime": "2026-04-30T12:00:00Z",
                "quotedFileContent": {"value": "hello drive"},
                "author": {"displayName": "Bob", "emailAddress": "bob@example.com"},
                "replies": [],
                "resolved": false
            }]
        }"#;
        tiny_http::Response::from_string(body).with_header(
            tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                .unwrap(),
        )
    });
    std::env::set_var("MDVIEWER_DRIVE_API_BASE", &base);

    let mut ws = Workspace::new_for_test(dir.path());
    let api = Arc::new(DriveApi::with_token("fake".into()));
    ws.set_drive_api_for_test(api);
    let tab_id = ws.test_open_drive_api_tab(file_id, "# hello drive\n");

    // Pre-condition: tab has zero threads.
    assert_eq!(
        ws.comments_for(&tab_id).unwrap().list_threads().len(),
        0,
        "tab starts with no comments before the first poll"
    );

    ws.drive_poll_one(file_id).expect("poll should succeed");

    let threads = ws.comments_for(&tab_id).unwrap().list_threads();
    assert_eq!(
        threads.len(),
        1,
        "poll must merge the single returned comment as a thread"
    );
    assert_eq!(
        threads[0].comments[0].body, "Looks good!",
        "thread body must match the Drive comment content"
    );
    assert_eq!(
        threads[0].anchor.exact, "hello drive",
        "thread anchor must come from quotedFileContent.value"
    );

    std::env::remove_var("MDVIEWER_DRIVE_API_BASE");
}

#[test]
#[serial]
fn drive_poll_one_short_circuits_on_304() {
    let dir = TempDir::new().unwrap();
    let file_id = "FID-2";

    // Stub returns 304 Not Modified for every call.
    let call_count = Arc::new(AtomicUsize::new(0));
    let counter = call_count.clone();
    let (base, _h) = stub_server(move |_req| {
        counter.fetch_add(1, Ordering::SeqCst);
        tiny_http::Response::from_string("").with_status_code(304)
    });
    std::env::set_var("MDVIEWER_DRIVE_API_BASE", &base);

    let mut ws = Workspace::new_for_test(dir.path());
    let api = Arc::new(DriveApi::with_token("fake".into()));
    ws.set_drive_api_for_test(api);
    let tab_id = ws.test_open_drive_api_tab(file_id, "# hello\n");

    // The poll should succeed without merging anything (CommentList for
    // 304 is mapped to an empty Vec by drive::api::list_comments).
    ws.drive_poll_one(file_id)
        .expect("304 response must not surface as an error");

    let threads = ws.comments_for(&tab_id).unwrap().list_threads();
    assert!(
        threads.is_empty(),
        "304 response must not produce any merged threads"
    );
    assert_eq!(
        call_count.load(Ordering::SeqCst),
        1,
        "304 must not trigger retry storm"
    );

    std::env::remove_var("MDVIEWER_DRIVE_API_BASE");
}

#[test]
#[serial]
fn drive_poll_one_errors_when_not_connected() {
    let dir = TempDir::new().unwrap();
    let mut ws = Workspace::new_for_test(dir.path());
    // No drive_api set — poll should error with NotConnected.
    let res = ws.drive_poll_one("any-file-id");
    assert!(
        matches!(res, Err(mdviewer_lib::drive::DriveError::NotConnected)),
        "drive_poll_one without an API must surface NotConnected, got {:?}",
        res
    );
}
