//! Integration tests for `drive::api` HTTP wrapper.
//!
//! Each test mutates the global `MDVIEWER_DRIVE_API_BASE` env var to point at
//! a stub `tiny_http` server, so every test is tagged
//! `#[serial_test::serial]` to force serial execution regardless of
//! `--test-threads`.

mod common;
use common::stub_server;
use mdviewer_lib::drive::api::{DriveApi, ListCommentsArgs};

#[test]
#[serial_test::serial]
fn api_list_comments_includes_start_modified_time_filter() {
    let captured = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
    let cap = captured.clone();
    let (base, _h) = stub_server(move |req| {
        *cap.lock().unwrap() = Some(req.url().to_string());
        tiny_http::Response::from_string(r#"{"comments":[]}"#)
    });
    std::env::set_var("MDVIEWER_DRIVE_API_BASE", &base);
    let api = DriveApi::with_token("fake".into());
    let _ = api
        .list_comments(&ListCommentsArgs {
            file_id: "FILEID",
            start_modified_time: Some("2026-04-30T12:00:00Z"),
            if_none_match: None,
        })
        .unwrap();
    let url = captured.lock().unwrap().clone().unwrap();
    assert!(url.contains("/files/FILEID/comments"));
    assert!(
        url.contains("startModifiedTime=2026-04-30T12%3A00%3A00Z"),
        "delta-only filter must be sent, got {}",
        url
    );
}

#[test]
#[serial_test::serial]
fn api_retries_on_5xx_then_succeeds() {
    let counter = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let c = counter.clone();
    let (base, _h) = stub_server(move |_req| {
        let n = c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if n < 2 {
            tiny_http::Response::from_string("server error").with_status_code(503)
        } else {
            tiny_http::Response::from_string(r#"{"comments":[]}"#)
        }
    });
    std::env::set_var("MDVIEWER_DRIVE_API_BASE", &base);
    let api = DriveApi::with_token("fake".into());
    api.list_comments(&ListCommentsArgs {
        file_id: "FID",
        start_modified_time: None,
        if_none_match: None,
    })
    .unwrap();
    assert_eq!(counter.load(std::sync::atomic::Ordering::SeqCst), 3);
}

#[test]
#[serial_test::serial]
fn api_does_not_retry_on_4xx() {
    let counter = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let c = counter.clone();
    let (base, _h) = stub_server(move |_req| {
        c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        tiny_http::Response::from_string(r#"{"error":{"code":403,"message":"forbidden"}}"#)
            .with_status_code(403)
    });
    std::env::set_var("MDVIEWER_DRIVE_API_BASE", &base);
    let api = DriveApi::with_token("fake".into());
    let res = api.list_comments(&ListCommentsArgs {
        file_id: "FID",
        start_modified_time: None,
        if_none_match: None,
    });
    assert!(matches!(res, Err(_)));
    assert_eq!(counter.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[test]
#[serial_test::serial]
fn api_handles_304_not_modified_without_retry() {
    let counter = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let c = counter.clone();
    let (base, _h) = stub_server(move |req| {
        c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        // Verify the If-None-Match header was sent.
        let has_inm = req
            .headers()
            .iter()
            .any(|h| h.field.equiv("If-None-Match"));
        assert!(has_inm, "expected If-None-Match header on conditional GET");
        tiny_http::Response::from_string("").with_status_code(304)
    });
    std::env::set_var("MDVIEWER_DRIVE_API_BASE", &base);
    let api = DriveApi::with_token("fake".into());
    let res = api
        .list_comments(&ListCommentsArgs {
            file_id: "FID",
            start_modified_time: None,
            if_none_match: Some("\"etag-abc\""),
        })
        .expect("304 should be treated as successful no-change response");
    assert!(res.comments.is_empty(), "304 returns empty comment list");
    assert_eq!(
        counter.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "304 must not trigger retry storm"
    );
}
