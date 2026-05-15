//! SSH transport layer for `ssh://` URLs.
//!
//! The `SshTransport` trait abstracts fetch/push/list/stat/sha256
//! operations. Two implementations satisfy it: a Unix process-spawn
//! impl that shells to system `ssh`/`scp` (`transport_unix`), and a
//! Windows russh-based in-process impl (`transport_windows`).
//!
//! Selection is at compile time via `#[cfg(unix)]` / `#[cfg(windows)]`.
//! Callers should not instantiate `SshTransport` directly — go through
//! `operations::open_url` / `operations::save_back` / `operations::list`.

pub mod transport;

#[cfg(unix)]
pub mod transport_unix;

#[cfg(windows)]
pub mod transport_windows;

// A5 adds the auth probe + high-level operations (open_url / save_back /
// save_sidecar). `askpass` (Unix-only socket server) lands in A6.
pub mod auth;
pub mod operations;

// A6: Unix-only socket server feeding the standalone `mdviewer-askpass`
// helper bin. The helper is what `ssh` invokes via `SSH_ASKPASS`; it
// connects back to this server over a tempdir Unix socket. Gated
// `#[cfg(unix)]` to match the module's own gating.
#[cfg(unix)]
pub mod askpass;
