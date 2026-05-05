//! Pure filename resolver for sidecar files.
//!
//! Used by both desktop's `Path`-based `sidecar_path` and Android's
//! `DocumentFile`-sibling logic so the `{name}` substitution doesn't
//! drift between platforms.
//!
//! The resolver is deliberately string-only: callers pass the bare
//! filename (e.g., `notes.md`) and a pattern (e.g., the user's
//! `comments.sidecar_pattern` setting). The helper returns just the
//! sibling filename — no parent-directory handling — because Android's
//! `content://` URIs have no `Path::parent` analogue. The desktop wrapper
//! in `src-tauri/src/sidecar.rs` joins the result with `md_path.parent()`
//! itself; Android's `Sidecar.kt` uses `DocumentFile.findFile(...)` on the
//! parent tree to locate the sibling.

/// Resolve the sidecar filename for a document filename and pattern.
///
/// `doc_filename` is just the filename (e.g., `notes.md`), NOT a full
/// path. `pattern` may contain `{name}` (replaced by the stem) and any
/// literal suffix/prefix the user prefers.
///
/// The "stem" is everything before the final `.` in `doc_filename`,
/// matching the semantics of `std::path::Path::file_stem` on a leaf
/// filename. Examples:
///
/// - `("notes.md", "{name}.md.comments.json")` -> `notes.md.comments.json`
/// - `("spec.md",  ".{name}.comments")`        -> `.spec.comments`
/// - `("README.MD", "{name}.md.comments.json")`-> `README.md.comments.json`
/// - `("essay.markdown", "{name}.md.comments.json")` -> `essay.md.comments.json`
///
/// If `pattern` doesn't contain `{name}` the function returns the pattern
/// verbatim — that's the natural string-replace semantics and lets
/// power-users pin a single fixed sidecar name if they really want.
pub fn sidecar_filename(doc_filename: &str, pattern: &str) -> String {
    // `rsplit_once('.')` splits at the LAST dot so `"essay.markdown"`
    // gives stem `"essay"` (matching `Path::file_stem`'s behavior on a
    // leaf filename). The `!before.is_empty()` guard treats `".bashrc"`
    // — a dot-prefixed filename with no real extension — as having stem
    // `".bashrc"`, again matching `Path::file_stem`.
    let stem = match doc_filename.rsplit_once('.') {
        Some((before, _ext)) if !before.is_empty() => before,
        _ => doc_filename,
    };
    pattern.replace("{name}", stem)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Dot-prefixed filenames (no real extension) keep their leading dot
    /// in the stem — matches `Path::file_stem(".bashrc") == ".bashrc"`.
    /// Without this guard the stem would silently become the empty string
    /// and `"{name}.json"` would resolve to `".json"`.
    #[test]
    fn dot_prefixed_filename_treats_whole_name_as_stem() {
        assert_eq!(sidecar_filename(".bashrc", "{name}.bak"), ".bashrc.bak");
    }

    /// Filename without any dot at all (no extension) uses the entire
    /// filename as the stem.
    #[test]
    fn extensionless_filename_uses_full_name_as_stem() {
        assert_eq!(sidecar_filename("notes", "{name}.comments.json"), "notes.comments.json");
    }

    /// Multiple `{name}` tokens are all substituted — `String::replace`
    /// is global, not first-only. Pin the behavior so a future swap to
    /// `replacen(.., 1)` (e.g., for "performance") doesn't silently change
    /// the contract.
    #[test]
    fn multiple_name_tokens_all_substituted() {
        assert_eq!(
            sidecar_filename("doc.md", "{name}/{name}.json"),
            "doc/doc.json"
        );
    }
}
