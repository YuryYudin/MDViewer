//! Thin HTTP wrapper around Drive REST. Base URL via `MDVIEWER_DRIVE_API_BASE`
//! (default https://www.googleapis.com); the e2e harness redirects this to
//! its mock server. Retries on 5xx + 429 with exponential backoff, never on
//! 4xx. All requests carry the bearer token from the OAuth flow.

use serde::{Deserialize, Serialize};
use std::time::Duration;

const DEFAULT_BASE: &str = "https://www.googleapis.com";
const RETRY_INITIAL_MS: u64 = 200;
const RETRY_MAX_ATTEMPTS: u32 = 4;

pub struct DriveApi {
    base: String,
    client: reqwest::blocking::Client,
    token: std::sync::Mutex<String>,
}

#[derive(Debug, Clone)]
pub struct ListCommentsArgs<'a> {
    pub file_id: &'a str,
    pub start_modified_time: Option<&'a str>,
    pub if_none_match: Option<&'a str>,
}

#[derive(Debug, Deserialize)]
pub struct CommentList {
    #[serde(default)]
    pub comments: Vec<DriveCommentResource>,
    #[serde(default, rename = "nextPageToken")]
    pub next_page_token: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct DriveCommentResource {
    pub id: Option<String>,
    pub content: String,
    #[serde(rename = "quotedFileContent")]
    pub quoted_file_content: Option<QuotedFileContent>,
    #[serde(rename = "modifiedTime")]
    pub modified_time: Option<String>,
    #[serde(default)]
    pub replies: Vec<DriveReplyResource>,
    #[serde(default)]
    pub resolved: bool,
    pub author: Option<DriveAuthor>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct DriveReplyResource {
    pub id: Option<String>,
    pub content: String,
    #[serde(rename = "modifiedTime")]
    pub modified_time: Option<String>,
    pub author: Option<DriveAuthor>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct QuotedFileContent {
    pub value: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct DriveAuthor {
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(rename = "emailAddress")]
    pub email_address: Option<String>,
}

impl DriveApi {
    pub fn with_token(token: String) -> Self {
        Self {
            base: std::env::var("MDVIEWER_DRIVE_API_BASE")
                .unwrap_or_else(|_| DEFAULT_BASE.into()),
            client: reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(20))
                .build()
                .expect("reqwest build"),
            token: std::sync::Mutex::new(token),
        }
    }

    pub fn replace_token(&self, token: String) {
        *self.token.lock().unwrap() = token;
    }

    fn auth_header(&self) -> String {
        format!("Bearer {}", self.token.lock().unwrap())
    }

    fn send_with_retry<F>(
        &self,
        build: F,
    ) -> Result<reqwest::blocking::Response, super::DriveError>
    where
        F: Fn() -> reqwest::blocking::RequestBuilder,
    {
        let mut delay = RETRY_INITIAL_MS;
        let mut last_err: Option<super::DriveError> = None;
        for attempt in 0..RETRY_MAX_ATTEMPTS {
            let resp = build()
                .header("Authorization", self.auth_header())
                .send();
            match resp {
                Ok(r) => {
                    let status = r.status();
                    if status.is_success() {
                        return Ok(r);
                    }
                    // 304 Not Modified is a successful conditional-GET
                    // outcome, not a failure — return Ok so the caller can
                    // detect it via response.status() and skip retries.
                    if status == reqwest::StatusCode::NOT_MODIFIED {
                        return Ok(r);
                    }
                    if status.as_u16() == 412 {
                        return Err(super::DriveError::PreconditionFailed);
                    }
                    if status.is_client_error() && status.as_u16() != 429 {
                        return Err(parse_error_envelope(r));
                    }
                    // 5xx or 429 → retry
                    last_err = Some(super::DriveError::Api(format!("http {}", status)));
                }
                Err(e) => last_err = Some(super::DriveError::Network(e.to_string())),
            }
            if attempt + 1 < RETRY_MAX_ATTEMPTS {
                std::thread::sleep(Duration::from_millis(delay));
                delay *= 2;
            }
        }
        Err(last_err.unwrap_or_else(|| super::DriveError::Api("retry exhausted".into())))
    }

    pub fn list_comments(
        &self,
        args: &ListCommentsArgs,
    ) -> Result<CommentList, super::DriveError> {
        let path = format!(
            "/drive/v3/files/{}/comments",
            urlencoding::encode(args.file_id)
        );
        let resp = self.send_with_retry(|| {
            let mut req = self
                .client
                .get(format!("{}{}", self.base, path))
                .query(&[("fields", "comments(id,content,modifiedTime,resolved,quotedFileContent/value,author/displayName,author/emailAddress,replies(id,content,modifiedTime,author/displayName,author/emailAddress)),nextPageToken")]);
            if let Some(t) = args.start_modified_time {
                req = req.query(&[("startModifiedTime", t)]);
            }
            if let Some(etag) = args.if_none_match {
                req = req.header("If-None-Match", etag);
            }
            req
        })?;
        // 304 Not Modified means the caller's cache is still valid; return an
        // empty payload so the caller's prior cache stays authoritative.
        if resp.status() == reqwest::StatusCode::NOT_MODIFIED {
            return Ok(CommentList {
                comments: Vec::new(),
                next_page_token: None,
            });
        }
        resp.json::<CommentList>()
            .map_err(|e| super::DriveError::Api(e.to_string()))
    }

    pub fn create_comment(
        &self,
        file_id: &str,
        body: &DriveCommentResource,
    ) -> Result<DriveCommentResource, super::DriveError> {
        let path = format!(
            "/drive/v3/files/{}/comments",
            urlencoding::encode(file_id)
        );
        let resp = self.send_with_retry(|| {
            self.client
                .post(format!("{}{}", self.base, path))
                .query(&[(
                    "fields",
                    "id,content,modifiedTime,quotedFileContent/value,author/displayName,author/emailAddress",
                )])
                .json(body)
        })?;
        resp.json::<DriveCommentResource>()
            .map_err(|e| super::DriveError::Api(e.to_string()))
    }

    pub fn delete_comment(
        &self,
        file_id: &str,
        comment_id: &str,
    ) -> Result<(), super::DriveError> {
        let path = format!(
            "/drive/v3/files/{}/comments/{}",
            urlencoding::encode(file_id),
            urlencoding::encode(comment_id)
        );
        let _ = self
            .send_with_retry(|| self.client.delete(format!("{}{}", self.base, path)))?;
        Ok(())
    }

    pub fn create_reply(
        &self,
        file_id: &str,
        comment_id: &str,
        body: &DriveReplyResource,
    ) -> Result<DriveReplyResource, super::DriveError> {
        let path = format!(
            "/drive/v3/files/{}/comments/{}/replies",
            urlencoding::encode(file_id),
            urlencoding::encode(comment_id)
        );
        let resp = self.send_with_retry(|| {
            self.client
                .post(format!("{}{}", self.base, path))
                .query(&[(
                    "fields",
                    "id,content,modifiedTime,author/displayName,author/emailAddress",
                )])
                .json(body)
        })?;
        resp.json::<DriveReplyResource>()
            .map_err(|e| super::DriveError::Api(e.to_string()))
    }

    pub fn list_permissions(
        &self,
        file_id: &str,
    ) -> Result<Vec<super::DriveCollaborator>, super::DriveError> {
        let path = format!(
            "/drive/v3/files/{}/permissions",
            urlencoding::encode(file_id)
        );
        #[derive(Deserialize)]
        struct PermResp {
            permissions: Vec<Perm>,
        }
        #[derive(Deserialize)]
        struct Perm {
            #[serde(rename = "displayName")]
            display_name: Option<String>,
            #[serde(rename = "emailAddress")]
            email_address: Option<String>,
        }
        let resp = self.send_with_retry(|| {
            self.client
                .get(format!("{}{}", self.base, path))
                .query(&[("fields", "permissions(displayName,emailAddress)")])
        })?;
        let parsed: PermResp = resp
            .json()
            .map_err(|e| super::DriveError::Api(e.to_string()))?;
        Ok(parsed
            .permissions
            .into_iter()
            .filter_map(|p| {
                Some(super::DriveCollaborator {
                    display_name: p.display_name?,
                    email_address: p.email_address?,
                })
            })
            .collect())
    }

    pub fn files_get_metadata(
        &self,
        file_id: &str,
    ) -> Result<FileMetadata, super::DriveError> {
        let path = format!("/drive/v3/files/{}", urlencoding::encode(file_id));
        let resp = self.send_with_retry(|| {
            self.client
                .get(format!("{}{}", self.base, path))
                .query(&[("fields", "id,name,modifiedTime,headRevisionId,size")])
        })?;
        resp.json::<FileMetadata>()
            .map_err(|e| super::DriveError::Api(e.to_string()))
    }

    /// GET `files/<id>?alt=media` — returns the raw response so the caller
    /// can stream the body to disk and capture the HTTP `ETag` header (used
    /// for the next round's `If-Match` precondition on PATCH). The Drive
    /// `etag` *field* on the JSON resource is **not** the same value and
    /// must not be substituted here.
    pub fn raw_get_media(
        &self,
        file_id: &str,
    ) -> Result<reqwest::blocking::Response, super::DriveError> {
        let path = format!("/drive/v3/files/{}", urlencoding::encode(file_id));
        self.send_with_retry(|| {
            self.client
                .get(format!("{}{}", self.base, path))
                .query(&[("alt", "media")])
        })
    }

    /// PATCH `upload/drive/v3/files/<id>?uploadType=media` with `If-Match` set
    /// to the prior ETag. A 412 is mapped by `send_with_retry` to
    /// `DriveError::PreconditionFailed` so the caller surfaces a conflict
    /// banner. On success, returns the new ETag from the response header so
    /// the caller can update its cached metadata in lockstep with the write.
    pub fn raw_patch_media(
        &self,
        file_id: &str,
        body: &[u8],
        etag: &str,
    ) -> Result<String, super::DriveError> {
        let path = format!(
            "/upload/drive/v3/files/{}?uploadType=media",
            urlencoding::encode(file_id)
        );
        let resp = self.send_with_retry(|| {
            self.client
                .patch(format!("{}{}", self.base, path))
                .header("If-Match", etag)
                .header("Content-Type", "text/markdown")
                .body(body.to_vec())
        })?;
        resp.headers()
            .get(reqwest::header::ETAG)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
            .ok_or_else(|| super::DriveError::Api("missing ETag on upload".into()))
    }

    /// PATCH update file metadata or content. Caller supplies the JSON body
    /// shape (e.g. `{"name":"renamed.md"}`) and an optional ETag for
    /// optimistic concurrency. A 412 on the response is mapped to
    /// `DriveError::PreconditionFailed` so the caller can surface a conflict
    /// banner instead of overwriting newer remote state.
    pub fn files_update(
        &self,
        file_id: &str,
        body: &serde_json::Value,
        if_match: Option<&str>,
    ) -> Result<FileMetadata, super::DriveError> {
        let path = format!("/drive/v3/files/{}", urlencoding::encode(file_id));
        let resp = self.send_with_retry(|| {
            let mut req = self
                .client
                .patch(format!("{}{}", self.base, path))
                .query(&[("fields", "id,name,modifiedTime,headRevisionId,size")])
                .json(body);
            if let Some(etag) = if_match {
                req = req.header("If-Match", etag);
            }
            req
        })?;
        resp.json::<FileMetadata>()
            .map_err(|e| super::DriveError::Api(e.to_string()))
    }
}

#[derive(Debug, Deserialize)]
pub struct FileMetadata {
    pub id: String,
    pub name: String,
    #[serde(rename = "modifiedTime")]
    pub modified_time: Option<String>,
    #[serde(rename = "headRevisionId")]
    pub head_revision_id: Option<String>,
    pub size: Option<String>,
}

fn parse_error_envelope(resp: reqwest::blocking::Response) -> super::DriveError {
    #[derive(Deserialize)]
    struct Envelope {
        error: ErrorBody,
    }
    #[derive(Deserialize)]
    struct ErrorBody {
        code: Option<u32>,
        message: Option<String>,
    }
    match resp.json::<Envelope>() {
        Ok(e) => super::DriveError::Api(format!(
            "{}: {}",
            e.error.code.unwrap_or(0),
            e.error.message.unwrap_or_default()
        )),
        Err(_) => super::DriveError::Api("unparseable error envelope".into()),
    }
}
