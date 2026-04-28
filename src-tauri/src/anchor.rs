//! Anchor model: W3C TextQuoteSelector + TextPositionSelector flattened into
//! a single record. Phase-1 scope is exact-match resolution only; Phase-2
//! (B1) layers fuzzy reattachment scored against a configurable threshold.

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
        search_from = abs_start + 1; // overlapping search
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
