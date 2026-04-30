//! OAuth 2.0 PKCE loopback flow per RFC 8252.
//!
//! The user clicks Connect → we open the system browser to a Google
//! authorization URL with `code_challenge` (S256) → user consents → Google
//! redirects to `http://127.0.0.1:<random>/?code=...&state=...` → our
//! `tiny_http` listener captures the code → we exchange it for tokens →
//! refresh token persisted via Stronghold (key from drive/keyring.rs).
//!
//! ## Design pins
//!
//! - Scopes are exactly `drive.file openid email`. Don't widen — `drive.readonly`
//!   or `userinfo.profile` either inflates the consent dialog or triggers
//!   Google verification we don't have.
//! - PKCE only — no client secret. `BasicClient::new` accepts an
//!   `Option<ClientSecret>`; we always pass `None`. The PKCE verifier is the
//!   credential.
//! - Loopback listener binds `127.0.0.1` exactly (RFC 8252) on port `0` so
//!   the OS picks a free port; that port becomes part of the redirect URI
//!   for that one auth attempt.

use base64::Engine;
use serde::Deserialize;

const SCOPE_DRIVE_FILE: &str = "https://www.googleapis.com/auth/drive.file";
const SCOPE_OPENID: &str = "openid";
const SCOPE_EMAIL: &str = "email";
const AUTH_BASE: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_BASE: &str = "https://oauth2.googleapis.com/token";

/// Fluent builder for an OAuth authorization URL. The shipped client_id is
/// baked at compile time via `option_env!("MDVIEWER_DEFAULT_CLIENT_ID")`; if
/// the user has supplied a BYO client_id (their own Google Cloud project),
/// that overrides the default. The redirect port is filled in by
/// `run_loopback_flow` once `tiny_http` has chosen one.
pub struct AuthBuilder {
    default_client_id: String,
    byo_client_id: Option<String>,
    redirect_port: u16,
}

impl Default for AuthBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl AuthBuilder {
    pub fn new() -> Self {
        Self {
            default_client_id: option_env!("MDVIEWER_DEFAULT_CLIENT_ID")
                .unwrap_or("PLACEHOLDER_CLIENT_ID.apps.googleusercontent.com")
                .into(),
            byo_client_id: None,
            redirect_port: 0,
        }
    }

    pub fn with_default_client_id(mut self, id: &str) -> Self {
        self.default_client_id = id.into();
        self
    }

    pub fn with_byo_client_id(mut self, id: Option<&str>) -> Self {
        self.byo_client_id = id.map(str::to_owned);
        self
    }

    pub fn with_redirect_port(mut self, port: u16) -> Self {
        self.redirect_port = port;
        self
    }

    /// Returns the BYO client_id when present, falling back to the shipped
    /// default. Public so the loopback flow can use the same resolution
    /// rule for the token exchange.
    pub fn resolved_client_id(&self) -> &str {
        self.byo_client_id
            .as_deref()
            .unwrap_or(&self.default_client_id)
    }

    pub fn redirect_port(&self) -> u16 {
        self.redirect_port
    }

    pub fn build_authorization_url(&self) -> AuthorizationUrl {
        let (verifier, challenge) = pkce_pair();
        let state = random_state();
        let scope = [SCOPE_DRIVE_FILE, SCOPE_OPENID, SCOPE_EMAIL].join(" ");
        // Mirror the `MDVIEWER_DRIVE_API_BASE` / `MDVIEWER_DRIVE_TOKEN_BASE`
        // env-var override pattern (A4 / `exchange_code` below) so the e2e
        // mock-server harness in C3 can redirect the consent URL too —
        // otherwise the BYO-consent-URL scenario can't be exercised in CI.
        let auth_base = std::env::var("MDVIEWER_DRIVE_AUTH_BASE")
            .unwrap_or_else(|_| AUTH_BASE.into());
        let mut url = url::Url::parse(&auth_base).expect("AUTH_BASE is a valid URL");
        url.query_pairs_mut()
            .append_pair("client_id", self.resolved_client_id())
            .append_pair(
                "redirect_uri",
                &format!("http://127.0.0.1:{}", self.redirect_port),
            )
            .append_pair("response_type", "code")
            .append_pair("scope", &scope)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &state)
            .append_pair("access_type", "offline")
            .append_pair("prompt", "consent");
        AuthorizationUrl {
            url: url.into(),
            state,
            code_verifier: verifier,
        }
    }
}

/// Bundle returned from `build_authorization_url`. The caller opens `url` in
/// the browser, then keeps `state` (to verify the redirect) and
/// `code_verifier` (to send during the token exchange).
pub struct AuthorizationUrl {
    pub url: String,
    pub state: String,
    pub code_verifier: String,
}

fn pkce_pair() -> (String, String) {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).expect("getrandom failed");
    let verifier = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf);
    use sha2::{Digest, Sha256};
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

fn random_state() -> String {
    let mut buf = [0u8; 16];
    getrandom::getrandom(&mut buf).expect("getrandom failed");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

/// Subset of the Google token endpoint response we care about. `refresh_token`
/// is `None` on subsequent consents (Google only sends it the first time),
/// which is why `prompt=consent` + `access_type=offline` are required on the
/// authorization URL above.
#[derive(Debug, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: u64,
    pub id_token: Option<String>,
    pub token_type: String,
}

/// Pulls the `email` claim out of a Google id_token. The token is an
/// unsigned-from-our-perspective JWT (`header.payload.signature`); we
/// base64url-decode the payload and read the `email` field. Signature
/// verification is unnecessary here — the token came over TLS from the
/// Google token endpoint we just authenticated to.
pub fn extract_email_from_id_token(jwt: &str) -> Option<String> {
    let payload = jwt.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    v.get("email")?.as_str().map(str::to_owned)
}

/// Synchronous loopback exchange used by the production `drive_connect` IPC.
/// Spawns a `tiny_http` listener on 127.0.0.1:0, opens the system browser via
/// the caller-supplied `open_url` closure (Tauri's `tauri-plugin-shell` in
/// production, a no-op in tests), blocks until the redirect arrives or
/// `timeout` elapses, exchanges the authorization code for tokens, and
/// returns them. Refresh-token persistence is the caller's responsibility
/// (Stronghold lives in main.rs setup).
pub fn run_loopback_flow(
    builder: AuthBuilder,
    timeout: std::time::Duration,
    open_url: impl FnOnce(&str),
) -> Result<TokenResponse, super::DriveError> {
    let server = tiny_http::Server::http("127.0.0.1:0")
        .map_err(|e| super::DriveError::Network(e.to_string()))?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|sa| sa.port())
        .unwrap_or(0);
    let builder = builder.with_redirect_port(port);
    let auth = builder.build_authorization_url();
    open_url(&auth.url);

    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        match server.recv_timeout(std::time::Duration::from_millis(500)) {
            Ok(Some(req)) => {
                let url = format!("http://127.0.0.1{}", req.url());
                let parsed = url::Url::parse(&url)
                    .map_err(|e| super::DriveError::Api(e.to_string()))?;
                let q: std::collections::HashMap<_, _> =
                    parsed.query_pairs().into_owned().collect();
                if q.get("state").map(String::as_str) != Some(&auth.state) {
                    let _ = req.respond(
                        tiny_http::Response::from_string("state mismatch")
                            .with_status_code(400),
                    );
                    return Err(super::DriveError::Api("oauth state mismatch".into()));
                }
                let code = q
                    .get("code")
                    .cloned()
                    .ok_or_else(|| super::DriveError::Api("no code".into()))?;
                let _ = req.respond(tiny_http::Response::from_string(
                    "<html><body>Connected. You can close this tab.</body></html>",
                ));
                return exchange_code(&builder, &code, &auth.code_verifier);
            }
            Ok(None) => continue,
            Err(e) => return Err(super::DriveError::Network(e.to_string())),
        }
    }
    Err(super::DriveError::Network("oauth timed out".into()))
}

fn exchange_code(
    builder: &AuthBuilder,
    code: &str,
    verifier: &str,
) -> Result<TokenResponse, super::DriveError> {
    let token_base = std::env::var("MDVIEWER_DRIVE_TOKEN_BASE")
        .unwrap_or_else(|_| TOKEN_BASE.into());
    let redirect_uri = format!("http://127.0.0.1:{}", builder.redirect_port());
    let body = [
        ("client_id", builder.resolved_client_id()),
        ("code", code),
        ("code_verifier", verifier),
        ("grant_type", "authorization_code"),
        ("redirect_uri", &redirect_uri),
    ];
    let resp = reqwest::blocking::Client::new()
        .post(token_base)
        .form(&body)
        .send()
        .map_err(|e| super::DriveError::Network(e.to_string()))?;
    if !resp.status().is_success() {
        return Err(super::DriveError::Api(resp.text().unwrap_or_default()));
    }
    resp.json::<TokenResponse>()
        .map_err(|e| super::DriveError::Api(e.to_string()))
}
