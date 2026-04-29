use mdviewer_lib::conflict::{diff_md, HunkKind};

#[test]
fn detects_overlapping_changes_as_separate_hunks() {
    let local = "line 1\nline 2 local\nline 3\nline 4\n";
    let incoming = "line 1\nline 2 incoming\nline 3\nline 4 changed\n";
    let hunks = diff_md(local, incoming);
    assert_eq!(hunks.len(), 2);
    assert_eq!(hunks[0].kind, HunkKind::Conflicting);
    assert!(hunks[0].local_text.contains("local"));
    assert!(hunks[0].incoming_text.contains("incoming"));
    assert_eq!(hunks[1].kind, HunkKind::Conflicting);
    assert!(hunks[1].local_text.contains("line 4"));
    assert!(hunks[1].incoming_text.contains("line 4 changed"));
}

#[test]
fn identical_inputs_yield_no_hunks() {
    let s = "alpha\nbeta\n";
    assert!(diff_md(s, s).is_empty());
}

#[test]
fn pure_addition_emits_added_hunk() {
    let local = "line 1\nline 2\n";
    let incoming = "line 1\nline 2\nline 3\n";
    let hunks = diff_md(local, incoming);
    assert_eq!(hunks.len(), 1);
    assert_eq!(hunks[0].kind, HunkKind::Added);
    assert!(hunks[0].local_text.is_empty());
    assert!(hunks[0].incoming_text.contains("line 3"));
}

#[test]
fn pure_deletion_emits_removed_hunk() {
    let local = "line 1\nline 2\nline 3\n";
    let incoming = "line 1\nline 3\n";
    let hunks = diff_md(local, incoming);
    assert_eq!(hunks.len(), 1);
    assert_eq!(hunks[0].kind, HunkKind::Removed);
    assert!(hunks[0].local_text.contains("line 2"));
    assert!(hunks[0].incoming_text.is_empty());
}

#[test]
fn line_ranges_are_zero_indexed_half_open() {
    // Hunk spans local lines [1,2) and incoming lines [1,2): exactly one
    // line replaced on each side. Half-open ranges keep the JS-side merge
    // helper's slice math straightforward.
    let local = "a\nb\nc\n";
    let incoming = "a\nB\nc\n";
    let hunks = diff_md(local, incoming);
    assert_eq!(hunks.len(), 1);
    assert_eq!(hunks[0].local_range, (1, 2));
    assert_eq!(hunks[0].incoming_range, (1, 2));
}

#[test]
fn empty_local_against_nonempty_incoming_is_one_added_hunk() {
    let hunks = diff_md("", "x\ny\n");
    assert_eq!(hunks.len(), 1);
    assert_eq!(hunks[0].kind, HunkKind::Added);
}

#[test]
fn nonempty_local_against_empty_incoming_is_one_removed_hunk() {
    let hunks = diff_md("x\ny\n", "");
    assert_eq!(hunks.len(), 1);
    assert_eq!(hunks[0].kind, HunkKind::Removed);
}
