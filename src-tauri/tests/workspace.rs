use mdviewer_lib::workspace::{OpenOpts, OpenOutcome, Workspace};
use std::fs;
use tempfile::TempDir;

fn fresh() -> (Workspace, TempDir) {
    let tmp = TempDir::new().unwrap();
    let ws = Workspace::new(tmp.path()).unwrap();
    (ws, tmp)
}

fn open_doc(ws: &mut Workspace, path: &std::path::Path) -> mdviewer_lib::workspace::OpenResult {
    match ws.open_document(path, OpenOpts::default()).unwrap() {
        OpenOutcome::Document(r) => r,
        OpenOutcome::Conflict { .. } => panic!("expected document, got conflict"),
    }
}

#[test]
fn open_loads_md_and_returns_html_plus_threads() {
    let (mut ws, tmp) = fresh();
    let md = tmp.path().join("a.md");
    fs::write(&md, "# Hello\n\nbody.").unwrap();
    let opened = open_doc(&mut ws, &md);
    assert!(opened.html.contains("<h1>"));
    assert_eq!(opened.threads.len(), 0);
    assert_eq!(ws.list_open_documents().len(), 1);
    assert_eq!(ws.active_tab_id(), Some(opened.tab_id.as_str()));
}

#[test]
fn two_tabs_keep_independent_state() {
    let (mut ws, tmp) = fresh();
    let a = tmp.path().join("a.md");
    fs::write(&a, "# A").unwrap();
    let b = tmp.path().join("b.md");
    fs::write(&b, "# B").unwrap();
    let oa = open_doc(&mut ws, &a);
    let ob = open_doc(&mut ws, &b);
    assert_eq!(ws.list_open_documents().len(), 2);
    assert_eq!(ws.active_tab_id(), Some(ob.tab_id.as_str()));
    ws.activate_tab(&oa.tab_id).unwrap();
    assert_eq!(ws.active_tab_id(), Some(oa.tab_id.as_str()));
    ws.close_tab(&oa.tab_id).unwrap();
    assert_eq!(ws.list_open_documents().len(), 1);
    assert_eq!(ws.active_tab_id(), Some(ob.tab_id.as_str()));
}

#[test]
fn opening_same_path_returns_existing_tab() {
    let (mut ws, tmp) = fresh();
    let md = tmp.path().join("a.md");
    fs::write(&md, "# A").unwrap();
    let first = open_doc(&mut ws, &md);
    let second = open_doc(&mut ws, &md);
    assert_eq!(first.tab_id, second.tab_id);
    assert_eq!(ws.list_open_documents().len(), 1);
}

#[test]
fn comments_for_returns_per_tab_store() {
    let (mut ws, tmp) = fresh();
    let md = tmp.path().join("a.md");
    fs::write(&md, "# A").unwrap();
    let opened = open_doc(&mut ws, &md);
    let store = ws.comments_for(&opened.tab_id).unwrap();
    assert_eq!(store.list_threads().len(), 0);
}

#[test]
fn resolve_anchor_for_tab_returns_resolved_for_exact_quote() {
    use mdviewer_lib::anchor::{Anchor, ResolveOutcome};
    let (mut ws, tmp) = fresh();
    let md = tmp.path().join("a.md");
    fs::write(&md, "alpha beta gamma").unwrap();
    let opened = open_doc(&mut ws, &md);
    let outcome = ws
        .resolve_anchor_for_tab(
            &opened.tab_id,
            &Anchor {
                start: 6,
                end: 10,
                exact: "beta".into(),
                prefix: "alpha ".into(),
                suffix: " gamma".into(),
            },
        )
        .unwrap();
    assert!(matches!(outcome, ResolveOutcome::Resolved { .. }));
}

#[test]
fn activate_tab_errors_when_id_unknown() {
    // Covers the `bail!` branch in activate_tab — unknown id must error
    // rather than silently mutate the active pointer.
    let (mut ws, _tmp) = fresh();
    let err = ws.activate_tab("tab-does-not-exist").unwrap_err();
    assert!(err.to_string().contains("no such tab"));
    assert_eq!(ws.active_tab_id(), None);
}

#[test]
fn comments_for_errors_when_tab_id_unknown() {
    let (ws, _tmp) = fresh();
    let err = ws.comments_for("tab-missing").unwrap_err();
    assert!(err.to_string().contains("no such tab"));
}

#[test]
fn comments_for_mut_returns_writable_store_and_errors_when_unknown() {
    use mdviewer_lib::anchor::Anchor;
    use mdviewer_lib::comments::{NewComment, NewThread};

    let (mut ws, tmp) = fresh();
    let md = tmp.path().join("a.md");
    fs::write(&md, "# A").unwrap();
    let opened = open_doc(&mut ws, &md);

    // happy path: write through comments_for_mut and observe via comments_for.
    let store = ws.comments_for_mut(&opened.tab_id).unwrap();
    let _ = store.create_thread(NewThread {
        anchor: Anchor {
            start: 0,
            end: 1,
            exact: "#".into(),
            prefix: "".into(),
            suffix: " A".into(),
        },
        first_comment: NewComment {
            author: "A".into(),
            color: "#000".into(),
            body: "hi".into(),
        },
    });
    assert_eq!(ws.comments_for(&opened.tab_id).unwrap().list_threads().len(), 1);

    // error path: missing tab id.
    let err = ws.comments_for_mut("tab-missing").unwrap_err();
    assert!(err.to_string().contains("no such tab"));
}

#[test]
fn resolve_anchor_for_tab_errors_when_tab_unknown() {
    use mdviewer_lib::anchor::Anchor;
    let (ws, _tmp) = fresh();
    let err = ws
        .resolve_anchor_for_tab(
            "tab-missing",
            &Anchor {
                start: 0,
                end: 0,
                exact: "x".into(),
                prefix: "".into(),
                suffix: "".into(),
            },
        )
        .unwrap_err();
    assert!(err.to_string().contains("no such tab"));
}

#[test]
fn store_accessors_expose_settings_and_recents() {
    // Covers settings_store / settings_store_mut / recents_store.
    let (mut ws, tmp) = fresh();

    // settings_store: read snapshot.
    let before = ws.settings_store().get();
    assert_eq!(before.appearance.font_size_px, 14);

    // settings_store_mut: mutate via update; readback shows new value.
    ws.settings_store_mut()
        .update(|s| {
            s.appearance.font_size_px = 18;
        })
        .unwrap();
    assert_eq!(ws.settings_store().get().appearance.font_size_px, 18);

    // recents_store: empty until we open a doc, then contains the path.
    assert!(ws.recents_store().list().is_empty());
    let md = tmp.path().join("a.md");
    fs::write(&md, "# A").unwrap();
    let _ = open_doc(&mut ws, &md);
    let recents = ws.recents_store().list();
    assert_eq!(recents.len(), 1);
}

#[test]
fn opening_md_with_existing_sidecar_loads_all_threads_anchored() {
    // Success criterion 5: "hand a counterpart their .md plus its sidecar,
    // and when the counterpart opens the .md all existing threads appear
    // correctly anchored." This is delivered in Phase 1 — verify it here.
    let (mut ws, tmp) = fresh();
    let md = tmp.path().join("doc.md");
    fs::write(&md, "alpha beta gamma\nDelta epsilon zeta\n").unwrap();
    let sidecar = tmp.path().join("doc.md.comments.json");
    fs::write(
        &sidecar,
        r##"{
        "schema_version": 1,
        "threads": [
            {"id": "t-1", "anchor": {"start": 6, "end": 10, "exact": "beta", "prefix": "alpha ", "suffix": " gamma"},
             "comments": [{"id": "c-1", "author": "Alice", "color": "#f80", "body": "hi", "created_at": "2026-04-01T00:00:00Z"}],
             "resolved": false},
            {"id": "t-2", "anchor": {"start": 23, "end": 31, "exact": "epsilon", "prefix": "Delta ", "suffix": " zeta"},
             "comments": [{"id": "c-2", "author": "Bob", "color": "#08f", "body": "thoughts?", "created_at": "2026-04-01T01:00:00Z"}],
             "resolved": false}
        ]
    }"##,
    )
    .unwrap();

    let opened = open_doc(&mut ws, &md);
    assert_eq!(
        opened.threads.len(),
        2,
        "both threads should load from the sidecar"
    );
    let ids: Vec<&str> = opened.threads.iter().map(|t| t.id.as_str()).collect();
    assert!(ids.contains(&"t-1") && ids.contains(&"t-2"));

    // Both anchors must resolve against the document text — not orphan.
    use mdviewer_lib::anchor::ResolveOutcome;
    for t in &opened.threads {
        let outcome = ws.resolve_anchor_for_tab(&opened.tab_id, &t.anchor).unwrap();
        assert!(
            matches!(outcome, ResolveOutcome::Resolved { .. }),
            "thread {} should resolve, got {:?}",
            t.id,
            outcome
        );
    }
}
