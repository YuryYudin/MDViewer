use mdviewer_lib::anchor::{resolve_anchor, resolve_anchor_with_threshold, Anchor, ResolveOutcome};

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
fn resolves_quote_with_multibyte_utf8_does_not_panic() {
    // Regression: the multi-match search loop used `search_from = abs_start + 1`
    // which lands inside a multi-byte UTF-8 character on inputs like CJK or
    // emoji, panicking on the next slice. The byte-step must be the char's
    // UTF-8 length.
    let src = "你好你好"; // four 3-byte CJK chars → 12 bytes
    let a = anchor(0, 6, "你好", "", "");
    let out = resolve_anchor(src, &a);
    // First "你好" wins on closeness to anchor.start = 0. No panic.
    assert_eq!(out, ResolveOutcome::Resolved { start: 0, end: 6 });
}

#[test]
fn resolves_emoji_quote_with_overlapping_search() {
    // Emoji are typically 4 bytes (or more for ZWJ sequences); ensure the
    // overlapping-search byte step doesn't slice them in half.
    let src = "🚀🚀🚀 done";
    let a = anchor(0, 4, "🚀", "", "🚀🚀");
    let out = resolve_anchor(src, &a);
    // Three matches; closest to anchor.start=0 is the first.
    assert_eq!(out, ResolveOutcome::Resolved { start: 0, end: 4 });
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

// ----------------------------------------------------------------------
// B1 (Phase-2): fuzzy reattachment via diff-match-patch-rs Bitap.
// ----------------------------------------------------------------------

#[test]
fn fuzzy_reattaches_after_minor_insertion() {
    // Original: "selectable phrase one." → user inserts " short" before "phrase".
    let src = "Hello selectable short phrase one. More text.";
    let a = anchor(6, 28, "selectable phrase one.", "Hello ", " More text.");
    let out = resolve_anchor_with_threshold(src, &a, 60);
    match out {
        ResolveOutcome::Resolved { start, end } => {
            assert!(&src[start..end].contains("phrase one"));
        }
        _ => panic!("expected fuzzy resolve, got {out:?}"),
    }
}

#[test]
fn orphans_when_fuzzy_score_below_threshold() {
    let src = "Completely unrelated paragraph with no overlap.";
    let a = anchor(6, 28, "selectable phrase one.", "Hello ", " More text.");
    let out = resolve_anchor_with_threshold(src, &a, 75);
    assert_eq!(out, ResolveOutcome::Orphan);
}

#[test]
fn unicode_boundary_regression() {
    // Anchor crosses an emoji; ensure we never panic on slice-by-byte.
    let src = "Hello 🌍 selectable phrase one. More text.";
    let a = anchor(0, 0, "phrase one", "selectable ", ". More");
    let out = resolve_anchor_with_threshold(src, &a, 75);
    assert!(matches!(out, ResolveOutcome::Resolved { .. }));
}

#[test]
fn property_inserts_deletes_replacements() {
    let original_anchor = anchor(6, 11, "bravo", "alpha ", " charlie");
    // Insertion before the quote.
    let edited = "PRE alpha bravo charlie delta echo foxtrot";
    assert!(matches!(
        resolve_anchor_with_threshold(edited, &original_anchor, 75),
        ResolveOutcome::Resolved { .. }
    ));
    // Deletion of an unrelated word.
    let edited = "alpha bravo charlie echo foxtrot";
    assert!(matches!(
        resolve_anchor_with_threshold(edited, &original_anchor, 75),
        ResolveOutcome::Resolved { .. }
    ));
    // Replacement of the quote itself — at high threshold this should orphan.
    let edited = "alpha XXXXX charlie delta echo foxtrot";
    assert_eq!(
        resolve_anchor_with_threshold(edited, &original_anchor, 90),
        ResolveOutcome::Orphan
    );
}

#[test]
fn fuzzy_resolve_handles_stale_start_past_source_end() {
    // Original document had the phrase near offset 200; user then deleted
    // most of the document and the phrase now lives near offset 30. Stale
    // anchor.start of 200 must not panic the resolver.
    let source = "shortened text — the moved phrase still appears here.";
    let a = Anchor {
        start: 200,
        end: 218,
        exact: "the moved phrase".into(),
        prefix: "— ".into(),
        suffix: " still".into(),
    };
    match resolve_anchor_with_threshold(source, &a, 75) {
        ResolveOutcome::Resolved { start, .. } => assert!(start < source.len()),
        ResolveOutcome::Orphan => panic!("should have reattached after stale offset"),
    }
}

#[test]
fn exact_match_short_circuits_fuzzy_path() {
    // Exact match present → must take the Phase-1 path (no fuzzy needed).
    let src = "alpha bravo charlie";
    let a = anchor(6, 11, "bravo", "alpha ", " charlie");
    let out = resolve_anchor_with_threshold(src, &a, 75);
    assert_eq!(out, ResolveOutcome::Resolved { start: 6, end: 11 });
}

#[test]
fn fuzzy_orphans_on_empty_exact() {
    // Defensive: a fuzzy call with empty exact must orphan, not silently match
    // the empty string.
    let src = "any text";
    let a = anchor(0, 0, "", "", "");
    assert_eq!(
        resolve_anchor_with_threshold(src, &a, 75),
        ResolveOutcome::Orphan
    );
}

#[test]
fn fuzzy_locates_end_via_suffix_after_inserted_word() {
    // The user inserted " short" inside the quote. With a non-empty suffix,
    // locate_end must extend `end` past the insertion to land before the
    // suffix — exercising the candidate-return branch in locate_end.
    let src = "Hello selectable short phrase one. More text.";
    let a = anchor(6, 28, "selectable phrase one.", "Hello ", " More text.");
    let out = resolve_anchor_with_threshold(src, &a, 60);
    match out {
        ResolveOutcome::Resolved { start, end } => {
            assert_eq!(start, 6);
            // end must land right before " More text." — i.e. at byte 34.
            assert_eq!(end, 34);
            assert_eq!(&src[start..end], "selectable short phrase one.");
        }
        _ => panic!("expected resolved with extended end, got {out:?}"),
    }
}

#[test]
fn fuzzy_orphans_when_context_below_threshold() {
    // Construct a case where Bitap finds a fuzzy match but the surrounding
    // prefix/suffix don't match the stored ones — the context-score gate
    // should orphan it.
    //
    // The pattern "alpha bravo" appears fuzzy-near the start of `src`, but
    // the stored prefix and suffix are very long and don't match the
    // surrounding context at all, so the score is well below 90%.
    let src = "alpha brovo charlie";
    let a = Anchor {
        start: 0,
        end: 11,
        exact: "alpha bravo".into(),
        prefix: "STORED_LONG_PREFIX_THAT_DOES_NOT_MATCH ".into(),
        suffix: " STORED_LONG_SUFFIX_THAT_DOES_NOT_MATCH".into(),
    };
    assert_eq!(
        resolve_anchor_with_threshold(src, &a, 90),
        ResolveOutcome::Orphan
    );
}

#[test]
fn fuzzy_with_zero_context_scores_full() {
    // When prefix and suffix are both empty and the fuzzy match locates a
    // candidate, the context-score numerator/denominator are both zero and
    // the resolver must NOT divide by zero — the implementation treats this
    // as 100% context score.
    let src = "lorem ipsem dolor";
    let a = Anchor {
        start: 0,
        end: 11,
        exact: "lorem ipsum".into(), // typo — fuzzy required
        prefix: "".into(),
        suffix: "".into(),
    };
    assert!(matches!(
        resolve_anchor_with_threshold(src, &a, 50),
        ResolveOutcome::Resolved { .. }
    ));
}
