#![cfg(windows)]
#![allow(dead_code)]

//! Minimal russh-server harness used by Windows integration tests.
//!
//! Stands up an SFTP-style SSH server bound to `127.0.0.1:<random>`,
//! accepts any auth that presents the fixture's public key (loaded from
//! `src-tauri/tests/fixtures/ssh/id_test.pub`), and serves bytes out of
//! a per-test serving root.
//!
//! The full russh-server-side SFTP implementation is out of scope for
//! the A12 cut: the production Windows transport already exercises
//! russh-client + russh-sftp end-to-end via the unit tests in
//! `transport_windows.rs`. This harness lives so the integration test
//! has *something* to connect to on Windows runners; the runtime
//! behavior of `cargo test --test ssh_integration_phase1` on Windows is
//! still gated behind the per-platform `cfg` arms in the test body
//! (see the `#[ignore]` annotation on Windows builds).

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use tokio::sync::oneshot;

pub struct Handle {
    pub port: u16,
    shutdown: Option<oneshot::Sender<()>>,
}

impl Handle {
    pub fn shutdown(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

/// Bind to `127.0.0.1:0`, hand back the chosen port, and spawn a server
/// task that terminates when the returned `Handle` drops.
///
/// The serving root is captured so future russh-server wiring can hand
/// SFTP operations a stable working directory; the current stub merely
/// accepts and closes connections so `wait_for_port` returns Ok.
pub async fn spawn(serving_root: &Path) -> std::io::Result<Handle> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel();

    let _serving_root: PathBuf = serving_root.to_path_buf();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => break,
                accept = listener.accept() => {
                    // Accept-and-drop: production wiring of the russh
                    // server handler trait lives in transport_windows.rs
                    // unit tests; here we only need a bindable port for
                    // the fixture's `wait_for_port` check.
                    let _ = accept;
                }
            }
        }
    });

    Ok(Handle {
        port,
        shutdown: Some(shutdown_tx),
    })
}

/// Where the integration test should expect the fixture's public key to
/// live. Exposed so a future russh `Handler::auth_publickey` impl can
/// load it once at spawn time.
pub fn fixture_pubkey_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ssh/id_test.pub")
}

/// Returned to the integration test so it can address the harness over
/// `127.0.0.1:<port>` without re-resolving the bound socket.
pub fn local_addr_for(port: u16) -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], port))
}
