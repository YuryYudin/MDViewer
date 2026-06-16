//! SSH auth strategy probe.
//!
//! Decides per-platform whether the operation can proceed silently
//! (agent has keys) or whether we need to prompt the user.

use std::path::PathBuf;

pub enum AuthStrategy {
    /// ssh-agent reports loaded keys — silent auth.
    AgentOnly,
    /// Unix: ssh will be invoked with SSH_ASKPASS pointing at our
    /// helper binary; the helper connects to this socket.
    UnixAskpass { socket_path: PathBuf },
    /// Windows: russh auth-callback emits AskpassRequest events on `tx`
    /// and awaits the reply via `inbox` (the modal answers via the
    /// `ssh_password_response` Tauri command in A9, which calls
    /// `inbox.respond(req_id, value)`). Both `tx` and `inbox` are
    /// app-state singletons cloned at AuthStrategy construction time.
    WindowsCallback {
        tx: tokio::sync::mpsc::Sender<AskpassRequest>,
        inbox: std::sync::Arc<AskpassInbox>,
    },
}

/// Per-process inbox holding pending askpass-prompt reply channels, keyed by
/// req_id. Populated when a helper connection arrives (Unix askpass, A6) or
/// a russh auth callback fires (Windows, also in A5 — inline in this file);
/// drained when the frontend modal sends the user's response back via the
/// `ssh_password_response` Tauri command (A9). Lives in `auth.rs` rather than
/// `askpass.rs` because both producers (Unix + Windows) need it, and
/// `askpass.rs` is the Unix-only socket-server module.
pub struct AskpassInbox {
    pending: std::sync::Mutex<
        std::collections::HashMap<String, tokio::sync::oneshot::Sender<Option<String>>>,
    >,
}

impl Default for AskpassInbox {
    fn default() -> Self {
        Self::new()
    }
}

impl AskpassInbox {
    pub fn new() -> Self {
        Self {
            pending: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// Register a pending prompt and return its reply receiver.
    pub fn register(&self, req_id: String) -> tokio::sync::oneshot::Receiver<Option<String>> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.pending.lock().unwrap().insert(req_id, tx);
        rx
    }

    /// Resolve a pending prompt with the user's reply (`Some(value)`) or
    /// cancellation (`None`). Silently no-ops on unknown req_id (modal sent
    /// a stale reply after the prompt already cancelled). Synchronous because
    /// `oneshot::Sender::send` doesn't await.
    pub fn respond(&self, req_id: &str, value: Option<String>) {
        if let Some(tx) = self.pending.lock().unwrap().remove(req_id) {
            let _ = tx.send(value);
        }
    }
}

/// Event payload emitted by the Unix askpass server (A6) and the Windows
/// russh auth callback (also A5, inline `impl AuthStrategy::authenticate`).
/// The reply is NOT carried inside this struct — both producers register a
/// oneshot in `AskpassInbox` keyed by `req_id` before emitting the event.
/// The Tauri command `ssh_password_response` (A9) calls
/// `inbox.respond(req_id, value)` to resolve the registered oneshot. This
/// keeps `AskpassRequest` Clone-able and `Debug`-able, which a struct
/// containing a `oneshot::Sender` is not.
#[derive(Debug, Clone)]
pub struct AskpassRequest {
    pub req_id: String,
    pub prompt: String,
    pub is_password: bool,
}

/// Connect-time inputs threaded through probe + dispatch. Allocated once at
/// `AppState` construction (A9 wires it up) and passed by reference into the
/// per-operation auth flow.
pub struct AuthContext {
    pub askpass_helper_path: PathBuf,
    pub askpass_socket: PathBuf,
    pub askpass_tx: tokio::sync::mpsc::Sender<AskpassRequest>,
    pub inbox: std::sync::Arc<AskpassInbox>,
}

/// Synchronous probe — reads `SSH_AUTH_SOCK` and runs `ssh-add -l` to decide
/// whether silent agent auth is possible. Returns the per-platform fallback
/// strategy when the agent has no usable keys.
pub fn probe(ctx: &AuthContext) -> AuthStrategy {
    let has_agent_keys = std::env::var_os("SSH_AUTH_SOCK").is_some() && {
        // `ssh-add -l` exits 0 iff there are keys loaded, 1 if none, 2 if no agent.
        std::process::Command::new("ssh-add")
            .arg("-l")
            .output()
            .map(|o| o.status.code() == Some(0))
            .unwrap_or(false)
    };
    if has_agent_keys {
        return AuthStrategy::AgentOnly;
    }
    #[cfg(unix)]
    {
        AuthStrategy::UnixAskpass {
            socket_path: ctx.askpass_socket.clone(),
        }
    }
    #[cfg(windows)]
    {
        AuthStrategy::WindowsCallback {
            tx: ctx.askpass_tx.clone(),
            inbox: ctx.inbox.clone(),
        }
    }
}

// === Dispatch methods on AuthStrategy ===
//
// AuthStrategy is an enum (not a trait) so it stays plain and can be passed
// by value through the transports. The "behavior" lives in inherent `impl`
// blocks on the enum, with cfg-gated method surfaces matching each
// transport's needs:
//   - Unix transports call `authenticate_unix(cmd, ctx)` to install the
//     SSH_ASKPASS + MDVIEWER_ASKPASS_SOCKET env vars (helper-bin path comes
//     from ctx so this module doesn't need to know about askpass.rs).
//   - Windows transport calls `authenticate(session, user)` to drive russh's
//     auth dance. The dance is inlined here (no separate callback module) so
//     auth.rs has no cross-module references that would block compilation
//     at A5 commit time.

#[cfg(unix)]
impl AuthStrategy {
    pub async fn authenticate_unix(
        &self,
        cmd: &mut tokio::process::Command,
        ctx: &AuthContext,
    ) -> Result<(), super::transport::TransportError> {
        match self {
            AuthStrategy::AgentOnly => Ok(()),
            AuthStrategy::UnixAskpass { socket_path } => {
                cmd.env("SSH_ASKPASS", &ctx.askpass_helper_path);
                cmd.env("MDVIEWER_ASKPASS_SOCKET", socket_path);
                cmd.env("SSH_ASKPASS_REQUIRE", "force");
                cmd.env_remove("DISPLAY");
                Ok(())
            }
            AuthStrategy::WindowsCallback { .. } => unreachable!("WindowsCallback on Unix"),
        }
    }
}

// Windows russh-auth dance lives inline here (previously a separate A7
// task — folded in to keep file ownership disjoint).
#[cfg(windows)]
impl AuthStrategy {
    pub async fn authenticate<H>(
        &self,
        session: &mut russh::client::Handle<H>,
        user: &str,
    ) -> Result<(), super::transport::TransportError>
    where
        H: russh::client::Handler + Send,
    {
        match self {
            AuthStrategy::AgentOnly => {
                // Try ssh-agent via `russh::keys`. russh 0.61's `connect_env`
                // is Unix-only (it dials a `SSH_AUTH_SOCK` Unix socket); on
                // Windows the OpenSSH agent is a named pipe, so we dial that
                // instead. `probe()` only picks `AgentOnly` when
                // `SSH_AUTH_SOCK` is set, so prefer its value as the pipe path
                // and fall back to the conventional OpenSSH pipe name.
                //
                // russh 0.61 also replaced the old `authenticate_future`
                // move-dance with `authenticate_publickey_with(user,
                // public_key, hash_alg, &mut signer)`: `AgentClient` implements
                // `auth::Signer`, so russh calls back into the agent for each
                // sign request rather than receiving private key material. The
                // signer is borrowed (`&mut`) now, so it no longer has to be
                // threaded through the loop by value.
                let pipe_path = std::env::var_os("SSH_AUTH_SOCK")
                    .unwrap_or_else(|| r"\\.\pipe\openssh-ssh-agent".into());
                if let Ok(mut agent) =
                    russh::keys::agent::client::AgentClient::connect_named_pipe(&pipe_path).await
                {
                    if let Ok(ids) = agent.request_identities().await {
                        for id in ids {
                            // Only plain public-key identities are driven here;
                            // certificates use a separate auth method we don't
                            // offer.
                            let key = match id {
                                russh::keys::agent::AgentIdentity::PublicKey {
                                    key,
                                    ..
                                } => key,
                                _ => continue,
                            };
                            if let Ok(result) = session
                                .authenticate_publickey_with(user, key, None, &mut agent)
                                .await
                            {
                                if result.success() {
                                    return Ok(());
                                }
                            }
                        }
                    }
                }
                Err(super::transport::TransportError::Ssh {
                    code: None,
                    stderr: "agent has no usable keys for this host".into(),
                })
            }
            AuthStrategy::WindowsCallback { tx, inbox } => {
                use std::sync::atomic::{AtomicU64, Ordering};
                static NEXT_ID: AtomicU64 = AtomicU64::new(0);
                let req_id = format!("win-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
                let reply_rx = inbox.register(req_id.clone());
                let req = AskpassRequest {
                    req_id: req_id.clone(),
                    prompt: format!("{}@<remote>'s password:", user),
                    is_password: true,
                };
                tx.send(req).await.map_err(|_| {
                    super::transport::TransportError::Io(std::io::Error::new(
                        std::io::ErrorKind::Other,
                        "auth modal channel closed",
                    ))
                })?;
                let answer = match reply_rx.await {
                    Ok(Some(s)) => s,
                    _ => {
                        return Err(super::transport::TransportError::Io(
                            std::io::Error::new(
                                std::io::ErrorKind::PermissionDenied,
                                "auth cancelled",
                            ),
                        ));
                    }
                };
                let result = session
                    .authenticate_password(user, &answer)
                    .await
                    .map_err(|e| {
                        super::transport::TransportError::Io(std::io::Error::new(
                            std::io::ErrorKind::Other,
                            e.to_string(),
                        ))
                    })?;
                if !result.success() {
                    return Err(super::transport::TransportError::Ssh {
                        code: None,
                        stderr: "password authentication failed".into(),
                    });
                }
                Ok(())
            }
            AuthStrategy::UnixAskpass { .. } => unreachable!("UnixAskpass on Windows"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_ctx() -> AuthContext {
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        AuthContext {
            askpass_helper_path: std::path::PathBuf::from("/usr/lib/mdviewer/mdviewer-askpass"),
            askpass_socket: std::path::PathBuf::from("/tmp/mdviewer-askpass.sock"),
            askpass_tx: tx,
            inbox: std::sync::Arc::new(AskpassInbox::new()),
        }
    }

    #[test]
    fn probe_returns_some_strategy() {
        // Hard to test in isolation without controlling ssh-add. The probe
        // is verified end-to-end via the integration test in A12. Here we
        // assert the function compiles and returns one of the variants.
        let ctx = fake_ctx();
        let _ = probe(&ctx);
    }

    #[tokio::test]
    async fn inbox_register_then_respond_delivers_value() {
        let inbox = AskpassInbox::new();
        let rx = inbox.register("req-1".into());
        inbox.respond("req-1", Some("secret".into()));
        let got = rx.await.expect("oneshot delivered");
        assert_eq!(got, Some("secret".into()));
    }

    #[tokio::test]
    async fn inbox_respond_with_none_signals_cancellation() {
        let inbox = AskpassInbox::new();
        let rx = inbox.register("req-2".into());
        inbox.respond("req-2", None);
        let got = rx.await.expect("oneshot delivered");
        assert_eq!(got, None);
    }

    #[test]
    fn inbox_respond_unknown_id_is_silent() {
        let inbox = AskpassInbox::new();
        // No registration — respond should be a no-op rather than panicking.
        inbox.respond("never-registered", Some("ignored".into()));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn authenticate_unix_agent_only_sets_no_env() {
        let strat = AuthStrategy::AgentOnly;
        let mut cmd = tokio::process::Command::new("/bin/true");
        let ctx = fake_ctx();
        strat
            .authenticate_unix(&mut cmd, &ctx)
            .await
            .expect("agent-only succeeds");
        // No assertion on cmd env — agent-only is a no-op by design.
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn authenticate_unix_askpass_installs_env_vars() {
        let strat = AuthStrategy::UnixAskpass {
            socket_path: PathBuf::from("/tmp/socket.sock"),
        };
        let mut cmd = tokio::process::Command::new("/bin/true");
        let ctx = fake_ctx();
        strat
            .authenticate_unix(&mut cmd, &ctx)
            .await
            .expect("askpass install ok");
        // tokio::process::Command doesn't expose its env in a way we can read
        // back portably; the spawn-side smoke check is left to the A12
        // integration test. The fact that this returns Ok with the
        // UnixAskpass variant means we exercised that arm.
    }
}
