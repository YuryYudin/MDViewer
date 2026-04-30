//! Vault-key derivation for the Stronghold OAuth refresh-token store.
//!
//! Strategy (per design): a per-machine random salt lives in the OS keyring
//! (Keychain / Credential Locker / Secret Service). The Stronghold vault key
//! is derived from the salt via SHA-256. When the keyring is unavailable, we
//! fall back to a static obfuscation key and log a warning — explicitly
//! documented as obfuscation only, not encryption.
//!
//! Module surface kept tight on purpose:
//! - `vault_key()` is the only production entry point.
//! - `vault_key_for_test` + `KeyringBackend` exist solely so the integration
//!   test crate can drive the derivation through an in-memory or failing
//!   backend without touching the host's real keyring.
//! - The salt itself never leaves the module — only the derived `[u8; 32]`.

use base64::Engine;
use sha2::{Digest, Sha256};
use std::sync::Mutex;

const SERVICE: &str = "com.mdviewer.app";
const SALT_KEY: &str = "drive_vault_salt";
const SALT_LEN: usize = 32;
/// Static obfuscation key used only when no OS keyring is reachable. This
/// is NOT encryption — it merely prevents casual on-disk inspection of the
/// Stronghold blob. The accompanying `tracing::warn!` makes the degradation
/// visible to operators.
const STATIC_FALLBACK: &[u8; 32] = b"mdviewer-static-fallback-32bytes";

/// Trait abstraction over the OS keyring so tests can swap in an in-memory
/// or always-failing implementation. Synchronous on purpose — the real
/// `keyring::Entry` API is sync, and we want to call this from Stronghold
/// setup without dragging in an async runtime.
pub trait KeyringStore {
    fn get(&self, key: &str) -> Option<String>;
    fn set(&self, key: &str, value: &str) -> Result<(), String>;
}

/// Production backend: routes through the `keyring` crate's `Entry`.
pub struct OsKeyring;

impl KeyringStore for OsKeyring {
    fn get(&self, key: &str) -> Option<String> {
        keyring::Entry::new(SERVICE, key).ok()?.get_password().ok()
    }
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        keyring::Entry::new(SERVICE, key)
            .map_err(|e| e.to_string())?
            .set_password(value)
            .map_err(|e| e.to_string())
    }
}

/// Test backend: in-memory store + a "failing" mode that simulates no OS
/// keyring. `KeyringBackend::set` flips `fallback_used` when the inner
/// store is `None`, giving the test a clean observability hook without an
/// `Any`-style downcast from `derive_from`.
pub struct KeyringBackend {
    store: Mutex<Option<std::collections::HashMap<String, String>>>,
    fallback_used: Mutex<bool>,
}

impl KeyringBackend {
    /// Backend with a working in-memory store. Each instance starts empty,
    /// so the first `vault_key_for_test` call mints a fresh random salt.
    pub fn in_memory() -> Self {
        Self {
            store: Mutex::new(Some(std::collections::HashMap::new())),
            fallback_used: Mutex::new(false),
        }
    }

    /// Backend that simulates an unreachable keyring: every `set` fails and
    /// flips the `fallback_used` flag.
    pub fn failing() -> Self {
        Self {
            store: Mutex::new(None),
            fallback_used: Mutex::new(false),
        }
    }

    pub fn fallback_was_used(&self) -> bool {
        *self.fallback_used.lock().unwrap()
    }
}

impl KeyringStore for KeyringBackend {
    fn get(&self, key: &str) -> Option<String> {
        self.store.lock().unwrap().as_ref()?.get(key).cloned()
    }
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        let mut g = self.store.lock().unwrap();
        match g.as_mut() {
            Some(m) => {
                m.insert(key.into(), value.into());
                Ok(())
            }
            None => {
                *self.fallback_used.lock().unwrap() = true;
                Err("no keyring available".into())
            }
        }
    }
}

/// Public entry point for production code. Stronghold setup calls this
/// once at boot.
pub fn vault_key() -> [u8; 32] {
    derive_from(&OsKeyring)
}

/// Test seam — exported for `tests/drive_keyring.rs`. Returns `Result` so
/// future test cases can assert on error variants without changing the
/// signature.
pub fn vault_key_for_test<S: KeyringStore>(store: &S) -> Result<[u8; 32], String> {
    Ok(derive_from(store))
}

fn derive_from<S: KeyringStore>(store: &S) -> [u8; 32] {
    let salt = match get_or_mint_salt(store) {
        Ok(s) => s,
        Err(_) => {
            tracing::warn!(
                "drive::keyring: no OS keyring available — using static obfuscation key. \
                 OAuth refresh tokens are obfuscated, NOT encrypted. Connect a Secret Service \
                 daemon (Linux) or run on macOS/Windows for encryption at rest."
            );
            return *STATIC_FALLBACK;
        }
    };
    // Domain-separated SHA-256 over the salt: the version tag means we can
    // rotate the derivation without colliding with a previously-stored key.
    let mut hasher = Sha256::new();
    hasher.update(b"mdviewer-drive-vault-v1");
    hasher.update(&salt);
    let out = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&out);
    key
}

fn get_or_mint_salt<S: KeyringStore>(store: &S) -> Result<Vec<u8>, String> {
    if let Some(b64) = store.get(SALT_KEY) {
        return base64::engine::general_purpose::STANDARD
            .decode(&b64)
            .map_err(|e| e.to_string());
    }
    let mut salt = vec![0u8; SALT_LEN];
    getrandom::getrandom(&mut salt).map_err(|e| e.to_string())?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&salt);
    store.set(SALT_KEY, &encoded)?;
    Ok(salt)
}
