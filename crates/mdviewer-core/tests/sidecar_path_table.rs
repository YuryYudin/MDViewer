//! Table-test fixtures for `sidecar_filename` — the pure-string resolver
//! that desktop's `sidecar_path` and Android's DocumentFile-sibling logic
//! share so the `{name}` substitution rule cannot drift between platforms.

use mdviewer_core::sidecar_path::sidecar_filename;

#[test]
fn default_pattern_appends_md_comments_json() {
    assert_eq!(
        sidecar_filename("notes.md", "{name}.md.comments.json"),
        "notes.md.comments.json"
    );
}

#[test]
fn dot_prefix_pattern_strips_md_extension() {
    assert_eq!(
        sidecar_filename("spec.md", ".{name}.comments"),
        ".spec.comments"
    );
}

#[test]
fn upper_case_md_extension() {
    assert_eq!(
        sidecar_filename("README.MD", "{name}.md.comments.json"),
        "README.md.comments.json"
    );
}

#[test]
fn markdown_extension() {
    assert_eq!(
        sidecar_filename("essay.markdown", "{name}.md.comments.json"),
        "essay.md.comments.json"
    );
}

#[test]
fn no_substitution_token_returns_pattern_verbatim() {
    assert_eq!(sidecar_filename("notes.md", "fixed.json"), "fixed.json");
}

#[test]
fn empty_filename_handled_gracefully() {
    // Pathologically malformed; behavior is "use empty stem".
    assert_eq!(
        sidecar_filename("", "{name}.md.comments.json"),
        ".md.comments.json"
    );
}
