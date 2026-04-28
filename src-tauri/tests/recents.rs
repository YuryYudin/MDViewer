use mdviewer_lib::recents::RecentsStore;
use std::fs;
use tempfile::TempDir;

fn store() -> (RecentsStore, TempDir) {
    let tmp = TempDir::new().unwrap();
    (RecentsStore::open(tmp.path()).unwrap(), tmp)
}

#[test]
fn push_moves_existing_to_top() {
    let (store, tmp) = store();
    let a = tmp.path().join("a.md");
    let b = tmp.path().join("b.md");
    fs::write(&a, "").unwrap();
    fs::write(&b, "").unwrap();

    store.push(&a).unwrap();
    store.push(&b).unwrap();
    store.push(&a).unwrap();

    let entries = store.list();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0], a.canonicalize().unwrap());
    assert_eq!(entries[1], b.canonicalize().unwrap());
}

#[test]
fn cap_of_ten() {
    let (store, tmp) = store();
    let mut paths = Vec::new();
    for i in 0..15 {
        let p = tmp.path().join(format!("f{i}.md"));
        fs::write(&p, "").unwrap();
        store.push(&p).unwrap();
        // `push` canonicalizes — on macOS, /var/folders/.. canonicalizes to
        // /private/var/folders/.. so we compare against the canonical form.
        paths.push(p.canonicalize().unwrap());
    }
    let entries = store.list();
    assert_eq!(entries.len(), 10);
    // Most-recently pushed first.
    assert_eq!(entries[0], paths[14]);
    assert_eq!(entries[9], paths[5]);
}

#[test]
fn missing_paths_are_pruned_on_load() {
    // Pruning is verified at *load* time (RecentsStore::open), not push time —
    // we push two existing paths, then delete one, then reopen. So this test
    // only exercises the open-time existence check; it does not depend on
    // whether `push` canonicalizes the path or falls back. The fall-back lives
    // in a separate unit test.
    let (store, tmp) = store();
    let kept = tmp.path().join("kept.md");
    let gone = tmp.path().join("gone.md");
    fs::write(&kept, "").unwrap();
    fs::write(&gone, "").unwrap();
    store.push(&kept).unwrap();
    store.push(&gone).unwrap();
    fs::remove_file(&gone).unwrap();

    let reopened = RecentsStore::open(tmp.path()).unwrap();
    assert_eq!(reopened.list(), vec![kept.canonicalize().unwrap()]);
}

#[test]
fn push_falls_back_when_canonicalize_fails() {
    // When the path doesn't exist, canonicalize() will fail; push should
    // fall back to the path as-given. We can still observe this on list()
    // because the in-memory list is not pruned by push.
    let (store, tmp) = store();
    let nonexistent = tmp.path().join("does_not_exist.md");
    store.push(&nonexistent).unwrap();
    let entries = store.list();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0], nonexistent);
}
