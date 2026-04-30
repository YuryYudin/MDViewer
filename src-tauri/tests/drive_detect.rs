//! A5: Drive Desktop path detection + file_id resolver tests.
//!
//! `is_drive_desktop_path` is unit-testable across all platforms on a single
//! CI host because it takes `target_os` and `home` as arguments rather than
//! reading them from `std::env::consts::OS`. The resolver tests use
//! `FileIdResolver::with_responses` to inject canned `files.list` JSON,
//! avoiding any network or `tauri::AppHandle` dependency.

use mdviewer_lib::drive::detect::{is_drive_desktop_path, DriveDesktopRoot};
use mdviewer_lib::drive::file_id::{resolve_file_id, FileIdResolution, FileIdResolver};

// ---------- detect.rs ---------------------------------------------------

#[test]
fn detect_macos_cloudstorage_path() {
    let p = std::path::Path::new(
        "/Users/alice/Library/CloudStorage/GoogleDrive-alice@gmail.com/My Drive/notes.md",
    );
    let r = is_drive_desktop_path(p, "macos", Some("/Users/alice"));
    assert!(matches!(r, Some(DriveDesktopRoot { .. })));
    assert_eq!(r.unwrap().mount_kind.as_str(), "macos-cloudstorage");
}

#[test]
fn detect_macos_legacy_volumes_path() {
    let p = std::path::Path::new("/Volumes/GoogleDrive/My Drive/notes.md");
    let r = is_drive_desktop_path(p, "macos", Some("/Users/alice"));
    assert_eq!(r.unwrap().mount_kind.as_str(), "macos-legacy-volumes");
}

#[test]
fn detect_windows_my_drive_path() {
    let p = std::path::Path::new(r"G:\My Drive\notes.md");
    let r = is_drive_desktop_path(p, "windows", Some(r"C:\Users\alice"));
    assert_eq!(r.unwrap().mount_kind.as_str(), "windows-drive-letter");
}

#[test]
fn detect_windows_userprofile_path() {
    let p = std::path::Path::new(r"C:\Users\alice\Google Drive\notes.md");
    let r = is_drive_desktop_path(p, "windows", Some(r"C:\Users\alice"));
    assert_eq!(r.unwrap().mount_kind.as_str(), "windows-userprofile");
}

#[test]
fn detect_linux_returns_none() {
    let p = std::path::Path::new("/home/alice/Drive/notes.md");
    assert!(is_drive_desktop_path(p, "linux", Some("/home/alice")).is_none());
}

#[test]
fn detect_non_drive_path_returns_none() {
    let p = std::path::Path::new("/Users/alice/Documents/notes.md");
    assert!(is_drive_desktop_path(p, "macos", Some("/Users/alice")).is_none());
}

// ---------- file_id.rs --------------------------------------------------

#[test]
fn file_id_resolver_returns_unique_match_from_drive() {
    let mock = FileIdResolver::with_responses(vec![
        r#"{"files":[{"id":"FID1","name":"notes.md","parents":["root"]}]}"#.into(),
    ]);
    let p = std::path::Path::new(
        "/Users/alice/Library/CloudStorage/GoogleDrive-alice@gmail.com/My Drive/notes.md",
    );
    let r = resolve_file_id(p, "macos", Some("/Users/alice"), &mock).unwrap();
    assert!(matches!(r, FileIdResolution::Resolved(ref id) if id == "FID1"));
}

#[test]
fn file_id_resolver_returns_ambiguous_on_multiple_matches() {
    let mock = FileIdResolver::with_responses(vec![
        r#"{"files":[{"id":"FID1","name":"notes.md","parents":["P1"]},{"id":"FID2","name":"notes.md","parents":["P2"]}]}"#.into(),
    ]);
    let p = std::path::Path::new(
        "/Users/alice/Library/CloudStorage/GoogleDrive-alice@gmail.com/My Drive/notes.md",
    );
    let r = resolve_file_id(p, "macos", Some("/Users/alice"), &mock).unwrap();
    assert!(matches!(r, FileIdResolution::Ambiguous(ref v) if v.len() == 2));
}

#[test]
fn file_id_resolver_caches_resolution() {
    let mock = FileIdResolver::with_responses(vec![
        r#"{"files":[{"id":"FID1","name":"notes.md","parents":["root"]}]}"#.into(),
    ]);
    let p = std::path::Path::new(
        "/Users/alice/Library/CloudStorage/GoogleDrive-alice@gmail.com/My Drive/notes.md",
    );
    let _ = resolve_file_id(p, "macos", Some("/Users/alice"), &mock).unwrap();
    let _ = resolve_file_id(p, "macos", Some("/Users/alice"), &mock).unwrap();
    assert_eq!(mock.calls(), 1, "cached lookup must not re-call Drive");
}
