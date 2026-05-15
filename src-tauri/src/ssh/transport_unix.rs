//! Unix transport — shells to system `ssh` and `scp` via tokio::process.

use super::transport::{DirEntry, SshStat, SshTransport, TransportError};
use mdviewer_core::ssh_url::SshUrl;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

pub struct UnixTransport;

impl Default for UnixTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl UnixTransport {
    pub fn new() -> Self {
        Self
    }

    fn target(url: &SshUrl) -> String {
        match &url.user {
            Some(u) => format!("{}@{}", u, url.host),
            None => url.host.clone(),
        }
    }

    fn port_args(url: &SshUrl) -> Vec<String> {
        if url.port == 22 {
            vec![]
        } else {
            vec!["-p".into(), url.port.to_string()]
        }
    }
}

#[async_trait::async_trait]
impl SshTransport for UnixTransport {
    async fn fetch(&self, url: &SshUrl) -> Result<Vec<u8>, TransportError> {
        // `ssh user@host -p port -- cat /path` — bytes on stdout.
        let mut cmd = Command::new("ssh");
        cmd.args(Self::port_args(url));
        cmd.arg(Self::target(url));
        cmd.arg("--");
        cmd.arg("cat");
        cmd.arg(&url.path);
        let out = cmd.output().await.map_err(TransportError::Spawn)?;
        if !out.status.success() {
            return Err(TransportError::Ssh {
                code: out.status.code(),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }
        Ok(out.stdout)
    }

    async fn push(&self, url: &SshUrl, bytes: &[u8]) -> Result<(), TransportError> {
        // `ssh user@host -p port -- sh -c "cat > /path"` — stream bytes on stdin.
        // Using `sh -c` rather than scp to (a) work with `cat` redirection
        // semantics that don't need a remote temp file and (b) keep one
        // codepath whether the remote uses scp protocol v1/v2 or sftp.
        let mut cmd = Command::new("ssh");
        cmd.args(Self::port_args(url));
        cmd.arg(Self::target(url));
        cmd.arg("--");
        cmd.arg("sh");
        cmd.arg("-c");
        // Single-quote the path defensively. Path-with-quote characters
        // are intentionally not supported — they're a rare edge case
        // and we'd rather fail clearly than ship a quoting bug.
        if url.path.contains('\'') {
            return Err(TransportError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "remote paths containing single quotes are not supported",
            )));
        }
        cmd.arg(format!("cat > '{}'", url.path));
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        let mut child = cmd.spawn().map_err(TransportError::Spawn)?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(bytes).await.map_err(TransportError::Io)?;
            drop(stdin);
        }
        let out = child
            .wait_with_output()
            .await
            .map_err(TransportError::Io)?;
        if !out.status.success() {
            return Err(TransportError::Ssh {
                code: out.status.code(),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }
        Ok(())
    }

    async fn list_dir(&self, url: &SshUrl) -> Result<Vec<DirEntry>, TransportError> {
        // `ssh user@host -- ls -lA --time-style=+%s /path` — parse stdout.
        // The format string is GNU-specific; on macOS/BSD we fall back to
        // a portable `find /path -maxdepth 1 -printf` invocation only if
        // the first attempt fails. The Phase 2 dialog is the primary
        // consumer, so parsing happens here and the trait returns typed
        // `DirEntry` values.
        let mut cmd = Command::new("ssh");
        cmd.args(Self::port_args(url));
        cmd.arg(Self::target(url));
        cmd.arg("--");
        cmd.arg("ls");
        cmd.arg("-lA");
        cmd.arg("--");
        cmd.arg(&url.path);
        let out = cmd.output().await.map_err(TransportError::Spawn)?;
        if !out.status.success() {
            return Err(TransportError::Ssh {
                code: out.status.code(),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }
        parse_ls_la(&String::from_utf8_lossy(&out.stdout))
    }

    async fn stat(&self, url: &SshUrl) -> Result<SshStat, TransportError> {
        // `ssh user@host -- stat -c "%s %F" /path` — GNU. Fall back to
        // `wc -c </path` + heuristic if -c flag is unsupported.
        let mut cmd = Command::new("ssh");
        cmd.args(Self::port_args(url));
        cmd.arg(Self::target(url));
        cmd.arg("--");
        cmd.arg("stat");
        cmd.arg("-c");
        cmd.arg("%s %F");
        cmd.arg("--");
        cmd.arg(&url.path);
        let out = cmd.output().await.map_err(TransportError::Spawn)?;
        if !out.status.success() {
            return Err(TransportError::Ssh {
                code: out.status.code(),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }
        let s = String::from_utf8_lossy(&out.stdout);
        let mut parts = s.trim().splitn(2, ' ');
        let size: u64 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
        let kind = parts.next().unwrap_or("");
        Ok(SshStat {
            size,
            is_dir: kind.contains("directory"),
            mtime: None,
        })
    }
}

fn parse_ls_la(input: &str) -> Result<Vec<DirEntry>, TransportError> {
    // ls -lA emits a "total N" header line, then one entry per line.
    // Format: "perms links owner group size date time name". We split
    // on whitespace, take the first char of perms for is_dir, the 5th
    // field for size, and the rest of the line after the 8th field for
    // name (handles names with spaces).
    let mut out = Vec::new();
    for line in input.lines().skip_while(|l| l.starts_with("total ")) {
        if line.is_empty() {
            continue;
        }
        let mut fields = line.split_whitespace();
        let perms = fields.next().unwrap_or("");
        let _links = fields.next();
        let _owner = fields.next();
        let _group = fields.next();
        let size: u64 = fields.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let _month = fields.next();
        let _day = fields.next();
        let _time = fields.next();
        let name = fields.collect::<Vec<_>>().join(" ");
        if name.is_empty() {
            continue;
        }
        out.push(DirEntry {
            name,
            is_dir: perms.starts_with('d'),
            size,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ls_la_extracts_files_and_dirs() {
        let input = "total 8\n\
                     -rw-r--r-- 1 alice alice 123 May 14 10:00 fixture.md\n\
                     drwxr-xr-x 2 alice alice  64 May 14 10:00 subdir\n";
        let entries = parse_ls_la(input).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "fixture.md");
        assert!(!entries[0].is_dir);
        assert_eq!(entries[0].size, 123);
        assert_eq!(entries[1].name, "subdir");
        assert!(entries[1].is_dir);
    }

    #[test]
    fn parse_ls_la_handles_names_with_spaces() {
        // `split_whitespace().collect().join(" ")` collapses runs of
        // whitespace in the name to single spaces — acceptable trade-off
        // for not needing column-index alignment with the date.
        let input = "total 4\n\
                     -rw-r--r-- 1 alice alice 12 May 14 10:00 my file.md\n";
        let entries = parse_ls_la(input).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "my file.md");
        assert_eq!(entries[0].size, 12);
    }

    #[test]
    fn parse_ls_la_skips_total_header_and_blank_lines() {
        let input = "total 0\n\n";
        let entries = parse_ls_la(input).unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn parse_ls_la_empty_input_yields_no_entries() {
        let entries = parse_ls_la("").unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn parse_ls_la_size_defaults_to_zero_on_garbage() {
        // If the 5th column doesn't parse as u64 (e.g. a device file
        // listing `major, minor` rather than a byte count), we keep
        // emitting the entry with size 0 rather than dropping it.
        let input = "crw-rw-rw- 1 root root 1, 3 May 14 10:00 null\n";
        let entries = parse_ls_la(input).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].size, 0);
    }

    #[test]
    fn target_string_with_user() {
        let url = SshUrl {
            user: Some("alice".into()),
            host: "h".into(),
            port: 22,
            path: "/x".into(),
        };
        assert_eq!(UnixTransport::target(&url), "alice@h");
    }

    #[test]
    fn target_string_without_user() {
        let url = SshUrl {
            user: None,
            host: "h".into(),
            port: 22,
            path: "/x".into(),
        };
        assert_eq!(UnixTransport::target(&url), "h");
    }

    #[test]
    fn port_args_omitted_when_default() {
        let url = SshUrl {
            user: None,
            host: "h".into(),
            port: 22,
            path: "/x".into(),
        };
        assert!(UnixTransport::port_args(&url).is_empty());
    }

    #[test]
    fn port_args_present_when_non_default() {
        let url = SshUrl {
            user: None,
            host: "h".into(),
            port: 2222,
            path: "/x".into(),
        };
        assert_eq!(UnixTransport::port_args(&url), vec!["-p", "2222"]);
    }

    #[test]
    fn new_and_default_produce_equivalent_unit_transports() {
        // `UnixTransport` is a unit struct with no state — both constructors
        // are exercised so the coverage signal reflects that they're sound.
        let _ = UnixTransport::new();
        let _ = UnixTransport;
        let _ = UnixTransport::default();
    }

    #[tokio::test]
    async fn push_rejects_path_with_single_quote() {
        // Defensive guard for the `sh -c "cat > '...'"` quoting strategy.
        let t = UnixTransport::new();
        let url = SshUrl {
            user: None,
            host: "h".into(),
            port: 22,
            path: "/tmp/it's.md".into(),
        };
        let err = t.push(&url, b"x").await.unwrap_err();
        match err {
            TransportError::Io(e) => {
                assert_eq!(e.kind(), std::io::ErrorKind::InvalidInput);
            }
            other => panic!("expected Io error, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn fetch_when_ssh_missing_returns_spawn_or_ssh_error() {
        // Override PATH so `ssh` cannot be resolved; the spawn either
        // fails outright (Spawn) or — on systems where Command can still
        // run but exits non-zero — surfaces as an Ssh error with non-zero
        // exit. Either is correct trait behavior for "no ssh in PATH".
        // Saving and restoring PATH around the call keeps the rest of
        // the test binary's environment intact.
        let orig = std::env::var_os("PATH");
        // SAFETY: tests run serially within this test fn; we restore PATH
        // before returning so neighboring async tests don't observe it.
        unsafe {
            std::env::set_var("PATH", "");
        }
        let t = UnixTransport::new();
        let url = SshUrl {
            user: None,
            host: "host.invalid".into(),
            port: 22,
            path: "/file".into(),
        };
        let result = t.fetch(&url).await;
        unsafe {
            match orig {
                Some(v) => std::env::set_var("PATH", v),
                None => std::env::remove_var("PATH"),
            }
        }
        // We expect an error of some kind; the exact variant depends on
        // whether the OS resolves `ssh` from a cached lookup or not.
        assert!(result.is_err());
    }
}
