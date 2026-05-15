//! Standalone helper binary invoked by `ssh` via SSH_ASKPASS.
//!
//! Reads the prompt from argv[1] (ssh-askpass protocol),
//! connects to the main mdviewer process via the Unix socket
//! advertised in `MDVIEWER_ASKPASS_SOCKET`, forwards the prompt as a
//! length-prefixed JSON frame, prints the user's response on stdout
//! (where `ssh` reads it). Exits non-zero on cancel so `ssh`
//! terminates the operation.
//!
//! Deliberately NOT a Tauri binary — only tokio + std + serde deps,
//! so startup is in tens of milliseconds rather than the seconds a
//! WebKit-linked binary would need.

#![cfg_attr(not(unix), allow(dead_code))]

#[cfg(unix)]
mod unix_impl {
    use serde::Serialize;
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UnixStream;

    /// Wire-compatible with `crate::ssh::askpass::Prompt`. We don't
    /// import the lib crate here because the helper bin must NOT link
    /// Tauri's transitive dep tree — that's the whole point of keeping
    /// it standalone. The shape is locked by
    /// `ssh::askpass::tests::prompt_serialization_is_stable`.
    #[derive(Serialize)]
    pub(super) struct Prompt<'a> {
        pub req_id: &'a str,
        pub message: &'a str,
        pub is_password: bool,
    }

    /// Drive the full helper round-trip. Returns:
    ///   * `Ok(Some(value))` on a Reply frame.
    ///   * `Ok(None)` on a Cancel frame (or any non-Reply shape).
    ///   * `Err(_)` on I/O failure connecting / reading / writing.
    pub(super) async fn talk_to_server(
        socket: &Path,
        prompt: &Prompt<'_>,
    ) -> std::io::Result<Option<String>> {
        let mut stream = UnixStream::connect(socket).await?;
        let buf = serde_json::to_vec(prompt)?;
        stream.write_all(&(buf.len() as u32).to_be_bytes()).await?;
        stream.write_all(&buf).await?;
        stream.flush().await?;
        let mut len_buf = [0u8; 4];
        stream.read_exact(&mut len_buf).await?;
        let len = u32::from_be_bytes(len_buf) as usize;
        let mut resp_buf = vec![0u8; len];
        stream.read_exact(&mut resp_buf).await?;
        let resp: serde_json::Value = serde_json::from_slice(&resp_buf)?;
        // Two-shape parsing: a Reply frame has `value`; a Cancel frame
        // doesn't. We deliberately don't enforce `kind == "reply"` so a
        // future server can extend the enum without breaking helpers
        // already deployed on user machines.
        if let Some(v) = resp.get("value").and_then(|v| v.as_str()) {
            return Ok(Some(v.to_string()));
        }
        Ok(None)
    }

    /// Best-effort guess at whether ssh wants a password (mask input)
    /// vs a confirmation (don't mask). ssh prompts include things like
    /// `"yury@host's password:"`, `"Enter passphrase for key '~/.ssh/id_ed25519':"`,
    /// `"Are you sure you want to continue connecting (yes/no/[fingerprint])?"`.
    /// We mask anything containing "password" or "passphrase" and
    /// reveal otherwise.
    pub(super) fn detect_is_password(prompt: &str) -> bool {
        let lower = prompt.to_lowercase();
        lower.contains("password") || lower.contains("passphrase")
    }

    /// What the helper should do once the server round-trip finishes
    /// (or fails to start). The bin's `main` runs the side-effects;
    /// tests cover the decision purely.
    #[derive(Debug, PartialEq, Eq)]
    pub(super) enum Outcome {
        /// Print `value` + newline to stdout, then exit 0.
        Reply(String),
        /// Print `stderr_msg` to stderr, then exit with `exit_code`
        /// (>= 1 for any non-success path).
        Error { exit_code: i32, stderr_msg: String },
    }

    /// Pure decision: turn an `Option<MDVIEWER_ASKPASS_SOCKET>` env
    /// value + the talk_to_server result into an Outcome. Split out so
    /// the bin's `main` is just plumbing (env read, stdout write,
    /// process::exit) and the exit-code policy is testable.
    pub(super) fn decide_outcome(
        socket_env: Option<&std::ffi::OsStr>,
        server_result: Result<Option<String>, std::io::Error>,
    ) -> Outcome {
        if socket_env.is_none() {
            return Outcome::Error {
                exit_code: 2,
                stderr_msg:
                    "MDVIEWER_ASKPASS_SOCKET not set; refusing to prompt outside mdviewer"
                        .into(),
            };
        }
        match server_result {
            Ok(Some(value)) => Outcome::Reply(value),
            Ok(None) => Outcome::Error {
                exit_code: 1,
                stderr_msg: "auth cancelled".into(),
            },
            Err(e) => Outcome::Error {
                exit_code: 3,
                stderr_msg: format!("askpass: {}", e),
            },
        }
    }

    pub(super) async fn run(prompt_text: String) -> ! {
        let socket_env = std::env::var_os("MDVIEWER_ASKPASS_SOCKET");
        // Pre-flight: if the env var is missing we never even try to
        // open a socket — that's pure plumbing the decide_outcome
        // function captures.
        let socket_path: PathBuf = match socket_env.as_deref() {
            Some(s) => PathBuf::from(s),
            None => {
                let outcome = decide_outcome(None, Ok(None));
                emit_and_exit(outcome);
            }
        };
        let req_id = format!("{}", std::process::id());
        let prompt = Prompt {
            req_id: &req_id,
            message: &prompt_text,
            is_password: detect_is_password(&prompt_text),
        };
        let server_result = talk_to_server(&socket_path, &prompt).await;
        let outcome = decide_outcome(Some(std::ffi::OsStr::new("set")), server_result);
        emit_and_exit(outcome);
    }

    /// Side-effect tail: stdout write + stderr write + process::exit.
    /// Diverging so the caller doesn't need to thread a `!` return.
    fn emit_and_exit(outcome: Outcome) -> ! {
        match outcome {
            Outcome::Reply(value) => {
                let mut stdout = std::io::stdout();
                // ssh strips trailing newline before using the response;
                // including it matches the shipped ssh-askpass behavior.
                let _ = stdout.write_all(value.as_bytes());
                let _ = stdout.write_all(b"\n");
                let _ = stdout.flush();
                std::process::exit(0);
            }
            Outcome::Error { exit_code, stderr_msg } => {
                eprintln!("{}", stderr_msg);
                std::process::exit(exit_code);
            }
        }
    }
}

#[cfg(unix)]
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let prompt_text: String = std::env::args().nth(1).unwrap_or_default();
    unix_impl::run(prompt_text).await
}

// Windows uses the russh in-process auth callback path; there is no
// helper bin on Windows. The bin target still needs *a* main so Cargo
// can produce an artifact (which we'll never ship). Exit non-zero so
// any accidental invocation fails loudly.
#[cfg(not(unix))]
fn main() {
    eprintln!("mdviewer-askpass is Unix-only");
    std::process::exit(2);
}

#[cfg(all(test, unix))]
mod tests {
    use super::unix_impl::{decide_outcome, detect_is_password, talk_to_server, Outcome, Prompt};
    use std::ffi::OsStr;
    use std::path::PathBuf;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UnixListener;

    /// Spin up a one-shot Unix listener that mirrors what
    /// `ssh::askpass::start_listener` does to the wire — read the
    /// length-prefixed Prompt, write a Response — so the helper-bin
    /// code path is exercised end-to-end without the lib's server.
    async fn echo_server(reply: Option<&'static str>) -> PathBuf {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mdviewer-askpass-test.sock");
        let listener = UnixListener::bind(&path).unwrap();
        // Leak the tempdir for the duration of the test process.
        let _kept: &'static tempfile::TempDir = Box::leak(Box::new(dir));
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            // Read length + payload.
            let mut len_buf = [0u8; 4];
            s.read_exact(&mut len_buf).await.unwrap();
            let len = u32::from_be_bytes(len_buf) as usize;
            let mut buf = vec![0u8; len];
            s.read_exact(&mut buf).await.unwrap();
            // Write a Response. We model both the Reply and Cancel
            // shapes; the helper detects via the "value" field.
            let resp: serde_json::Value = if let Some(r) = reply {
                serde_json::json!({ "kind": "reply", "req_id": "test", "value": r })
            } else {
                serde_json::json!({ "kind": "cancel", "req_id": "test" })
            };
            let bytes = serde_json::to_vec(&resp).unwrap();
            s.write_all(&(bytes.len() as u32).to_be_bytes()).await.unwrap();
            s.write_all(&bytes).await.unwrap();
            s.flush().await.unwrap();
        });
        path
    }

    #[tokio::test]
    async fn helper_reads_reply_frame_and_returns_value() {
        let path = echo_server(Some("hunter2")).await;
        let out = talk_to_server(
            &path,
            &Prompt {
                req_id: "test",
                message: "Password:",
                is_password: true,
            },
        )
        .await
        .unwrap();
        assert_eq!(out.as_deref(), Some("hunter2"));
    }

    #[tokio::test]
    async fn helper_returns_none_on_cancel_frame() {
        let path = echo_server(None).await;
        let out = talk_to_server(
            &path,
            &Prompt {
                req_id: "test",
                message: "Password:",
                is_password: true,
            },
        )
        .await
        .unwrap();
        assert!(out.is_none(), "cancel frame must return None");
    }

    #[tokio::test]
    async fn helper_errors_when_socket_missing() {
        let result = talk_to_server(
            std::path::Path::new("/nonexistent/mdviewer-askpass-missing.sock"),
            &Prompt {
                req_id: "test",
                message: "Password:",
                is_password: true,
            },
        )
        .await;
        assert!(result.is_err(), "missing socket must surface as I/O error");
    }

    #[test]
    fn decide_outcome_missing_env_exits_two() {
        let out = decide_outcome(None, Ok(Some("ignored".into())));
        match out {
            Outcome::Error { exit_code, stderr_msg } => {
                assert_eq!(exit_code, 2);
                assert!(stderr_msg.contains("MDVIEWER_ASKPASS_SOCKET"));
            }
            _ => panic!("expected Error outcome"),
        }
    }

    #[test]
    fn decide_outcome_reply_carries_value() {
        let out = decide_outcome(Some(OsStr::new("set")), Ok(Some("hunter2".into())));
        assert_eq!(out, Outcome::Reply("hunter2".into()));
    }

    #[test]
    fn decide_outcome_cancel_exits_one() {
        let out = decide_outcome(Some(OsStr::new("set")), Ok(None));
        match out {
            Outcome::Error { exit_code, stderr_msg } => {
                assert_eq!(exit_code, 1);
                assert_eq!(stderr_msg, "auth cancelled");
            }
            _ => panic!("expected Error outcome"),
        }
    }

    #[test]
    fn decide_outcome_io_error_exits_three() {
        let err = std::io::Error::new(std::io::ErrorKind::ConnectionRefused, "boom");
        let out = decide_outcome(Some(OsStr::new("set")), Err(err));
        match out {
            Outcome::Error { exit_code, stderr_msg } => {
                assert_eq!(exit_code, 3);
                assert!(stderr_msg.starts_with("askpass: "));
                assert!(stderr_msg.contains("boom"));
            }
            _ => panic!("expected Error outcome"),
        }
    }

    #[test]
    fn detect_is_password_classifies_common_prompts() {
        assert!(detect_is_password("yury@host's password:"));
        assert!(detect_is_password("Enter passphrase for key '~/.ssh/id_ed25519':"));
        assert!(detect_is_password("PASSWORD:"));
        assert!(!detect_is_password(
            "Are you sure you want to continue connecting (yes/no)?"
        ));
        assert!(!detect_is_password(""));
    }
}
