//! Unix transport — shells to system `ssh` and `scp` via tokio::process.

use super::auth::{probe, AuthContext};
use super::transport::{DirEntry, SshStat, SshTransport, TransportError};
use mdviewer_core::ssh_url::SshUrl;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

/// Unix transport. Each fetch/push/list_dir/stat:
///   1. Builds the `ssh` argv via `build_*_argv` helpers.
///   2. Probes the auth strategy via `auth::probe(&ctx)` (cheap — reads
///      `SSH_AUTH_SOCK` + `ssh-add -l`).
///   3. Installs SSH_ASKPASS + MDVIEWER_ASKPASS_SOCKET env vars on the
///      `Command` via `AuthStrategy::authenticate_unix(&mut cmd, &ctx)`
///      BEFORE spawning, so the spawned ssh sees the helper hook even when
///      the agent has no keys loaded. Agent-only operations skip the env
///      install (no-op `Ok(())` from `authenticate_unix`).
///
/// `auth_ctx` is `Option<Arc<AuthContext>>`: production construction in
/// `main.rs::build_ssh_app_state` always passes `Some(ctx)` so the askpass
/// flow can resolve a password prompt; the `None` constructor exists so
/// unit tests in this file can drive the transport without spinning up a
/// real `AskpassServer`.
pub struct UnixTransport {
    auth_ctx: Option<Arc<AuthContext>>,
    /// A12 test seam: when populated (only via `new_with_test_identity`),
    /// every `ssh` spawn gets prepended with `-i <key> -o
    /// IdentitiesOnly=yes -o UserKnownHostsFile=/dev/null -o
    /// StrictHostKeyChecking=no` so the integration test can target a
    /// local sshd fixture without an agent or known_hosts entry. The
    /// production path leaves this `None`; the env-var reads only run
    /// inside the test-only constructor, so no production code ever
    /// consults `MDVIEWER_TEST_SSH_*`.
    test_identity: Option<TestIdentity>,
}

/// Test-only ssh override: identity-file path + an extra `-p` to
/// override the URL-derived port. The transport always honors the
/// URL's port via `port_args`; this is here so a test that hardcodes
/// a port-22 URL but wants to redirect to a non-22 fixture has a
/// channel to do so. Currently only `identity_file` is required —
/// `port_override` is kept for forward-compat.
#[derive(Debug, Clone)]
struct TestIdentity {
    identity_file: std::path::PathBuf,
    port_override: Option<u16>,
}

impl Default for UnixTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl UnixTransport {
    /// Construct a transport with no auth context — every command runs in
    /// agent-only mode. Used by unit tests where a real `AskpassServer`
    /// would be overkill. Production code paths construct via
    /// `with_auth_context`.
    pub fn new() -> Self {
        Self {
            auth_ctx: None,
            test_identity: None,
        }
    }

    /// Production constructor: stash a clonable handle to the shared
    /// `AuthContext` so each per-command spawn can install the askpass
    /// env vars (SSH_ASKPASS + MDVIEWER_ASKPASS_SOCKET) and the russh
    /// callback path can resolve a pending prompt against the same inbox.
    pub fn with_auth_context(ctx: Arc<AuthContext>) -> Self {
        Self {
            auth_ctx: Some(ctx),
            test_identity: None,
        }
    }

    /// A12 test-only constructor: reads `MDVIEWER_TEST_SSH_IDENTITY`
    /// (absolute path to a private key) and `MDVIEWER_TEST_SSH_PORT`
    /// (optional u16) from the process environment and produces a
    /// transport that prepends the identity + strict-host-key-bypass
    /// flags to every `ssh` argv.
    ///
    /// The `StrictHostKeyChecking=no` knob is acceptable here because
    /// the test runs against a controlled local sshd whose key the
    /// fixture just generated; the production transport keeps strict
    /// checking. Hidden behind `#[doc(hidden)]` so it doesn't show up
    /// in cargo doc output, but `pub` so integration tests in the
    /// `tests/` directory (a separate crate) can construct one.
    #[doc(hidden)]
    pub fn new_with_test_identity() -> Self {
        let identity_file = std::env::var_os("MDVIEWER_TEST_SSH_IDENTITY")
            .map(std::path::PathBuf::from)
            .expect(
                "MDVIEWER_TEST_SSH_IDENTITY must be set when constructing a test-identity transport",
            );
        let port_override = std::env::var("MDVIEWER_TEST_SSH_PORT")
            .ok()
            .and_then(|s| s.parse::<u16>().ok());
        Self {
            auth_ctx: None,
            test_identity: Some(TestIdentity {
                identity_file,
                port_override,
            }),
        }
    }

    /// Build the leading argv supplied by the test-identity seam, if
    /// any. Empty in production. Inserted before `port_args` so the
    /// `-i` / `-o` flags apply uniformly to fetch/push/list_dir/stat.
    fn test_identity_args(&self) -> Vec<String> {
        match &self.test_identity {
            None => Vec::new(),
            Some(t) => {
                let mut v = vec![
                    "-i".to_string(),
                    t.identity_file.to_string_lossy().into_owned(),
                    "-o".to_string(),
                    "IdentitiesOnly=yes".to_string(),
                    "-o".to_string(),
                    "UserKnownHostsFile=/dev/null".to_string(),
                    "-o".to_string(),
                    "StrictHostKeyChecking=no".to_string(),
                    "-o".to_string(),
                    "GlobalKnownHostsFile=/dev/null".to_string(),
                    // Disable batch mode is unnecessary, but we DO want
                    // BatchMode=yes to make sure the test never opens an
                    // interactive prompt (which would hang the runner).
                    "-o".to_string(),
                    "BatchMode=yes".to_string(),
                ];
                if let Some(p) = t.port_override {
                    v.push("-p".to_string());
                    v.push(p.to_string());
                }
                v
            }
        }
    }

    /// Install SSH_ASKPASS/MDVIEWER_ASKPASS_SOCKET env vars on `cmd` before
    /// spawn, if an `AuthContext` was supplied at construction. Tests
    /// without context (legacy `new()`) skip the install entirely — same
    /// behavior as `AuthStrategy::AgentOnly`.
    async fn install_auth_env(
        &self,
        cmd: &mut Command,
    ) -> Result<(), TransportError> {
        if let Some(ctx) = &self.auth_ctx {
            let strategy = probe(ctx);
            strategy.authenticate_unix(cmd, ctx).await?;
        }
        Ok(())
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
        cmd.args(self.test_identity_args());
        cmd.args(argv);
        // Install SSH_ASKPASS + MDVIEWER_ASKPASS_SOCKET env vars on `cmd`
        // BEFORE spawning so the spawned `ssh` consults our helper when the
        // agent has no usable keys for this host (Decision 5 — no silent
        // degradation to agent-only fallback).
        self.install_auth_env(&mut cmd).await?;
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
        cmd.args(self.test_identity_args());
        cmd.args(argv);
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        self.install_auth_env(&mut cmd).await?;
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
        cmd.args(self.test_identity_args());
        cmd.args(argv);
        self.install_auth_env(&mut cmd).await?;
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
        cmd.args(self.test_identity_args());
        cmd.args(argv);
        self.install_auth_env(&mut cmd).await?;
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
    fn new_and_default_produce_transports_without_auth_context() {
        // Both no-arg constructors yield a transport in agent-only mode
        // (`auth_ctx == None`). Exercised so the coverage signal stays clean
        // and the no-context fallback path is observed.
        let t = UnixTransport::new();
        assert!(t.auth_ctx.is_none());
        assert!(t.test_identity.is_none());
        let t = UnixTransport::default();
        assert!(t.auth_ctx.is_none());
        assert!(t.test_identity.is_none());
    }

    #[test]
    fn test_identity_args_empty_when_seam_unused() {
        // Production constructors never populate `test_identity`; the seam
        // method must be a no-op for them so the argv is byte-identical to
        // the legacy production shape.
        let t = UnixTransport::new();
        assert!(t.test_identity_args().is_empty());
    }

    #[test]
    #[serial]
    fn new_with_test_identity_reads_env_vars() {
        // A12: the test-only constructor reads MDVIEWER_TEST_SSH_IDENTITY
        // and prepends `-i <path>` + strict-host-key-bypass flags. We pin
        // the argv shape so a future refactor that drops a flag is caught
        // here rather than in a flaky integration test.
        let key_path_env = "MDVIEWER_TEST_SSH_IDENTITY";
        let port_env = "MDVIEWER_TEST_SSH_PORT";
        let prev_key = std::env::var(key_path_env).ok();
        let prev_port = std::env::var(port_env).ok();
        std::env::set_var(key_path_env, "/tmp/test_id");
        std::env::set_var(port_env, "12345");
        let t = UnixTransport::new_with_test_identity();
        let args = t.test_identity_args();
        // -i <path>
        assert_eq!(args[0], "-i");
        assert_eq!(args[1], "/tmp/test_id");
        // Strict-host-key bypass + identities-only + batch-mode.
        assert!(args.iter().any(|a| a == "IdentitiesOnly=yes"));
        assert!(args.iter().any(|a| a == "UserKnownHostsFile=/dev/null"));
        assert!(args.iter().any(|a| a == "StrictHostKeyChecking=no"));
        assert!(args.iter().any(|a| a == "BatchMode=yes"));
        // Optional port override.
        assert!(args.iter().any(|a| a == "12345"));
        // Restore env so neighboring tests aren't perturbed.
        match prev_key {
            Some(v) => std::env::set_var(key_path_env, v),
            None => std::env::remove_var(key_path_env),
        }
        match prev_port {
            Some(v) => std::env::set_var(port_env, v),
            None => std::env::remove_var(port_env),
        }
    }

    #[test]
    fn with_auth_context_stashes_the_arc() {
        use super::super::auth::{AskpassInbox, AuthContext};
        use std::path::PathBuf;
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let ctx = Arc::new(AuthContext {
            askpass_helper_path: PathBuf::from("/opt/mdviewer/mdviewer-askpass"),
            askpass_socket: PathBuf::from("/tmp/sock"),
            askpass_tx: tx,
            inbox: Arc::new(AskpassInbox::new()),
        });
        let t = UnixTransport::with_auth_context(ctx.clone());
        let held = t.auth_ctx.as_ref().expect("ctx stashed");
        assert!(Arc::ptr_eq(held, &ctx));
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
