//! High-level SSH operations: open_url, save_back, list.
//!
//! Wraps an `SshTransport` impl with the bookkeeping that the rest of
//! the app needs: per-platform cache mirror, conflict-detection hash
//! tracking, and CRDT-merged sidecar push.

use super::transport::{SshTransport, TransportError};
use mdviewer_core::ssh_url::SshUrl;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Compute the local cache path for a remote URL.
///
/// Resolution: `<base>/<host>_<port>_<user>/<path with reserved-char escaping>`.
/// IPv6 `:` in host literals → `-`. Reserved Windows characters in the path
/// (`< > : " | ? *`, also `\` which we never produce ourselves) → percent-encoded.
pub fn cache_path_for_url(base: &Path, url: &SshUrl) -> PathBuf {
    let user_part = url.user.as_deref().unwrap_or("");
    let host_sanitized = url.host.replace(':', "-");
    let key = format!("{}_{}_{}", host_sanitized, url.port, user_part);
    let mut p = base.join(key);
    // Strip the leading slash, then translate forward-slash → platform
    // separator (PathBuf::push handles that on Windows automatically when
    // we push individual components).
    let rel = url.path.trim_start_matches('/');
    for seg in rel.split('/') {
        p.push(escape_segment(seg));
    }
    p
}

fn escape_segment(seg: &str) -> String {
    let mut out = String::with_capacity(seg.len());
    for c in seg.chars() {
        match c {
            '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\\' => {
                out.push_str(&format!("%{:02X}", c as u32));
            }
            _ => out.push(c),
        }
    }
    out
}

/// Bytes + hash + on-disk cache mirror produced by `open_url`. The caller
/// (workspace open-tab path) stores `sha256` alongside the tab state so a
/// later `save_back` can compare against it for conflict detection.
pub struct OpenOutcome {
    pub bytes: Vec<u8>,
    pub sha256: [u8; 32],
    pub cache_path: PathBuf,
}

/// Outcome of a `save_back` attempt. `Saved` carries the new on-disk hash
/// (which the caller stores as the new `on_open_sha` for subsequent
/// saves). `Conflict` carries both byte buffers so the Conflict modal can
/// render side-by-side; the caller surfaces the modal and re-tries the
/// save after the user resolves.
pub enum SaveBackOutcome {
    Saved { new_sha256: [u8; 32] },
    Conflict { local: Vec<u8>, remote: Vec<u8> },
}

pub struct Operations {
    transport: Arc<dyn SshTransport>,
    cache_base: PathBuf,
}

impl Operations {
    pub fn new(transport: Arc<dyn SshTransport>, cache_base: PathBuf) -> Self {
        Self {
            transport,
            cache_base,
        }
    }

    /// The cache-mirror base directory. Callers that need to predict where a
    /// given URL would land WITHOUT fetching (e.g. the `-w` new-window
    /// dispatch's already-open one-owner check) pair this with
    /// `cache_path_for_url(ops.cache_base(), &url)`.
    pub fn cache_base(&self) -> &Path {
        &self.cache_base
    }

    /// Resolve the cache base from `MDVIEWER_REMOTE_CACHE_DIR` (override)
    /// or the Tauri-provided per-platform cache dir. Mirrors the env-var
    /// override pattern from `MDVIEWER_DATA_DIR` at `main.rs:1167-1169`.
    pub fn resolve_cache_base(tauri_cache_dir: PathBuf) -> PathBuf {
        if let Ok(env_override) = std::env::var("MDVIEWER_REMOTE_CACHE_DIR") {
            if !env_override.is_empty() {
                return PathBuf::from(env_override);
            }
        }
        tauri_cache_dir.join("remote")
    }

    /// Forward a directory listing to the underlying transport.
    ///
    /// `Operations` keeps `transport` private so callers can't poke at
    /// it directly; the higher-level methods (`open_url`, `save_back`,
    /// `save_sidecar`) all go through it. `list_dir` is symmetric — the
    /// B1 IPC handler needs the entries verbatim (no caching, no hash
    /// bookkeeping) so this is a pass-through. Errors propagate the
    /// transport's `Display` text unchanged.
    pub async fn list_dir(
        &self,
        url: &SshUrl,
    ) -> Result<Vec<super::transport::DirEntry>, TransportError> {
        self.transport.list_dir(url).await
    }

    /// Fetch the remote bytes, hash them, mirror to the cache path, and
    /// return all three to the caller. The cache mirror lets the watcher
    /// observe local edits via a real file path; the hash is what
    /// `save_back` compares against to detect remote drift.
    pub async fn open_url(&self, url: &SshUrl) -> Result<OpenOutcome, TransportError> {
        let bytes = self.transport.fetch(url).await?;
        let sha256 = self.transport.sha256(&bytes);
        let cache_path = cache_path_for_url(&self.cache_base, url);
        if let Some(parent) = cache_path.parent() {
            std::fs::create_dir_all(parent).map_err(TransportError::Io)?;
        }
        std::fs::write(&cache_path, &bytes).map_err(TransportError::Io)?;
        Ok(OpenOutcome {
            bytes,
            sha256,
            cache_path,
        })
    }

    /// Save back with pre-save recheck: fetch remote bytes, hash them,
    /// compare against `on_open_sha`. Returns `Conflict` on mismatch
    /// (the caller surfaces the existing Conflict modal); otherwise
    /// pushes `local_bytes` and returns `Saved` with the new hash.
    pub async fn save_back(
        &self,
        url: &SshUrl,
        local_bytes: &[u8],
        on_open_sha: &[u8; 32],
    ) -> Result<SaveBackOutcome, TransportError> {
        let remote_now = self.transport.fetch(url).await?;
        let remote_sha = self.transport.sha256(&remote_now);
        if &remote_sha != on_open_sha {
            return Ok(SaveBackOutcome::Conflict {
                local: local_bytes.to_vec(),
                remote: remote_now,
            });
        }
        self.transport.push(url, local_bytes).await?;
        // The saved hash is now the hash of the bytes we just pushed —
        // assuming successful push the remote contents equal local_bytes.
        let mut h = Sha256::new();
        h.update(local_bytes);
        let new_sha: [u8; 32] = h.finalize().into();
        Ok(SaveBackOutcome::Saved { new_sha256: new_sha })
    }

    /// Push a CRDT-merged sidecar. Per Decision 7: fetch the remote
    /// sidecar bytes, merge them with the local sidecar via
    /// `mdviewer_core::comments::merge_stores_bytes`, then push the
    /// merged result. If the merge yields no changes versus the remote,
    /// skip the push.
    ///
    /// Error handling per Decision 5: only treat an explicit "remote
    /// sidecar does not exist yet" stderr as empty bytes (fresh save —
    /// first comment on a freshly-opened doc). Every other
    /// `TransportError` (auth failure, network outage, permission
    /// denied, IO error) propagates so the caller can surface the
    /// verbatim ssh stderr in a toast rather than silently overwriting
    /// live remote comments with the local-only view.
    pub async fn save_sidecar(
        &self,
        sidecar_url: &SshUrl,
        local_sidecar: &[u8],
    ) -> Result<(), TransportError> {
        let remote = match self.transport.fetch(sidecar_url).await {
            Ok(bytes) => bytes,
            Err(TransportError::Ssh { ref stderr, .. })
                if stderr.contains("No such file") || stderr.contains("does not exist") =>
            {
                Vec::new()
            }
            Err(e) => return Err(e),
        };
        // The sidecar wire/disk format is the v2 JSON envelope (base64-wrapped
        // Automerge) that `mdviewer_core::sidecar::{save,load}_sidecar_bytes`
        // produce — the same bytes the local `.comments.json` holds — NOT raw
        // Automerge. Decode both sides to stores, CRDT-merge, re-encode. An
        // empty remote (no sidecar yet) decodes to an empty store.
        let local_store =
            mdviewer_core::sidecar::load_sidecar_bytes(local_sidecar).map_err(sidecar_io_err)?;
        let remote_store =
            mdviewer_core::sidecar::load_sidecar_bytes(&remote).map_err(sidecar_io_err)?;
        let merged = mdviewer_core::comments::merge_stores(&local_store, &remote_store);
        // Skip the push when the merge produced no semantic change vs the
        // remote — compare thread content (ignoring Automerge actor-id churn,
        // which a byte-level check would trip over).
        if remote_store.list_threads() == merged.list_threads() {
            return Ok(());
        }
        let merged_bytes =
            mdviewer_core::sidecar::save_sidecar_bytes(&merged).map_err(sidecar_io_err)?;
        self.transport.push(sidecar_url, &merged_bytes).await
    }

    /// Open-time counterpart to [`save_sidecar`](Self::save_sidecar): fetch the
    /// remote comment sidecar (if any), CRDT-merge it with whatever sidecar is
    /// already in the local cache, and write the merged result back to
    /// `cache_sidecar_path` so the opened tab's comment load (which reads the
    /// cache mirror) reflects remote + local comments.
    ///
    /// A missing remote sidecar is a no-op: the local cache sidecar (if any) is
    /// left untouched. Like `save_sidecar`, only an explicit "does not exist"
    /// stderr is treated as "no remote sidecar yet"; every other transport
    /// error propagates so the caller can decide whether to surface it.
    pub async fn pull_sidecar(
        &self,
        sidecar_url: &SshUrl,
        cache_sidecar_path: &Path,
    ) -> Result<(), TransportError> {
        let remote = match self.transport.fetch(sidecar_url).await {
            Ok(bytes) => bytes,
            Err(TransportError::Ssh { ref stderr, .. })
                if stderr.contains("No such file") || stderr.contains("does not exist") =>
            {
                return Ok(());
            }
            Err(e) => return Err(e),
        };
        if remote.is_empty() {
            return Ok(());
        }
        // Same v2-envelope format as `save_sidecar`: decode remote + local-cache
        // sidecars to stores, CRDT-merge, and write the merged envelope back to
        // the cache so the comment load reflects remote + local.
        let remote_store =
            mdviewer_core::sidecar::load_sidecar_bytes(&remote).map_err(sidecar_io_err)?;
        let local = std::fs::read(cache_sidecar_path).unwrap_or_default();
        let local_store =
            mdviewer_core::sidecar::load_sidecar_bytes(&local).map_err(sidecar_io_err)?;
        let merged = mdviewer_core::comments::merge_stores(&local_store, &remote_store);
        let merged_bytes =
            mdviewer_core::sidecar::save_sidecar_bytes(&merged).map_err(sidecar_io_err)?;
        if let Some(parent) = cache_sidecar_path.parent() {
            std::fs::create_dir_all(parent).map_err(TransportError::Io)?;
        }
        std::fs::write(cache_sidecar_path, &merged_bytes).map_err(TransportError::Io)?;
        Ok(())
    }
}

/// Map a core sidecar/merge error into a `TransportError::Io` so the SSH
/// sidecar paths can use `?` on `anyhow::Result` returns.
fn sidecar_io_err(e: impl std::fmt::Display) -> TransportError {
    TransportError::Io(std::io::Error::new(
        std::io::ErrorKind::Other,
        e.to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use std::sync::Mutex;

    #[test]
    fn cache_path_basic() {
        let base = Path::new("/tmp/mdviewer-cache/remote");
        let url = SshUrl {
            user: Some("alice".into()),
            host: "host.example".into(),
            port: 22,
            path: "/notes/file.md".into(),
        };
        let p = cache_path_for_url(base, &url);
        assert_eq!(
            p,
            Path::new("/tmp/mdviewer-cache/remote/host.example_22_alice/notes/file.md"),
        );
    }

    #[test]
    fn cache_path_ipv6_colon_becomes_dash() {
        let base = Path::new("/cache");
        let url = SshUrl {
            user: None,
            host: "2001:db8::1".into(),
            port: 2222,
            path: "/f.md".into(),
        };
        let p = cache_path_for_url(base, &url);
        assert_eq!(p, Path::new("/cache/2001-db8--1_2222_/f.md"));
    }

    #[test]
    fn cache_path_escapes_reserved_windows_chars() {
        let base = Path::new("/cache");
        let url = SshUrl {
            user: None,
            host: "h".into(),
            port: 22,
            path: "/a:b/c?d.md".into(),
        };
        let p = cache_path_for_url(base, &url);
        // : → %3A, ? → %3F
        assert_eq!(p, Path::new("/cache/h_22_/a%3Ab/c%3Fd.md"));
    }

    #[test]
    #[serial]
    fn resolve_cache_base_respects_env_var() {
        // `#[serial]` keeps this from racing with
        // `resolve_cache_base_falls_back_to_tauri_dir_when_unset` — both
        // mutate the same `MDVIEWER_REMOTE_CACHE_DIR` global, and cargo
        // runs tests within a binary in parallel by default.
        let key = "MDVIEWER_REMOTE_CACHE_DIR";
        let prev = std::env::var(key).ok();
        std::env::set_var(key, "/tmp/override-cache");
        let resolved = Operations::resolve_cache_base(PathBuf::from("/should/not/be/used"));
        assert_eq!(resolved, PathBuf::from("/tmp/override-cache"));
        // Empty env value falls back to the Tauri-provided dir.
        std::env::set_var(key, "");
        let resolved_empty = Operations::resolve_cache_base(PathBuf::from("/from/tauri"));
        assert_eq!(resolved_empty, PathBuf::from("/from/tauri/remote"));
        match prev {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
    }

    #[test]
    #[serial]
    fn resolve_cache_base_falls_back_to_tauri_dir_when_unset() {
        let key = "MDVIEWER_REMOTE_CACHE_DIR";
        let prev = std::env::var(key).ok();
        std::env::remove_var(key);
        let resolved = Operations::resolve_cache_base(PathBuf::from("/tauri/cache"));
        assert_eq!(resolved, PathBuf::from("/tauri/cache/remote"));
        if let Some(v) = prev {
            std::env::set_var(key, v);
        }
    }

    // === Transport fakes for open_url / save_back / save_sidecar coverage ===

    struct FakeTransport {
        // (responses to consecutive fetch() calls, in order)
        fetch_responses: Mutex<Vec<Result<Vec<u8>, TransportError>>>,
        // (records every push call's bytes for assertion)
        pushed: Mutex<Vec<Vec<u8>>>,
    }

    impl FakeTransport {
        fn new(fetch_responses: Vec<Result<Vec<u8>, TransportError>>) -> Self {
            Self {
                fetch_responses: Mutex::new(fetch_responses),
                pushed: Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait::async_trait]
    impl SshTransport for FakeTransport {
        async fn fetch(&self, _url: &SshUrl) -> Result<Vec<u8>, TransportError> {
            let mut q = self.fetch_responses.lock().unwrap();
            if q.is_empty() {
                return Err(TransportError::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "fake fetch queue exhausted",
                )));
            }
            q.remove(0)
        }
        async fn push(
            &self,
            _url: &SshUrl,
            bytes: &[u8],
        ) -> Result<(), TransportError> {
            self.pushed.lock().unwrap().push(bytes.to_vec());
            Ok(())
        }
        async fn list_dir(
            &self,
            _url: &SshUrl,
        ) -> Result<Vec<super::super::transport::DirEntry>, TransportError> {
            Ok(vec![])
        }
        async fn stat(
            &self,
            _url: &SshUrl,
        ) -> Result<super::super::transport::SshStat, TransportError> {
            Ok(super::super::transport::SshStat {
                size: 0,
                is_dir: false,
                mtime: None,
            })
        }
    }

    fn sample_url() -> SshUrl {
        SshUrl {
            user: Some("u".into()),
            host: "h".into(),
            port: 22,
            path: "/x.md".into(),
        }
    }

    fn sha256_of(bytes: &[u8]) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(bytes);
        h.finalize().into()
    }

    #[tokio::test]
    async fn open_url_writes_cache_mirror_and_returns_hash() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeTransport::new(vec![Ok(b"hello world".to_vec())]));
        let ops = Operations::new(fake.clone(), tmp.path().to_path_buf());
        let url = sample_url();
        let out = ops.open_url(&url).await.expect("open ok");
        assert_eq!(out.bytes, b"hello world");
        assert_eq!(out.sha256, sha256_of(b"hello world"));
        let written = std::fs::read(&out.cache_path).expect("cache file exists");
        assert_eq!(written, b"hello world");
        // The cache path lives under base + key.
        assert!(out
            .cache_path
            .starts_with(tmp.path().join("h_22_u")));
    }

    #[tokio::test]
    async fn save_back_pushes_when_remote_hash_matches() {
        let original = b"original".to_vec();
        let fake = Arc::new(FakeTransport::new(vec![Ok(original.clone())]));
        let tmp = tempfile::tempdir().unwrap();
        let ops = Operations::new(fake.clone(), tmp.path().to_path_buf());
        let url = sample_url();
        let on_open = sha256_of(&original);
        let outcome = ops
            .save_back(&url, b"new local bytes", &on_open)
            .await
            .expect("save_back ok");
        match outcome {
            SaveBackOutcome::Saved { new_sha256 } => {
                assert_eq!(new_sha256, sha256_of(b"new local bytes"));
            }
            SaveBackOutcome::Conflict { .. } => panic!("expected Saved"),
        }
        let pushed = fake.pushed.lock().unwrap();
        assert_eq!(pushed.len(), 1);
        assert_eq!(pushed[0], b"new local bytes");
    }

    #[tokio::test]
    async fn save_back_returns_conflict_when_remote_drifts() {
        // The remote returns NEW bytes; on_open_sha is over the ORIGINAL.
        let fake = Arc::new(FakeTransport::new(vec![Ok(b"new remote".to_vec())]));
        let tmp = tempfile::tempdir().unwrap();
        let ops = Operations::new(fake.clone(), tmp.path().to_path_buf());
        let url = sample_url();
        let on_open = sha256_of(b"original");
        let outcome = ops
            .save_back(&url, b"local edits", &on_open)
            .await
            .expect("save_back ok");
        match outcome {
            SaveBackOutcome::Conflict { local, remote } => {
                assert_eq!(local, b"local edits");
                assert_eq!(remote, b"new remote");
            }
            SaveBackOutcome::Saved { .. } => panic!("expected Conflict"),
        }
        // No push happened — pre-save recheck rejected.
        assert!(fake.pushed.lock().unwrap().is_empty());
    }

    // === Helpers for the save_sidecar tests ===

    fn sidecar_url() -> SshUrl {
        SshUrl {
            user: None,
            host: "h".into(),
            port: 22,
            path: "/x.md.comments.json".into(),
        }
    }

    fn fixture_anchor(exact: &str) -> mdviewer_core::anchor::Anchor {
        mdviewer_core::anchor::Anchor {
            start: 0,
            end: exact.len(),
            exact: exact.into(),
            prefix: String::new(),
            suffix: String::new(),
        }
    }

    fn store_with_thread(
        thread_id: &str,
        comment_id: &str,
        anchor_text: &str,
    ) -> Vec<u8> {
        use mdviewer_core::comments::{Comment, CommentsStore, Thread};
        let thread = Thread {
            id: thread_id.into(),
            anchor: fixture_anchor(anchor_text),
            comments: vec![Comment {
                id: comment_id.into(),
                author: "alice".into(),
                color: "#ff0000".into(),
                body: "hi".into(),
                created_at: "2026-05-15T00:00:00Z".into(),
                ..Default::default()
            }],
            resolved: false,
            resolved_at: None,
            resolved_by: None,
        };
        // Produce the on-disk v2-envelope format (what save/pull_sidecar
        // consume), not raw Automerge.
        mdviewer_core::sidecar::save_sidecar_bytes(&CommentsStore::from_threads(vec![thread]))
            .unwrap()
    }

    #[tokio::test]
    async fn save_sidecar_pushes_merged_when_local_diverges_from_remote() {
        use mdviewer_core::sidecar::load_sidecar_bytes;
        // Local has thread A; remote has thread B. The CRDT merge unions
        // both (distinct ids never conflict — see comments.rs's
        // store_to_automerge rationale). We assert:
        //   1. exactly one push happens, and
        //   2. the pushed bytes round-trip to a store containing BOTH
        //      threads (so the merge actually ran end-to-end, not just
        //      a short-circuit re-push of local bytes).
        let local_bytes = store_with_thread("t-A", "c-A", "alpha");
        let remote_bytes = store_with_thread("t-B", "c-B", "beta");
        let fake = Arc::new(FakeTransport::new(vec![Ok(remote_bytes.clone())]));
        let tmp = tempfile::tempdir().unwrap();
        let ops = Operations::new(fake.clone(), tmp.path().to_path_buf());

        ops.save_sidecar(&sidecar_url(), &local_bytes)
            .await
            .expect("save_sidecar ok");

        let pushed = fake.pushed.lock().unwrap();
        assert_eq!(pushed.len(), 1, "expected exactly one push");
        let pushed_store = load_sidecar_bytes(&pushed[0]).expect("decode pushed");
        let ids: Vec<&str> = pushed_store
            .list_threads()
            .iter()
            .map(|t| t.id.as_str())
            .collect();
        assert!(ids.contains(&"t-A"), "thread A missing from merged push: {:?}", ids);
        assert!(ids.contains(&"t-B"), "thread B missing from merged push: {:?}", ids);
    }

    #[tokio::test]
    async fn save_sidecar_skips_push_when_local_equals_remote() {
        // Symmetric setup: local and remote carry the same single thread.
        // The merge produces a store with the same thread content; the
        // semantic-equality short-circuit fires and no push happens.
        // (Byte equality wouldn't fire here — Automerge actor ids mint
        // fresh on every `merge_stores_bytes` call — which is why
        // save_sidecar compares deserialized thread lists, not bytes.)
        let local = store_with_thread("t-S", "c-S", "same");
        let remote = store_with_thread("t-S", "c-S", "same");
        let fake = Arc::new(FakeTransport::new(vec![Ok(remote.clone())]));
        let tmp = tempfile::tempdir().unwrap();
        let ops = Operations::new(fake.clone(), tmp.path().to_path_buf());

        ops.save_sidecar(&sidecar_url(), &local)
            .await
            .expect("save_sidecar ok");

        assert_eq!(
            fake.pushed.lock().unwrap().len(),
            0,
            "no push expected when local == remote semantically",
        );
    }

    #[tokio::test]
    async fn save_sidecar_treats_not_found_stderr_as_empty_remote() {
        // Decision 5 carve-out: the remote sidecar doesn't exist yet
        // (first comment on a freshly-opened doc). The Unix transport
        // surfaces "No such file or directory" in the ssh stderr;
        // save_sidecar must treat this as an empty remote and proceed
        // to push the local bytes verbatim.
        let local_bytes = store_with_thread("t-A", "c-A", "alpha");
        let fake = Arc::new(FakeTransport::new(vec![Err(TransportError::Ssh {
            code: Some(1),
            stderr: "cat: /remote/x.md.comments.json: No such file or directory\n".into(),
        })]));
        let tmp = tempfile::tempdir().unwrap();
        let ops = Operations::new(fake.clone(), tmp.path().to_path_buf());

        ops.save_sidecar(&sidecar_url(), &local_bytes)
            .await
            .expect("not-found stderr should be treated as empty, not an error");

        let pushed = fake.pushed.lock().unwrap();
        assert_eq!(pushed.len(), 1, "expected push to proceed against empty remote");
    }

    #[tokio::test]
    async fn save_sidecar_propagates_non_not_found_transport_errors() {
        // Counterpart to the carve-out: an auth/permission/network
        // failure must surface so the caller (Tauri command → frontend)
        // can render a toast with the verbatim stderr. The previous
        // implementation's blanket `unwrap_or_default()` would have
        // silently treated this as "remote has no sidecar" and
        // overwritten live remote comments with the local-only view.
        let local_bytes = store_with_thread("t-A", "c-A", "alpha");
        let fake = Arc::new(FakeTransport::new(vec![Err(TransportError::Ssh {
            code: Some(255),
            stderr: "Permission denied (publickey).\n".into(),
        })]));
        let tmp = tempfile::tempdir().unwrap();
        let ops = Operations::new(fake.clone(), tmp.path().to_path_buf());

        let err = ops
            .save_sidecar(&sidecar_url(), &local_bytes)
            .await
            .expect_err("auth failures must propagate");
        match err {
            TransportError::Ssh { stderr, .. } => {
                assert!(
                    stderr.contains("Permission denied"),
                    "expected verbatim stderr, got: {stderr}",
                );
            }
            other => panic!("expected TransportError::Ssh, got {other:?}"),
        }
        // No push happened — we never proceeded past the fetch.
        assert_eq!(fake.pushed.lock().unwrap().len(), 0);
    }
}
