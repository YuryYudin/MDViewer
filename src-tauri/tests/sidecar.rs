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
fn round_trips_through_disk_with_schema_v2_header() {
    // C1 promotes the on-disk format to v2 (Automerge envelope). The
    // round-trip coverage stays the same; only the version literal changes
    // and the assertion now parses the JSON envelope rather than scanning
    // the raw bytes.
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

    let raw = std::fs::read(&path).unwrap();
    let envelope: serde_json::Value =
        serde_json::from_slice(&raw).expect("v2 envelope is JSON");
    assert_eq!(envelope["schema_version"], 2);

    let loaded = load_sidecar(&path).unwrap();
    assert_eq!(loaded.list_threads().len(), 1);
}

#[test]
fn writes_v2_with_automerge_payload() {
    let tmp = TempDir::new().unwrap();
    let md = tmp.path().join("doc.md");
    std::fs::write(&md, "x").unwrap();
    let mut store = CommentsStore::new();
    store.create_thread(NewThread {
        anchor: anchor(),
        first_comment: NewComment {
            author: "A".into(),
            color: "#f80".into(),
            body: "hi".into(),
        },
    });

    let sc = sidecar_path(&md, "{name}.md.comments.json");
    save_sidecar(&sc, &store).unwrap();

    let bytes = std::fs::read(&sc).unwrap();
    // The on-disk envelope is JSON containing schema_version + base64(automerge bytes).
    let envelope: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(envelope["schema_version"], 2);
    assert!(envelope["automerge"].is_string());
    let am_b64 = envelope["automerge"].as_str().unwrap();
    assert!(!am_b64.is_empty(), "automerge payload should not be empty");
}

#[test]
fn loads_v1_and_round_trips_to_v2_on_next_save() {
    let tmp = TempDir::new().unwrap();
    let md = tmp.path().join("doc.md");
    std::fs::write(&md, "x").unwrap();
    let sc = sidecar_path(&md, "{name}.md.comments.json");

    // Hand-write a v1 file with one thread.
    let v1 = r##"{
        "schema_version": 1,
        "threads": [{
            "id": "t-1", "anchor": {"start":0,"end":5,"exact":"hello","prefix":"","suffix":""},
            "comments": [{"id":"c-1","author":"A","color":"#f80","body":"hi","created_at":"2025-01-01T00:00:00Z"}],
            "resolved": false
        }]
    }"##;
    std::fs::write(&sc, v1).unwrap();

    let store = load_sidecar(&sc).unwrap();
    assert_eq!(store.list_threads().len(), 1);
    assert_eq!(store.list_threads()[0].id, "t-1"); // ID preserved
    assert_eq!(store.list_threads()[0].comments[0].id, "c-1");

    // First save rewrites as v2.
    save_sidecar(&sc, &store).unwrap();
    let envelope: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&sc).unwrap()).unwrap();
    assert_eq!(envelope["schema_version"], 2);

    // Reload yields the same thread set.
    let reloaded = load_sidecar(&sc).unwrap();
    assert_eq!(reloaded.list_threads().len(), 1);
    assert_eq!(reloaded.list_threads()[0].id, "t-1");
    assert_eq!(reloaded.list_threads()[0].comments[0].id, "c-1");
    assert_eq!(reloaded.list_threads()[0].comments[0].body, "hi");
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
    // C1 introduces v2 (Automerge envelope); both v1 and v2 are accepted.
    // Anything beyond that must bail rather than silently mishandle a future
    // format. We use schema_version: 99 as a stand-in for "from the future".
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("future.md.comments.json");
    std::fs::write(&path, r#"{"schema_version": 99, "threads": []}"#).unwrap();
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
fn merge_policy_always_unions_threads_from_both_sides() {
    // C1 promoted Auto-merge=Always from the Phase-1 newest-mtime rule to a
    // CRDT union. Two distinct threads from local + two distinct threads
    // from incoming converge to all four — neither side loses work.
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

    // The `incoming_is_newer` flag is retained for API compatibility but
    // is no longer consulted under Always — the CRDT merge is order-free.
    let outcome = merge_with_policy(local, incoming, AutoMergeMode::Always, true);
    match outcome {
        MergeOutcome::Adopted(s) => assert_eq!(s.list_threads().len(), 3),
        MergeOutcome::AskUser { .. } => panic!("Always must not ask"),
    }
}

#[test]
fn merge_policy_always_keeps_local_threads_when_incoming_is_empty() {
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
