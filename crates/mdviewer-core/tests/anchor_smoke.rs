//! Smoke test: an anchor created against a fixture source resolves to the
//! same offsets via mdviewer-core::anchor::resolve_anchor.

use mdviewer_core::anchor::{resolve_anchor, Anchor, ResolveOutcome};

#[test]
fn resolves_exact_match_to_original_offsets() {
    let source = "Hello world. This is a paragraph.";
    let anchor = Anchor {
        start: 13,
        end: 32,
        exact: "This is a paragraph".into(),
        prefix: "world. ".into(),
        suffix: ".".into(),
    };

    match resolve_anchor(source, &anchor) {
        ResolveOutcome::Resolved { start, end } => {
            assert_eq!(start, 13);
            assert_eq!(end, 32);
        }
        other => panic!("expected Resolved, got {other:?}"),
    }
}
