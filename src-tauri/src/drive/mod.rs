//! Google Drive integration: OAuth (PKCE loopback), comment sync (delta polling),
//! file download/upload (cache + ETag), Drive Desktop path detection, offline
//! queue replay. Public surface is the `TabBackend` enum routed through
//! `workspace::Tab` (added in A7) plus the `DriveStatus` snapshot consumed by
//! the status pill view (added in A8).

pub mod api;
pub mod auth;
pub mod keyring;

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
