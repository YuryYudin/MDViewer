//! End-to-end exercise of the `mdviewer-askpass` helper bin.
//!
//! `cargo test` exposes the compiled bin's path via `CARGO_BIN_EXE_<name>`.
//! Spawning it against a hand-rolled Unix listener covers `main`,
//! `run`, and `emit_and_exit` — code paths whose unit tests can't reach
//! them in-process because each one terminates with `process::exit`.
//!
//! Unix-only: the helper bin doesn't ship on Windows.

#![cfg(unix)]

use std::io::{Read, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;

/// Spawn a one-shot blocking listener that mirrors the askpass-server
/// protocol: read one length-prefixed JSON Prompt frame, write one
/// length-prefixed JSON Response frame. Returned `JoinHandle` panics
/// if anything on the wire surprises it.
fn spawn_echo_server(
    socket_path: PathBuf,
    reply: Option<&'static str>,
) -> thread::JoinHandle<serde_json::Value> {
    let listener = UnixListener::bind(&socket_path).expect("bind unix listener");
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        let mut len_buf = [0u8; 4];
        stream.read_exact(&mut len_buf).expect("read prompt len");
        let len = u32::from_be_bytes(len_buf) as usize;
        let mut buf = vec![0u8; len];
        stream.read_exact(&mut buf).expect("read prompt body");
        let prompt: serde_json::Value =
            serde_json::from_slice(&buf).expect("prompt is valid json");

        let resp: serde_json::Value = match reply {
            Some(r) => {
                serde_json::json!({ "kind": "reply", "req_id": prompt["req_id"], "value": r })
            }
            None => serde_json::json!({ "kind": "cancel", "req_id": prompt["req_id"] }),
        };
        let bytes = serde_json::to_vec(&resp).expect("serialize response");
        stream
            .write_all(&(bytes.len() as u32).to_be_bytes())
            .expect("write response len");
        stream.write_all(&bytes).expect("write response body");
        stream.flush().expect("flush");
        prompt
    })
}

#[test]
fn helper_bin_prints_reply_value_on_stdout_with_exit_zero() {
    let bin = env!("CARGO_BIN_EXE_mdviewer-askpass");
    let dir = tempfile::tempdir().expect("tempdir");
    let socket = dir.path().join("askpass.sock");

    let server = spawn_echo_server(socket.clone(), Some("hunter2"));

    let output = Command::new(bin)
        .arg("Enter passphrase for key '/home/u/.ssh/id_ed25519':")
        .env("MDVIEWER_ASKPASS_SOCKET", &socket)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("spawn mdviewer-askpass");

    let prompt = server.join().expect("server thread");
    // Helper must propagate the prompt verbatim and flag the passphrase
    // case as a password input.
    assert_eq!(
        prompt["message"].as_str(),
        Some("Enter passphrase for key '/home/u/.ssh/id_ed25519':")
    );
    assert_eq!(prompt["is_password"].as_bool(), Some(true));
    assert!(output.status.success(), "helper exited non-zero");
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim_end(),
        "hunter2"
    );
}

#[test]
fn helper_bin_exits_one_on_cancel_frame() {
    let bin = env!("CARGO_BIN_EXE_mdviewer-askpass");
    let dir = tempfile::tempdir().expect("tempdir");
    let socket = dir.path().join("askpass.sock");

    let _server = spawn_echo_server(socket.clone(), None);

    let output = Command::new(bin)
        .arg("Password:")
        .env("MDVIEWER_ASKPASS_SOCKET", &socket)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("spawn mdviewer-askpass");

    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty(), "no value written on cancel");
    let err = String::from_utf8_lossy(&output.stderr);
    assert!(err.contains("auth cancelled"), "stderr: {}", err);
}

#[test]
fn helper_bin_exits_two_when_env_unset() {
    let bin = env!("CARGO_BIN_EXE_mdviewer-askpass");
    // Deliberately do NOT set MDVIEWER_ASKPASS_SOCKET. Also clear it in
    // case the test runner inherited one — Command::env_remove makes the
    // assertion robust against shared environments.
    let output = Command::new(bin)
        .arg("Password:")
        .env_remove("MDVIEWER_ASKPASS_SOCKET")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("spawn mdviewer-askpass");

    assert_eq!(output.status.code(), Some(2));
    let err = String::from_utf8_lossy(&output.stderr);
    assert!(
        err.contains("MDVIEWER_ASKPASS_SOCKET"),
        "stderr: {}",
        err
    );
}

#[test]
fn helper_bin_exits_three_when_socket_unreachable() {
    let bin = env!("CARGO_BIN_EXE_mdviewer-askpass");
    let output = Command::new(bin)
        .arg("Password:")
        .env(
            "MDVIEWER_ASKPASS_SOCKET",
            "/nonexistent/mdviewer-askpass.sock",
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("spawn mdviewer-askpass");

    assert_eq!(output.status.code(), Some(3));
    let err = String::from_utf8_lossy(&output.stderr);
    assert!(err.starts_with("askpass: "), "stderr: {}", err);
}
