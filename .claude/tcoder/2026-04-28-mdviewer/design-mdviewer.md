# MDViewer — Cross-Platform Markdown Viewer with Collaborative Comments

## Problem

Technical teams keep specifications, RFCs, design notes, and onboarding material as `.md` files on disk and in repositories because plain markdown is durable, diffable, and survives every tool change. But review and discussion of those documents is friction-heavy:

- General-purpose markdown editors (Obsidian, Typora, VS Code) render `.md` well but have no native commenting that travels with the file.
- GitHub PR review requires the document to live in a repo, ties comments to source-line numbers (fragile across edits), and locks discussion to the PR lifecycle.
- Google Docs supports rich review but forces conversion away from `.md`, breaking the on-disk workflow and causing drift.
- Real-time collaboration tools require a server, an account, and network availability — too heavyweight for a small team passing a design doc around.

The result: reviewers paste prose into Slack threads, comment in the PR even when the doc isn't ready for one, or copy the file into Google Docs and never sync back. Every workaround loses fidelity, slows the cycle, or fragments the review history. There is no lightweight desktop tool that lets two or three reviewers discuss a markdown file in place and exchange that discussion without standing up infrastructure.

## Goal

Ship a cross-platform native desktop app that renders `.md` files, lets users add threaded comments anchored to selected text, and exchanges document plus comments asynchronously via files alone — no server, no account.

## Success Criteria

All criteria assume both collaborators run MDViewer; see the Phase mapping below for which phase delivers each.

1. A user can open any `.md` file from disk and see it rendered with GFM tables, task lists, autolinks. When syntax highlighting and Mermaid are enabled (default), code blocks render highlighted and ` ```mermaid ` blocks render as diagrams; when each is disabled, the corresponding source is shown verbatim.
2. A user can select arbitrary text in the rendered view, start a threaded comment on it, post replies, and resolve the thread.
3. A user can configure their display name and avatar color on first launch and modify them later from a Settings page.
4. A user can switch between View and Edit modes, save edits back to the underlying `.md`, and on returning to View see existing comments still attached to their original text where it survives.
5. A user can hand a counterpart their `.md` plus its sidecar, and when the counterpart opens the `.md` all existing threads appear correctly anchored.
6. When two users have each added comments and exchange sidecars, the merged result contains both sets of threads with no data lost; under the default Auto-merge=Always setting this happens with no user action, while under Ask or Manual the user confirms the merge.
7. When two users have each edited the underlying `.md`, the app shows a side-by-side diff and lets the user choose hunks to keep or hand-edit before saving.
8. A user can switch between Light, Dark, and Follow-system themes and the choice is honored across every screen.
9. Every persistent setting in the Settings page takes effect immediately for new behavior; one-shot actions (regenerate ID, open DevTools, reset to defaults) execute when invoked. The Sync provider control is intentionally inert until cloud sync ships.
10. A single `tauri build` produces an installable artifact for each of macOS (`.dmg` or `.app`, code signing not required), Windows (`.msi` or `.exe`), and Linux (`.AppImage` or `.deb`).

**Phase mapping**

| Criterion | Delivered in |
| --- | --- |
| 1, 2, 3, 8, 9 | Phase 1 |
| 4 | Phase 2 (light editing, anchor reattachment) |
| 5 | Phase 1 (sidecar exchange works end-to-end with plain JSON; CRDT in Phase 3 makes merging conflict-free) |
| 6, 7 | Phase 3 (CRDT auto-merge for comments; conflict-diff UI for `.md` text) |
| 10 | Phase 3 (per-OS bundling pipeline finalizes alongside the share/export deliverable) |

## Wireframes

- `wireframes/01-startup.html` — empty app on first window with recent files list and Open / Settings actions.
- `wireframes/02-profile-setup.html` — first-launch modal collecting display name and avatar color.
- `wireframes/03-document-view.html` — document open in a tab, rendered, sidebar with empty-comments state.
- `wireframes/04-selection-popover.html` — text selected in rendered view; Comment / Copy popover anchored to the selection.
- `wireframes/05-document-with-comments.html` — multiple anchored highlights with threads in the sidebar; one thread active.
- `wireframes/06-thread-detail.html` — focused thread with replies, reply composer, resolve button.
- `wireframes/07-edit-mode.html` — mode toggled to Edit; raw `.md` textarea; comments shown read-only in sidebar.
- `wireframes/08-conflict-diff.html` — side-by-side diff between local and incoming `.md` for hunk-by-hunk resolution.
- `wireframes/09-orphan-comments.html` — comments whose anchors couldn't be reattached after edits, with relocate / keep / delete actions.
- `wireframes/10-share-dialog.html` — share dialog explaining the `.md` + sidecar pair being prepared.
- `wireframes/11-settings.html` — full Settings page with Profile, Appearance, Editor & viewer, Comments, Shortcuts, Advanced, About.
- `wireframes/12-dark-mode.html` — document-with-comments view rendered with the dark theme applied.

The wireframes folder also contains a navigation hub (index.html) and shared CSS file used during design review only; neither is part of the shipped app.

## E2E Acceptance Scenarios

- **Open a .md and view it rendered:** Given a `.md` file on disk, when the user opens it from `wireframes/01-startup.html`, then it appears in a new tab rendered as in `wireframes/03-document-view.html` with no comments shown.
- **Set up profile on first launch:** Given a fresh install, when the user enters a name and selects a color in `wireframes/02-profile-setup.html` and clicks Save, then `wireframes/03-document-view.html` shows that name in the status bar.
- **Add a comment to a selection:** Given an open document in `wireframes/03-document-view.html`, when the user selects text and clicks Comment in the popover from `wireframes/04-selection-popover.html`, then a new highlighted anchor appears with a thread in the sidebar matching `wireframes/05-document-with-comments.html`.
- **Reply and resolve a thread:** Given a thread shown in `wireframes/05-document-with-comments.html`, when the user opens it via `wireframes/06-thread-detail.html`, posts a reply, and clicks Resolve, then the thread renders with the resolved style in the sidebar.
- **Edit the underlying .md and reattach anchors:** Given existing comments in `wireframes/05-document-with-comments.html`, when the user toggles to Edit mode shown in `wireframes/07-edit-mode.html`, modifies surrounding text, and switches back to View, then anchors whose quoted text still appears reattach automatically and any below the reattachment threshold appear as orphans in `wireframes/09-orphan-comments.html`.
- **Auto-merge incoming comment sidecar:** Given a local copy with two threads as in `wireframes/05-document-with-comments.html`, when the user opens the same `.md` after replacing the sidecar with a counterpart's, then both sets of threads appear without prompting.
- **Resolve a text conflict on the .md:** Given the local `.md` and an incoming `.md` differ in overlapping ranges, when the user opens the document, then `wireframes/08-conflict-diff.html` renders side-by-side and Finish merge produces a single saved `.md`.
- **Share a document and its sidecar:** Given a document open with comments, when the user invokes Share from `wireframes/10-share-dialog.html` and clicks Export, then the app produces a folder containing the `.md` and its `.md.comments.json` ready to send.
- **Change settings and see them take effect:** Given the user navigates to `wireframes/11-settings.html` and changes the theme to Dark and the reattachment confidence to 80%, then the app immediately renders in dark theme as in `wireframes/12-dark-mode.html` and the next anchor reattachment applies the new threshold.
- **Switch theme without restart:** Given the app is in Light mode at `wireframes/03-document-view.html`, when the user picks Dark in `wireframes/11-settings.html`, then every visible surface (titlebar, tabs, editor, sidebar, status bar) re-renders with the dark palette as in `wireframes/12-dark-mode.html`.

## Architecture

The app is a Tauri 2 desktop bundle: a Rust backend hosting the document/comments domain logic, and a TypeScript frontend running in the platform WebView for presentation and interaction. Components and their relationships:

**Rust core**

- `src-tauri/Cargo.toml` — Rust crate manifest declaring all backend dependencies.
- `src-tauri/src/main.rs` — Tauri entry; window lifecycle; registers IPC commands; wires modules; resolves cross-platform paths via Tauri's `path::log_dir()` and `path::app_config_dir()` so log files and settings live at OS-appropriate locations (macOS `~/Library/Logs/MDViewer/`, Linux `~/.local/state/MDViewer/logs/`, Windows `%LOCALAPPDATA%\MDViewer\logs\`).
- `src-tauri/src/workspace.rs` — owns the multi-document state: the set of open documents, the active tab, and per-tab session info (file path, last-saved hash, mode, scroll position). Exposes IPC commands `open_document`, `close_tab`, `activate_tab`, `list_open_documents`. Each tab references one logical document; `src-tauri/src/document.rs` is parameterized per-document via a document handle obtained from this module.
- `src-tauri/src/document.rs` — markdown parsing via `pulldown-cmark` (GFM extensions), code-block highlighting via `syntect`, HTML emission. The emitted HTML annotates text-bearing inline elements with `data-src-offset` attributes carrying the source-character offset of their start; the frontend reads these at selection time so DOM ranges always resolve to source-text offsets without round-trips. Also exposes `save_document(path, contents)` for persisting edits; the `save_document` path is registered with `src-tauri/src/watcher.rs` as a self-originated write so the resulting filesystem event does not trigger a reload prompt.
- `src-tauri/src/watcher.rs` — file-system watcher built on `notify`. Watches each currently-open `.md` plus its sidecar; on change, consults the user's "external-change behavior" setting (Ask / Reload / Ignore) and emits an event to the frontend. Suppresses events whose path+timestamp+content-hash match a recently-recorded self-write. When a tab has unsaved edits, always asks regardless of the setting. External `.md` changes route into `src-tauri/src/document.rs`; external sidecar changes route into `src-tauri/src/sidecar.rs`, which re-loads and applies the same Auto-merge policy (Always / Ask / Manual) as the open-time path so an updated sidecar arriving while the doc is open behaves identically to one found at open time.
- `src-tauri/src/anchor.rs` — anchor model (W3C TextQuoteSelector + TextPositionSelector), fuzzy reattachment using a diff-match-patch implementation (see Phase-2 candidates below), confidence scoring, orphan detection. The reverse direction — turning stored source offsets back into DOM ranges for highlight rendering — is also exposed here so the frontend can call one IPC `resolve_anchor(doc, anchor)` and receive a `(start_offset, end_offset)` pair already validated against the current text.
- `src-tauri/src/comments.rs` — thread store (plain JSON in Phase 1, Automerge-backed in Phase 3): threads, comments, replies, resolve state, author metadata. Exposes CRUD commands and emits change events.
- `src-tauri/src/sidecar.rs` — read/write `<doc>.md.comments.json` next to the `.md`; in Phase 1 stores plain JSON with a `schema_version: 1` header; in Phase 3 stores compact Automerge bytes with `schema_version: 2`. On load, sidecars with `schema_version < 2` are parsed as JSON, wrapped into a fresh Automerge document (each thread becomes a CRDT entry preserving its existing IDs), and rewritten on next save.
- `src-tauri/src/conflict.rs` — diff between local `.md` and incoming `.md`; emits hunks for the WebView to render in the conflict view.
- `src-tauri/src/settings.rs` — single settings store covering profile, appearance, editor/viewer prefs, comments prefs, and the shortcut bindings table; persisted in Tauri's app-config directory via the cross-platform path strategy in `src-tauri/src/main.rs`. Emits typed change events; consumers subscribe.
- `src-tauri/src/recents.rs` — most-recently-used `.md` files for the startup screen.

**TypeScript frontend**

- `src/index.html` — root document the WebView loads.
- `src/main.ts` — bootstrap, theme application, IPC setup, frontend keymap. The keymap is constructed from the shortcuts table held in `src-tauri/src/settings.rs`; remap UX (Phase 1: read-only display in the Settings page; full remap deferred per Non-Goals) is handled here when later enabled.
- `src/views/Workspace.ts` — top-level shell that mounts the title bar, tab bar, body region, and status bar; renders a single active `src/views/Document.ts` (or `src/views/Conflict.ts` / `src/views/Settings.ts`) at a time based on the active tab from `src-tauri/src/workspace.rs`.
- `src/views/TabBar.ts` — tabs and the "+" new-tab button (`wireframes/01-startup.html`, `wireframes/03-document-view.html`); consumes the open-documents list from `src-tauri/src/workspace.rs` and dispatches `activate_tab` / `close_tab` IPC.
- `src/views/StartPage.ts` — startup with recents and Open / Settings buttons (corresponds to `wireframes/01-startup.html`).
- `src/views/ProfileSetup.ts` — first-launch modal (`wireframes/02-profile-setup.html`).
- `src/views/Document.ts` — rendered MD pane (mounts HTML from Rust), Mermaid post-render, selection handling (`wireframes/03-document-view.html`, `wireframes/05-document-with-comments.html`).
- `src/views/Edit.ts` — raw `.md` textarea editor (`wireframes/07-edit-mode.html`). On change, debounces locally for the user-configured interval and then calls the `save_document` IPC in `src-tauri/src/document.rs`; Rust performs the actual file write and tags it self-originated for `src-tauri/src/watcher.rs` to suppress. Frontend debounce is acceptable here because the keystroke stream lives in the WebView; only the write decision crosses the boundary.
- `src/views/CommentsSidebar.ts` — threads list, filter, active-thread sync (`wireframes/05-document-with-comments.html`, `wireframes/09-orphan-comments.html`).
- `src/views/SelectionPopover.ts` — anchored popover on text selection (`wireframes/04-selection-popover.html`).
- `src/views/ThreadDetail.ts` — thread reply composer, resolve (`wireframes/06-thread-detail.html`).
- `src/views/Conflict.ts` — side-by-side diff view (`wireframes/08-conflict-diff.html`).
- `src/views/ShareDialog.ts` — share/export modal (`wireframes/10-share-dialog.html`).
- `src/views/Settings.ts` — full Settings page with all sub-panels wired to the Rust settings store (`wireframes/11-settings.html`).
- `src/styles/theme.css` — Light/Dark CSS variables.
- `src/styles/app.css` — layout for app shell, tabs, sidebar, popovers.

**Test layout**

- `src-tauri/tests/` — Rust integration tests for each backend module.
- `tests/` — Vitest unit tests for the TypeScript frontend.
- `e2e/` — Playwright end-to-end tests covering the acceptance scenarios.

**Settings → consumer mapping** (each setting is read by exactly the modules that need it; `src-tauri/src/settings.rs` publishes change events):

- Profile (name, color, stable user ID) → `src-tauri/src/comments.rs` (author metadata on new entries), `src/views/CommentsSidebar.ts` (avatar rendering), status bar.
- Theme → `src/main.ts` (sets `body.theme-dark` / Light / Follow-system listener), all CSS surfaces.
- Editor font size, line height, density → `src/styles/theme.css` CSS variables, `src/views/Edit.ts`, `src/views/Document.ts`.
- Default open mode → `src/views/Document.ts` (initial mode on tab open).
- Auto-save + debounce → `src/views/Edit.ts` (debounce policy) calling `save_document` in `src-tauri/src/document.rs` (write).
- External-change behavior → `src-tauri/src/watcher.rs` (consumes the setting when filesystem events arrive); the frontend reload prompt is rendered by `src/views/Document.ts`.
- Syntax highlighting / Mermaid toggles → `src-tauri/src/document.rs` (skip `syntect`; emit raw `<pre>` for mermaid blocks).
- Show whitespace, word-wrap → `src/views/Edit.ts`.
- Show resolved threads → `src/views/CommentsSidebar.ts` (filter).
- Sidecar filename pattern → `src-tauri/src/sidecar.rs`.
- Reattachment confidence threshold → `src-tauri/src/anchor.rs`.
- Auto-merge mode → `src-tauri/src/sidecar.rs`.
- Sync provider → reserved (local-only in this release; the Settings control is intentionally inert).
- Shortcut bindings (read-only display in v1; persisted in `src-tauri/src/settings.rs` so future remap UX has a target schema) → frontend keymap in `src/main.ts`.
- About (app version, commit hash, links) → `src/views/Settings.ts`, sourced from build-time constants emitted by `src-tauri/build.rs` and re-exported via `src-tauri/src/main.rs`.
- Verbose logs / Open DevTools / Reset to defaults → `src-tauri/src/main.rs` and `src/views/Settings.ts`; one-shot actions, not persistent settings.

Data flow for a comment: user selects text in `src/views/Document.ts` → frontend reads `data-src-offset` attributes on the surrounding inline elements to derive `(start, end)` source-text offsets and the quote/prefix/suffix snippet (no DOM-to-source translation needed in Rust because the offsets are already authoritative) → frontend sends offsets + quote/prefix/suffix to `src-tauri/src/comments.rs` via Tauri IPC → `src-tauri/src/anchor.rs` stores the selectors → `src-tauri/src/comments.rs` mutates the thread store → `src-tauri/src/sidecar.rs` persists. Sidebar receives a change event and re-renders. The reverse direction (rendering anchored highlights for an existing comment) calls `src-tauri/src/anchor.rs::resolve_anchor`, which returns the validated source offsets that `src/views/Document.ts` translates to DOM ranges by walking the same `data-src-offset` attributes.

Data flow for a sidecar merge: opening a `.md` triggers `src-tauri/src/sidecar.rs` to load `<doc>.md.comments.json` if present. In Phase 1 (plain JSON), the most-recently-modified file wins; an "Auto-merge: Ask/Manual" setting can prompt the user instead. In Phase 3 (Automerge), the loader merges prior and current operation histories deterministically and the frontend re-renders threads. Sidecars with `schema_version < 2` are migrated in place to schema 2 on first save by Phase 3.

Data flow for an edit save: keystroke in `src/views/Edit.ts` → debounce expires → IPC `save_document(path, contents)` → `src-tauri/src/document.rs` writes bytes and registers `(path, content_hash, timestamp)` with `src-tauri/src/watcher.rs` as a self-originated write → filesystem fires a watch event → `src-tauri/src/watcher.rs` matches it against the recent self-write log and drops it.

**Technical risks**

- *WebKitGTK rendering parity.* Tauri uses different WebViews per OS (WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux). Subtle differences in selection ranges, fonts, and CSS support require per-platform smoke testing. Mitigation: Playwright suite runs on all three OSes in CI; selection-range serialization in `src-tauri/src/anchor.rs` is engine-independent (string offsets, not DOM ranges).
- *Mermaid bundle weight.* Mermaid is a heavy JS dependency (~hundreds of KB). Mitigation: lazy-load it on first encounter with a `mermaid` block; respect the Mermaid toggle in Settings.
- *Automerge sidecar growth.* Automerge stores operation history; long-lived documents accumulate bytes. Mitigation: scheduled compaction (Automerge `save` produces a compact form) when sidecars exceed a threshold; document this for users in Advanced settings.
- *Anchor-reattachment quality on heavy edits.* Fuzzy match has a confidence floor; aggressive rewrites produce orphans. Mitigation: tunable threshold in Settings; orphan UX (`wireframes/09-orphan-comments.html`) keeps the comment instead of dropping it.

## Key Decisions

- **Tauri 2 over Electron / pure-Rust GUI / Dioxus.** Chose Tauri 2 for the small bundle size, native Rust core, mature WebView rendering of rich text with selection, and built-in cross-platform packaging. *Considered:* Electron (Node-based, larger bundle, weaker native story); egui / Iced (rich-text selection and layout would be substantial DIY work); Dioxus (smaller ecosystem and less Tauri-comparable tooling for this use case).
- **CRDT (Automerge) for the comment sidecar; plain `.md` for document text.** Comments merge automatically across copies, removing per-exchange friction; the `.md` stays editable in any tool and shareable via any channel. *Considered:* full Automerge for both (rejected — external `.md` edits would be invisible to the CRDT, defeating "open any `.md`"); plain JSON sidecar with last-writer-wins (rejected — silently loses one user's comments on conflict).
- **Text-range anchors with fuzzy reattachment (Hypothesis-style).** Selectors store quoted text plus prefix/suffix context; on reload they are relocated by string match, falling back to fuzzy match scored against a configurable threshold. *Considered:* line-number anchors (fragile after any edit); injected block IDs (pollutes the `.md`); forking the existing Hypothesis client / `apache/annotator` (rejected — both target browser-extension and web-page contexts and would not adapt cleanly to a desktop file-first workflow with a Rust core; reusing the W3C Web Annotations selector model is the actual portable piece).
- **Sidecar file `<doc>.md.comments.json` next to the `.md`.** The `.md` stays untouched. *Considered:* HTML-comment-embedded comments inside the `.md` (rejected — clutters the file and breaks downstream renderers); zip bundle (rejected — needs custom unpacking and breaks "open in any tool").
- **Rust-heavy core; TypeScript frontend as a presentation layer.** Parsing, anchor resolution, CRDT operations, settings, and all file IO (including edit saves via `save_document` IPC) live in Rust where they're testable in isolation; the WebView decorates and provides interaction. *Considered:* JS-heavy frontend (rejected — splits domain logic across the language boundary, complicates testing).
- **Diff-match-patch crate selection deferred to Phase 2 implementation.** Two acceptable Rust ports exist: [`diff-match-patch-rs`](https://crates.io/crates/diff-match-patch-rs) (active, broader feature parity with the original JS) and [`dissimilar`](https://crates.io/crates/dissimilar) (smaller, narrower API but well-maintained). The Phase-2 implementation task validates Unicode handling and benchmarks reattachment latency on representative documents, then locks the choice in `src-tauri/Cargo.toml`. *Rejected from the candidate list:* `dmp_rs` (sparsely maintained, last-publish risk).

## Non-Goals

- **No realtime collaboration.** This release exchanges sidecars asynchronously; realtime would require a sync server and presence/cursor protocol, which doubles scope and contradicts the local-only premise of the MVP.
- **No Google Drive or iCloud Drive integration.** Cloud sync needs OAuth, per-provider conflict semantics, and offline reconciliation, all of which are out of scope until local file-based sharing has proven the workflow.
- **No multi-user identity verification or authentication.** Identities are local profiles only; the small-team trust model the app targets does not require accounts, and anything stronger would mandate a server.
- **No WYSIWYG markdown editor.** Editing is in raw `.md` only because building an in-place WYSIWYG editor that handles every GFM extension and Mermaid is a multi-quarter project that overlaps with Obsidian and Typora.
- **No diagram-authoring UI.** Mermaid blocks render from text source only; shipping a graphical diagram editor is a separate product surface and is not necessary for the review use case.
- **No mathematical formula rendering (KaTeX or MathJax).** The user did not include math in day-one requirements; deferring it keeps the rendering pipeline focused on the agreed feature set.
- **No mobile (iOS/Android) builds.** Tauri 2 supports them, but selection, sidebars, and modals all need a separate mobile UX pass that has not been designed.
- **No git-aware integration.** The app does not read git history, branch state, or PR comments; the `.md` lives wherever the filesystem puts it, regardless of repo membership.
- **No interactive shortcut remapping in v1.** The Settings page displays the active bindings (read-only), and the schema in `src-tauri/src/settings.rs` is extensible to user overrides — but capture-a-keystroke UX, conflict detection, and per-platform default presets are deferred until the core feature set lands.

## Implementation Approach

| Path | Change |
| --- | --- |
| `src-tauri/Cargo.toml` | new — Rust deps **cumulative across phases**. Phase 1: `tauri`, `serde`, `serde_json`, `pulldown-cmark`, `syntect`, `notify` (file watcher), `anyhow`, `tracing`. Phase 2 adds the diff-match-patch crate (`diff-match-patch-rs` or `dissimilar`, locked during Phase 2 per Key Decisions). Phase 3 adds `automerge`. |
| `src-tauri/src/main.rs` | new — Tauri entry, window manager, IPC commands, theme bridge to OS. |
| `src-tauri/build.rs` | new — emits build-time constants (version, commit hash) consumed by the About panel. |
| `src-tauri/src/workspace.rs` | new — multi-document state, open-tabs list, active-tab routing, IPC commands. |
| `src-tauri/src/document.rs` | new — MD parsing, `data-src-offset` HTML emission, syntax highlighting, `save_document` IPC. |
| `src-tauri/src/watcher.rs` | new — `notify`-based file watcher with self-write suppression and external-change policy. |
| `src-tauri/src/anchor.rs` | new — anchor model, fuzzy reattachment with confidence scoring, `resolve_anchor` reverse mapping. |
| `src-tauri/src/comments.rs` | new — thread store (Phase 1: plain JSON; Phase 3: Automerge) and IPC commands. |
| `src-tauri/src/sidecar.rs` | new — sidecar IO; Phase 1 plain JSON; Phase 3 Automerge with `schema_version < 2` migration. |
| `src-tauri/src/conflict.rs` | new — `.md` text-conflict diff and hunk emission. |
| `src-tauri/src/settings.rs` | new — settings schema (including shortcuts table), persistence, change-event channel. |
| `src-tauri/src/recents.rs` | new — MRU file list. |
| `src/index.html` | new — root document. |
| `src/main.ts` | new — frontend bootstrap, IPC, theme bridge, router, keymap loaded from settings. |
| `src/views/Workspace.ts` | new — top-level shell mounting title bar, tab bar, body, status bar. |
| `src/views/TabBar.ts` | new — tabs and "+" button; reads open-documents list from `src-tauri/src/workspace.rs`. |
| `src/views/StartPage.ts` | new — startup screen with recents. |
| `src/views/ProfileSetup.ts` | new — first-launch modal. |
| `src/views/Document.ts` | new — rendered MD container; coordinates selection and sidebar. |
| `src/views/Edit.ts` | new — raw `.md` textarea with autosave. |
| `src/views/CommentsSidebar.ts` | new — threads list. |
| `src/views/SelectionPopover.ts` | new — selection-anchored popover. |
| `src/views/ThreadDetail.ts` | new — thread replies and resolve. |
| `src/views/Conflict.ts` | new — side-by-side diff view. |
| `src/views/ShareDialog.ts` | new — share/export modal. |
| `src/views/Settings.ts` | new — full Settings page; all controls call into the Rust settings store. |
| `src/styles/theme.css` | new — Light/Dark CSS variables. |
| `src/styles/app.css` | new — layout. |
| `src-tauri/tests/` | new — Rust unit and integration tests for each module. |
| `tests/` | new — TypeScript Vitest unit tests for views and IPC adapters. |
| `e2e/` | new — Playwright E2E tests covering the acceptance scenarios above. |

**Test impact per behavior change:**
- Workspace / tab manager → unit tests for open / activate / close transitions; integration test that two open tabs hold independent document state.
- Document parsing & `data-src-offset` emission → unit tests for GFM features, code highlighting, Mermaid passthrough; round-trip test that DOM offsets recovered via `data-src-offset` reconstruct the original source range.
- Watcher → integration tests for self-write suppression (a save followed by no reload prompt), external-change ask/reload/ignore behavior, and the unsaved-edits override.
- Anchor reattachment → property tests with synthetic edits (insertion, deletion, replacement) over fixture text; tests crossing the configurable confidence threshold to verify orphan classification.
- Comments store → CRUD tests in Phase 1 (JSON); merge-order independence and thread-state convergence in Phase 3 (Automerge).
- Sidecar IO → round-trip serialization in both schemas; missing-file handling; Phase-3 migration test reading a `schema_version: 1` sidecar produced in Phase 1 and verifying lossless conversion.
- Conflict diff → hunk extraction from contrived divergent texts.
- Settings store → load/save round-trip; change-event delivery; default values; persistence path resolved correctly per OS.
- Frontend views → Vitest with jsdom for selection logic, tab transitions, sidebar rendering, theme switching, settings interactions.
- All success criteria → Playwright E2E mapped to the acceptance scenarios.

**Migration / operational steps:**
- v0 itself: greenfield, no existing data.
- Phase-1-to-Phase-3 sidecar migration: on load, Phase-3 code reads `schema_version` from the sidecar header; values `< 2` are parsed as JSON and converted into a fresh Automerge document (each thread becomes a CRDT entry preserving its original `id`), then written back as `schema_version: 2` on the next save. A one-shot CLI subcommand `mdviewer migrate-sidecars <dir>` is provided for batch conversion.
- Operational: log rotation under the OS-appropriate log directory (Tauri `path::log_dir()`); settings live under `path::app_config_dir()`.

**Phase rationale:**
- *Phase 1 — Viewer with local comments.* Tauri scaffold, multi-document workspace + tab bar, MD rendering pipeline with `data-src-offset` annotations, text-range anchors with no reattachment yet (no editing), threaded comments + resolve, plain JSON sidecar (`schema_version: 1`, no CRDT yet), local profile, Light/Dark themes, full Settings page wired to the relevant subsystems with read-only shortcuts display, recents.
- *Phase 2 — Light editing and reattachment.* View/Edit toggle, raw `.md` editor, IPC-backed save with watcher self-suppression, fuzzy anchor reattachment on return to View, orphan-comment UX, file-watcher integration with the user-configured external-change behavior.
- *Phase 3 — CRDT collaboration & distribution.* Replace JSON sidecar with Automerge (`schema_version: 2`) including the migration step described above, auto-merge sidecars on reload (Auto-merge setting honored), conflict-diff view for `.md` text, share/export dialog, per-OS bundling pipelines (`.dmg`/`.msi`/`.AppImage`/`.deb`).

Phases are sequential because each builds on the prior layer's data shape (anchors require parsing; reattachment requires the editor; CRDT requires the comment store).

## Test Coverage

- **Tools:** `cargo llvm-cov` for the Rust core, Vitest with `@vitest/coverage-v8` for the TypeScript frontend, Playwright for E2E.
- **Commands:** `cargo llvm-cov --workspace --html` and `npm run test:coverage`.
- **Baseline:** `null` — greenfield project.
- **Threshold:** 90 (per `coverage_threshold` setting).

Coverage gates apply to the Rust core and TypeScript frontend separately; E2E is treated as additive and not subject to the percentage threshold.

## E2E Tooling

- **Runner:** Playwright with the Tauri WebView driver.
- **Command:** `npm run test:e2e`.

If the project does not have Playwright configured, the first implementation task after the `e2e-red` task adds Playwright + a Tauri WebView driver harness.

## Scope Estimate

- **Phases:** 3 (Phase 1 viewer + comments; Phase 2 editing + reattachment; Phase 3 CRDT collaboration + distribution).
- **Tasks:** estimated **32 tasks** across all three phases (Tauri scaffold + `build.rs`; workspace/tab manager; MD parser with offset annotations; watcher; anchor module; comments store; sidecar IO including the Phase-3 migration; conflict module; settings store with shortcuts schema; recents; ten frontend views including `Workspace.ts` and `TabBar.ts`; theme + layout CSS; Rust unit tests; TS unit tests; E2E suite; per-OS bundling pipelines).
- **Recommended execution mode:** `subagents` (user-selected; the three phases are sequential and per-phase parallelism is moderate, so subagents handle the workload without the operational overhead of agent teams).
