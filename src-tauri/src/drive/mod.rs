//! Google Drive integration: OAuth (PKCE loopback), comment sync (delta polling),
//! file download/upload (cache + ETag), Drive Desktop path detection, offline
//! queue replay. Public surface is the `TabBackend` enum routed through
//! `workspace::Tab` (added in A7) plus the `DriveStatus` snapshot consumed by
//! the status pill view (added in A8).

pub mod api;
pub mod auth;
pub mod cache;
pub mod comments;
pub mod detect;
pub mod file_id;
pub mod files;
pub mod keyring;
pub mod queue;
pub mod tokens;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum TabBackend {
    Local,
    DriveDesktop,
    DriveApi,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct DriveStatus {
    pub connected: bool,
    pub account_email: Option<String>,
    pub online: bool,
    pub pending_count: u32,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct DriveCollaborator {
    pub display_name: String,
    pub email_address: String,
}

#[derive(Debug, thiserror::Error)]
pub enum DriveError {
    #[error("not connected")]
    NotConnected,
    #[error("network: {0}")]
    Network(String),
    #[error("precondition failed (etag mismatch)")]
    PreconditionFailed,
    #[error("ambiguous file_id resolution: {0} matches")]
    Ambiguous(usize),
    #[error("invalid drive url")]
    InvalidUrl,
    #[error("api: {0}")]
    Api(String),
}

/// Extract a Drive `file_id` from a pasted URL. Accepts only the two known
/// shapes:
///   * `https://drive.google.com/file/d/<id>/<...>`
///   * `https://drive.google.com/open?id=<id>` (and `?id=<id>` on any
///     google.com host path)
///
/// Hosts not under `google.com` are rejected so a phishing URL that
/// happens to carry a `/file/d/<id>` path shape doesn't open anything.
/// Empty `<id>` segments are rejected. Returns the bare `file_id` on
/// success, `DriveError::InvalidUrl` otherwise.
pub fn parse_drive_url(input: &str) -> Result<String, DriveError> {
    let url = url::Url::parse(input).map_err(|_| DriveError::InvalidUrl)?;
    let host = url.host_str().unwrap_or("");
    // ends_with("google.com") matches drive.google.com, docs.google.com,
    // and the bare google.com — all valid Drive link hosts. Anything else
    // (example.com, evil.google.com.attacker.com) is rejected by the
    // suffix check (the latter doesn't end in ".google.com").
    if !(host == "google.com" || host.ends_with(".google.com")) {
        return Err(DriveError::InvalidUrl);
    }
    // /file/d/<id>/...
    let segments: Vec<&str> = url
        .path_segments()
        .map(|s| s.collect())
        .unwrap_or_default();
    if segments.len() >= 3 && segments[0] == "file" && segments[1] == "d" {
        let id = segments[2];
        if !id.is_empty() {
            return Ok(id.to_string());
        }
    }
    // ?id=<id>
    for (k, v) in url.query_pairs() {
        if k == "id" && !v.is_empty() {
            return Ok(v.into_owned());
        }
    }
    Err(DriveError::InvalidUrl)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_url_file_d_form() {
        assert_eq!(
            parse_drive_url("https://drive.google.com/file/d/abc123/view").unwrap(),
            "abc123"
        );
    }

    #[test]
    fn parse_url_query_id_form() {
        assert_eq!(
            parse_drive_url("https://drive.google.com/open?id=abc123").unwrap(),
            "abc123"
        );
    }

    #[test]
    fn parse_url_rejects_non_google() {
        assert!(parse_drive_url("https://evil.com/file/d/abc/view").is_err());
    }

    #[test]
    fn parse_url_rejects_empty_id() {
        assert!(parse_drive_url("https://drive.google.com/file/d/").is_err());
        assert!(parse_drive_url("https://drive.google.com/open?id=").is_err());
    }

    #[test]
    fn parse_url_rejects_garbage() {
        assert!(parse_drive_url("not a url at all").is_err());
        assert!(parse_drive_url("https://example.com").is_err());
    }
}
