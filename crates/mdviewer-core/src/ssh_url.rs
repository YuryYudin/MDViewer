//! Strict parser for `ssh://[user@]host[:port]/path` URLs.
//!
//! Lives outside `sidecar_path.rs` deliberately — that module's preamble
//! documents a string-only contract for Android `content://` URI compat.
//! The URL-aware sidecar helper for SSH lives here instead.
//!
//! The grammar accepted is intentionally narrower than what the `url`
//! crate would parse:
//! - scheme must be exactly `ssh://`
//! - host must be non-empty
//! - port must be a valid `u16` (defaults to 22 when omitted)
//! - path must be absolute (start with `/`) AND non-empty beyond the leading
//!   slash; bare `ssh://host/` is rejected because every consumer wants a
//!   real path
//! - query strings (`?...`) and fragments (`#...`) are rejected outright
//! - IPv6 literals are accepted in bracketed form: `[2001:db8::1]:port`

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshUrl {
    pub user: Option<String>,
    pub host: String,
    pub port: u16,
    pub path: String,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum ParseError {
    #[error("missing or wrong scheme (expected ssh://)")]
    Scheme,
    #[error("empty host")]
    EmptyHost,
    #[error("invalid port: {0}")]
    Port(String),
    #[error("path must be absolute (start with /)")]
    RelativePath,
    #[error("query strings and fragments are not supported")]
    QueryOrFragment,
    #[error("malformed URL: {0}")]
    Malformed(&'static str),
}

pub fn parse(input: &str) -> Result<SshUrl, ParseError> {
    let rest = input.strip_prefix("ssh://").ok_or(ParseError::Scheme)?;
    if rest.contains('?') || rest.contains('#') {
        return Err(ParseError::QueryOrFragment);
    }
    // Split authority from path. Without a `/` separator there is no
    // path at all, which means the URL is missing the absolute remote
    // path we require.
    let (authority, path) = rest
        .split_once('/')
        .map(|(a, p)| (a, format!("/{}", p)))
        .ok_or(ParseError::RelativePath)?;
    // Reject `ssh://host/` — the leading slash is present but there is
    // no actual remote path to operate on.
    if path == "/" {
        return Err(ParseError::RelativePath);
    }

    let (user, hostport) = match authority.split_once('@') {
        Some((u, hp)) => (Some(u.to_string()), hp),
        None => (None, authority),
    };

    let (host, port) = if let Some(rest) = hostport.strip_prefix('[') {
        // IPv6 literal: `[addr]:port` or `[addr]`.
        let (addr, after) = rest
            .split_once(']')
            .ok_or(ParseError::Malformed("unterminated IPv6 literal"))?;
        let port = if let Some(p) = after.strip_prefix(':') {
            p.parse::<u16>().map_err(|_| ParseError::Port(p.to_string()))?
        } else if after.is_empty() {
            22
        } else {
            return Err(ParseError::Malformed("garbage after IPv6 literal"));
        };
        (addr.to_string(), port)
    } else {
        match hostport.rsplit_once(':') {
            Some((h, p)) => {
                let port = p
                    .parse::<u16>()
                    .map_err(|_| ParseError::Port(p.to_string()))?;
                (h.to_string(), port)
            }
            None => (hostport.to_string(), 22),
        }
    };

    if host.is_empty() {
        return Err(ParseError::EmptyHost);
    }

    Ok(SshUrl {
        user,
        host,
        port,
        path,
    })
}

impl fmt::Display for SshUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ssh://")?;
        if let Some(u) = &self.user {
            write!(f, "{}@", u)?;
        }
        if self.host.contains(':') {
            write!(f, "[{}]", self.host)?;
        } else {
            write!(f, "{}", self.host)?;
        }
        if self.port != 22 {
            write!(f, ":{}", self.port)?;
        }
        write!(f, "{}", self.path)
    }
}

/// Apply the user's `comments.sidecar_pattern` (e.g. `"{name}.comments.json"`)
/// to the URL's filename component. The `{name}` token is replaced with the
/// basename minus its extension; the rest of the URL (user, host, port, parent
/// directory) is preserved.
///
/// Matches the semantics of `sidecar_path::sidecar_filename` for local paths:
/// the "name" is everything before the final `.`, so `file.md` → `file`,
/// `archive.tar.gz` → `archive.tar`, and an extensionless `README` → `README`.
pub fn sidecar_url(url: &SshUrl, pattern: &str) -> SshUrl {
    let (parent, file) = match url.path.rfind('/') {
        Some(i) => (&url.path[..=i], &url.path[i + 1..]),
        None => ("/", url.path.as_str()),
    };
    let name = file.rsplit_once('.').map(|(n, _)| n).unwrap_or(file);
    let sidecar_name = pattern.replace("{name}", name);
    let mut out = url.clone();
    out.path = format!("{}{}", parent, sidecar_name);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_user_host_port_path() {
        let u = parse("ssh://alice@example.com:2222/notes/file.md").unwrap();
        assert_eq!(u.user.as_deref(), Some("alice"));
        assert_eq!(u.host, "example.com");
        assert_eq!(u.port, 2222);
        assert_eq!(u.path, "/notes/file.md");
    }

    #[test]
    fn defaults_port_to_22() {
        let u = parse("ssh://example.com/file.md").unwrap();
        assert_eq!(u.port, 22);
    }

    #[test]
    fn user_is_optional() {
        let u = parse("ssh://example.com/file.md").unwrap();
        assert_eq!(u.user, None);
    }

    #[test]
    fn ipv6_host_literal_supported() {
        let u = parse("ssh://[2001:db8::1]:2222/file.md").unwrap();
        assert_eq!(u.host, "2001:db8::1");
        assert_eq!(u.port, 2222);
    }

    #[test]
    fn ipv6_host_literal_default_port() {
        let u = parse("ssh://[2001:db8::1]/file.md").unwrap();
        assert_eq!(u.host, "2001:db8::1");
        assert_eq!(u.port, 22);
    }

    #[test]
    fn ipv6_unterminated_is_malformed() {
        assert!(matches!(
            parse("ssh://[2001:db8::1/file.md"),
            Err(ParseError::Malformed(_))
        ));
    }

    #[test]
    fn ipv6_garbage_after_bracket_is_malformed() {
        assert!(matches!(
            parse("ssh://[2001:db8::1]xyz/file.md"),
            Err(ParseError::Malformed(_))
        ));
    }

    #[test]
    fn ipv6_invalid_port_is_port_error() {
        assert!(matches!(
            parse("ssh://[2001:db8::1]:abc/file.md"),
            Err(ParseError::Port(_))
        ));
    }

    #[test]
    fn rejects_missing_scheme() {
        assert_eq!(parse("example.com/file.md"), Err(ParseError::Scheme));
    }

    #[test]
    fn rejects_wrong_scheme() {
        assert_eq!(parse("sftp://example.com/file.md"), Err(ParseError::Scheme));
    }

    #[test]
    fn rejects_empty_host() {
        assert_eq!(parse("ssh:///file.md"), Err(ParseError::EmptyHost));
    }

    #[test]
    fn rejects_relative_path() {
        // Bare `ssh://host` with no slash separator: no path at all.
        assert_eq!(parse("ssh://example.com"), Err(ParseError::RelativePath));
        // `ssh://host/`: leading slash but no actual path component.
        assert_eq!(parse("ssh://example.com/"), Err(ParseError::RelativePath));
        // Trailing slash is valid — list_dir on a directory uses this form.
        assert!(parse("ssh://example.com/notes/").is_ok());
    }

    #[test]
    fn rejects_query_string() {
        assert_eq!(
            parse("ssh://example.com/file.md?branch=x"),
            Err(ParseError::QueryOrFragment)
        );
    }

    #[test]
    fn rejects_fragment() {
        assert_eq!(
            parse("ssh://example.com/file.md#anchor"),
            Err(ParseError::QueryOrFragment)
        );
    }

    #[test]
    fn rejects_malformed_port() {
        assert!(matches!(
            parse("ssh://example.com:abc/file.md"),
            Err(ParseError::Port(_))
        ));
        assert!(matches!(
            parse("ssh://example.com:99999/file.md"),
            Err(ParseError::Port(_))
        ));
    }

    #[test]
    fn path_passed_through_byte_identical() {
        // No trim, no normalisation — `//` and unusual casing are preserved
        // so SFTP semantics on the remote side are not silently rewritten.
        let u = parse("ssh://example.com//weird//Path.MD").unwrap();
        assert_eq!(u.path, "//weird//Path.MD");
    }

    // --- sidecar_url ---

    #[test]
    fn sidecar_url_applies_pattern() {
        let u = parse("ssh://host/notes/file.md").unwrap();
        let s = sidecar_url(&u, "{name}.comments.json");
        assert_eq!(s.path, "/notes/file.comments.json");
        assert_eq!(s.host, "host");
        assert_eq!(s.user, None);
        assert_eq!(s.port, 22);
    }

    #[test]
    fn sidecar_url_preserves_user_host_port() {
        // The non-path fields must round-trip unchanged.
        let u = parse("ssh://alice@example.com:2222/notes/file.md").unwrap();
        let s = sidecar_url(&u, "{name}.comments.json");
        assert_eq!(s.user.as_deref(), Some("alice"));
        assert_eq!(s.host, "example.com");
        assert_eq!(s.port, 2222);
        assert_eq!(s.path, "/notes/file.comments.json");
    }

    #[test]
    fn sidecar_url_pattern_with_prefix() {
        // Different `{name}` placement still works; `.` separators in the
        // pattern are literal.
        let u = parse("ssh://host/work/report.md").unwrap();
        let s = sidecar_url(&u, ".{name}.comments.json");
        assert_eq!(s.path, "/work/.report.comments.json");
    }

    #[test]
    fn sidecar_url_pattern_without_name_token() {
        // A pattern with no `{name}` token replaces the filename entirely.
        let u = parse("ssh://host/work/report.md").unwrap();
        let s = sidecar_url(&u, "comments.json");
        assert_eq!(s.path, "/work/comments.json");
    }

    #[test]
    fn sidecar_url_extensionless_file() {
        // No `.` in the filename → the entire basename is `{name}`.
        let u = parse("ssh://host/work/README").unwrap();
        let s = sidecar_url(&u, "{name}.comments.json");
        assert_eq!(s.path, "/work/README.comments.json");
    }

    #[test]
    fn sidecar_url_multi_dot_filename() {
        // Mirrors `sidecar_path::sidecar_filename`: only the final dot
        // separates name from extension, so `archive.tar.gz` → `archive.tar`.
        let u = parse("ssh://host/work/archive.tar.gz").unwrap();
        let s = sidecar_url(&u, "{name}.comments.json");
        assert_eq!(s.path, "/work/archive.tar.comments.json");
    }

    #[test]
    fn sidecar_url_root_level_file() {
        // Parent is `/`; the result still lands in `/`.
        let u = parse("ssh://host/file.md").unwrap();
        let s = sidecar_url(&u, "{name}.comments.json");
        assert_eq!(s.path, "/file.comments.json");
    }

    #[test]
    fn sidecar_url_pathless_struct_defensive_branch() {
        // `parse()` always produces an absolute path so this branch is
        // unreachable through the public surface. `SshUrl` is `pub` with
        // `pub` fields though, so a caller could construct one by hand.
        // Cover the defensive arm so a future refactor that drops it has
        // to acknowledge the contract change.
        let u = SshUrl {
            user: None,
            host: "host".to_string(),
            port: 22,
            path: "file.md".to_string(),
        };
        let s = sidecar_url(&u, "{name}.comments.json");
        assert_eq!(s.path, "/file.comments.json");
    }

    // --- Display ---

    #[test]
    fn roundtrip_to_string() {
        let u = parse("ssh://alice@example.com:2222/notes/file.md").unwrap();
        assert_eq!(u.to_string(), "ssh://alice@example.com:2222/notes/file.md");
    }

    #[test]
    fn display_default_port_is_omitted() {
        let u = parse("ssh://example.com/file.md").unwrap();
        assert_eq!(u.to_string(), "ssh://example.com/file.md");
    }

    #[test]
    fn display_ipv6_host_is_bracketed() {
        let u = parse("ssh://[2001:db8::1]:2222/file.md").unwrap();
        assert_eq!(u.to_string(), "ssh://[2001:db8::1]:2222/file.md");
    }

    #[test]
    fn display_ipv6_default_port_still_brackets_host() {
        let u = parse("ssh://[2001:db8::1]/file.md").unwrap();
        assert_eq!(u.to_string(), "ssh://[2001:db8::1]/file.md");
    }
}
