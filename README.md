# MDViewer

A cross-platform desktop Markdown viewer with **collaborative commenting** — hand a colleague a folder containing `notes.md` and `notes.md.comments.json`, they open it, the comments anchor to the same words you highlighted. No server, no account, no fork of the document. Built with Rust + Tauri 2 + TypeScript.

> **Status:** Phase 1–3 complete (Open / View / Comment / Edit / Share). Cloud sync is intentionally out of scope; the unit of collaboration is **a folder**.

---

## Why MDViewer

Most lightweight Markdown viewers stop at "render and read." Most commenting tools require a server, an account, or a SaaS workflow. MDViewer sits in the middle:

- **Read-first.** Open any `.md`, see clean rendered output, scrollable, themable, fast.
- **Comment in place.** Triple-click a phrase, type a thread, post a reply. Comments anchor to the actual words via [W3C Web Annotation selectors](https://www.w3.org/TR/annotation-model/#text-quote-selector) — small edits to the surrounding prose don't lose the highlight.
- **Share by file.** Comments live next to the document in `notes.md.comments.json`. Zip the folder, AirDrop it, attach it to email — the recipient sees your comments. Their replies land in the same sidecar; CRDT auto-merge handles the round-trip.

If you want Git-style review, use Git. If you want a Notion-style workspace, use Notion. MDViewer is for the case where the document is the artifact, comments are the conversation, and the network is "send file."

---

## Features

### Reading
- Rendered GitHub-flavored Markdown (`pulldown-cmark`)
- Syntax highlighting for fenced code blocks (`syntect`)
- Mermaid diagram support (toggleable)
- Tabs (open multiple docs side-by-side via the tab strip)
- Recents list with relative-time labels
- Light / Dark / Follow-system themes (`color-scheme` propagated so native scrollbars match)

### Commenting
- **Selection popover** on triple-click → start a thread
- **Threaded replies** (`Post`, `Resolve`)
- **Robust anchoring**: each thread carries `prefix · exact · suffix · start · end`. Edits within prefix/suffix tolerance reattach automatically; larger edits surface as **orphaned** comments in a side panel for manual reattachment.
- **Author colors** for at-a-glance attribution
- Comments persist as a sibling sidecar file — the `.md` itself is **never modified**

### Editing
- Toggle View ↔ Edit mode (`Cmd+E`)
- Atomic save (`Cmd+S`) — write-temp + rename so a crash mid-write can't corrupt the file
- External-change watcher: if a file changes on disk while you have it open, MDViewer asks (or auto-reloads) per your settings
- Three-way merge UI when local and incoming edits conflict (line-anchored hunks; Accept Left / Accept Right / Hand-edit per hunk)

### Sharing
- **Export** (Share dialog): copies `.md` + sidecar into a chosen folder for hand-off
- **Import**: receiving a sidecar runs an Automerge merge — both sides' threads, replies, and resolutions are preserved without duplicate work
- Configurable auto-merge: `Always` (silent), `Ask` (prompt on divergence), `Manual`

### App chrome
- Native menu (App / File / Edit / View / Window) with platform-correct accelerators (Cmd+O, Cmd+,, etc.)
- Settings panel: theme, font size, line height, density, syntax highlighting, mermaid, auto-save, external-change behavior, reattachment confidence threshold, sidecar pattern, profile (display name, color), keyboard shortcuts
- First-launch profile setup (you pick a name and an avatar color)

---

## Screenshots

> _See `docs/wireframes/*.html` for the design intent each view ships against._

The Phase-1/2/3 wireframes (`01-startup.html` through `12-dark-mode.html`) double as the visual contract — every view has a fidelity test that asserts wireframe-shape DOM is what the running app renders. See [Testing](#testing) for how we keep visuals from drifting.

---

## Quick start

### Prerequisites

- **Rust** 1.75+ (`rustup` recommended)
- **Node.js** 20+ and **npm** 10+
- Platform-native toolchain for Tauri 2:
  - **macOS**: Xcode Command Line Tools
  - **Windows**: Visual Studio Build Tools (C++) + WebView2
  - **Linux**: `webkit2gtk-4.1`, `libsoup-3.0`, build-essential (see [tauri.app prereqs](https://tauri.app/start/prerequisites/))

### Run from source

```bash
git clone <this-repo>
cd MDViewer
npm install
npm run tauri dev
```

`npm run tauri dev` does three things in sequence:

1. `npm run gen:types` — exports IPC types from Rust (`ts-rs`) into `src/types-generated.ts`. Frontend reads only from this generated file, so the IPC contract stays bit-exact.
2. `vite` — serves the frontend at `localhost:1420`.
3. `cargo run` — builds and launches the Tauri binary, which loads the WebView pointed at the Vite dev server.

Hot-reload works for the frontend; Rust changes trigger a rebuild + relaunch.

### Package a release build

```bash
./scripts/build.sh             # auto-detects host → DMG / MSI / AppImage
./scripts/build.sh --debug     # debug profile, skip signing
./scripts/build.sh --skip-tests
```

Cross-compilation is **not supported** — each WebView depends on host-platform libraries that don't resolve elsewhere. For multi-platform releases, push a `v*` tag and let CI fan out to macOS / Windows / Linux runners (`.github/workflows/release.yml`, when added).

### Per-platform shortcuts

```bash
npm run build:dmg        # macOS
npm run build:msi        # Windows
npm run build:appimage   # Linux (AppImage)
npm run build:deb        # Linux (deb)
```

---

## Sharing a document

The collaboration model is intentionally simple: **one folder, two files**.

```
my-notes/
  proposal.md                 # your markdown — never modified by MDViewer
  proposal.md.comments.json   # sidecar with threads, replies, anchors
```

To share:

1. Open the doc, comment on it.
2. **File → Share** (or the Share button) → pick a destination folder.
3. MDViewer copies both files. Hand the folder over.

The sidecar is a JSON envelope wrapping a base64-encoded [Automerge](https://automerge.org/) blob (`schema_version: 2`). Two collaborators editing offline can each return their copy; importing one into the other runs a deterministic CRDT merge — no thread is lost, no comment is duplicated, resolutions are unioned.

Phase-1 plain JSON sidecars (`schema_version: 1`) are still readable; the migration to v2 happens in memory on the next save, so existing files don't need a converter run.

---

## Architecture

### Rust ↔ TypeScript boundary

```
┌────────────────────────────────────────────────────────┐
│  Tauri WebView (TypeScript + Vite + DOM)               │
│  src/main.ts                                           │
│  ├── views/ — pure functions that mount into a node    │
│  ├── ipc.ts — typed wrappers around tauri::invoke      │
│  ├── keymap.ts — KB shortcut → Action → CustomEvent    │
│  └── menuBridge.ts — Tauri event → CustomEvent         │
└────────────────┬───────────────────────────────────────┘
                 │ IPC: invoke / emit
                 ▼
┌────────────────────────────────────────────────────────┐
│  Rust binary (Tauri 2, single mutex-guarded Workspace) │
│  src-tauri/src/                                        │
│  ├── workspace.rs — tabs, active doc, open/close       │
│  ├── document.rs  — markdown → HTML (with src offsets) │
│  ├── comments.rs  — threads, Automerge CRDT            │
│  ├── sidecar.rs   — JSON IO for .comments.json         │
│  ├── anchor.rs    — TextQuote/Position resolver        │
│  ├── conflict.rs  — line-anchored 3-way diff           │
│  ├── watcher.rs   — notify-rs file watcher             │
│  ├── settings.rs  — TOML store + change events         │
│  ├── recents.rs   — JSON-backed MRU list               │
│  └── menu.rs      — native menu construction           │
└────────────────────────────────────────────────────────┘
```

**Key conventions:**

- **No business logic in `main.rs`.** Tauri command handlers are thin shims that lock the workspace mutex and delegate to a `Workspace::*` method. This keeps the binary testable indirectly via integration tests against `Workspace`.
- **Type generation is mandatory.** Every type that crosses IPC derives `#[derive(ts_rs::TS)]` and is appended to `src-tauri/src/bin/export_types.rs::export_all`. The frontend imports from `src/types-generated.ts`; a `tests/codegen.test.ts` Vitest case re-runs the exporter and asserts byte-equality, so a stale generated file fails CI immediately.
- **CustomEvents are the action bus.** Keymap, menu, and view buttons all dispatch `mdviewer:*` CustomEvents on `document`. View modules subscribe. There's no Redux, no signal library — just `addEventListener`.
- **Watcher events flow Rust → JS via `tauri::Emitter`.** `external-change`, `show-conflict`, and `menu-action` are the three custom events the WebView listens for via `@tauri-apps/api/event`.

### Anchor algorithm

Each thread stores a [W3C TextQuoteSelector](https://www.w3.org/TR/annotation-model/#text-quote-selector) flattened into the row:

```ts
interface Anchor {
  start: number;      // byte offset (TextPositionSelector)
  end: number;
  exact: string;      // the highlighted span
  prefix: string;     // up to ~32 chars of context before
  suffix: string;     // up to ~32 chars of context after
}
```

Resolution order:

1. **Exact match at `start`** → fast path, O(1) attach.
2. **Exact-text scan** if offsets shifted → O(n) but typical doc.
3. **Bitap fuzzy match** (`diff-match-patch-rs`) scored against `settings.comments.reattachment_confidence` (default 0.85). Above threshold → reattach with the new offsets. Below → mark **orphan**, surface in the orphan panel for manual reattachment.

Benchmarked at ~200 µs/iter on a 110 KB synthetic doc with a deliberate typo (forces the fuzzy path) — see `benches/anchor_bench.rs`.

---

## Project layout

```
MDViewer/
├── src/                       # TypeScript frontend
│   ├── main.ts                # bootstrap + global wiring
│   ├── ipc.ts                 # invoke wrappers
│   ├── keymap.ts              # keyboard → Action mapping
│   ├── menuBridge.ts          # native menu → CustomEvent
│   ├── views/                 # one file per view (Workspace, Document, …)
│   ├── styles/
│   │   ├── theme.css          # CSS variables (light / dark)
│   │   └── app.css            # layout
│   └── types-generated.ts     # AUTO-GENERATED, do not edit
├── src-tauri/                 # Rust backend
│   ├── src/                   # see Architecture above
│   ├── tests/                 # cargo integration tests
│   ├── benches/               # Criterion benches
│   └── tauri.conf.json
├── tests/                     # Vitest unit tests (jsdom)
│   └── views/                 # one *.test.ts + *.fidelity.test.ts per view
├── e2e/                       # WebdriverIO + tauri-webdriver-automation
│   ├── 00-startpage-open-flow.spec.ts
│   ├── … (15 specs total)
│   └── helpers/app.ts         # fixture + e2e hook helpers
├── docs/wireframes/           # HTML/CSS design intent (12 wireframes)
├── scripts/build.sh           # one-command release packaging
├── package.json
└── README.md                  # you are here
```

---

## Keyboard shortcuts

All shortcuts are user-configurable in **Settings → Shortcuts**. Defaults:

| Action                | Shortcut          |
|-----------------------|-------------------|
| Open file             | `Cmd/Ctrl + O`    |
| Save file             | `Cmd/Ctrl + S`    |
| New document          | `Cmd/Ctrl + N`    |
| Close tab             | `Cmd/Ctrl + W`    |
| Toggle edit mode      | `Cmd/Ctrl + E`    |
| Toggle comments panel | `Cmd/Ctrl + Shift + S` |
| Comment on selection  | `Cmd/Ctrl + Shift + M` |
| Resolve focused thread| `Cmd/Ctrl + Shift + R` |
| Toggle dark mode      | `Cmd/Ctrl + Shift + D` |
| Open settings         | `Cmd/Ctrl + ,`    |

`Mod` in the settings file maps to Cmd on macOS, Ctrl on Windows/Linux.

---

## Testing

The test pyramid has three layers, each catching a different class of regression:

### Unit (Vitest + jsdom) — `npm test`

`tests/**/*.test.ts` exercise pure functions and view-mount behavior. Each view also has a `*.fidelity.test.ts` that mounts the view and asserts the **DOM shape matches its wireframe** (`docs/wireframes/0X-*.html`). Fidelity tests catch regressions where a refactor accidentally changes layout — the kind of bug that builds and unit-tests pass but the screenshot is wrong.

```bash
npm test                    # one shot
npm run test:watch          # watch mode
npm run test:coverage       # v8 coverage report
```

### Rust (cargo test)

```bash
cd src-tauri && cargo test  # unit + integration tests
cargo test --features e2e   # also covers the WebDriver hook
```

Integration tests under `src-tauri/tests/` drive the `Workspace` directly without spinning up Tauri.

### End-to-end (WebdriverIO + tauri-webdriver-automation) — `npm run test:e2e`

15 specs that drive the **real packaged binary** through real WebDriver sessions on macOS. Each spec opens a fresh app instance pointed at a per-test temp data dir (`MDVIEWER_DATA_DIR` env override) so tests are isolated.

```bash
npm run test:e2e            # builds the e2e binary then runs the suite
```

The OS file dialog is undriveable from WebDriver, so tests use a debug-only `__mdviewerE2E.open(absPath)` hook attached when `__WEBDRIVER__` is present. The binary is a separate `--features e2e` build — release artifacts never expose the hook.

### Code-generation (`tests/codegen.test.ts`)

Re-runs the Rust-side `export_types` binary against a temp directory and asserts the result is byte-identical to the committed `src/types-generated.ts`. A drift between Rust types and the generated TS file fails this test on the next run, so the IPC contract stays canonical.

---

## Design constraints (intentional)

- **No cloud sync.** The unit of collaboration is a folder. We may explore Google Drive / iCloud integration later, but the file-level CRDT story is the foundation.
- **No account system.** Profile is a local `display_name + color` pair, written into each comment's `author` field. Recipients see the name as-is — there's no identity verification.
- **Sidecar, not embed.** Comments are NEVER written into the `.md`. This keeps the document a clean publishable artifact and lets non-MDViewer tools render it untouched.
- **No history beyond CRDT ops.** We don't store a full audit log of who edited what when. The Automerge blob preserves enough op history to merge concurrent edits, but it's not a replacement for Git.

---

## Troubleshooting

**"Status bar disappeared after I opened a doc"** — Likely a stale dev build. The grid-track regression was fixed in `3b8e495`; rebuild with `npm run tauri dev` to clear `dist/`.

**"My comments stopped showing up after I edited the doc"** — They were probably reattached as orphans because the prose changed past the configured fuzzy threshold. Check the **Orphan comments** panel (toggleable in the sidebar). Lower `settings.comments.reattachment_confidence` to be more permissive, or re-anchor manually.

**"`npm run tauri dev` errors with `webkit2gtk-4.1` not found" (Linux)** — Tauri 2 requires the `4.1` line; older distros ship `4.0`. See [tauri.app prereqs](https://tauri.app/start/prerequisites/) for the apt/dnf one-liner.

**"E2E tests fail with `MDVIEWER_DATA_DIR not set`"** — `wdio.conf.ts` injects this via `tauri:options.env`. If you're running a single spec by hand, set it manually: `MDVIEWER_DATA_DIR=$(mktemp -d) npx wdio run wdio.conf.ts --spec e2e/01-open-render.spec.ts`.

---

## Contributing

The codebase is organized for incremental contribution:

- **Adding a view**: write a `mountFoo(root, ipc, …)` function under `src/views/Foo.ts`, mirror it with `tests/views/Foo.test.ts` (behavior) and `Foo.fidelity.test.ts` (DOM shape vs. `docs/wireframes/0X-*.html`).
- **Adding an IPC command**: declare the handler in `src-tauri/src/main.rs`, wire the body in the appropriate module, append the type(s) to `src-tauri/src/bin/export_types.rs::export_all`, run `npm run gen:types`, then add a typed wrapper in `src/ipc.ts`.
- **Adding a keyboard shortcut**: extend the `Action` union in `src/keymap.ts`, the dispatcher switch in `src/main.ts`, and the default in `src-tauri/src/settings.rs::default_shortcuts`. Mention it in this README's [Keyboard shortcuts](#keyboard-shortcuts) table.
- **Adding a menu item**: extend `src-tauri/src/menu.rs::build` (the menu structure) and `menu_id_to_action` (the id → action mapping), plus `src/menuBridge.ts::MENU_ACTION_TO_EVENT`. Both halves have unit tests that pin the contract.

Run the full test suite (`npm test && cd src-tauri && cargo test && cd .. && npm run test:e2e`) before sending a PR.

---

## License

MIT OR Apache-2.0, at your option. See `Cargo.toml`.
