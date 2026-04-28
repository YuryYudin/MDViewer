use mdviewer_lib::anchor::{resolve_anchor, Anchor, ResolveOutcome};

fn anchor(start: usize, end: usize, exact: &str, prefix: &str, suffix: &str) -> Anchor {
    Anchor {
        start,
        end,
        exact: exact.into(),
        prefix: prefix.into(),
        suffix: suffix.into(),
    }
}

#[test]
fn resolves_when_exact_match_at_offset() {
    let src = "Hello selectable phrase one. More text.";
    let a = anchor(6, 28, "selectable phrase one.", "Hello ", " More text.");
    let out = resolve_anchor(src, &a);
    assert_eq!(out, ResolveOutcome::Resolved { start: 6, end: 28 });
}

#[test]
fn resolves_when_text_shifted_but_quote_intact() {
    let src = "PREFIX Hello selectable phrase one. More text.";
    // Stored offsets are stale, but the exact quote is still verbatim.
    let a = anchor(6, 28, "selectable phrase one.", "Hello ", " More text.");
    let out = resolve_anchor(src, &a);
    assert_eq!(out, ResolveOutcome::Resolved { start: 13, end: 35 });
}

#[test]
fn returns_orphan_when_quote_missing() {
    let src = "Completely different document content.";
    let a = anchor(6, 28, "selectable phrase one.", "Hello ", " More text.");
    let out = resolve_anchor(src, &a);
    assert_eq!(out, ResolveOutcome::Orphan);
}

#[test]
fn picks_correct_match_using_prefix_suffix_disambiguation() {
    // The quote appears twice; prefix/suffix narrow it.
    let src = "AAA target BBB target CCC";
    let a = anchor(11, 17, "target", "AAA ", " BBB");
    let out = resolve_anchor(src, &a);
    assert_eq!(out, ResolveOutcome::Resolved { start: 4, end: 10 });
}

#[test]
fn serde_round_trip_preserves_all_fields() {
    let a = anchor(5, 10, "hello", "PRE", "SUF");
    let json = serde_json::to_string(&a).unwrap();
    let parsed: Anchor = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed, a);
}

#[test]
fn empty_exact_is_orphan() {
    // Defensive: an anchor whose exact text was lost should not be silently
    // matched against the empty string (which would resolve everywhere).
    let src = "Some document text.";
    let a = anchor(0, 0, "", "", "");
    let out = resolve_anchor(src, &a);
    assert_eq!(out, ResolveOutcome::Orphan);
}

#[test]
fn multi_match_with_no_context_falls_back_to_nearest_offset() {
    // Both candidates score zero on prefix/suffix (anchor.prefix and
    // anchor.suffix are empty). The tiebreak by distance to anchor.start
    // picks the second occurrence at byte 15 (closer to stored 14 than
    // the first occurrence at byte 4).
    let src = "AAA target BBB target CCC";
    let a = anchor(14, 20, "target", "", "");
    let out = resolve_anchor(src, &a);
    assert_eq!(out, ResolveOutcome::Resolved { start: 15, end: 21 });
}

#[test]
fn serde_round_trip_resolved_outcome() {
    let r = ResolveOutcome::Resolved { start: 7, end: 19 };
    let json = serde_json::to_string(&r).unwrap();
    assert!(json.contains("\"kind\":\"resolved\""));
    let parsed: ResolveOutcome = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed, r);
}

#[test]
fn serde_round_trip_orphan_outcome() {
    let r = ResolveOutcome::Orphan;
    let json = serde_json::to_string(&r).unwrap();
    assert_eq!(json, "{\"kind\":\"orphan\"}");
    let parsed: ResolveOutcome = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed, r);
}
