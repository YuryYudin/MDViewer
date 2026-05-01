//! D2 integration tests for `Workspace::drive_get_collaborators` and
//! `Workspace::drive_resolve_path`.
//!
//! Both methods route through the authenticated `DriveApi` once it's
//! populated by `drive_connect`; the disconnected state must surface
//! `DriveError::NotConnected` rather than panicking or silently returning
//! an empty result.

mod common;
use common::stub_server;
use mdviewer_lib::drive::api::DriveApi;
use mdviewer_lib::workspace::Workspace;
use serial_test::serial;
use std::sync::Arc;
use tempfile::TempDir;

#[test]
#[serial]
fn drive_get_collaborators_returns_permissions_list() {
    let dir = TempDir::new().unwrap();
    let file_id = "FID-COLLAB";

    let (base, _h) = stub_server(move |req| {
        let url = req.url().to_string();
        assert!(
            url.contains(&format!("/files/{}/permissions", file_id)),
            "expected list_permissions path, got {}",
            url
        );
        let body = r#"{
            "permissions": [
                {"displayName": "Alice", "emailAddress": "alice@example.com"},
                {"displayName": "Bob",   "emailAddress": "bob@example.com"}
            ]
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

    let collabs = ws
        .drive_get_collaborators(file_id)
        .expect("get_collaborators should succeed");
    assert_eq!(collabs.len(), 2, "expected two collaborators");
    assert_eq!(collabs[0].display_name, "Alice");
    assert_eq!(collabs[0].email_address, "alice@example.com");
    assert_eq!(collabs[1].display_name, "Bob");
    assert_eq!(collabs[1].email_address, "bob@example.com");

    std::env::remove_var("MDVIEWER_DRIVE_API_BASE");
}

#[test]
#[serial]
fn drive_get_collaborators_errors_when_not_connected() {
    let dir = TempDir::new().unwrap();
    let ws = Workspace::new_for_test(dir.path());
    let res = ws.drive_get_collaborators("any-file-id");
    assert!(
        matches!(res, Err(mdviewer_lib::drive::DriveError::NotConnected)),
        "drive_get_collaborators without an API must surface NotConnected, got {:?}",
        res
    );
}

#[test]
#[serial]
fn drive_resolve_path_errors_when_not_connected() {
    let dir = TempDir::new().unwrap();
    let ws = Workspace::new_for_test(dir.path());
    let res = ws.drive_resolve_path("/some/path/notes.md");
    assert!(
        matches!(res, Err(mdviewer_lib::drive::DriveError::NotConnected)),
        "drive_resolve_path without an API must surface NotConnected, got {:?}",
        res
    );
}

/// drive_resolve_path delegates to the file_id resolver. We don't drive a
/// full Drive Desktop path-detection round-trip here — the resolver itself
/// is unit-tested in `drive_files.rs` / `drive_detect.rs`. This test pins
/// the wiring contract: a path that DOES live under a Drive Desktop mount
/// (per the `is_drive_desktop_path` heuristic) and matches a single file
/// in `files.list` returns the file_id.
#[cfg(target_os = "macos")]
#[test]
#[serial]
fn drive_resolve_path_returns_file_id_for_single_match() {
    let tmp = TempDir::new().unwrap();
    let home_raw = tmp.path().join("alice-home");
    std::fs::create_dir_all(&home_raw).unwrap();
    let home = home_raw.canonicalize().unwrap();
    let drive_root = home
        .join("Library")
        .join("CloudStorage")
        .join("GoogleDrive-alice@gmail.com")
        .join("My Drive");
    std::fs::create_dir_all(&drive_root).unwrap();
    let doc_path = drive_root.join("notes.md");
    std::fs::write(&doc_path, "# hello").unwrap();

    std::env::set_var("HOME", &home);

    let (base, _h) = stub_server(|req| {
        let url = req.url().to_string();
        assert!(
            url.contains("/files") && url.contains("name%3D%27notes.md%27"),
            "expected files.list with name='notes.md' query, got {}",
            url
        );
        let body = r#"{"files":[{"id":"FID-RESOLVED","name":"notes.md","parents":["root"]}]}"#;
        tiny_http::Response::from_string(body).with_header(
            tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                .unwrap(),
        )
    });
    std::env::set_var("MDVIEWER_DRIVE_API_BASE", &base);

    std::fs::create_dir_all(tmp.path().join("data")).unwrap();
    let mut ws = Workspace::new_for_test(tmp.path().join("data").as_path());
    let api = Arc::new(DriveApi::with_token("fake".into()));
    ws.set_drive_api_for_test(api);

    let resolved = ws
        .drive_resolve_path(doc_path.to_str().unwrap())
        .expect("resolve must succeed");
    assert_eq!(resolved, "FID-RESOLVED");

    std::env::remove_var("MDVIEWER_DRIVE_API_BASE");
}
