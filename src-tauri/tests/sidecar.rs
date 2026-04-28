use mdviewer_lib::anchor::Anchor;
use mdviewer_lib::comments::{CommentsStore, MergeOutcome, NewComment, NewThread};
use mdviewer_lib::settings::AutoMergeMode;
use mdviewer_lib::sidecar::{load_sidecar, merge_with_policy, save_sidecar, sidecar_path};
use tempfile::TempDir;

fn anchor() -> Anchor {
    Anchor {
        start: 0,
        end: 5,
        exact: "Hello".into(),
        prefix: "".into(),
        suffix: " world".into(),
    }
}

#[test]
fn round_trips_through_disk_with_schema_v1_header() {
    let tmp = TempDir::new().unwrap();
    let md = tmp.path().join("sample.md");
    std::fs::write(&md, "Hello world").unwrap();

    let mut store = CommentsStore::new();
    let _ = store.create_thread(NewThread {
        anchor: anchor(),
        first_comment: NewComment {
            author: "Alice".into(),
            color: "#f80".into(),
            body: "hi".into(),
        },
    });

    let pattern = "{name}.md.comments.json";
    let path = sidecar_path(&md, pattern);
    save_sidecar(&path, &store).unwrap();

    let raw = std::fs::read_to_string(&path).unwrap();
    assert!(
        raw.contains("\"schema_version\": 1"),
        "v1 header expected: {raw}"
    );

    let loaded = load_sidecar(&path).unwrap();
    assert_eq!(loaded.list_threads().len(), 1);
}

#[test]
fn missing_sidecar_yields_empty_store() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("missing.md.comments.json");
    let store = load_sidecar(&path).unwrap();
    assert!(store.list_threads().is_empty());
}

#[test]
fn sidecar_path_honors_pattern() {
    let p = std::path::PathBuf::from("/docs/spec.md");
    assert_eq!(
        sidecar_path(&p, "{name}.md.comments.json"),
        std::path::PathBuf::from("/docs/spec.md.comments.json")
    );
    assert_eq!(
        sidecar_path(&p, ".{name}.comments"),
        std::path::PathBuf::from("/docs/.spec.comments")
    );
}

#[test]
fn load_sidecar_rejects_unknown_schema_version() {
    // Phase-1 only knows v1. v2 lands with C1 and a migration test, so we
    // explicitly bail rather than silently treating v2 as v1 (which would
    // drop unknown fields and corrupt the sidecar on re-save).
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("future.md.comments.json");
    std::fs::write(&path, r#"{"schema_version": 2, "threads": []}"#).unwrap();
    let err = load_sidecar(&path).unwrap_err();
    assert!(format!("{err}").contains("unsupported schema_version"));
}

#[test]
fn load_sidecar_propagates_parse_error_for_invalid_json() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("garbage.md.comments.json");
    std::fs::write(&path, "not-valid-json").unwrap();
    let err = load_sidecar(&path).unwrap_err();
    let msg = format!("{err}");
    assert!(msg.contains("parse sidecar"), "got: {msg}");
}

#[test]
fn save_sidecar_creates_missing_parent_dirs() {
    // The caller may pass a path under a workspace folder that doesn't yet
    // exist on disk (first save of a brand-new doc). save_sidecar must
    // mkdir -p the parents instead of failing with ENOENT.
    let tmp = TempDir::new().unwrap();
    let nested = tmp.path().join("a").join("b").join("c");
    let path = nested.join("doc.md.comments.json");

    let store = CommentsStore::new();
    save_sidecar(&path, &store).unwrap();
    assert!(path.exists());
}

#[test]
fn merge_policy_always_picks_newer_side() {
    let mut local = CommentsStore::new();
    let _ = local.create_thread(NewThread {
        anchor: anchor(),
        first_comment: NewComment {
            author: "Local".into(),
            color: "#f00".into(),
            body: "local".into(),
        },
    });

    let mut incoming = CommentsStore::new();
    let _ = incoming.create_thread(NewThread {
        anchor: anchor(),
        first_comment: NewComment {
            author: "Remote".into(),
            color: "#0f0".into(),
            body: "remote-1".into(),
        },
    });
    let _ = incoming.create_thread(NewThread {
        anchor: anchor(),
        first_comment: NewComment {
            author: "Remote".into(),
            color: "#0f0".into(),
            body: "remote-2".into(),
        },
    });

    // incoming_is_newer = true -> caller adopts the incoming store.
    let outcome = merge_with_policy(local, incoming, AutoMergeMode::Always, true);
    match outcome {
        MergeOutcome::Adopted(s) => assert_eq!(s.list_threads().len(), 2),
        MergeOutcome::AskUser { .. } => panic!("Always must not ask"),
    }
}

#[test]
fn merge_policy_always_keeps_local_when_local_is_newer() {
    let mut local = CommentsStore::new();
    let _ = local.create_thread(NewThread {
        anchor: anchor(),
        first_comment: NewComment {
            author: "Local".into(),
            color: "#f00".into(),
            body: "local".into(),
        },
    });
    let incoming = CommentsStore::new();
    // incoming_is_newer = false -> keep local.
    let outcome = merge_with_policy(local, incoming, AutoMergeMode::Always, false);
    match outcome {
        MergeOutcome::Adopted(s) => assert_eq!(s.list_threads().len(), 1),
        MergeOutcome::AskUser { .. } => panic!("Always must not ask"),
    }
}

#[test]
fn merge_policy_ask_returns_both_sides_for_user_prompt() {
    let local = CommentsStore::new();
    let mut incoming = CommentsStore::new();
    let _ = incoming.create_thread(NewThread {
        anchor: anchor(),
        first_comment: NewComment {
            author: "Remote".into(),
            color: "#0f0".into(),
            body: "remote".into(),
        },
    });
    let outcome = merge_with_policy(local, incoming, AutoMergeMode::Ask, true);
    match outcome {
        MergeOutcome::AskUser { local, incoming } => {
            assert!(local.list_threads().is_empty());
            assert_eq!(incoming.list_threads().len(), 1);
        }
        MergeOutcome::Adopted(_) => panic!("Ask must surface both sides"),
    }
}

#[test]
fn merge_policy_manual_returns_both_sides_for_user_prompt() {
    let local = CommentsStore::new();
    let incoming = CommentsStore::new();
    let outcome = merge_with_policy(local, incoming, AutoMergeMode::Manual, false);
    assert!(matches!(outcome, MergeOutcome::AskUser { .. }));
}

#[test]
fn round_trip_preserves_distinct_threads_with_same_anchor() {
    // Design guarantee from the "Avoid" section: distinct thread IDs must
    // remain distinct across save/load even when their anchors overlap.
    // Otherwise reply IDs would dangle when C1 merges this sidecar with an
    // incoming one.
    let tmp = TempDir::new().unwrap();
    let md = tmp.path().join("doc.md");
    std::fs::write(&md, "Hello world").unwrap();

    let mut store = CommentsStore::new();
    let t1 = store.create_thread(NewThread {
        anchor: anchor(),
        first_comment: NewComment {
            author: "Alice".into(),
            color: "#f80".into(),
            body: "first take".into(),
        },
    });
    // new_id now appends an atomic counter, so back-to-back calls produce
    // distinct IDs even when the system clock has microsecond granularity.
    let t2 = store.create_thread(NewThread {
        anchor: anchor(), // identical anchor on purpose
        first_comment: NewComment {
            author: "Bob".into(),
            color: "#08f".into(),
            body: "second take".into(),
        },
    });
    assert_ne!(t1.id, t2.id, "fresh threads must have distinct ids");

    let path = sidecar_path(&md, "{name}.md.comments.json");
    save_sidecar(&path, &store).unwrap();

    let loaded = load_sidecar(&path).unwrap();
    let ids: Vec<&str> = loaded.list_threads().iter().map(|t| t.id.as_str()).collect();
    assert_eq!(ids.len(), 2, "both threads must round-trip");
    assert!(ids.contains(&t1.id.as_str()));
    assert!(ids.contains(&t2.id.as_str()));
}
