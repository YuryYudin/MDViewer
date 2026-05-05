//! A5: thin desktop wrapper still resolves paths and round-trips through
//! `std::fs`. This is the boundary integration test — it asserts the
//! wrapper actually delegates to `mdviewer_core::sidecar` (rather than
//! re-implementing the dispatch) by writing bytes via the path-form
//! API and reading them back via the bytes-form API in core.

use mdviewer_core::sidecar::load_sidecar_bytes;
use mdviewer_lib::anchor::Anchor;
use mdviewer_lib::comments::{CommentsStore, NewComment, NewThread};
use mdviewer_lib::sidecar::{load_sidecar, save_sidecar};
use tempfile::TempDir;

fn anchor() -> Anchor {
    Anchor {
        start: 0,
        end: 5,
        exact: "Hello".into(),
        prefix: String::new(),
        suffix: " world".into(),
    }
}

#[test]
fn save_then_load_via_path_round_trips() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("notes.md.comments.json");

    let mut store = CommentsStore::new();
    let created = store.create_thread(NewThread {
        anchor: anchor(),
        first_comment: NewComment {
            author: "Alice".into(),
            color: "#f80".into(),
            body: "hi".into(),
        },
    });

    save_sidecar(&path, &store).unwrap();
    let restored = load_sidecar(&path).unwrap();

    assert_eq!(restored.list_threads().len(), 1);
    assert_eq!(restored.list_threads()[0].id, created.id);
}

#[test]
fn wrapper_writes_same_bytes_core_reads() {
    // Boundary check: the desktop wrapper's on-disk bytes are decodable by
    // `mdviewer_core::sidecar::load_sidecar_bytes` directly — there is no
    // hidden path-only framing that Android would miss.
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("doc.md.comments.json");

    let mut store = CommentsStore::new();
    store.create_thread(NewThread {
        anchor: anchor(),
        first_comment: NewComment {
            author: "Bob".into(),
            color: "#08f".into(),
            body: "from desktop".into(),
        },
    });
    save_sidecar(&path, &store).unwrap();

    let raw = std::fs::read(&path).unwrap();
    let via_core = load_sidecar_bytes(&raw).unwrap();
    assert_eq!(via_core.list_threads().len(), 1);
    assert_eq!(via_core.list_threads()[0].comments[0].body, "from desktop");
}
