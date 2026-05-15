//! B5: Save-conflict integration tests.
//!
//! Exercises both Drive save-conflict paths end-to-end through the public
//! `Workspace::save_drive_*_tab` surface (B2) so the wireframe-07 banner
//! routing has a guaranteed contract:
//!
//! 1. `DriveApi` 412 from `upload_with_etag` → `SaveError::Conflict`
//!    carrying the user's local bytes alongside the freshly-fetched remote
//!    bytes (via `raw_get_media`, NOT `download_to_cache` — the cache file
//!    must not be mutated while the tab buffer is live).
//! 2. `DriveDesktop` watcher mismatch from `compare_for_save` → the same
//!    `DriveConflict` shape with the on-disk bytes as the remote half.
//!
//! The two share a return type so `src/views/Conflict.ts` can route both
//! through the existing diff-merge view; the `source` discriminant is what
//! lets the view pick the right banner copy.

mod common;
use common::stub_server;

use mdviewer_lib::drive::api::DriveApi;
use mdviewer_lib::workspace::{ConflictSource, SaveError, Workspace};
use std::sync::Arc;

#[test]
#[serial_test::serial]
fn save_conflict_412_returns_local_and_remote_bytes() {
    // Stub server: PATCH (uploadType=media) → 412; subsequent GET
    // (alt=media) → fresh remote bytes the conflict view will diff against
    // the user's still-in-memory local edits.
    let (base, _h) = stub_server(|req| {
        let url = req.url().to_string();
        if url.contains("uploadType=media") {
            tiny_http::Response::from_string(r#"{"error":{"code":412,"message":"etag"}}"#)
                .with_status_code(412)
        } else if url.contains("alt=media") {
            tiny_http::Response::from_string("# remote version\n")
        } else {
            tiny_http::Response::from_string(r#"{"id":"FID","name":"notes.md"}"#)
        }
    });
    std::env::set_var("MDVIEWER_DRIVE_API_BASE", &base);

    let dir = tempfile::tempdir().unwrap();
    let mut ws = Workspace::new_for_test(dir.path());
    ws.set_drive_api_for_test(Arc::new(DriveApi::with_token("fake".into())));

    let tab_id = ws.test_open_drive_api_tab("FID", "# local\n");
    let result = ws.save_drive_api_tab(&tab_id, b"# local edits\n", "W/\"stale\"");

    let outcome = result.expect_err("412 must surface SaveError::Conflict");
    let (local, remote, source) = match outcome {
        SaveError::Conflict {
            local,
            remote,
            source,
        } => (local, remote, source),
        other => panic!("expected SaveError::Conflict, got {:?}", other),
    };
    assert_eq!(
        std::str::from_utf8(&local).unwrap(),
        "# local edits\n",
        "the user's just-typed bytes must round-trip — losing them defeats the conflict UI"
    );
    assert_eq!(
        std::str::from_utf8(&remote).unwrap(),
        "# remote version\n",
        "the conflict view needs the freshly-fetched server bytes, not the cached pre-edit copy"
    );
    assert!(
        matches!(source, ConflictSource::DriveApiEtag),
        "412 path must be tagged DriveApiEtag so the banner picks the API copy"
    );
}

#[test]
#[serial_test::serial]
fn save_conflict_drive_desktop_path_uses_watcher_compare() {
    // Open a real on-disk file as a DriveDesktop tab so the workspace's
    // internal watcher captures the (mtime, sha256) baseline. Then mutate
    // the file from a "third party" before the user hits Save — the
    // watcher's compare_for_save must spot the divergence and the save
    // dispatch must surface it as a SaveError::Conflict carrying both
    // the user's local bytes and the on-disk bytes.
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("notes.md");
    std::fs::write(&p, b"# v1\n").unwrap();

    let mut ws = Workspace::new_for_test(dir.path());
    let tab_id = ws.test_open_drive_desktop_tab(&p);

    // Some other tool changes the file out from under us.
    std::thread::sleep(std::time::Duration::from_millis(20));
    std::fs::write(&p, b"# changed externally\n").unwrap();

    // User hits save.
    let res = ws.save_drive_desktop_tab(&tab_id, b"# my new edits\n");
    let outcome = res.expect_err("watcher mismatch must surface SaveError::Conflict");
    let (local, remote, source) = match outcome {
        SaveError::Conflict {
            local,
            remote,
            source,
        } => (local, remote, source),
        other => panic!("expected SaveError::Conflict, got {:?}", other),
    };
    assert_eq!(
        std::str::from_utf8(&local).unwrap(),
        "# my new edits\n",
        "the user's local bytes must be preserved for the diff-merge view"
    );
    assert_eq!(
        std::str::from_utf8(&remote).unwrap(),
        "# changed externally\n",
        "the on-disk bytes must be the remote half — that's what the user has to merge against"
    );
    assert!(
        matches!(source, ConflictSource::DriveDesktopWatcher),
        "DriveDesktop path must be tagged DriveDesktopWatcher so the banner picks the sync-client copy"
    );
}
