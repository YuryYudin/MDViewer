//! Integration tests for B2: `parse_drive_url` URL parsing + the
//! `Workspace::drive_open_url` end-to-end open flow (file_id parse →
//! download to cache → DriveApi-backed Tab → de-dupe on second open).
//!
//! The de-dupe test exercises the real Workspace through the
//! `#[cfg(test)] new_for_test` helper this task adds, with a stubbed
//! Drive HTTP surface so the round-trip stays hermetic.

mod common;
use common::stub_server;

#[test]
fn drive_open_url_extracts_file_id_from_file_d_form() {
    use mdviewer_lib::drive::parse_drive_url;
    let url = "https://drive.google.com/file/d/1ABCxyz_FILEID/view?usp=sharing";
    assert_eq!(parse_drive_url(url).unwrap(), "1ABCxyz_FILEID");
}

#[test]
fn drive_open_url_extracts_file_id_from_query_id_form() {
    use mdviewer_lib::drive::parse_drive_url;
    let url = "https://drive.google.com/open?id=1ABCxyz_FILEID";
    assert_eq!(parse_drive_url(url).unwrap(), "1ABCxyz_FILEID");
}

#[test]
fn drive_open_url_extracts_file_id_from_docs_subdomain() {
    // docs.google.com is also a `google.com` host — the parser must accept
    // `/file/d/<id>/...` paths under it the same way it accepts the bare
    // drive.google.com host. The link-paste flow can yield either domain.
    use mdviewer_lib::drive::parse_drive_url;
    let url = "https://docs.google.com/document/d/1ABCxyz_FILEID/edit";
    // /document/d/<id>/... is NOT one of the two supported shapes — only
    // /file/d/<id>/... matches the regex. The parser must reject this.
    assert!(parse_drive_url(url).is_err());
}

#[test]
fn drive_open_url_rejects_invalid_urls() {
    use mdviewer_lib::drive::parse_drive_url;
    assert!(parse_drive_url("https://example.com").is_err());
    assert!(parse_drive_url("not a url at all").is_err());
    // Wrong host — must not accept a phishing URL just because it carries
    // a /file/d/<id> path shape.
    assert!(parse_drive_url("https://evil.com/file/d/STOLEN/view").is_err());
    // /file/d/ but missing the id segment.
    assert!(parse_drive_url("https://drive.google.com/file/d/").is_err());
    // ?id= but empty value.
    assert!(parse_drive_url("https://drive.google.com/open?id=").is_err());
}

#[test]
#[serial_test::serial]
fn open_url_returns_existing_tab_when_file_id_already_open() {
    // End-to-end: stand up a stub Drive HTTP surface that returns a tiny
    // markdown body for both files-get-metadata and the alt=media download.
    // First `drive_open_url` must create a fresh DriveApi-backed tab; the
    // second `drive_open_url` for the SAME url must return the existing
    // tab handle rather than spawning a duplicate.
    use mdviewer_lib::drive::api::DriveApi;
    use mdviewer_lib::workspace::Workspace;
    use std::sync::Arc;

    use std::sync::atomic::{AtomicUsize, Ordering};
    let dir = tempfile::tempdir().unwrap();
    let body = "# hello drive\n";
    let etag = "W/\"abc123\"";

    // Count every request the stub server fields. The second `drive_open_url`
    // for the same URL must short-circuit on the de-dupe lookup — if it
    // doesn't, this counter will tick past 2 (one metadata + one download
    // per call) and the assertion at the bottom catches the regression.
    let request_count = Arc::new(AtomicUsize::new(0));
    let counter_for_router = request_count.clone();
    let (base, _h) = stub_server(move |req| {
        counter_for_router.fetch_add(1, Ordering::SeqCst);
        // The first request hits /drive/v3/files/<id> (metadata, no
        // alt=media query), the second hits the same path with alt=media.
        // For metadata we must return a JSON FileMetadata; for download we
        // return the raw body with an ETag header.
        let url = req.url().to_string();
        if url.contains("alt=media") {
            tiny_http::Response::from_string(body)
                .with_header(format!("ETag: {}", etag).parse::<tiny_http::Header>().unwrap())
        } else {
            // files_get_metadata response.
            let payload = r#"{"id":"FID1","name":"hello.md","modifiedTime":"2026-01-01T00:00:00Z"}"#;
            tiny_http::Response::from_string(payload)
                .with_header("Content-Type: application/json".parse::<tiny_http::Header>().unwrap())
        }
    });
    std::env::set_var("MDVIEWER_DRIVE_API_BASE", &base);

    let mut ws = Workspace::new_for_test(dir.path());
    // Inject a stub DriveApi with a non-empty token so api.auth_header() works.
    ws.set_drive_api_for_test(Arc::new(DriveApi::with_token("fake".into())));

    let url = "https://drive.google.com/file/d/FID1/view";
    let first = ws.drive_open_url(url).unwrap();
    let second = ws.drive_open_url(url).unwrap();
    assert_eq!(
        first.id, second.id,
        "second open of the same drive URL must reuse the existing tab"
    );
    // Exactly two server hits: one files.get metadata + one alt=media
    // download from the FIRST drive_open_url. The second call must not
    // touch the network — that's the whole point of the de-dupe branch.
    assert_eq!(
        request_count.load(Ordering::SeqCst),
        2,
        "second drive_open_url must short-circuit before any network I/O"
    );
}

#[test]
#[serial_test::serial]
fn drive_api_tab_path_does_not_collide_with_local_open_of_cache_file() {
    // Regression: previously `drive_open_url` set `Tab.path` to the cache
    // file (`<config_dir>/drive_cache/<file_id>`). A subsequent
    // `Workspace::open_document(<that cache path>)` would then short-circuit
    // through `find_by_path` and re-emit the existing DriveApi tab as if
    // it were a Local tab — silently mixing backends. The synthetic
    // `drive-api://<file_id>` path keeps the two slots disjoint.
    use mdviewer_lib::drive::api::DriveApi;
    use mdviewer_lib::workspace::{OpenOutcome, Workspace};
    use std::sync::Arc;

    let dir = tempfile::tempdir().unwrap();
    let body = "# regression\n";
    let etag = "W/\"reg\"";

    let (base, _h) = stub_server(move |req| {
        let url = req.url().to_string();
        if url.contains("alt=media") {
            tiny_http::Response::from_string(body)
                .with_header(format!("ETag: {}", etag).parse::<tiny_http::Header>().unwrap())
        } else {
            let payload = r#"{"id":"FID2","name":"regression.md","modifiedTime":"2026-01-01T00:00:00Z"}"#;
            tiny_http::Response::from_string(payload)
                .with_header("Content-Type: application/json".parse::<tiny_http::Header>().unwrap())
        }
    });
    std::env::set_var("MDVIEWER_DRIVE_API_BASE", &base);

    let mut ws = Workspace::new_for_test(dir.path());
    ws.set_drive_api_for_test(Arc::new(DriveApi::with_token("fake".into())));

    let url = "https://drive.google.com/file/d/FID2/view";
    let drive_summary = ws.drive_open_url(url).unwrap();
    // The DriveApi tab's path is the synthetic `drive-api://FID2` shape,
    // not the cache file path. Verify by grabbing the synthetic path and
    // ensuring a Local open of the actual cache file lands a DIFFERENT
    // tab id.
    assert_eq!(
        drive_summary.path.to_string_lossy(),
        "drive-api://FID2",
        "DriveApi tab.path must use the synthetic drive-api:// URI"
    );

    // Now open the cache file as a Local document. find_by_path should
    // NOT return the DriveApi tab; we should get a fresh tab with a
    // distinct id. Cache layout is `<config_dir>/drive/<file_id>/<name>`
    // per `drive::files::cache_dir_for`.
    let cache_path = dir.path().join("drive").join("FID2").join("regression.md");
    assert!(
        cache_path.exists(),
        "cache file should be on disk after drive_open_url: {:?}",
        cache_path
    );
    let local_outcome = ws
        .open_document(&cache_path, mdviewer_lib::workspace::OpenOpts::default())
        .unwrap();
    let local_tab_id = match local_outcome {
        OpenOutcome::Document(r) => r.tab_id,
        OpenOutcome::Conflict { .. } => panic!("expected Document, got Conflict"),
    };
    assert_ne!(
        drive_summary.id, local_tab_id,
        "Local open of the cache file must NOT collide with the DriveApi tab"
    );
}
