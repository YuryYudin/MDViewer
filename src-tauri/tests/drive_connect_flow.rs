//! D2 integration tests for `Workspace::drive_connect` and the
//! polling-cancel signal exposed by `drive_disconnect`.
//!
//! `drive_connect` requires an OAuth round-trip + token persistence + a
//! `tauri::AppHandle` (the production path spawns a polling task). To keep
//! these tests hermetic, D2 introduces a `drive_connect_for_test()` method
//! that runs the same OAuth + token-persist + DriveApi-populate pipeline,
//! initializes the `polling_cancel` watch channel, but skips the polling
//! task spawn (which would otherwise demand a real `AppHandle`). The test
//! seam uses a built-in opener that, on receipt of the authorize URL,
//! spawns a worker thread to fire the consent-redirect HTTP GET back at
//! the loopback listener so the OAuth state machine completes.

mod common;
use common::stub_server;
use mdviewer_lib::workspace::Workspace;
use serial_test::serial;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tempfile::TempDir;

/// Build a stub Google OAuth surface. Routes:
///   GET /o/oauth2/v2/auth → captured (the test opener fires the redirect
///       directly to the loopback listener; we don't depend on this
///       endpoint's response body).
///   POST /token → returns access_token=at-1, refresh_token=rt-1, and an
///       id_token whose payload (base64url decoded) contains
///       {"email":"alice@example.com"}.
///
/// Returns (base_url, captured_authorize_url, server_handle).
fn build_oauth_stub() -> (
    String,
    Arc<std::sync::Mutex<Option<String>>>,
    std::thread::JoinHandle<()>,
) {
    let captured_auth_url = Arc::new(std::sync::Mutex::new(None::<String>));
    let captured_for_router = captured_auth_url.clone();
    let (base, handle) = stub_server(move |req| {
        let url = req.url().to_string();
        if url.starts_with("/o/oauth2") || url.starts_with("/?") {
            *captured_for_router.lock().unwrap() = Some(url.clone());
            tiny_http::Response::from_string("authorize OK")
        } else if url == "/token" {
            // id_token payload (base64url-no-pad) for {"email":"alice@example.com"}:
            //   eyJlbWFpbCI6ImFsaWNlQGV4YW1wbGUuY29tIn0
            let body = r#"{"access_token":"at-1","refresh_token":"rt-1","token_type":"Bearer","expires_in":3600,"id_token":"hdr.eyJlbWFpbCI6ImFsaWNlQGV4YW1wbGUuY29tIn0.sig"}"#;
            tiny_http::Response::from_string(body).with_header(
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                    .unwrap(),
            )
        } else {
            tiny_http::Response::from_string("not found").with_status_code(404)
        }
    });
    (base, captured_auth_url, handle)
}

#[test]
#[serial]
fn drive_connect_runs_oauth_and_populates_api() {
    let dir = TempDir::new().unwrap();

    let (base, _captured, _h) = build_oauth_stub();
    std::env::set_var("MDVIEWER_DRIVE_AUTH_BASE", format!("{}/o/oauth2/v2/auth", base));
    std::env::set_var("MDVIEWER_DRIVE_TOKEN_BASE", format!("{}/token", base));

    let mut ws = Workspace::new_for_test(dir.path());

    ws.drive_connect_for_test()
        .expect("drive_connect_for_test should succeed against the stub");

    // After connect: API is populated, settings reflect connected = true.
    assert!(
        ws.drive_api_arc().is_some(),
        "drive_api must be populated after drive_connect"
    );
    let s = ws.settings_store().get();
    assert!(
        s.cloud.drive.connected,
        "settings.cloud.drive.connected must be true after drive_connect"
    );
    assert_eq!(
        s.cloud.drive.account_email.as_deref(),
        Some("alice@example.com"),
        "account_email should be derived from the id_token's email claim"
    );

    std::env::remove_var("MDVIEWER_DRIVE_AUTH_BASE");
    std::env::remove_var("MDVIEWER_DRIVE_TOKEN_BASE");
}

#[test]
#[serial]
fn drive_connect_persists_refresh_token_to_local_store() {
    let dir = TempDir::new().unwrap();
    let (base, _captured, _h) = build_oauth_stub();
    std::env::set_var("MDVIEWER_DRIVE_AUTH_BASE", format!("{}/o/oauth2/v2/auth", base));
    std::env::set_var("MDVIEWER_DRIVE_TOKEN_BASE", format!("{}/token", base));

    let mut ws = Workspace::new_for_test(dir.path());
    ws.drive_connect_for_test().expect("connect");

    use mdviewer_lib::drive::tokens::{load_refresh_token, TokenStore};
    let store = TokenStore::open_for_test(
        dir.path().join("drive_tokens.bin"),
        &mdviewer_lib::drive::keyring::vault_key(),
    )
    .unwrap();
    let token = load_refresh_token(&store, "alice@example.com")
        .expect("load")
        .expect("refresh token persisted");
    assert_eq!(token, "rt-1");

    std::env::remove_var("MDVIEWER_DRIVE_AUTH_BASE");
    std::env::remove_var("MDVIEWER_DRIVE_TOKEN_BASE");
}

#[test]
#[serial]
fn drive_disconnect_signals_polling_cancel() {
    // drive_connect_for_test populates `polling_cancel` (a watch channel
    // sender); drive_disconnect takes it (.take()) and drops it, which
    // wakes any awaiter on the corresponding receiver. We exercise this by
    // subscribing to the channel before disconnect and asserting the
    // receiver wakes within a short timeout afterwards.
    let dir = TempDir::new().unwrap();
    let (base, _captured, _h) = build_oauth_stub();
    std::env::set_var("MDVIEWER_DRIVE_AUTH_BASE", format!("{}/o/oauth2/v2/auth", base));
    std::env::set_var("MDVIEWER_DRIVE_TOKEN_BASE", format!("{}/token", base));

    let mut ws = Workspace::new_for_test(dir.path());
    ws.drive_connect_for_test().expect("connect");

    let mut rx = ws
        .polling_cancel_rx_for_test()
        .expect("polling_cancel must be initialized after drive_connect");
    assert_eq!(*rx.borrow(), true, "cancel channel starts at true");

    ws.drive_disconnect();

    // After disconnect the sender is dropped; .changed() resolves with
    // Err — either way it stops blocking, which is the cancellation signal.
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancelled_for_thread = cancelled.clone();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async move {
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(1),
                rx.changed(),
            )
            .await;
            cancelled_for_thread.store(true, Ordering::SeqCst);
        });
    })
    .join()
    .unwrap();

    assert!(
        cancelled.load(Ordering::SeqCst),
        "drive_disconnect must signal the polling-cancel channel"
    );

    std::env::remove_var("MDVIEWER_DRIVE_AUTH_BASE");
    std::env::remove_var("MDVIEWER_DRIVE_TOKEN_BASE");
}

#[test]
#[serial]
fn drive_connect_with_byo_client_id_uses_user_value() {
    // BYO client_id from settings.cloud.drive.custom_oauth_client_id should
    // appear as the `client_id` query parameter in the authorize URL the
    // opener receives. The test opener captures that URL into a shared
    // Arc<Mutex<Option<String>>> for inspection.
    let dir = TempDir::new().unwrap();
    let (base, _captured, _h) = build_oauth_stub();
    std::env::set_var("MDVIEWER_DRIVE_AUTH_BASE", format!("{}/o/oauth2/v2/auth", base));
    std::env::set_var("MDVIEWER_DRIVE_TOKEN_BASE", format!("{}/token", base));

    let mut ws = Workspace::new_for_test(dir.path());
    ws.settings_store()
        .update(|s| {
            s.cloud.drive.custom_oauth_client_id =
                Some("byo-tester.apps.googleusercontent.com".into());
        })
        .unwrap();

    let captured = ws
        .drive_connect_capture_auth_url_for_test()
        .expect("connect");
    let auth_url = captured.expect("authorize URL must have been captured");
    assert!(
        auth_url.contains("client_id=byo-tester.apps.googleusercontent.com"),
        "authorize URL must use BYO client_id, got: {}",
        auth_url
    );

    std::env::remove_var("MDVIEWER_DRIVE_AUTH_BASE");
    std::env::remove_var("MDVIEWER_DRIVE_TOKEN_BASE");
}
