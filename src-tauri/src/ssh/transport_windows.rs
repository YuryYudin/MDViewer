//! Windows transport — uses `russh` + `russh-sftp` in-process.
//!
//! There is no system ssh client we can rely on across the entire
//! supported Windows surface (Windows 10 < 1809 didn't ship OpenSSH and
//! the design explicitly targets those users), so this impl uses native
//! Rust libraries to satisfy the same `SshTransport` trait surface as
//! `transport_unix`. Host-key verification goes through
//! `russh-keys::known_hosts` against `~/.ssh/known_hosts`; unknown hosts
//! fail with the no-TOFU "accept via `ssh user@host` first" message per
//! the Decision: Host key verification.

use super::transport::{DirEntry, SshStat, SshTransport, TransportError};
use mdviewer_core::ssh_url::SshUrl;
use russh::client::{self, Handle, Handler};
use russh::keys::key::PublicKey;
use russh_sftp::client::SftpSession;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncReadExt;

pub struct WindowsTransport {
    /// `AuthStrategy` is the enum defined in A5 (`src-tauri/src/ssh/auth.rs`).
    /// It is `Clone` (all fields — `Arc`, `mpsc::Sender` — are Clone), held
    /// by value here rather than behind a trait object. The russh-callback
    /// body for the `WindowsCallback` variant lives in A5's
    /// `src-tauri/src/ssh/auth.rs::AuthStrategy::authenticate` (Windows
    /// `impl` block) and is invoked through that method.
    pub auth: crate::ssh::auth::AuthStrategy,
}

/// The Handler is constructed per-connect and carries the host+port it was
/// built for so `check_server_key` can look up the right `known_hosts`
/// entry. russh's `Handler::check_server_key` signature (russh 0.45) only
/// hands us the presented `PublicKey`; host/port must come from `&self`
/// state we populate before passing the handler to `client::connect`.
struct ClientHandler {
    host: String,
    port: u16,
}

#[async_trait::async_trait]
impl Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        // Compare against ~/.ssh/known_hosts using the host+port this
        // Handler was constructed for. Mismatch surfaces a verbatim
        // diagnostic. Unknown host fails with the no-in-app-TOFU message
        // per Decision: Host key verification.
        //
        // russh-keys 0.45 maps the three outcomes onto `Result<bool, Error>`:
        //   * `Ok(true)`                   — entry present and matches
        //   * `Ok(false)`                  — no host entry found (NotFound)
        //   * `Err(Error::KeyChanged{..})` — entry present but a different key
        //                                    is recorded (Mismatch — the
        //                                    "REMOTE HOST IDENTIFICATION HAS
        //                                    CHANGED" case)
        //   * other `Err(_)`               — IO failure reading known_hosts;
        //                                    surface as a NotFound-equivalent
        //                                    diagnostic so the user knows to
        //                                    populate the file.
        match russh_keys::check_known_hosts(&self.host, self.port, server_public_key) {
            Ok(true) => Ok(true),
            Ok(false) => Err(russh::Error::IO(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!(
                    "host key for {}:{} not in known_hosts; accept this host via `ssh user@host` first",
                    self.host, self.port
                ),
            ))),
            Err(russh_keys::Error::KeyChanged { line }) => {
                Err(russh::Error::IO(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    format!(
                        "host key verification failed for {}:{}: presented key does not match the entry recorded at ~/.ssh/known_hosts line {}",
                        self.host, self.port, line
                    ),
                )))
            }
            Err(e) => Err(russh::Error::IO(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!(
                    "host key for {}:{} could not be verified ({}); accept this host via `ssh user@host` first",
                    self.host, self.port, e
                ),
            ))),
        }
    }
}

impl WindowsTransport {
    pub fn new(auth: crate::ssh::auth::AuthStrategy) -> Self {
        Self { auth }
    }

    async fn connect(&self, url: &SshUrl) -> Result<Handle<ClientHandler>, TransportError> {
        let config = Arc::new(client::Config {
            inactivity_timeout: Some(Duration::from_secs(30)),
            ..Default::default()
        });
        let handler = ClientHandler {
            host: url.host.clone(),
            port: url.port,
        };
        let addr = format!("{}:{}", url.host, url.port);
        let mut session = client::connect(config, addr, handler).await.map_err(|e| {
            TransportError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;
        // Auth: A5's AuthStrategy::authenticate (Windows impl block)
        // handles the full russh dance — agent-first, then password
        // prompt via the inbox if needed. Since A5 landed before A4 per
        // the task order, self.auth is the real strategy here, not a
        // placeholder.
        let user = url.user.as_deref().unwrap_or("root");
        self.auth.authenticate(&mut session, user).await?;
        Ok(session)
    }
}

#[async_trait::async_trait]
impl SshTransport for WindowsTransport {
    async fn fetch(&self, url: &SshUrl) -> Result<Vec<u8>, TransportError> {
        let session = self.connect(url).await?;
        let channel = session.channel_open_session().await.map_err(|e| {
            TransportError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;
        let sftp = SftpSession::new(channel.into_stream()).await.map_err(|e| {
            TransportError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;
        let mut file = sftp.open(&url.path).await.map_err(|e| {
            TransportError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;
        let mut buf = Vec::new();
        file.read_to_end(&mut buf).await.map_err(TransportError::Io)?;
        Ok(buf)
    }

    async fn push(&self, url: &SshUrl, bytes: &[u8]) -> Result<(), TransportError> {
        let session = self.connect(url).await?;
        let channel = session.channel_open_session().await.map_err(|e| {
            TransportError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;
        let sftp = SftpSession::new(channel.into_stream()).await.map_err(|e| {
            TransportError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;
        let mut file = sftp.create(&url.path).await.map_err(|e| {
            TransportError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;
        use tokio::io::AsyncWriteExt;
        file.write_all(bytes).await.map_err(TransportError::Io)?;
        file.flush().await.map_err(TransportError::Io)?;
        Ok(())
    }

    async fn list_dir(&self, url: &SshUrl) -> Result<Vec<DirEntry>, TransportError> {
        let session = self.connect(url).await?;
        let channel = session.channel_open_session().await.map_err(|e| {
            TransportError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;
        let sftp = SftpSession::new(channel.into_stream()).await.map_err(|e| {
            TransportError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;
        let entries = sftp.read_dir(&url.path).await.map_err(|e| {
            TransportError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;
        Ok(entries
            .into_iter()
            .map(|e| DirEntry {
                name: e.file_name(),
                is_dir: e.file_type().is_dir(),
                size: e.metadata().len(),
            })
            .collect())
    }

    async fn stat(&self, url: &SshUrl) -> Result<SshStat, TransportError> {
        let session = self.connect(url).await?;
        let channel = session.channel_open_session().await.map_err(|e| {
            TransportError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;
        let sftp = SftpSession::new(channel.into_stream()).await.map_err(|e| {
            TransportError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;
        let md = sftp.metadata(&url.path).await.map_err(|e| {
            TransportError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;
        Ok(SshStat {
            size: md.len(),
            is_dir: md.is_dir(),
            mtime: None,
        })
    }
}
