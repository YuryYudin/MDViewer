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
use mdviewer_lib::drive::cache::load_cache_meta;
use mdviewer_lib::workspace::Workspace;
use serial_test::serial;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
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

/// D2 review fix: after a successful list_comments fetch, drive_poll_one
/// MUST persist a fresh `CacheMeta` capturing the response ETag and a
/// fresh `last_fetched` timestamp. Without that persistence the next poll
/// would always fall back to an unconditional GET (the saved etag never
/// advances), defeating the 304 short-circuit in production.
///
/// This test also asserts the second poll sends the saved etag back as
/// `If-None-Match`, proving the round-trip survives the cache_meta load.
#[test]
#[serial]
fn drive_poll_one_persists_cache_meta_and_sends_if_none_match() {
    let dir = TempDir::new().unwrap();
    let file_id = "FID-CACHE-1";

    // Capture every inbound `If-None-Match` header so we can assert the
    // second poll sees the etag the first poll persisted. The stub also
    // returns a fixed `ETag` response header on the first call so the
    // workspace has a value to write into cache_meta.
    let captured_inm: Arc<Mutex<Vec<Option<String>>>> = Arc::new(Mutex::new(Vec::new()));
    let inm_writer = captured_inm.clone();
    let server_etag = "\"etag-from-server-v1\"";
    let (base, _h) = stub_server(move |req| {
        let inm = req
            .headers()
            .iter()
            .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case("If-None-Match"))
            .map(|h| h.value.as_str().to_string());
        inm_writer.lock().unwrap().push(inm);
        let body = r#"{
            "comments": [{
                "id": "drive-comment-cache-1",
                "content": "etag please",
                "modifiedTime": "2026-04-30T12:00:00Z",
                "quotedFileContent": {"value": "hello drive"},
                "author": {"displayName": "Bob", "emailAddress": "bob@example.com"},
                "replies": [],
                "resolved": false
            }]
        }"#;
        tiny_http::Response::from_string(body)
            .with_header(
                tiny_http::Header::from_bytes(
                    &b"Content-Type"[..],
                    &b"application/json"[..],
                )
                .unwrap(),
            )
            .with_header(
                tiny_http::Header::from_bytes(&b"ETag"[..], server_etag.as_bytes())
                    .unwrap(),
            )
    });
    std::env::set_var("MDVIEWER_DRIVE_API_BASE", &base);

    let mut ws = Workspace::new_for_test(dir.path());
    let api = Arc::new(DriveApi::with_token("fake".into()));
    ws.set_drive_api_for_test(api);
    let _tab_id = ws.test_open_drive_api_tab(file_id, "# hello drive\n");

    // Pre-condition: no cache_meta on disk.
    assert!(
        load_cache_meta(ws.config_dir(), file_id).is_none(),
        "cache_meta must be absent before the first poll"
    );

    // First poll: fetches with no If-None-Match, persists cache_meta with
    // the server-supplied ETag and a fresh last_fetched timestamp.
    ws.drive_poll_one(file_id).expect("first poll succeeds");

    let meta = load_cache_meta(ws.config_dir(), file_id)
        .expect("first poll must write cache_meta to disk");
    assert_eq!(
        meta.etag, server_etag,
        "cache_meta.etag must equal the server's ETag header from the response"
    );
    assert!(
        !meta.last_fetched.is_empty(),
        "cache_meta.last_fetched must be a non-empty RFC3339 timestamp"
    );
    assert!(
        meta.last_fetched.contains('T') && meta.last_fetched.ends_with('Z'),
        "cache_meta.last_fetched must look like an RFC3339 'Z' timestamp, got {:?}",
        meta.last_fetched
    );

    // Second poll: workspace must read cache_meta back and send its etag
    // as If-None-Match on the next request — proving the round-trip works.
    ws.drive_poll_one(file_id).expect("second poll succeeds");

    let captured = captured_inm.lock().unwrap().clone();
    assert_eq!(
        captured.len(),
        2,
        "stub must have observed exactly two requests, got {captured:?}"
    );
    assert_eq!(
        captured[0], None,
        "first poll must NOT send If-None-Match (no prior etag)"
    );
    assert_eq!(
        captured[1].as_deref(),
        Some(server_etag),
        "second poll must replay the persisted etag as If-None-Match"
    );

    std::env::remove_var("MDVIEWER_DRIVE_API_BASE");
}
