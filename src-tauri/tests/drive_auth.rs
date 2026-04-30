//! Integration tests for the OAuth 2.0 PKCE loopback flow in `drive::auth`.
//!
//! The loopback exchange itself talks to Google's live token endpoint, so we
//! can't drive the full round-trip from `cargo test`. We instead pin the
//! deterministic surfaces of the state machine:
//!
//! 1. `build_authorization_url` produces a URL with the right `client_id`,
//!    redirect, response type, scopes, and PKCE challenge / method.
//! 2. A BYO (bring-your-own) client_id supplied via the builder overrides
//!    the shipped default — this is the workaround for users who want to
//!    use their own Google Cloud project.
//! 3. `extract_email_from_id_token` decodes the standard JWT payload and
//!    returns the `email` claim — used to populate `DriveStatus.account_email`
//!    after a successful consent.

use base64::Engine;
use mdviewer_lib::drive::auth::{extract_email_from_id_token, AuthBuilder};

#[test]
fn auth_state_authorization_url_contains_pkce_and_default_client_id() {
    let url = AuthBuilder::new()
        .with_default_client_id("123-default.apps.googleusercontent.com")
        .with_redirect_port(54321)
        .build_authorization_url();
    let parsed = url::Url::parse(url.url.as_str()).unwrap();
    let q: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
    assert_eq!(
        q.get("client_id").map(String::as_str),
        Some("123-default.apps.googleusercontent.com")
    );
    assert_eq!(
        q.get("redirect_uri").map(String::as_str),
        Some("http://127.0.0.1:54321")
    );
    assert_eq!(q.get("response_type").map(String::as_str), Some("code"));
    assert_eq!(
        q.get("code_challenge_method").map(String::as_str),
        Some("S256")
    );
    assert!(
        q.get("code_challenge").is_some(),
        "PKCE challenge required"
    );
    let scope = q.get("scope").map(String::as_str).unwrap();
    assert!(scope.contains("https://www.googleapis.com/auth/drive.file"));
    assert!(scope.contains("openid"));
    assert!(scope.contains("email"));
}

#[test]
fn auth_state_byo_client_id_overrides_default() {
    let url = AuthBuilder::new()
        .with_default_client_id("default.apps.googleusercontent.com")
        .with_byo_client_id(Some("byo-corp.apps.googleusercontent.com"))
        .with_redirect_port(54321)
        .build_authorization_url();
    let parsed = url::Url::parse(url.url.as_str()).unwrap();
    let q: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
    assert_eq!(
        q.get("client_id").map(String::as_str),
        Some("byo-corp.apps.googleusercontent.com")
    );
}

#[test]
fn auth_state_id_token_email_extraction() {
    // Manufactured id_token: header.payload.signature, payload contains
    // {"email":"alice@example.com"}.
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(br#"{"email":"alice@example.com","email_verified":true}"#);
    let token = format!("eyJhbGciOiJSUzI1NiJ9.{}.signature", payload);
    assert_eq!(
        extract_email_from_id_token(&token).unwrap(),
        "alice@example.com"
    );
}
