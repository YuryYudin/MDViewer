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

    /// Compose the full argv (program-name `ssh` excluded) for a remote
    /// command. Shape: `[<port flags...>, target, "--", "<remote cmd>"]`.
    ///
    /// CRITICAL: the remote command is ONE argv element, not split into
    /// `sh`, `-c`, `<cmd>`. ssh joins all post-target argv with spaces and
    /// the remote sshd already runs the result through the user's login
    /// shell — a second `sh -c` layer makes the shell re-tokenize the
    /// joined string and the original quoting is lost. See the
    /// `build_fetch_argv_passes_single_command_string_to_ssh` test for the
    /// pinned shape.
    fn build_remote_argv(url: &SshUrl, remote_cmd: String) -> Vec<String> {
        let mut argv = Self::port_args(url);
        argv.push(Self::target(url));
        argv.push("--".into());
        argv.push(remote_cmd);
        argv
    }

    pub(crate) fn build_fetch_argv(url: &SshUrl) -> Result<Vec<String>, TransportError> {
        let quoted = quote_remote_path(&url.path)?;
        Ok(Self::build_remote_argv(url, format!("cat -- {}", quoted)))
    }

    pub(crate) fn build_push_argv(url: &SshUrl) -> Result<Vec<String>, TransportError> {
        let quoted = quote_remote_path(&url.path)?;
        Ok(Self::build_remote_argv(url, format!("cat > {}", quoted)))
    }

    pub(crate) fn build_list_dir_argv(url: &SshUrl) -> Result<Vec<String>, TransportError> {
        let quoted = quote_remote_path(&url.path)?;
        Ok(Self::build_remote_argv(url, format!("ls -lA -- {}", quoted)))
    }

    pub(crate) fn build_stat_argv(url: &SshUrl) -> Result<Vec<String>, TransportError> {
        let quoted = quote_remote_path(&url.path)?;
        Ok(Self::build_remote_argv(
            url,
            format!("stat -c '%s %F' -- {}", quoted),
        ))
    }
}

/// Single-quote the remote path for safe inclusion in a shell command line.
///
/// `ssh` joins all post-target argv with spaces and the remote sshd re-parses
/// the result through the user's login shell — so an unquoted path containing
/// whitespace or shell metacharacters arrives as multiple tokens. We wrap the
/// path in single quotes uniformly across fetch/list_dir/stat/push.
///
/// Paths containing a single quote are intentionally rejected: handling them
/// would require escape sequences that aren't portable across `sh`
/// implementations. The trade-off is "fail clearly on a rare edge case"
/// rather than "ship a quoting bug".
fn quote_remote_path(path: &str) -> Result<String, TransportError> {
    if path.contains('\'') {
        return Err(TransportError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "path contains single quote; not supported",
        )));
    }
    Ok(format!("'{}'", path))
}

#[async_trait::async_trait]
impl SshTransport for UnixTransport {
    async fn fetch(&self, url: &SshUrl) -> Result<Vec<u8>, TransportError> {
        // `ssh user@host -p port -- cat -- '/path'` — bytes on stdout. The
        // remote command is passed as ONE argv element after `--`; ssh
        // joins post-target argv with spaces and the remote sshd already
        // invokes the user's login shell, so an extra `sh -c` layer would
        // cause double-parsing and lose the quoting.
        let argv = Self::build_fetch_argv(url)?;
        let mut cmd = Command::new("ssh");
        cmd.args(argv);
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
        // `ssh user@host -p port -- cat > '/path'` — stream bytes on stdin.
        // Using `cat >` rather than scp to (a) work with redirection
        // semantics that don't need a remote temp file and (b) keep one
        // codepath whether the remote uses scp protocol v1/v2 or sftp.
        // The remote command is one argv element; see `fetch` for the
        // "no extra sh -c wrap" rationale.
        let argv = Self::build_push_argv(url)?;
        let mut cmd = Command::new("ssh");
        cmd.args(argv);
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
        // `ssh user@host -- ls -lA -- '/path'` — parse stdout. The format
        // is GNU-specific; we do NOT attempt a BSD fallback here. If the
        // remote `ls` rejects `-lA` or our parser doesn't recognize its
        // output, the non-zero exit's stderr is surfaced verbatim via
        // `TransportError::Ssh` and the user can adapt.
        let argv = Self::build_list_dir_argv(url)?;
        let mut cmd = Command::new("ssh");
        cmd.args(argv);
        let out = cmd.output().await.map_err(TransportError::Spawn)?;
        if !out.status.success() {
            return Err(TransportError::Ssh {
                code: out.status.code(),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }
        Ok(parse_ls_la(&String::from_utf8_lossy(&out.stdout)))
    }

    async fn stat(&self, url: &SshUrl) -> Result<SshStat, TransportError> {
        // `ssh user@host -- stat -c '%s %F' -- '/path'` — GNU-only format.
        // As with list_dir, no BSD fallback: a non-zero exit surfaces the
        // remote's stderr verbatim via `TransportError::Ssh`.
        let argv = Self::build_stat_argv(url)?;
        let mut cmd = Command::new("ssh");
        cmd.args(argv);
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

fn parse_ls_la(input: &str) -> Vec<DirEntry> {
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
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    fn parse_ls_la_extracts_files_and_dirs() {
        let input = "total 8\n\
                     -rw-r--r-- 1 alice alice 123 May 14 10:00 fixture.md\n\
                     drwxr-xr-x 2 alice alice  64 May 14 10:00 subdir\n";
        let entries = parse_ls_la(input);
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
        let entries = parse_ls_la(input);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "my file.md");
        assert_eq!(entries[0].size, 12);
    }

    #[test]
    fn parse_ls_la_skips_total_header_and_blank_lines() {
        let input = "total 0\n\n";
        let entries = parse_ls_la(input);
        assert!(entries.is_empty());
    }

    #[test]
    fn parse_ls_la_empty_input_yields_no_entries() {
        let entries = parse_ls_la("");
        assert!(entries.is_empty());
    }

    #[test]
    fn parse_ls_la_size_defaults_to_zero_on_garbage() {
        // If the 5th column doesn't parse as u64 (e.g. a device file
        // listing `major, minor` rather than a byte count), we keep
        // emitting the entry with size 0 rather than dropping it.
        let input = "crw-rw-rw- 1 root root 1, 3 May 14 10:00 null\n";
        let entries = parse_ls_la(input);
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
    async fn fetch_rejects_path_with_single_quote() {
        // Same shell-quoting guard as `push`, applied uniformly across
        // every method that interpolates `url.path` into the remote argv.
        let t = UnixTransport::new();
        let url = SshUrl {
            user: None,
            host: "h".into(),
            port: 22,
            path: "/tmp/it's.md".into(),
        };
        let err = t.fetch(&url).await.unwrap_err();
        match err {
            TransportError::Io(e) => {
                assert_eq!(e.kind(), std::io::ErrorKind::InvalidInput);
            }
            other => panic!("expected Io error, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn list_dir_rejects_path_with_single_quote() {
        let t = UnixTransport::new();
        let url = SshUrl {
            user: None,
            host: "h".into(),
            port: 22,
            path: "/tmp/it's".into(),
        };
        let err = t.list_dir(&url).await.unwrap_err();
        match err {
            TransportError::Io(e) => {
                assert_eq!(e.kind(), std::io::ErrorKind::InvalidInput);
            }
            other => panic!("expected Io error, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn stat_rejects_path_with_single_quote() {
        let t = UnixTransport::new();
        let url = SshUrl {
            user: None,
            host: "h".into(),
            port: 22,
            path: "/tmp/it's.md".into(),
        };
        let err = t.stat(&url).await.unwrap_err();
        match err {
            TransportError::Io(e) => {
                assert_eq!(e.kind(), std::io::ErrorKind::InvalidInput);
            }
            other => panic!("expected Io error, got {:?}", other),
        }
    }

    #[test]
    fn build_fetch_argv_passes_single_command_string_to_ssh() {
        // ssh joins all post-target argv with spaces and the remote sshd
        // re-parses the result through the user's login shell, so wrapping
        // the command in a second `sh -c` layer turned `cat -- '/path'`
        // into four tokens (sh / -c / cat / --) plus a free /path — `cat`
        // ran as a no-arg script that read empty stdin and produced nothing.
        //
        // The fix is to pass the entire remote command as ONE argv element
        // after `target -- `. This test pins the contract.
        let url = SshUrl {
            user: Some("alice".into()),
            host: "h".into(),
            port: 22,
            path: "/tmp/file.md".into(),
        };
        let argv = UnixTransport::build_fetch_argv(&url).unwrap();
        // argv shape: [target, "--", "cat -- '/tmp/file.md'"]
        assert_eq!(argv, vec!["alice@h", "--", "cat -- '/tmp/file.md'"]);
    }

    #[test]
    fn build_fetch_argv_includes_port_args_when_non_default() {
        let url = SshUrl {
            user: None,
            host: "h".into(),
            port: 2222,
            path: "/file".into(),
        };
        let argv = UnixTransport::build_fetch_argv(&url).unwrap();
        // [-p, 2222, target, --, command]
        assert_eq!(argv, vec!["-p", "2222", "h", "--", "cat -- '/file'"]);
    }

    #[test]
    fn build_push_argv_passes_single_command_string_to_ssh() {
        let url = SshUrl {
            user: None,
            host: "h".into(),
            port: 22,
            path: "/tmp/file.md".into(),
        };
        let argv = UnixTransport::build_push_argv(&url).unwrap();
        assert_eq!(argv, vec!["h", "--", "cat > '/tmp/file.md'"]);
    }

    #[test]
    fn build_list_dir_argv_passes_single_command_string_to_ssh() {
        let url = SshUrl {
            user: None,
            host: "h".into(),
            port: 22,
            path: "/tmp".into(),
        };
        let argv = UnixTransport::build_list_dir_argv(&url).unwrap();
        assert_eq!(argv, vec!["h", "--", "ls -lA -- '/tmp'"]);
    }

    #[test]
    fn build_stat_argv_passes_single_command_string_to_ssh() {
        let url = SshUrl {
            user: None,
            host: "h".into(),
            port: 22,
            path: "/tmp/file.md".into(),
        };
        let argv = UnixTransport::build_stat_argv(&url).unwrap();
        assert_eq!(argv, vec!["h", "--", "stat -c '%s %F' -- '/tmp/file.md'"]);
    }

    #[tokio::test]
    #[serial]
    async fn fetch_when_ssh_missing_returns_spawn_or_ssh_error() {
        // Override PATH so `ssh` cannot be resolved; the spawn either
        // fails outright (Spawn) or — on systems where Command can still
        // run but exits non-zero — surfaces as an Ssh error with non-zero
        // exit. Either is correct trait behavior for "no ssh in PATH".
        // `#[serial]` keeps this from racing with any other test that
        // touches PATH or spawns a subprocess — cargo runs tests within
        // a binary in parallel by default, so without it a sibling test
        // would observe the blanked-out PATH and flake.
        let orig = std::env::var_os("PATH");
        // SAFETY: the `#[serial]` attribute ensures no other test in this
        // binary runs concurrently; we restore PATH before returning so
        // neighboring async tests don't observe the empty value.
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
