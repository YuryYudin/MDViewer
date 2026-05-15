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

// `operations`, `auth`, `askpass` are added
// in A5/A6. Keep this module compiling with just `transport` until
// they land.
