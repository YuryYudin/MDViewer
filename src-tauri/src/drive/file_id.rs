//! Resolves a local Drive Desktop path → Drive `file_id` by querying
//! `files.list` with `q="name='<basename>' and trashed=false"`.
//!
//! The resolver returns one of:
//!   - `Resolved(file_id)` when exactly one match is returned
//!   - `Ambiguous(Vec<FileMatch>)` when 2..=50 matches exist (renderable
//!     in the disambiguation picker)
//!   - `TooManyMatches { sample, total_estimate }` when more than `CAP=50`
//!     matches exist. We surface this distinctly as
//!     "ambiguity too large to display" so the UI can prompt for narrower
//!     input rather than silently truncating into a misleading picker.
//!
//! Caching: the in-memory `cache_q: HashMap<String, String>` deduplicates
//! identical query strings — a second call with the same `q` returns the
//! cached body without bumping `calls`. A persistent cache keyed by full
//! path lives at `<config_dir>/drive_path_resolutions.json` and is wired in
//! A7 once the resolver receives a `tauri::AppHandle`.

use std::path::Path;
use std::sync::Mutex;

#[derive(Debug, Clone)]
pub enum FileIdResolution {
    Resolved(String),
    Ambiguous(Vec<FileMatch>),
    /// More than `CAP=50` matches were returned by `files.list`. We expose
    /// a 50-element `sample` plus a `total_estimate` (count of matches the
    /// API actually returned, before truncation) so callers can render an
    /// "ambiguity too large to display" message and ask for a narrower
    /// query.
    TooManyMatches {
        sample: Vec<FileMatch>,
        total_estimate: usize,
    },
}

#[derive(Debug, Clone)]
pub struct FileMatch {
    pub id: String,
    pub name: String,
    pub parents: Vec<String>,
}

/// Trait so production wires the real `DriveApi` and tests inject canned
/// responses. The body returned is the raw JSON of `files.list?q=...`.
pub trait FileIdBackend {
    fn files_list(&self, q: &str) -> Result<String, super::DriveError>;
}

pub struct FileIdResolver {
    inner: Mutex<FileIdResolverInner>,
}

struct FileIdResolverInner {
    responses: Vec<String>,
    calls: usize,
    /// Per-query response cache. Keyed by the query string so a repeated
    /// `files.list?q=...` for the same path reuses the prior response without
    /// bumping `calls`. The path-level cache lives in A7.
    cache_q: std::collections::HashMap<String, String>,
}

impl FileIdResolver {
    pub fn with_responses(responses: Vec<String>) -> Self {
        Self {
            inner: Mutex::new(FileIdResolverInner {
                responses,
                calls: 0,
                cache_q: std::collections::HashMap::new(),
            }),
        }
    }
    pub fn calls(&self) -> usize {
        self.inner.lock().unwrap().calls
    }
}

impl FileIdBackend for FileIdResolver {
    fn files_list(&self, q: &str) -> Result<String, super::DriveError> {
        let mut g = self.inner.lock().unwrap();
        if let Some(cached) = g.cache_q.get(q) {
            return Ok(cached.clone());
        }
        g.calls += 1;
        let resp = g
            .responses
            .first()
            .cloned()
            .unwrap_or_else(|| r#"{"files":[]}"#.into());
        g.cache_q.insert(q.into(), resp.clone());
        Ok(resp)
    }
}

const CAP: usize = 50;

pub fn resolve_file_id(
    path: &Path,
    target_os: &str,
    home: Option<&str>,
    backend: &impl FileIdBackend,
) -> Result<FileIdResolution, super::DriveError> {
    let _root = super::detect::is_drive_desktop_path(path, target_os, home)
        .ok_or_else(|| super::DriveError::Api("not a Drive Desktop path".into()))?;
    let basename = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| super::DriveError::Api("no basename".into()))?;
    // v1 simplification: a flat name lookup. The resolver doesn't yet walk
    // arbitrary nested directories — Drive's `files.list` returns matches
    // across the user's drive.file-scoped corpus, and we surface ambiguity
    // when more than one matches the basename. Future iteration can
    // optionally narrow with `'<parent_id>' in parents` after we resolve
    // the immediate parent folder by name.
    let q = format!(
        "name='{}' and trashed=false",
        basename.replace('\'', "\\'")
    );
    let body = backend.files_list(&q)?;
    let parsed: FilesList = serde_json::from_str(&body)
        .map_err(|e| super::DriveError::Api(format!("files.list parse: {e}")))?;
    let total_returned = parsed.files.len();
    let matches: Vec<FileMatch> = parsed
        .files
        .into_iter()
        .map(|f| FileMatch {
            id: f.id,
            name: f.name,
            parents: f.parents.unwrap_or_default(),
        })
        .collect();
    if total_returned > CAP {
        return Ok(FileIdResolution::TooManyMatches {
            sample: matches.into_iter().take(CAP).collect(),
            total_estimate: total_returned,
        });
    }
    Ok(match matches.len() {
        0 => {
            return Err(super::DriveError::Api(format!(
                "no Drive file matches {}",
                basename
            )))
        }
        1 => FileIdResolution::Resolved(matches.into_iter().next().unwrap().id),
        _ => FileIdResolution::Ambiguous(matches),
    })
}

#[derive(serde::Deserialize)]
struct FilesList {
    #[serde(default)]
    files: Vec<FileEntry>,
}

#[derive(serde::Deserialize)]
struct FileEntry {
    id: String,
    name: String,
    parents: Option<Vec<String>>,
}
