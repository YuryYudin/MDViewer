//! Drive file download (alt=media) + upload (multipart with If-Match).
//!
//! Cache lives at `<config_dir>/drive/<file_id>/<name>` where `config_dir`
//! is resolved by the caller via Tauri's `app_cache_dir` API
//! (macOS: `~/Library/Caches/<bundle>`; Linux: `$XDG_CACHE_HOME`;
//! Windows: `%LOCALAPPDATA%\<bundle>\Caches`). Tests pass a tempdir.
//!
//! The HTTP `ETag` header captured from the download response — *not* the
//! `etag` field on the JSON file resource — is persisted in
//! `drive_cache_meta/<file_id>.json` so the next upload can send `If-Match`
//! and rely on Drive returning 412 if the remote moved out from under us.
//! On a successful upload we refresh `cache_meta.etag` with the new value
//! Drive returns, otherwise the next `If-Match` round would fail with 412
//! against our own write.
//!
//! Downloads write to `<name>.part` first and atomically rename on success,
//! so a kill-9 mid-fetch leaves the previous cached body intact rather than
//! a half-written file.

use crate::drive::api::DriveApi;
use crate::drive::cache::{save_cache_meta, CacheMeta};
use crate::drive::DriveError;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Result of a successful `download_to_cache` call. The caller typically
/// loads `cache_path` into the editor and stashes `etag` for a future
/// upload's `If-Match`.
pub struct DownloadOutcome {
    pub cache_path: PathBuf,
    pub etag: String,
}

/// Result of a successful `upload_with_etag` call. The variant carries the
/// fresh ETag so the caller can immediately refresh its cached metadata
/// — failing to do so would make the next `If-Match` round fail with 412
/// against our own write.
pub enum UploadOutcome {
    Updated { new_etag: String },
}

/// Download `file_id` to `<config_dir>/drive/<file_id>/<name>`, capture the
/// HTTP `ETag` header for future precondition checks, and persist a
/// `CacheMeta` entry. Writes the body to a `.part` sibling first so a crash
/// mid-fetch can't corrupt the cache.
pub fn download_to_cache(
    api: &DriveApi,
    config_dir: &Path,
    file_id: &str,
    name: &str,
) -> Result<DownloadOutcome, DriveError> {
    let cache_dir = cache_dir_for(config_dir, file_id);
    std::fs::create_dir_all(&cache_dir).map_err(|e| DriveError::Api(e.to_string()))?;
    let final_path = cache_dir.join(name);
    let part = cache_dir.join(format!("{}.part", name));

    let resp = api.raw_get_media(file_id)?;
    let etag = resp
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| DriveError::Api("missing ETag on download".into()))?
        .to_string();
    let bytes = resp
        .bytes()
        .map_err(|e| DriveError::Network(e.to_string()))?;
    std::fs::write(&part, &bytes).map_err(|e| DriveError::Api(e.to_string()))?;
    std::fs::rename(&part, &final_path).map_err(|e| DriveError::Api(e.to_string()))?;

    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let content_sha256 = format!("{:x}", hasher.finalize());

    save_cache_meta(
        config_dir,
        file_id,
        &CacheMeta {
            etag: etag.clone(),
            last_fetched: now_rfc3339(),
            content_sha256,
        },
    )
    .map_err(|e| DriveError::Api(e.to_string()))?;

    Ok(DownloadOutcome {
        cache_path: final_path,
        etag,
    })
}

/// PATCH `body` to Drive with `If-Match: etag`. A 412 surfaces as
/// `DriveError::PreconditionFailed` (mapped by `send_with_retry`); the
/// caller is responsible for showing a conflict banner. On success the
/// new ETag is returned so the caller can update `cache_meta.etag` before
/// the next round.
pub fn upload_with_etag(
    api: &DriveApi,
    file_id: &str,
    body: &[u8],
    etag: &str,
) -> Result<UploadOutcome, DriveError> {
    api.raw_patch_media(file_id, body, etag)
        .map(|new_etag| UploadOutcome::Updated { new_etag })
}

fn cache_dir_for(config_dir: &Path, file_id: &str) -> PathBuf {
    let mut p = config_dir.to_path_buf();
    p.push("drive");
    p.push(file_id);
    p
}

/// RFC3339 timestamp without pulling `chrono` — we already use the same
/// civil-date trick in `comments::now_rfc3339` to keep the binary small.
/// Exposed `pub(crate)` so other Drive modules (e.g. the poller in
/// `workspace::drive_poll_one`) can stamp `cache_meta.last_fetched`
/// without duplicating the implementation.
pub(crate) fn now_rfc3339() -> String {
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO);
    let secs = n.as_secs() as i64;
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400) as u32;
    let (year, month, day) = civil_from_days(days);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day / 60) % 60;
    let second = secs_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Days since 1970-01-01 → (year, month, day). Adapted from Howard
/// Hinnant's "chrono-Compatible Low-Level Date Algorithms" (public domain).
fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y_adj = if m <= 2 { y + 1 } else { y };
    (y_adj as i32, m, d)
}
