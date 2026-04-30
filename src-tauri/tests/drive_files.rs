//! Integration tests for `drive::files` download/upload helpers.
//!
//! Tests stub Drive's HTTP surface via `tiny_http` and route the production
//! code at the local server with `MDVIEWER_DRIVE_API_BASE`. Because that env
//! var is process-global, every test in this crate is `#[serial_test::serial]`
//! to force serial execution regardless of `--test-threads`.

mod common;
use common::stub_server;
use mdviewer_lib::drive::api::DriveApi;
use mdviewer_lib::drive::files::{download_to_cache, upload_with_etag, UploadOutcome};

#[test]
#[serial_test::serial]
fn files_download_writes_to_cache_and_records_etag() {
    let dir = tempfile::tempdir().unwrap();
    let body = "# hello drive\n";
    let etag = "W/\"abc123\"";
    let (base, _h) = stub_server(move |_req| {
        tiny_http::Response::from_string(body)
            .with_header(format!("ETag: {}", etag).parse::<tiny_http::Header>().unwrap())
    });
    std::env::set_var("MDVIEWER_DRIVE_API_BASE", &base);
    let api = DriveApi::with_token("fake".into());
    let outcome = download_to_cache(&api, dir.path(), "FID", "notes.md").unwrap();
    let written = std::fs::read_to_string(&outcome.cache_path).unwrap();
    assert_eq!(written, body);
    let meta = mdviewer_lib::drive::cache::load_cache_meta(dir.path(), "FID").unwrap();
    assert_eq!(meta.etag, etag);
}

#[test]
#[serial_test::serial]
fn files_upload_412_surfaces_precondition_failed() {
    let (base, _h) = stub_server(|_req| {
        tiny_http::Response::from_string(r#"{"error":{"code":412,"message":"etag mismatch"}}"#)
            .with_status_code(412)
    });
    std::env::set_var("MDVIEWER_DRIVE_API_BASE", &base);
    let api = DriveApi::with_token("fake".into());
    let result = upload_with_etag(&api, "FID", b"# updated\n", "W/\"oldetag\"");
    assert!(matches!(
        result,
        Err(mdviewer_lib::drive::DriveError::PreconditionFailed)
    ));
}

#[test]
#[serial_test::serial]
fn files_upload_success_returns_new_etag() {
    let new_etag = "W/\"newetag456\"";
    let captured_method = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
    let captured_if_match = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
    let m = captured_method.clone();
    let im = captured_if_match.clone();
    let (base, _h) = stub_server(move |req| {
        *m.lock().unwrap() = Some(req.method().to_string());
        *im.lock().unwrap() = req
            .headers()
            .iter()
            .find(|h| h.field.equiv("If-Match"))
            .map(|h| h.value.as_str().to_string());
        tiny_http::Response::from_string(r#"{"id":"FID"}"#)
            .with_header(format!("ETag: {}", new_etag).parse::<tiny_http::Header>().unwrap())
    });
    std::env::set_var("MDVIEWER_DRIVE_API_BASE", &base);
    let api = DriveApi::with_token("fake".into());
    let outcome = upload_with_etag(&api, "FID", b"# updated\n", "W/\"oldetag\"").unwrap();
    let UploadOutcome::Updated { new_etag: returned } = outcome;
    assert_eq!(returned, new_etag);
    assert_eq!(
        captured_method.lock().unwrap().as_deref(),
        Some("PATCH"),
        "upload should use PATCH for content update"
    );
    assert_eq!(
        captured_if_match.lock().unwrap().as_deref(),
        Some("W/\"oldetag\""),
        "If-Match must carry the prior ETag for optimistic concurrency"
    );
}
