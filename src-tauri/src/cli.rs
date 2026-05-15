//! Command-line argument parsing for `mdviewer <path-or-ssh-url> [...]`.
//!
//! Run-time scope: the WebView shell takes positional args at startup so a
//! user can launch from the terminal (`mdviewer notes.md`, `mdviewer
//! ssh://host/notes.md`), drag a file onto the macOS Dock icon, or pick
//! "Open With → MDViewer" from Finder. Each argument becomes a tab; the
//! first non-existent / unreadable one is surfaced through the normal
//! Workspace error path so the user sees the same banner they'd see from
//! File → Open.
//!
//! The parser is intentionally tiny — we don't want a clap dependency for
//! "skip flags, classify each arg as Local or Ssh." If we ever grow real
//! flags, swap this for clap and keep the test set as a contract.
//!
//! ## What gets skipped
//!
//! 1. `argv[0]` — the binary path itself.
//! 2. The first arg if it's the `migrate-sidecars` subcommand (handled
//!    separately in `main.rs`).
//! 3. Any arg starting with `-` — reserved for future flags. Today the
//!    binary has none, but `mdviewer --version` shouldn't be misread as
//!    "open a file called --version".
//! 4. Empty strings (defensive — Tauri's argv from
//!    `RunEvent::Opened { urls }` can include them on edge-case macOS
//!    drag interactions).
//!
//! ## OpenTarget classification
//!
//! Each surviving arg becomes an `OpenTarget`:
//!
//! * Args starting with `ssh://` are parsed via
//!   `mdviewer_core::ssh_url::parse`. Successful parses yield
//!   `OpenTarget::Ssh(url)`; malformed ssh:// URLs fall through to the
//!   Local branch so the user gets a familiar "file not found" toast
//!   rather than silent dropping. (The Workspace surfaces that error
//!   from `open_document`.)
//! * Every other surviving arg yields `OpenTarget::Local(canonical_or_raw)`.
//!   Existing paths are canonicalized; non-existent paths round-trip
//!   unchanged — the Workspace will report "no such file" when it tries
//!   to open them, which is the right behavior for "the user typed a
//!   bad path."

use mdviewer_core::ssh_url::{self, SshUrl};
use std::path::{Path, PathBuf};

/// Classification of a single positional argument.
///
/// `Local(PathBuf)` is the legacy file-open path; `Ssh(SshUrl)` is the
/// A9 addition that routes through `Workspace::open_ssh_url` instead of
/// `Workspace::open_document`. The variant discriminator IS the routing
/// decision — callers `match` on it and dispatch accordingly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenTarget {
    Local(PathBuf),
    Ssh(SshUrl),
}

impl OpenTarget {
    /// Convenience accessor for the (rare) cases that still want to
    /// filter for local paths only. Returns `None` for the `Ssh` variant
    /// so callers can `.filter_map` over a heterogeneous list. No A9
    /// call site uses this today, but exposing it keeps the variant
    /// transparent without forcing each consumer to pattern-match.
    pub fn as_local_path(&self) -> Option<&Path> {
        match self {
            OpenTarget::Local(p) => Some(p),
            OpenTarget::Ssh(_) => None,
        }
    }
}

/// Convert a list of URLs (delivered by Tauri's macOS `RunEvent::Opened`)
/// into `OpenTarget`s. The `file://` scheme yields `OpenTarget::Local`;
/// the `ssh://` scheme yields `OpenTarget::Ssh`. All other schemes are
/// dropped — Launch Services delivers `file://` for document opens in
/// practice, but a defensive guard means a future protocol-handler
/// addition won't crash the running app.
///
/// Mirrors `parse_positional_args`'s canonicalize-on-success behavior so
/// every path that flows into `Workspace::open_document` has the same
/// shape regardless of whether it came from argv or a Finder double-click.
pub fn urls_to_paths(urls: &[tauri::Url]) -> Vec<OpenTarget> {
    urls.iter()
        .filter_map(|u| match u.scheme() {
            "ssh" => ssh_url::parse(u.as_str()).ok().map(OpenTarget::Ssh),
            "file" => u
                .to_file_path()
                .ok()
                .map(|p| OpenTarget::Local(p.canonicalize().unwrap_or(p))),
            _ => None,
        })
        .collect()
}

/// Parse positional file paths / SSH URLs out of `args` (typically
/// `std::env::args()`). Returns an empty Vec when no targets are present
/// — the caller should boot into the StartPage in that case.
pub fn parse_positional_args(args: &[String]) -> Vec<OpenTarget> {
    let mut iter = args.iter().enumerate();

    // Skip argv[0] (binary path).
    let _ = iter.next();

    // Skip the migrate-sidecars subcommand if present. main.rs handles it
    // before `tauri::Builder` is even constructed, so we should never see
    // it here in practice — but the guard makes the parser robust if the
    // call order changes.
    let mut peeked = iter.next();
    if let Some((_, first)) = &peeked {
        if first.as_str() == "migrate-sidecars" {
            // Drop the entire subcommand line. main.rs has already exited
            // by the time we'd be parsing this anyway.
            return Vec::new();
        }
    }

    let mut out = Vec::new();
    while let Some((_, arg)) = peeked {
        if !arg.is_empty() && !arg.starts_with('-') {
            out.push(classify_arg(arg));
        }
        peeked = iter.next();
    }
    out
}

/// Classify a single argv string as `OpenTarget::Ssh` (when it parses as
/// a strict ssh:// URL) or `OpenTarget::Local` (everything else). A
/// malformed `ssh://...` argv falls into `Local` so the existing
/// "no such file" error path still surfaces a toast — silent dropping
/// would be worse.
fn classify_arg(arg: &str) -> OpenTarget {
    if arg.starts_with("ssh://") {
        if let Ok(url) = ssh_url::parse(arg) {
            return OpenTarget::Ssh(url);
        }
        // Fall through: treat malformed ssh:// argv as a Local path so
        // the normal "file not found" toast surfaces from Workspace.
    }
    let p = PathBuf::from(arg);
    OpenTarget::Local(p.canonicalize().unwrap_or(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    fn as_local(t: &OpenTarget) -> &Path {
        match t {
            OpenTarget::Local(p) => p,
            OpenTarget::Ssh(_) => panic!("expected Local, got Ssh"),
        }
    }

    fn as_ssh(t: &OpenTarget) -> &SshUrl {
        match t {
            OpenTarget::Ssh(u) => u,
            OpenTarget::Local(_) => panic!("expected Ssh, got Local"),
        }
    }

    #[test]
    fn empty_when_only_binary_name() {
        assert!(parse_positional_args(&argv(&["/usr/local/bin/mdviewer"])).is_empty());
    }

    #[test]
    fn returns_each_positional_path() {
        // Use /tmp paths that may or may not exist; canonicalization is a
        // best-effort step and the parser must not drop paths that fail
        // to canonicalize (typo support).
        let parsed = parse_positional_args(&argv(&[
            "mdviewer",
            "/tmp/this-may-not-exist-1.md",
            "/tmp/this-may-not-exist-2.md",
        ]));
        assert_eq!(parsed.len(), 2);
        assert_eq!(
            as_local(&parsed[0]).file_name().and_then(|s| s.to_str()),
            Some("this-may-not-exist-1.md"),
        );
        assert_eq!(
            as_local(&parsed[1]).file_name().and_then(|s| s.to_str()),
            Some("this-may-not-exist-2.md"),
        );
    }

    #[test]
    fn skips_flags() {
        // Future-proofing: `-v` / `--version` / etc. must NOT be
        // interpreted as paths. Today the binary has no flags, but a
        // typo like `--debug-mode` shouldn't get treated as a filename.
        let parsed = parse_positional_args(&argv(&[
            "mdviewer",
            "--debug",
            "/tmp/notes.md",
            "-v",
            "/tmp/another.md",
        ]));
        assert_eq!(parsed.len(), 2);
    }

    #[test]
    fn skips_empty_args() {
        // RunEvent::Opened { urls } on macOS edge-cases (drag interactions
        // mid-gesture) has been observed to deliver an empty string.
        // Never treat `""` as a filename.
        let parsed = parse_positional_args(&argv(&["mdviewer", "", "/tmp/x.md", ""]));
        assert_eq!(parsed.len(), 1);
        assert_eq!(
            as_local(&parsed[0]).file_name().and_then(|s| s.to_str()),
            Some("x.md"),
        );
    }

    #[test]
    fn migrate_sidecars_subcommand_consumes_everything() {
        // main.rs handles this subcommand before invoking the parser, but
        // the guard means a future re-ordering can't accidentally treat
        // `<dir>` as a doc to open.
        let parsed = parse_positional_args(&argv(&[
            "mdviewer",
            "migrate-sidecars",
            "/some/dir",
            "extra-noise",
        ]));
        assert!(parsed.is_empty());
    }

    #[test]
    fn classifies_ssh_url_as_ssh_variant() {
        // A9: an `ssh://...` arg must round-trip through the strict parser
        // and surface as `OpenTarget::Ssh`. We assert one representative
        // URL here; the SshUrl-grammar surface area is covered by
        // mdviewer_core::ssh_url's own unit suite.
        let parsed = parse_positional_args(&argv(&[
            "mdviewer",
            "ssh://alice@host.example:2222/notes/file.md",
        ]));
        assert_eq!(parsed.len(), 1);
        let url = as_ssh(&parsed[0]);
        assert_eq!(url.user.as_deref(), Some("alice"));
        assert_eq!(url.host, "host.example");
        assert_eq!(url.port, 2222);
        assert_eq!(url.path, "/notes/file.md");
    }

    #[test]
    fn ssh_and_local_mix_in_one_invocation() {
        // The argv parser must preserve order across the heterogeneous
        // mix — main.rs's open loop dispatches on the variant in argv
        // order.
        let parsed = parse_positional_args(&argv(&[
            "mdviewer",
            "/tmp/local-1.md",
            "ssh://host/remote-1.md",
            "/tmp/local-2.md",
        ]));
        assert_eq!(parsed.len(), 3);
        assert_eq!(
            as_local(&parsed[0]).file_name().and_then(|s| s.to_str()),
            Some("local-1.md"),
        );
        assert_eq!(as_ssh(&parsed[1]).host, "host");
        assert_eq!(
            as_local(&parsed[2]).file_name().and_then(|s| s.to_str()),
            Some("local-2.md"),
        );
    }

    #[test]
    fn malformed_ssh_url_falls_back_to_local() {
        // `ssh://` with no host is rejected by the strict parser. Rather
        // than silently dropping the arg, the classifier falls back to
        // `OpenTarget::Local` so the Workspace surfaces a "file not
        // found" toast — same UX the user would get for a typo'd local
        // path.
        let parsed = parse_positional_args(&argv(&["mdviewer", "ssh:///no-host.md"]));
        assert_eq!(parsed.len(), 1);
        // The fallback yields a Local target. The exact path shape isn't
        // load-bearing; the guarantee is "not Ssh, not silently dropped."
        match &parsed[0] {
            OpenTarget::Local(_) => {}
            OpenTarget::Ssh(_) => panic!("malformed ssh URL must not classify as Ssh"),
        }
    }

    #[test]
    fn urls_to_paths_filters_non_file_schemes() {
        // RunEvent::Opened delivers `file://` URLs in practice, but the
        // helper must drop other schemes defensively in case a future
        // protocol handler ships before the path-handling layer is
        // updated. Construct file URLs from real PathBufs so the test
        // works cross-platform (a literal `file:///tmp/...` only resolves
        // on Unix; Windows expects `file:///C:/...`).
        let dir = tempfile::tempdir().expect("tempdir");
        let p1 = dir.path().join("a.md");
        let p2 = dir.path().join("b.md");
        std::fs::write(&p1, b"# a").expect("write a");
        std::fs::write(&p2, b"# b").expect("write b");
        let urls = vec![
            tauri::Url::from_file_path(&p1).expect("file URL a"),
            tauri::Url::parse("https://example.com/foo.md").unwrap(),
            tauri::Url::from_file_path(&p2).expect("file URL b"),
        ];
        let paths = urls_to_paths(&urls);
        assert_eq!(paths.len(), 2);
        assert!(paths
            .iter()
            .all(|t| as_local(t).extension().and_then(|s| s.to_str()) == Some("md")));
    }

    #[test]
    fn urls_to_paths_canonicalizes_existing_targets() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("opened.md");
        std::fs::write(&target, b"# hi").expect("write");
        let url = tauri::Url::from_file_path(&target).expect("file URL");
        let paths = urls_to_paths(&[url]);
        assert_eq!(paths.len(), 1);
        assert_eq!(
            as_local(&paths[0]).file_name().and_then(|s| s.to_str()),
            Some("opened.md"),
        );
    }

    #[test]
    fn urls_to_paths_classifies_ssh_url() {
        // RunEvent::Opened delivers `ssh://` URLs when the OS hands the
        // running app an SSH target (e.g. through a custom URL handler).
        // The helper must round-trip the URL through the strict parser
        // and emit `OpenTarget::Ssh`.
        let url = tauri::Url::parse("ssh://user@host:22/file.md").expect("ssh URL parses");
        let targets = urls_to_paths(&[url]);
        assert_eq!(targets.len(), 1);
        let parsed = as_ssh(&targets[0]);
        assert_eq!(parsed.user.as_deref(), Some("user"));
        assert_eq!(parsed.host, "host");
        assert_eq!(parsed.path, "/file.md");
    }

    #[test]
    fn canonicalizes_existing_files() {
        // Real file → canonical path. Use a tempfile so the assertion
        // doesn't depend on the current working directory's contents.
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("doc.md");
        std::fs::write(&target, b"# Hi\n").expect("write");
        let parsed = parse_positional_args(&argv(&[
            "mdviewer",
            target.to_str().expect("utf-8 path"),
        ]));
        assert_eq!(parsed.len(), 1);
        // canonicalize() resolves any symlinks; the suffix should still
        // match the original file name.
        assert_eq!(
            as_local(&parsed[0]).file_name().and_then(|s| s.to_str()),
            Some("doc.md"),
        );
    }

    #[test]
    fn as_local_path_returns_none_for_ssh_variant() {
        let url = ssh_url::parse("ssh://host/notes/x.md").unwrap();
        let target = OpenTarget::Ssh(url);
        assert!(target.as_local_path().is_none());
    }

    #[test]
    fn as_local_path_returns_path_for_local_variant() {
        let target = OpenTarget::Local(PathBuf::from("/tmp/a.md"));
        assert_eq!(target.as_local_path(), Some(Path::new("/tmp/a.md")));
    }
}
