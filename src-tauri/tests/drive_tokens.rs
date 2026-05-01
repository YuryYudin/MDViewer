//! Round-trip tests for refresh-token persistence via the `drive::tokens`
//! helper.
//!
//! Production swaps the storage backend for the Tauri Stronghold plugin (which
//! requires a fully-realized `AppHandle` and is therefore impractical to drive
//! from a unit test). This test crate exercises the same `save_refresh_token`
//! / `load_refresh_token` API surface against a TempDir-scoped on-disk store
//! that uses XOR-with-key obfuscation — sufficient to pin the public contract
//! the IPC layer will eventually call into.

use mdviewer_lib::drive::tokens::{load_refresh_token, save_refresh_token, TokenStore};
use tempfile::TempDir;

fn fresh_store(dir: &TempDir) -> TokenStore {
    // Use a 32-byte deterministic key for testing — production derives the key
    // via `drive::keyring::vault_key()` and feeds it to Stronghold.
    let key = [0u8; 32];
    TokenStore::open_for_test(dir.path().join("vault.stronghold"), &key)
        .expect("test stronghold opens")
}

#[test]
fn save_and_load_refresh_token_round_trips() {
    let dir = TempDir::new().unwrap();
    let store = fresh_store(&dir);
    save_refresh_token(&store, "alice@example.com", "refresh-tok-abc123")
        .expect("save");
    let loaded = load_refresh_token(&store, "alice@example.com")
        .expect("load returns Result")
        .expect("token is present");
    assert_eq!(loaded, "refresh-tok-abc123");
}

#[test]
fn load_missing_token_returns_none() {
    let dir = TempDir::new().unwrap();
    let store = fresh_store(&dir);
    let loaded = load_refresh_token(&store, "nobody@example.com")
        .expect("load returns Result");
    assert!(loaded.is_none(), "missing token must yield None");
}

#[test]
fn save_overwrites_existing_token() {
    let dir = TempDir::new().unwrap();
    let store = fresh_store(&dir);
    save_refresh_token(&store, "alice@example.com", "first").unwrap();
    save_refresh_token(&store, "alice@example.com", "second").unwrap();
    let loaded = load_refresh_token(&store, "alice@example.com").unwrap().unwrap();
    assert_eq!(loaded, "second", "save must overwrite");
}
