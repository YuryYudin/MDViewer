//! Integration tests for the keyring/vault-key derivation in `drive::keyring`.
//!
//! The vault key feeds Stronghold (which holds the OAuth refresh token at
//! rest). These tests pin three behavioural guarantees:
//!
//! 1. With a working keyring backend, the derived key is stable across reads
//!    (so a relaunch sees the same Stronghold ciphertext).
//! 2. When no keyring is available, the code path emits a static-fallback
//!    key — explicitly obfuscation, not encryption — and we observe that the
//!    fallback ran (so the warning surface is wired up).
//! 3. Two independent fresh keyring backends mint *different* random salts
//!    (confirms the salt is randomly generated, not a hard-coded constant).

use mdviewer_lib::drive::keyring::{vault_key_for_test, KeyringBackend};

#[test]
fn keyring_path_returns_stable_32_byte_key() {
    // Same backend, two reads → identical key.
    let backend = KeyringBackend::in_memory();
    let k1 = vault_key_for_test(&backend).unwrap();
    let k2 = vault_key_for_test(&backend).unwrap();
    assert_eq!(k1, k2, "keyring-derived vault key must be stable");
    assert_eq!(k1.len(), 32);
}

#[test]
fn keyring_unavailable_falls_back_with_warning() {
    let backend = KeyringBackend::failing(); // simulates no OS keyring
    let k = vault_key_for_test(&backend).expect("fallback path must yield a key");
    assert_eq!(k.len(), 32);
    // The warning is structural — we test the code path exists, not the log
    // line itself. tracing-test could assert the log; we keep it simple.
    assert!(backend.fallback_was_used());
}

#[test]
fn fresh_keyring_mints_new_random_salt() {
    let b1 = KeyringBackend::in_memory();
    let b2 = KeyringBackend::in_memory();
    let k1 = vault_key_for_test(&b1).unwrap();
    let k2 = vault_key_for_test(&b2).unwrap();
    assert_ne!(k1, k2, "two independent backends must produce different salts");
}
