//! Command-line argument parsing for `mdviewer <path> [<path> ...]`.
//!
//! Run-time scope: the WebView shell takes positional args at startup so a
//! user can launch from the terminal (`mdviewer notes.md`), drag a file
//! onto the macOS Dock icon, or pick "Open With → MDViewer" from Finder.
//! Each path becomes a tab; the first non-existent / unreadable one is
//! surfaced through the normal Workspace error path so the user sees the
//! same banner they'd see from File → Open.
//!
//! The parser is intentionally tiny — we don't want a clap dependency for
//! "skip flags, keep paths." If we ever grow real flags, swap this for
//! clap and keep the test set as a contract.
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
//! Returned paths are `canonicalize`d when possible so a relative path
//! from the launching shell resolves the same way the file watcher and
//! tab dedup logic expect. Paths that don't exist yet (typos, deleted
//! files) round-trip unchanged — the Workspace will report an error
//! when it tries to open them, which is the right behavior for "the
//! user typed a bad path."

use std::path::PathBuf;

/// Convert a list of `file://` URLs (delivered by Tauri's macOS
/// `RunEvent::Opened`) into local paths. Non-file URLs are dropped — the
/// macOS Launch Services pipeline always delivers `file://` for a
/// document open, but a defensive guard means a future protocol handler
/// addition won't crash the running app.
///
/// Mirrors `parse_positional_args`'s canonicalize-on-success behavior so
/// every path that flows into `Workspace::open_document` has the same
/// shape regardless of whether it came from argv or a Finder double-click.
pub fn urls_to_paths(urls: &[tauri::Url]) -> Vec<PathBuf> {
    urls.iter()
        .filter_map(|u| u.to_file_path().ok())
        .map(|p| p.canonicalize().unwrap_or(p))
        .collect()
}

/// Parse positional file paths out of `args` (typically `std::env::args()`).
/// Returns an empty Vec when no paths are present — the caller should
/// boot into the StartPage in that case.
pub fn parse_positional_args(args: &[String]) -> Vec<PathBuf> {
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
            let p = PathBuf::from(arg);
            // Canonicalize so the watcher / tab dedup match the format
            // open_document produces. Fall through to the raw path when
            // the file doesn't exist — open_document will surface the
            // error itself.
            let resolved = p.canonicalize().unwrap_or(p);
            out.push(resolved);
        }
        peeked = iter.next();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
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
            parsed[0].file_name().and_then(|s| s.to_str()),
            Some("this-may-not-exist-1.md"),
        );
        assert_eq!(
            parsed[1].file_name().and_then(|s| s.to_str()),
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
        assert_eq!(parsed[0].file_name().and_then(|s| s.to_str()), Some("x.md"));
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
    fn urls_to_paths_filters_non_file_schemes() {
        // RunEvent::Opened delivers `file://` URLs in practice, but the
        // helper must drop other schemes defensively in case a future
        // protocol handler ships before the path-handling layer is
        // updated.
        let urls = vec![
            tauri::Url::parse("file:///tmp/cli-test.md").unwrap(),
            tauri::Url::parse("https://example.com/foo.md").unwrap(),
            tauri::Url::parse("file:///tmp/another.md").unwrap(),
        ];
        let paths = urls_to_paths(&urls);
        assert_eq!(paths.len(), 2);
        assert!(paths.iter().all(|p| p.extension().and_then(|s| s.to_str()) == Some("md")));
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
            paths[0].file_name().and_then(|s| s.to_str()),
            Some("opened.md"),
        );
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
            parsed[0].file_name().and_then(|s| s.to_str()),
            Some("doc.md"),
        );
    }
}
