# A8a: Workspace tab manager (Rust struct + tests)

**Avoid:**
- Do NOT make `Workspace` a global singleton via `lazy_static!` or a `static`. WHY: tests need isolated state per case; tauri::State<Mutex<Workspace>> lets the runtime own one and tests construct bare instances.
- Do NOT recompute the rendered HTML on every `activate_tab`. WHY: the design caches per-tab `RenderResult`; re-rendering on every switch would block the UI thread on syntect work for large docs.
- Do NOT register Tauri IPC commands here. WHY: that work belongs to A8b. This task ships only the Workspace struct and methods. A8b will use them.
- Do NOT couple `open_document` to a recents push when the path is the active tab. WHY: opening an already-active tab should be a no-op activation; recents should reflect user intent, not internal navigation.
- Do NOT take an `AppHandle` field on Workspace. WHY: A8b will call `app.emit("show-conflict", ...)` from the IPC layer where the handle is in scope; keeping Workspace handle-free keeps tests pure-Rust.

## Steps

### Step 1: Failing test

Create `src-tauri/tests/workspace.rs`:

```rust
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
    let a = tmp.path().join("a.md"); fs::write(&a, "# A").unwrap();
    let b = tmp.path().join("b.md"); fs::write(&b, "# B").unwrap();
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
    let md = tmp.path().join("a.md"); fs::write(&md, "# A").unwrap();
    let first = open_doc(&mut ws, &md);
    let second = open_doc(&mut ws, &md);
    assert_eq!(first.tab_id, second.tab_id);
    assert_eq!(ws.list_open_documents().len(), 1);
}

#[test]
fn comments_for_returns_per_tab_store() {
    let (mut ws, tmp) = fresh();
    let md = tmp.path().join("a.md"); fs::write(&md, "# A").unwrap();
    let opened = open_doc(&mut ws, &md);
    let store = ws.comments_for(&opened.tab_id).unwrap();
    assert_eq!(store.list_threads().len(), 0);
}

#[test]
fn resolve_anchor_for_tab_returns_resolved_for_exact_quote() {
    use mdviewer_lib::anchor::{Anchor, ResolveOutcome};
    let (mut ws, tmp) = fresh();
    let md = tmp.path().join("a.md"); fs::write(&md, "alpha beta gamma").unwrap();
    let opened = open_doc(&mut ws, &md);
    let outcome = ws.resolve_anchor_for_tab(
        &opened.tab_id,
        &Anchor { start: 6, end: 10, exact: "beta".into(), prefix: "alpha ".into(), suffix: " gamma".into() },
    ).unwrap();
    assert!(matches!(outcome, ResolveOutcome::Resolved { .. }));
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
    fs::write(&sidecar, r#"{
        "schema_version": 1,
        "threads": [
            {"id": "t-1", "anchor": {"start": 6, "end": 10, "exact": "beta", "prefix": "alpha ", "suffix": " gamma"},
             "comments": [{"id": "c-1", "author": "Alice", "color": "#f80", "body": "hi", "created_at": "2026-04-01T00:00:00Z"}],
             "resolved": false},
            {"id": "t-2", "anchor": {"start": 23, "end": 31, "exact": "epsilon", "prefix": "Delta ", "suffix": " zeta"},
             "comments": [{"id": "c-2", "author": "Bob", "color": "#08f", "body": "thoughts?", "created_at": "2026-04-01T01:00:00Z"}],
             "resolved": false}
        ]
    }"#).unwrap();

    let opened = open_doc(&mut ws, &md);
    assert_eq!(opened.threads.len(), 2, "both threads should load from the sidecar");
    let ids: Vec<&str> = opened.threads.iter().map(|t| t.id.as_str()).collect();
    assert!(ids.contains(&"t-1") && ids.contains(&"t-2"));

    // Both anchors must resolve against the document text — not orphan.
    use mdviewer_lib::anchor::ResolveOutcome;
    for t in &opened.threads {
        let outcome = ws.resolve_anchor_for_tab(&opened.tab_id, &t.anchor).unwrap();
        assert!(matches!(outcome, ResolveOutcome::Resolved { .. }),
                "thread {} should resolve, got {:?}", t.id, outcome);
    }
}
```

Run — expect "no module workspace".

### Step 2: Implement workspace.rs

Create `src-tauri/src/workspace.rs`:

```rust
use crate::anchor::{self, Anchor, ResolveOutcome};
use crate::comments::{CommentsStore, NewComment, NewThread, Thread};
use crate::document::{render_markdown, RenderOptions, RenderResult};
use crate::recents::RecentsStore;
use crate::sidecar::{load_sidecar, sidecar_path};
use crate::settings::SettingsStore;
use anyhow::{Context, Result};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub struct Tab {
    pub id: String,
    pub path: PathBuf,
    pub source: String,
    pub render: RenderResult,
    pub comments: CommentsStore,
    /// Bytes most recently written by `save_document` (B3) or read at open.
    /// Used by A8b's open-time conflict detection: when the disk bytes differ
    /// from this snapshot, the IPC layer emits `show-conflict`.
    pub last_saved_snapshot: Option<String>,
}

#[derive(Default, Clone, Copy)]
pub struct OpenOpts {
    pub force_reload: bool,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct OpenResult {
    pub tab_id: String,
    pub path: PathBuf,
    pub html: String,
    pub threads: Vec<Thread>,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum OpenOutcome {
    Document(OpenResult),
    Conflict {
        tab_id: String,
        path: PathBuf,
        local: String,    // last-saved bytes (the user's view of "mine")
        incoming: String, // what's on disk now
    },
}

pub struct Workspace {
    settings: SettingsStore,
    recents: RecentsStore,
    tabs: HashMap<String, Tab>,
    order: Vec<String>,
    active: Option<String>,
}

impl Workspace {
    pub fn new(data_dir: &Path) -> Result<Self> {
        Ok(Self {
            settings: SettingsStore::open(data_dir)?,
            recents: RecentsStore::open(data_dir)?,
            tabs: HashMap::new(),
            order: Vec::new(),
            active: None,
        })
    }

    pub fn open_document(&mut self, path: &Path, _opts: OpenOpts) -> Result<OpenOutcome> {
        let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());

        // Detach the existing-tab snapshot before any &mut self mutation.
        let existing = self.find_by_path(&canonical).map(|(id, tab)| {
            (id, tab.path.clone(), tab.render.html.clone(), tab.comments.list_threads().to_vec())
        });
        if let Some((id, p, html, threads)) = existing {
            self.active = Some(id.clone());
            return Ok(OpenOutcome::Document(OpenResult { tab_id: id, path: p, html, threads }));
        }

        let source = std::fs::read_to_string(&canonical).with_context(|| format!("read {:?}", canonical))?;
        let s = self.settings.get();
        let opts = RenderOptions {
            syntax_highlighting: s.editor.syntax_highlighting,
            mermaid_enabled: s.editor.mermaid_enabled,
        };
        let render = render_markdown(&source, &opts);

        let sc_path = sidecar_path(&canonical, &s.comments.sidecar_pattern);
        let comments = load_sidecar(&sc_path).unwrap_or_else(|_| CommentsStore::new());

        let id = format!("tab-{:x}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());

        // Phase-1 always opens as Document. Phase-3's C2 widens this to also
        // detect divergence vs `last_saved_snapshot` and return Conflict.
        let result = OpenResult {
            tab_id: id.clone(),
            path: canonical.clone(),
            html: render.html.clone(),
            threads: comments.list_threads().to_vec(),
        };

        self.tabs.insert(id.clone(), Tab {
            id: id.clone(),
            path: canonical.clone(),
            source: source.clone(),
            render,
            comments,
            last_saved_snapshot: Some(source),
        });
        self.order.push(id.clone());
        self.active = Some(id.clone());
        let _ = self.recents.push(&canonical);
        Ok(OpenOutcome::Document(result))
    }

    pub fn close_tab(&mut self, id: &str) -> Result<()> {
        self.tabs.remove(id);
        self.order.retain(|x| x != id);
        if self.active.as_deref() == Some(id) {
            self.active = self.order.last().cloned();
        }
        Ok(())
    }

    pub fn activate_tab(&mut self, id: &str) -> Result<()> {
        if !self.tabs.contains_key(id) { anyhow::bail!("no such tab"); }
        self.active = Some(id.into());
        Ok(())
    }

    pub fn list_open_documents(&self) -> Vec<&Tab> {
        self.order.iter().filter_map(|id| self.tabs.get(id)).collect()
    }

    pub fn active_tab_id(&self) -> Option<&str> { self.active.as_deref() }

    fn find_by_path(&self, p: &Path) -> Option<(String, &Tab)> {
        self.tabs.iter().find(|(_, t)| t.path == p).map(|(id, t)| (id.clone(), t))
    }

    pub fn settings_store(&self) -> &SettingsStore { &self.settings }
    pub fn settings_store_mut(&mut self) -> &mut SettingsStore { &mut self.settings }
    pub fn recents_store(&self) -> &RecentsStore { &self.recents }

    pub fn comments_for(&self, tab_id: &str) -> Result<&CommentsStore> {
        self.tabs.get(tab_id).map(|t| &t.comments)
            .ok_or_else(|| anyhow::anyhow!("no such tab: {tab_id}"))
    }

    pub fn comments_for_mut(&mut self, tab_id: &str) -> Result<&mut CommentsStore> {
        self.tabs.get_mut(tab_id).map(|t| &mut t.comments)
            .ok_or_else(|| anyhow::anyhow!("no such tab: {tab_id}"))
    }

    /// Phase-1: exact-quote search. B1 widens this to read
    /// `settings.comments.reattachment_confidence` and dispatch through
    /// `anchor::resolve_anchor_with_threshold`.
    pub fn resolve_anchor_for_tab(&self, tab_id: &str, a: &Anchor) -> Result<ResolveOutcome> {
        let tab = self.tabs.get(tab_id)
            .ok_or_else(|| anyhow::anyhow!("no such tab: {tab_id}"))?;
        Ok(anchor::resolve_anchor(&tab.source, a))
    }
}
```

### Step 3: Re-export from lib.rs

Modify `src-tauri/src/lib.rs` — add `pub mod workspace;` after the existing items.

### Step 3b: Append OpenResult / OpenOutcome to the codegen export

Modify `src-tauri/src/bin/export_types.rs` (created in A2b). Append:

```rust
buf.push_str(&mdviewer_lib::workspace::OpenResult::export_to_string().unwrap());
buf.push_str("\n");
buf.push_str(&mdviewer_lib::workspace::OpenOutcome::export_to_string().unwrap());
buf.push_str("\n");
```

Run `npm run gen:types` and confirm `src/types-generated.ts` now contains `OpenResult` and the `OpenOutcome` discriminated union.

### Step 4: Verify

```bash
(cd src-tauri && cargo test --test workspace && cargo run --bin export_types --quiet)
```

Expect 6 tests passed and `src/types-generated.ts` rewritten.

### Step 4b: Verify coverage on touched files

Apply the canonical coverage check from A1 (Step 4) to `src-tauri/src/workspace.rs`. Threshold ≥90%; add tests for any uncovered branches before committing.

### Step 5: Commit

```bash
git add src-tauri/src/workspace.rs src-tauri/src/lib.rs src-tauri/src/bin/export_types.rs src-tauri/tests/workspace.rs src/types-generated.ts
git commit -m "A8a: Workspace tab manager + OpenOutcome (Document | Conflict)"
```
