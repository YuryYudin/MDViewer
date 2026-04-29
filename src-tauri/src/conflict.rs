//! Line-anchored conflict diff between a "local" and "incoming" markdown
//! buffer. The output is a `Vec<Hunk>` where each hunk carries both sides
//! of the change plus its line range so the frontend (Conflict.ts) can
//! render Accept Left / Accept Right / Hand-edit controls per hunk.
//!
//! ## Why line granularity, not character
//!
//! The wireframe (08-conflict-diff.html) presents each hunk as two side-
//! by-side `<pre>` blocks with whole-row buttons. Character-level diffs
//! would force the UI into intra-line tokenization and an Accept-Range
//! gesture that's hard to operate. The `similar` crate's
//! `TextDiff::from_lines` already does the heavy lifting; this module
//! coalesces consecutive Insert/Delete changes into single hunks and
//! classifies each as Added / Removed / Conflicting.

use serde::{Deserialize, Serialize};
use similar::{ChangeTag, TextDiff};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum HunkKind {
    /// Both sides changed the same span — user must pick.
    Conflicting,
    /// Only `incoming` added lines here; `local` has nothing to lose.
    Added,
    /// Only `local` had these lines; `incoming` removed them.
    Removed,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct Hunk {
    pub kind: HunkKind,
    pub local_text: String,
    pub incoming_text: String,
    /// Line range in `local` as (start_inclusive, end_exclusive).
    pub local_range: (usize, usize),
    /// Line range in `incoming` as (start_inclusive, end_exclusive).
    pub incoming_range: (usize, usize),
}

/// Diff `local` against `incoming` line-by-line. Equal lines are skipped;
/// runs of Insert/Delete are coalesced into a single Hunk whose `kind`
/// upgrades to `Conflicting` whenever both directions appear in the same
/// run (i.e. the hunk has both `local_text` and `incoming_text`).
pub fn diff_md(local: &str, incoming: &str) -> Vec<Hunk> {
    let diff = TextDiff::from_lines(local, incoming);
    let mut hunks: Vec<Hunk> = Vec::new();
    let mut local_line = 0usize;
    let mut incoming_line = 0usize;
    let mut buffered: Option<Hunk> = None;

    for change in diff.iter_all_changes() {
        match change.tag() {
            ChangeTag::Equal => {
                if let Some(h) = buffered.take() {
                    hunks.push(h);
                }
                local_line += 1;
                incoming_line += 1;
            }
            ChangeTag::Delete => {
                let h = buffered.get_or_insert_with(|| Hunk {
                    kind: HunkKind::Removed,
                    local_text: String::new(),
                    incoming_text: String::new(),
                    local_range: (local_line, local_line),
                    incoming_range: (incoming_line, incoming_line),
                });
                h.local_text.push_str(change.value());
                h.local_range.1 = local_line + 1;
                local_line += 1;
                if matches!(h.kind, HunkKind::Added) {
                    h.kind = HunkKind::Conflicting;
                }
            }
            ChangeTag::Insert => {
                let h = buffered.get_or_insert_with(|| Hunk {
                    kind: HunkKind::Added,
                    local_text: String::new(),
                    incoming_text: String::new(),
                    local_range: (local_line, local_line),
                    incoming_range: (incoming_line, incoming_line),
                });
                h.incoming_text.push_str(change.value());
                h.incoming_range.1 = incoming_line + 1;
                incoming_line += 1;
                if matches!(h.kind, HunkKind::Removed) {
                    h.kind = HunkKind::Conflicting;
                }
            }
        }
    }
    if let Some(h) = buffered {
        hunks.push(h);
    }
    hunks
}
