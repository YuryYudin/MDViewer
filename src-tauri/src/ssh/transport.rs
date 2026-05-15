//! `SshTransport` trait — the contract every platform impl satisfies.
//!
//! Each method takes a parsed `SshUrl` so callers don't re-parse and
//! the impls can pluck out user/host/port/path without string surgery.

use mdviewer_core::ssh_url::SshUrl;
use std::fmt;

#[derive(Debug, Clone)]
pub struct SshStat {
    pub size: u64,
    pub is_dir: bool,
    pub mtime: Option<std::time::SystemTime>,
}

#[derive(Debug, Clone)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Debug)]
pub enum TransportError {
    Spawn(std::io::Error),
    Ssh { code: Option<i32>, stderr: String },
    Io(std::io::Error),
}

impl fmt::Display for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TransportError::Spawn(e) => write!(f, "failed to spawn ssh: {}", e),
            TransportError::Ssh { code, stderr } => {
                write!(f, "ssh exited {:?}\n{}", code, stderr)
            }
            TransportError::Io(e) => write!(f, "io error: {}", e),
        }
    }
}

impl std::error::Error for TransportError {}

#[async_trait::async_trait]
pub trait SshTransport: Send + Sync {
    async fn fetch(&self, url: &SshUrl) -> Result<Vec<u8>, TransportError>;
    async fn push(&self, url: &SshUrl, bytes: &[u8]) -> Result<(), TransportError>;
    async fn list_dir(&self, url: &SshUrl) -> Result<Vec<DirEntry>, TransportError>;
    async fn stat(&self, url: &SshUrl) -> Result<SshStat, TransportError>;
    fn sha256(&self, bytes: &[u8]) -> [u8; 32] {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(bytes);
        h.finalize().into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MockTransport;

    #[async_trait::async_trait]
    impl SshTransport for MockTransport {
        async fn fetch(&self, _url: &SshUrl) -> Result<Vec<u8>, TransportError> {
            Ok(b"hello".to_vec())
        }
        async fn push(&self, _url: &SshUrl, _bytes: &[u8]) -> Result<(), TransportError> {
            Ok(())
        }
        async fn list_dir(&self, _url: &SshUrl) -> Result<Vec<DirEntry>, TransportError> {
            Ok(vec![])
        }
        async fn stat(&self, _url: &SshUrl) -> Result<SshStat, TransportError> {
            Ok(SshStat {
                size: 5,
                is_dir: false,
                mtime: None,
            })
        }
    }

    #[tokio::test]
    async fn sha256_is_client_side_and_deterministic() {
        let t = MockTransport;
        let bytes = t
            .fetch(&SshUrl {
                user: None,
                host: "h".into(),
                port: 22,
                path: "/x".into(),
            })
            .await
            .unwrap();
        let h = t.sha256(&bytes);
        // Sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
        assert_eq!(
            hex::encode(h),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[tokio::test]
    async fn mock_transport_satisfies_trait() {
        // The trait is dyn-safe; this exercises every method via dynamic
        // dispatch so future signature drift breaks the dyn-safety contract
        // loudly rather than at the first dyn-using call site.
        let t: Box<dyn SshTransport> = Box::new(MockTransport);
        let url = SshUrl {
            user: None,
            host: "h".into(),
            port: 22,
            path: "/x".into(),
        };
        assert_eq!(t.fetch(&url).await.unwrap(), b"hello");
        t.push(&url, b"world").await.unwrap();
        assert!(t.list_dir(&url).await.unwrap().is_empty());
        let s = t.stat(&url).await.unwrap();
        assert_eq!(s.size, 5);
        assert!(!s.is_dir);
    }

    #[test]
    fn transport_error_display_formats_each_variant() {
        let spawn = TransportError::Spawn(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "ssh missing",
        ));
        assert!(spawn.to_string().starts_with("failed to spawn ssh"));

        let ssh = TransportError::Ssh {
            code: Some(255),
            stderr: "Permission denied".to_string(),
        };
        let msg = ssh.to_string();
        assert!(msg.contains("ssh exited"));
        assert!(msg.contains("Permission denied"));

        let io = TransportError::Io(std::io::Error::new(
            std::io::ErrorKind::BrokenPipe,
            "stdin closed",
        ));
        assert!(io.to_string().starts_with("io error"));
    }
}
