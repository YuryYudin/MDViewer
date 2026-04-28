//! End-to-end exercise of the `export_types` binary's `main` path.
//!
//! `cargo test` exposes the compiled bin's path via `CARGO_BIN_EXE_<name>`.
//! Spawning it from a temp working dir lets us cover the path resolution and
//! file-write branch inside `main` without touching the real workspace
//! `src/types-generated.ts` file.

use std::fs;
use std::process::Command;

#[test]
fn export_types_binary_writes_file_to_relative_path() {
    let bin = env!("CARGO_BIN_EXE_export_types");
    let dir = tempfile::tempdir().expect("tempdir");
    // The binary writes to `../src/types-generated.ts` relative to its CWD.
    // Set up that layout under the temp dir.
    let work = dir.path().join("work");
    let src = dir.path().join("src");
    fs::create_dir_all(&work).expect("mkdir work");
    fs::create_dir_all(&src).expect("mkdir src");

    let status = Command::new(bin)
        .current_dir(&work)
        .status()
        .expect("spawn export_types");
    assert!(status.success(), "binary should exit 0");

    let out = src.join("types-generated.ts");
    let body = fs::read_to_string(&out).expect("output file should exist");
    assert!(body.starts_with("// AUTO-GENERATED"));
    assert!(body.contains("BuildInfo"));
}
