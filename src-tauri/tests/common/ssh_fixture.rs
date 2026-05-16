//! Test fixture helper — spawns a local sshd (Linux/macOS) or a russh
//! in-process server (Windows) for the SSH integration tests.
//!
//! Lifecycle:
//!   1. Caller awaits `start_fixture()` — gets back a `SshdHandle`.
//!   2. Caller drives `Operations` against `handle.port` on `127.0.0.1`.
//!   3. When the handle drops, the sshd process / russh server is torn
//!      down. The handle keeps its tempdir alive until drop so the
//!      generated config file / pidfile / serving root survive every
//!      `await` inside the test.

#![allow(dead_code)]

use std::path::PathBuf;

/// Marker for the per-platform sshd flavor backing this handle. Tests
/// can use it to skip Unix-only assertions (e.g. pidfile content) when
/// running against the russh harness.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FixtureFlavor {
    /// `/usr/sbin/sshd -f <rendered config> -D` on Linux / macOS.
    SystemSshd,
    /// Embedded russh server on Windows.
    RusshHarness,
}

pub struct SshdHandle {
    pub port: u16,
    pub flavor: FixtureFlavor,
    /// Path the test should serve files from. On the sshd-backed path
    /// this is unconstrained (sshd reads any path the test user can
    /// reach); on the russh harness this is the per-test serving root.
    pub serving_root: PathBuf,
    #[cfg(unix)]
    inner: UnixInner,
    #[cfg(windows)]
    inner: WindowsInner,
}

#[cfg(unix)]
struct UnixInner {
    child: Option<tokio::process::Child>,
    /// Keep the tempdir alive until the handle drops so rendered config
    /// + pidfile survive the full test lifecycle.
    _tmpdir: tempfile::TempDir,
}

#[cfg(windows)]
struct WindowsInner {
    server: Option<crate::common::russh_test_server::Handle>,
    /// Keep the tempdir alive until the handle drops.
    _tmpdir: tempfile::TempDir,
}

impl Drop for SshdHandle {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            if let Some(mut c) = self.inner.child.take() {
                // `start_kill` is fire-and-forget; we deliberately do not
                // await here because Drop is sync. The pidfile + tmpdir
                // get cleaned up when `_tmpdir` drops on the next line.
                let _ = c.start_kill();
            }
        }
        #[cfg(windows)]
        {
            if let Some(s) = self.inner.server.take() {
                s.shutdown();
            }
        }
    }
}

/// Locate the committed fixture directory at `src-tauri/tests/fixtures/ssh`.
/// `CARGO_MANIFEST_DIR` resolves to `src-tauri` at integration-test build
/// time, so the joined path lands at the right place regardless of where
/// `cargo test` is invoked from.
pub fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ssh")
}

/// Pick an ephemeral port by binding to 0 and immediately closing. The
/// port can in theory be reused before we hand it to sshd; in practice
/// the race window is microseconds and CI runners have plenty of free
/// ports. `wait_for_port` below absorbs any startup delay.
fn pick_random_port() -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

/// Poll for the spawned sshd to bind its listener. We deliberately do
/// not `sleep 2` — fixed sleeps have historically flaked under CI load.
/// 50ms retry × up to 5s ceiling matches what the a12 plan specifies.
async fn wait_for_port(port: u16) -> std::io::Result<()> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("sshd at 127.0.0.1:{port} never came up within 5s"),
            ));
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

#[cfg(unix)]
pub async fn start_fixture() -> std::io::Result<SshdHandle> {
    let fixture_root_path = fixture_root();
    let tmpdir = tempfile::tempdir()?;
    let port = pick_random_port()?;
    let config_path = tmpdir.path().join("sshd_config");
    let pidfile = tmpdir.path().join("sshd.pid");

    // Re-tighten the committed private key perms before sshd reads them.
    // git can preserve mode bits across clones on most filesystems, but
    // the safe-by-default belt-and-braces is to chmod 600 here. sshd
    // refuses to load a key whose perms grant group/other read.
    use std::os::unix::fs::PermissionsExt;
    for name in ["id_test", "test_host_key"] {
        let p = fixture_root_path.join(name);
        if let Ok(meta) = std::fs::metadata(&p) {
            let mut perms = meta.permissions();
            perms.set_mode(0o600);
            let _ = std::fs::set_permissions(&p, perms);
        }
    }

    let template = std::fs::read_to_string(fixture_root_path.join("sshd_config.template"))?;
    let rendered = template
        .replace("__PORT__", &port.to_string())
        .replace(
            "__HOST_KEY__",
            fixture_root_path
                .join("test_host_key")
                .to_str()
                .expect("fixture path is valid UTF-8"),
        )
        .replace(
            "__AUTHKEYS__",
            fixture_root_path
                .join("authorized_keys")
                .to_str()
                .expect("fixture path is valid UTF-8"),
        )
        .replace(
            "__PIDFILE__",
            pidfile.to_str().expect("pidfile path is valid UTF-8"),
        );
    std::fs::write(&config_path, rendered)?;

    // `-D` keeps sshd in the foreground so `start_kill` on the child
    // terminates the listener; `-e` forwards logs to stderr so a failed
    // spawn surfaces the actual reason in the test output rather than
    // a generic "sshd never came up".
    let mut cmd = tokio::process::Command::new("/usr/sbin/sshd");
    cmd.arg("-f").arg(&config_path).arg("-D").arg("-e");
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let child = cmd.spawn()?;

    let serving_root = tmpdir.path().to_path_buf();
    let handle = SshdHandle {
        port,
        flavor: FixtureFlavor::SystemSshd,
        serving_root,
        inner: UnixInner {
            child: Some(child),
            _tmpdir: tmpdir,
        },
    };
    wait_for_port(port).await?;
    Ok(handle)
}

#[cfg(windows)]
pub async fn start_fixture() -> std::io::Result<SshdHandle> {
    // The Windows path doesn't render `sshd_config.template`; it reuses
    // only the keypair from `tests/fixtures/ssh/` and serves files from
    // a per-test tmpdir handed back as `serving_root`.
    let tmpdir = tempfile::tempdir()?;
    let serving_root = tmpdir.path().to_path_buf();
    let server = crate::common::russh_test_server::spawn(&serving_root).await?;
    let port = server.port;
    let handle = SshdHandle {
        port,
        flavor: FixtureFlavor::RusshHarness,
        serving_root,
        inner: WindowsInner {
            server: Some(server),
            _tmpdir: tmpdir,
        },
    };
    wait_for_port(port).await?;
    Ok(handle)
}
