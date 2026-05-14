//! Smoke test for the `render-cli` bin.
//!
//! Layer 2 (block-tree oracle, B3) and Layer 4 (v0.4.0 baseline audit, D1)
//! both shell out to this binary to obtain View-mode HTML without spinning
//! up Tauri. The contract they rely on:
//!
//! 1. argv[1] = path to a `.md` file → stdout is `RenderResult::html`,
//!    exit 0.
//! 2. argv[1] missing → exit non-zero, stderr usage message.
//! 3. argv[1] points at a missing file → exit non-zero, stderr read error.
//!
//! Cargo wires `CARGO_BIN_EXE_render-cli` for us because the bin is declared
//! in this crate's `Cargo.toml`.

use std::io::Write;
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_render-cli");

fn write_tmp_md(contents: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir();
    let path = dir.join(format!(
        "render-cli-smoke-{}.md",
        std::process::id(),
    ));
    let mut f = std::fs::File::create(&path).expect("create tmp md");
    f.write_all(contents.as_bytes()).expect("write tmp md");
    path
}

#[test]
fn success_path_emits_html_starting_with_h1() {
    let path = write_tmp_md("# Hello\n\nA paragraph.\n");
    let output = Command::new(BIN)
        .arg(&path)
        .output()
        .expect("run render-cli");
    assert!(
        output.status.success(),
        "expected success, got status={:?}, stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stderr),
    );
    let stdout = String::from_utf8(output.stdout).expect("utf8 stdout");
    assert!(
        stdout.starts_with("<h1"),
        "expected stdout to begin with <h1, got: {}",
        &stdout[..stdout.len().min(80)],
    );
    let _ = std::fs::remove_file(&path);
}

#[test]
fn missing_argv_prints_usage_and_exits_nonzero() {
    let output = Command::new(BIN).output().expect("run render-cli");
    assert!(
        !output.status.success(),
        "expected non-zero exit on missing argv",
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("usage"),
        "expected usage message on stderr, got: {}",
        stderr,
    );
}

#[test]
fn missing_file_prints_read_error_and_exits_nonzero() {
    let output = Command::new(BIN)
        .arg("/nonexistent/path/definitely-not-a-real-file.md")
        .output()
        .expect("run render-cli");
    assert!(
        !output.status.success(),
        "expected non-zero exit on missing file",
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("read"),
        "expected 'read' in stderr message, got: {}",
        stderr,
    );
}
