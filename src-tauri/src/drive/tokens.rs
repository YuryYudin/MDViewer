//! Refresh-token persistence for the Drive OAuth flow.
//!
//! Two key design points:
//!
//! 1. Only the **refresh token** lives at rest — access tokens expire in
//!    ~1 hour and stay in `DriveApi`'s in-memory mutex. Persisting an access
//!    token would gain nothing and lengthen the window an attacker could
//!    abuse a leaked snapshot.
//!
//! 2. **Production runs through the Tauri Stronghold plugin.** The plugin is
//!    registered in `main.rs` and IPC handlers will call into the plugin's
//!    `save` / `load` APIs via `app.state::<StrongholdCollection>()`. That
//!    surface needs a fully-realized `tauri::AppHandle` and a real Stronghold
//!    snapshot file — neither is convenient to construct from a unit test.
//!    So this module exposes a thin in-process facade (`TokenStore` +
//!    `save_refresh_token` / `load_refresh_token`) backed by a TempDir-scoped
//!    on-disk file with XOR-against-the-key obfuscation, exercised by
//!    `tests/drive_tokens.rs`. Production code can swap the body of the
//!    helpers (or wrap them in an enum with a `Stronghold` variant) once the
//!    IPC layer is wired — the public function signatures are the contract
//!    the rest of the Drive code couples to.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Test-friendly facade. The production registration sits in `main.rs` (see
/// `tauri_plugin_stronghold::Builder::new(...)`); this struct is what the
/// integration tests construct directly.
pub struct TokenStore {
    snapshot_path: PathBuf,
    key: [u8; 32],
}

impl TokenStore {
    /// Test seam — open a snapshot file at `snapshot_path` with a known key.
    /// Production never calls this directly: it uses the Stronghold plugin
    /// state managed by Tauri.
    ///
    /// Returns `io::Result` so future implementations (e.g. a real Stronghold
    /// open) can surface I/O failures without changing the call sites in the
    /// test harness.
    pub fn open_for_test(snapshot_path: PathBuf, key: &[u8; 32]) -> std::io::Result<Self> {
        Ok(Self {
            snapshot_path,
            key: *key,
        })
    }

    pub(crate) fn snapshot(&self) -> &Path {
        &self.snapshot_path
    }

    pub(crate) fn key(&self) -> &[u8; 32] {
        &self.key
    }
}

/// Persist `token` under `email` so a later `load_refresh_token` returns it.
/// Overwrites any previously stored token for the same email.
pub fn save_refresh_token(
    store: &TokenStore,
    email: &str,
    token: &str,
) -> std::io::Result<()> {
    // Read-modify-write the JSON map. The file is small (one entry per
    // signed-in account), so reading + rewriting on every save is fine.
    let mut map = read_map(store)?;
    map.insert(email.to_string(), token.to_string());
    write_map(store, &map)
}

/// Load the refresh token for `email`, or `Ok(None)` if no token has been
/// saved for that account. Returns `Err` only on malformed snapshot bytes
/// or a real I/O error reading the snapshot file.
pub fn load_refresh_token(
    store: &TokenStore,
    email: &str,
) -> std::io::Result<Option<String>> {
    let map = read_map(store)?;
    Ok(map.get(email).cloned())
}

fn read_map(store: &TokenStore) -> std::io::Result<HashMap<String, String>> {
    if !store.snapshot().exists() {
        return Ok(HashMap::new());
    }
    let bytes = std::fs::read(store.snapshot())?;
    if bytes.is_empty() {
        return Ok(HashMap::new());
    }
    // Test harness uses XOR against a 32-byte key — explicitly obfuscation,
    // not encryption. Production swaps this for the Stronghold call which
    // provides authenticated encryption.
    let decoded: Vec<u8> = bytes
        .iter()
        .enumerate()
        .map(|(i, b)| b ^ store.key()[i % 32])
        .collect();
    serde_json::from_slice(&decoded)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

fn write_map(
    store: &TokenStore,
    map: &HashMap<String, String>,
) -> std::io::Result<()> {
    let json = serde_json::to_vec(map)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let encoded: Vec<u8> = json
        .iter()
        .enumerate()
        .map(|(i, b)| b ^ store.key()[i % 32])
        .collect();
    if let Some(parent) = store.snapshot().parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(store.snapshot(), encoded)
}
