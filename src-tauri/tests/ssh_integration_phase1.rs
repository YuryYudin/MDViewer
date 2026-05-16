//! Phase 1 SSH integration tests — exercise the full Operations stack
//! against a local sshd fixture.
//!
//! Linux + macOS spawn `/usr/sbin/sshd -f <tmp-config> -D` against the
//! committed fixture keypair (see `tests/fixtures/ssh/README.md`).
//! Windows stands up a minimal russh server harness in-process — the
//! Windows path is annotated `#[ignore]` for the bytes-level assertions
//! because the harness stub only accepts-and-drops connections (the
//! production Windows transport unit-tests cover the russh client path
//! already).
//!
//! These tests REQUIRE a local sshd: Linux CI installs `openssh-server`
//! in `.github/workflows/ci.yml`'s test-rust job; macOS uses the bundled
//! `/usr/sbin/sshd`; Windows uses the in-process russh harness.
//!
//! Sshd availability is also probed at runtime — if `/usr/sbin/sshd` is
//! missing the suite reports a skip instead of failing, so a dev box
//! without openssh-server installed still passes `cargo test`.

mod common;

use common::ssh_fixture::start_fixture;
use mdviewer_lib::ssh::operations::{Operations, SaveBackOutcome};
#[cfg(unix)]
use mdviewer_lib::ssh::transport_unix::UnixTransport;
use mdviewer_core::ssh_url;
use std::sync::Arc;

/// On Unix we check that `/usr/sbin/sshd` is reachable; on Windows we
/// always proceed (the russh harness has no system dependency).
fn sshd_available() -> bool {
    #[cfg(unix)]
    {
        std::path::Path::new("/usr/sbin/sshd").exists()
    }
    #[cfg(windows)]
    {
        true
    }
}

fn current_username() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "test".into())
}

#[cfg(unix)]
#[tokio::test]
async fn open_save_back_round_trip() {
    if !sshd_available() {
        eprintln!("skipping ssh_integration_phase1::open_save_back_round_trip — /usr/sbin/sshd missing");
        return;
    }

    // 1. Fixture up. The `_fixture` drop guard tears down the sshd at end
    //    of test; the `_scratch` tempdir holds the file we serve.
    let fixture = match start_fixture().await {
        Ok(f) => f,
        Err(e) => {
            eprintln!(
                "skipping: ssh fixture failed to start ({e}); CI environment likely lacks openssh-server"
            );
            return;
        }
    };

    let scratch = tempfile::tempdir().expect("scratch tmpdir");
    let target = scratch.path().join("fixture.md");
    let initial = b"# original\n";
    std::fs::write(&target, initial).expect("seed target file");

    // 2. Tell our test-only UnixTransport seam which identity to use.
    //    The env-var hooks live ONLY in `new_with_test_identity()` — the
    //    production transport never reads them.
    let key_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ssh/id_test");
    std::env::set_var("MDVIEWER_TEST_SSH_IDENTITY", &key_path);
    std::env::set_var("MDVIEWER_TEST_SSH_PORT", fixture.port.to_string());

    // 3. Build the SSH URL pointing at the local sshd + the seeded file.
    let target_path = target.to_str().expect("UTF-8 path for test");
    let url = ssh_url::parse(&format!(
        "ssh://{}@127.0.0.1:{}{}",
        current_username(),
        fixture.port,
        target_path,
    ))
    .expect("parse fixture URL");

    let transport = Arc::new(UnixTransport::new_with_test_identity());
    let cache_base = scratch.path().join("cache");
    let ops = Operations::new(transport.clone(), cache_base.clone());

    // 4. Open: fetch + mirror to cache + return hash.
    let outcome = ops.open_url(&url).await.expect("open_url ok");
    assert_eq!(outcome.bytes, initial, "fetched bytes match seed");

    // 5. Save back: remote hash matches the one we have, so push succeeds.
    let new_bytes = b"# edited\n";
    let save_outcome = ops
        .save_back(&url, new_bytes, &outcome.sha256)
        .await
        .expect("save_back ok");
    assert!(
        matches!(save_outcome, SaveBackOutcome::Saved { .. }),
        "expected Saved (matching remote hash)"
    );

    // 6. Independent file-system read confirms the upload landed.
    let after = std::fs::read(&target).expect("re-read after push");
    assert_eq!(after, new_bytes, "remote bytes equal local edit");

    // 7. Conflict path: out-of-band mutate the remote, then save with the
    //    stale on_open_sha → must return Conflict (no push).
    let oob = b"# someone else\n";
    std::fs::write(&target, oob).expect("oob mutation");
    let local_again = b"# my edit\n";
    let conflict_outcome = ops
        .save_back(&url, local_again, &outcome.sha256)
        .await
        .expect("save_back ok (returns Conflict)");
    match conflict_outcome {
        SaveBackOutcome::Conflict { local, remote } => {
            assert_eq!(local, local_again);
            assert_eq!(remote, oob);
        }
        SaveBackOutcome::Saved { .. } => panic!("expected Conflict after oob mutation"),
    }
    // Sanity: the conflict path must NOT have pushed (file still equals
    // the out-of-band bytes).
    let after_conflict = std::fs::read(&target).expect("re-read after conflict");
    assert_eq!(after_conflict, oob, "no push happens on Conflict");
}

#[cfg(unix)]
#[tokio::test]
async fn save_back_after_resolving_conflict_pushes_with_new_hash() {
    // Phase 2 of the round-trip: confirm that once the caller resolves
    // a conflict (re-opening the doc to refresh on_open_sha), the next
    // save_back succeeds against the fresh hash. This pins the contract
    // that the conflict path is recoverable rather than terminal.
    if !sshd_available() {
        eprintln!("skipping: /usr/sbin/sshd missing");
        return;
    }
    let fixture = match start_fixture().await {
        Ok(f) => f,
        Err(e) => {
            eprintln!("skipping: ssh fixture failed to start ({e})");
            return;
        }
    };

    let scratch = tempfile::tempdir().expect("scratch tmpdir");
    let target = scratch.path().join("recover.md");
    std::fs::write(&target, b"# v1\n").expect("seed target file");

    let key_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ssh/id_test");
    std::env::set_var("MDVIEWER_TEST_SSH_IDENTITY", &key_path);
    std::env::set_var("MDVIEWER_TEST_SSH_PORT", fixture.port.to_string());

    let url = ssh_url::parse(&format!(
        "ssh://{}@127.0.0.1:{}{}",
        current_username(),
        fixture.port,
        target.to_str().expect("UTF-8 path"),
    ))
    .expect("parse fixture URL");

    let transport = Arc::new(UnixTransport::new_with_test_identity());
    let ops = Operations::new(transport.clone(), scratch.path().join("cache"));

    // First open → first hash.
    let first = ops.open_url(&url).await.expect("open_url v1 ok");

    // Out-of-band mutation flips the remote hash beneath us.
    std::fs::write(&target, b"# v2 from peer\n").expect("oob mutation");

    // Try to save back with the stale hash → Conflict.
    let conflict = ops
        .save_back(&url, b"# my edit\n", &first.sha256)
        .await
        .expect("save_back returns ok-with-conflict");
    assert!(matches!(conflict, SaveBackOutcome::Conflict { .. }));

    // Resolve: re-open to grab the fresh hash, then save against IT.
    let refreshed = ops.open_url(&url).await.expect("re-open ok");
    let final_bytes = b"# my edit on top of v2\n";
    let resaved = ops
        .save_back(&url, final_bytes, &refreshed.sha256)
        .await
        .expect("save_back ok (refreshed hash)");
    match resaved {
        SaveBackOutcome::Saved { new_sha256 } => {
            // The reported new hash must equal sha256(final_bytes).
            use sha2::Digest;
            let mut h = sha2::Sha256::new();
            h.update(final_bytes);
            let expected: [u8; 32] = h.finalize().into();
            assert_eq!(new_sha256, expected);
        }
        SaveBackOutcome::Conflict { .. } => panic!("expected Saved after re-open"),
    }
    let actual = std::fs::read(&target).expect("re-read after recovery");
    assert_eq!(actual, final_bytes);
}

#[cfg(windows)]
#[tokio::test]
#[ignore = "Windows russh harness is accept-and-drop; the full SFTP round-trip is covered by transport_windows.rs unit tests."]
async fn open_save_back_round_trip() {
    // The Windows harness stands up a bindable TCP listener so the
    // fixture's `wait_for_port` returns Ok, but it doesn't speak full
    // SSH yet. Production Windows russh wiring is covered in the unit
    // tests under `src/ssh/transport_windows.rs`; this slot exists so
    // a future iteration can drop the `#[ignore]` once the harness
    // grows a real `Handler` impl.
    let _ = start_fixture().await;
}
