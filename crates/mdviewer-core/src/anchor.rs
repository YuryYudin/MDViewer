//! Anchor model: W3C TextQuoteSelector + TextPositionSelector flattened into
//! a single record. Phase-1 scope is exact-match resolution only; Phase-2
//! (B1) layers fuzzy reattachment scored against a configurable threshold.
//!
//! ## Phase 2 crate decision (recorded by B1)
//!
//! Benchmarked on a 110 KB synthetic document (`lorem ipsem ...` repeated
//! 2_000 times) with `cargo bench --bench anchor_bench -- --quick`. The
//! fixture deliberately mistypes "ipsum" as "ipsem" so the exact-match
//! short-circuit cannot fire — every iteration goes through the Bitap
//! fuzzy path:
//!   - `diff-match-patch-rs` 0.4: ~200 µs / iter (measured locally at
//!     202 µs ± 1 µs; see `benches/anchor_bench.rs`).
//!   - `dissimilar` 1.0:          comparable order of magnitude per the
//!     crate's published README benchmarks for line/word-level diffs. We
//!     do NOT dual-wire because `dissimilar`'s API surface lacks a Bitap
//!     `match_main` equivalent — replicating it would require a parallel
//!     implementation that defeats the point of choosing a library.
//!
//! `diff-match-patch-rs` ships the Bitap-based `match_main` API directly
//! (locate fuzzy occurrences with a `match_threshold` knob), which is
//! exactly the primitive `resolve_anchor_with_threshold` needs. The cost
//! is paid only on doc-open and on save — well below human-perceptible
//! latency at this fixture size. We lock `diff-match-patch-rs = "0.4"`.

use diff_match_patch_rs::{DiffMatchPatch, Efficient};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct Anchor {
    /// Byte offset of the exact match's start in the most recently saved source.
    pub start: usize,
    /// Byte offset of the exact match's end (exclusive).
    pub end: usize,
    /// The selected text verbatim.
    pub exact: String,
    /// Up to ~32 chars of context preceding `exact` for disambiguation.
    pub prefix: String,
    /// Up to ~32 chars of context following `exact` for disambiguation.
    pub suffix: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResolveOutcome {
    Resolved { start: usize, end: usize },
    Orphan,
}

/// Phase-1 resolve: locate `anchor.exact` in `source` using prefix/suffix
/// disambiguation when there are multiple matches. Returns `Orphan` when the
/// quote is not present verbatim. Phase-2 will add a fuzzy fallback before
/// declaring orphan.
pub fn resolve_anchor(source: &str, anchor: &Anchor) -> ResolveOutcome {
    if anchor.exact.is_empty() {
        return ResolveOutcome::Orphan;
    }

    // Collect all exact-quote candidate ranges.
    let mut candidates: Vec<(usize, usize)> = Vec::new();
    let mut search_from = 0;
    while let Some(idx) = source[search_from..].find(&anchor.exact) {
        let abs_start = search_from + idx;
        let abs_end = abs_start + anchor.exact.len();
        candidates.push((abs_start, abs_end));
        // Advance by the byte-length of the char at abs_start so we never
        // land inside a multi-byte UTF-8 sequence (str::find / slicing
        // panic on non-char-boundary indices). For ASCII this is +1; for
        // CJK or emoji it's +2..4. Falls back to +1 only when abs_start
        // is past the end (shouldn't happen here since find returned Some).
        let step = source[abs_start..]
            .chars()
            .next()
            .map(|c| c.len_utf8())
            .unwrap_or(1);
        search_from = abs_start + step;
    }
    if candidates.is_empty() {
        return ResolveOutcome::Orphan;
    }

    // Single candidate — done.
    if candidates.len() == 1 {
        let (s, e) = candidates[0];
        if !is_char_boundary_pair(source, s, e) {
            return ResolveOutcome::Orphan;
        }
        return ResolveOutcome::Resolved { start: s, end: e };
    }

    // Multiple candidates: score by prefix/suffix match length, then prefer
    // the candidate closest to the stored offset as a tiebreak.
    let scored = candidates.into_iter().map(|(s, e)| {
        let pre_score = matching_suffix_len(&source[..s], &anchor.prefix);
        let suf_score = matching_prefix_len(&source[e..], &anchor.suffix);
        let score = pre_score + suf_score;
        let dist = (s as isize - anchor.start as isize).unsigned_abs();
        (score, std::cmp::Reverse(dist), s, e)
    });

    let best = scored.max_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    if let Some((_, _, s, e)) = best {
        if is_char_boundary_pair(source, s, e) {
            return ResolveOutcome::Resolved { start: s, end: e };
        }
    }
    ResolveOutcome::Orphan
}

/// Phase-2 resolve: try exact match first; if that returns Orphan, fall back
/// to a Bitap fuzzy match via `diff-match-patch-rs::DiffMatchPatch::match_main`
/// scored against the user-configured `threshold_pct` (1..=100).
///
/// `threshold_pct` is a percentage where higher means stricter. We translate
/// it into the `match_threshold` knob that diff-match-patch exposes (where
/// 0.0 means exact and 1.0 means anything matches) via
/// `match_threshold = 1.0 - threshold_pct / 100`. Below the configured
/// threshold the result is `Orphan`.
pub fn resolve_anchor_with_threshold(
    source: &str,
    anchor: &Anchor,
    threshold_pct: u8,
) -> ResolveOutcome {
    if anchor.exact.is_empty() {
        return ResolveOutcome::Orphan;
    }

    // Step 1: exact resolve (Phase-1 path) — this also handles
    // prefix/suffix-disambiguated multi-match cases.
    if let ResolveOutcome::Resolved { start, end } = resolve_anchor(source, anchor) {
        return ResolveOutcome::Resolved { start, end };
    }

    // Step 2: fuzzy fallback via Bitap.
    let mut dmp = DiffMatchPatch::new();
    // Higher threshold_pct = stricter; map to lower match_threshold.
    let threshold_pct = threshold_pct.clamp(1, 100);
    let match_threshold = 1.0_f32 - (threshold_pct as f32 / 100.0_f32);
    dmp.set_match_threshold(match_threshold);

    // Stale-offset guard: anchor.start is from a prior save and may exceed
    // source.len() after deletions. Bitap implementations vary on how they
    // handle out-of-range loc, so we clamp.
    let start_hint = anchor.start.min(source.len());

    // `Efficient` (= u8) operates on bytes; both `start_hint` and the
    // returned location are byte offsets — matching our Anchor model.
    let loc = dmp.match_main::<Efficient>(source, &anchor.exact, start_hint);
    let Some(mut start) = loc else {
        return ResolveOutcome::Orphan;
    };
    // Snap `start` onto a char boundary — Bitap operates on bytes and may
    // land mid-codepoint on multibyte input. Walk left to the nearest
    // boundary (0 is always a boundary, so this terminates).
    while start > 0 && !source.is_char_boundary(start) {
        start -= 1;
    }

    // Determine `end`: Bitap allows insertions inside the matched window, so
    // `start + anchor.exact.len()` may fall short of the natural quote-end
    // when the user inserted words inside the quote. Locate the stored
    // `suffix` in a small window after `start` and use that to anchor `end`.
    // Falls back to `start + anchor.exact.len()` when no suffix is configured
    // or none is found in the window.
    let nominal_end = (start + anchor.exact.len()).min(source.len());
    let end = locate_end(source, start, nominal_end, &anchor.suffix);
    // `locate_end` never returns past `source.len()` (the window is clamped),
    // but the resulting `end` may still land mid-codepoint if `suffix` was
    // found at a non-boundary index.
    if !source.is_char_boundary(end) {
        return ResolveOutcome::Orphan;
    }

    // Score the surrounding context against the stored prefix/suffix. With
    // the quote replaced this should drop below threshold and orphan.
    let pre_score = matching_suffix_len(&source[..start], &anchor.prefix);
    let suf_score = matching_prefix_len(&source[end..], &anchor.suffix);
    let context_len = anchor.prefix.len() + anchor.suffix.len();
    let context_score_pct: u8 = if context_len == 0 {
        100
    } else {
        (((pre_score + suf_score) * 100) / context_len) as u8
    };
    if context_score_pct < threshold_pct {
        return ResolveOutcome::Orphan;
    }

    ResolveOutcome::Resolved { start, end }
}

/// Locate a reasonable byte offset for the end of a fuzzy quote starting at
/// `start`. Bitap can match a pattern even when the user inserted words
/// inside the quote, so `start + anchor.exact.len()` may fall short of the
/// real quote-end. We search for the stored `suffix` within a window of
/// twice the nominal quote length immediately after `start` and, if found,
/// use its position as `end`. Falls back to `nominal_end` when there is no
/// suffix or no match.
fn locate_end(source: &str, start: usize, nominal_end: usize, suffix: &str) -> usize {
    if suffix.is_empty() || start >= source.len() {
        return nominal_end;
    }
    // Window absorbs up to one full pattern-length of insertions.
    let span = nominal_end.saturating_sub(start).max(8);
    let window_end = (start + 2 * span).min(source.len());
    let window = &source[start..window_end];
    if let Some(idx) = window.find(suffix) {
        let candidate = start + idx;
        if source.is_char_boundary(candidate) {
            return candidate;
        }
    }
    nominal_end
}

fn matching_suffix_len(haystack: &str, needle: &str) -> usize {
    // How many bytes of `needle`'s tail also appear at the end of `haystack`.
    let mut n = needle.len().min(haystack.len());
    while n > 0 {
        if haystack.is_char_boundary(haystack.len() - n)
            && needle.is_char_boundary(needle.len() - n)
            && haystack.ends_with(&needle[needle.len() - n..])
        {
            return n;
        }
        n -= 1;
    }
    0
}

fn matching_prefix_len(haystack: &str, needle: &str) -> usize {
    let mut n = needle.len().min(haystack.len());
    while n > 0 {
        if haystack.is_char_boundary(n) && needle.is_char_boundary(n) && haystack.starts_with(&needle[..n]) {
            return n;
        }
        n -= 1;
    }
    0
}

fn is_char_boundary_pair(s: &str, start: usize, end: usize) -> bool {
    end <= s.len() && s.is_char_boundary(start) && s.is_char_boundary(end)
}
