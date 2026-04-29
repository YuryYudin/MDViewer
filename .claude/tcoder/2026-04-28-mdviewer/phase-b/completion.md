# Phase B — Completion Summary

**Status:** Complete (2026-04-29). 4 tasks merged into `integrate/mdviewer` plus a phase-glue commit (`13c7796`) addressing the Phase-B impl-review's 5 integration findings.

## Tasks delivered

- **B1** — Diff-match-patch-rs locked after benchmarking the fuzzy path (~200µs/iter on 110KB). `resolve_anchor_with_threshold` short-circuits exact match then dispatches to Bitap; reads `settings.comments.reattachment_confidence` via `Workspace::resolve_anchor_for_tab`.
- **B2** — `notify`-based watcher with `(path, content_hash, Instant)` self-write suppression list (TTL 10s, match window 1500ms after the impl-review fix). All state behind `std::sync::Mutex` (no tokio in the watcher path). Settings subscriber updates external-change behavior live.
- **B3** — `save_document(path, contents, prime_self_write)` does atomic write (tmp → fsync → rename), parent-dir fsync, and runs the priming closure BEFORE the rename so the watcher's suppression list is primed unconditionally. The IPC handler closes over the watcher; the priming-closure pattern eliminates the save→notify race window the iter-1 reviewer flagged.
- **B4** — `Edit.ts` raw textarea editor with debounced autosave (debounce read from settings) + manual Save + word-wrap + show-whitespace. `OrphanComments.ts` matches wireframe 09 with Relocate/Keep/Delete actions. `Document.ts` extended with View/Edit toggle that force-flushes the autosave timer on Edit→View, re-renders, re-resolves anchors, splits orphans into a separate list. `CommentsSidebar.ts` accepts `orphans?` and mounts `OrphanComments` at the top.

## Phase-glue commit (post-review)

`13c7796` resolved 5 cross-task integration gaps surfaced by the implementation reviewer:
1. `main.rs::open_document` now registers the file with the watcher (`watch_md` + `watch_sidecar`) and clears the dirty bit on open.
2. New `set_dirty` IPC + `Ipc.setDirty` adapter so `Edit.ts` can flip the unsaved-edits override on first input and clear it after `forceSave`.
3. `Workspace.ts` mounts a real `Document` + `CommentsSidebar` with the threads/source/path payload; the View/Edit toggle, orphan UX, and external-change banner are now reachable end-to-end.
4. `Workspace.ts` listens for the `external-change` Tauri event from the watcher and surfaces a banner in the body region (auto-dismissed for `reload`).
5. Watcher integration test negative-assertion windows widened from 500ms → 1500ms (was flaky under `cargo llvm-cov` instrumentation).

## Coverage gate (enforce@90)

| File | Coverage |
|---|---|
| `src-tauri/src/anchor.rs` | 97.27% / 93.33% |
| `src-tauri/src/document.rs` | ~98% (B3 added `save_document` + tests) |
| `src-tauri/src/watcher.rs` | 93.01% / 92.05% |
| `src-tauri/src/workspace.rs` | 95.60% (preserved from A8a + B1 threshold test + B3 refresh_tab tests) |
| TypeScript | 99.66% overall (B4 added `Edit.ts`/`OrphanComments.ts` at 100%; modified `Document.ts`/`CommentsSidebar.ts` retain 100%) |

`src-tauri/src/main.rs` remains exempt from the 90% gate per the design's Test Coverage section.

## Tests

- Rust integration suites: 21 anchor + 12 workspace + 21 watcher + 9 sidecar + 7 settings + 11 comments + 10 ipc_registration + small (recents, scaffold, document, export_types_bin) = 100+ tests across 14 suites, all passing.
- Frontend: 153 Vitest tests across 15 files, all passing.

## Phase-1 success criterion 4 status

Criterion 4 (light editing + anchor reattachment) is now reachable end-to-end through the running app:
- View/Edit toggle in `Document.ts` (B4)
- Atomic save via `ipc.saveDocument` (B3)
- Watcher self-write suppression (B2 + B3 priming closure)
- Fuzzy reattachment via Bitap (B1)
- Orphan UX surfacing in the sidebar (B4)

## Hand-off contracts for Phase C

- `quick_hash` is the load-bearing primitive shared between `document::save_document` and `watcher.rs`. Phase C1's sidecar-write path should reuse it (do not invent a parallel hash).
- `OpenOutcome::Conflict` variant is wired into `main.rs::open_document`'s `app.emit("show-conflict", …)` but `Workspace::open_document` only ever returns `Document`. Phase C2 fills this in.
- The `external-change` event from B2 is now consumed by `Workspace.ts`. Phase C2's conflict-diff banner can hook into the same event surface.
- The priming-closure pattern in `save_document` is stable; Phase C1's Automerge sidecar writer should adopt the same shape if it wants self-write suppression.
- `Edit.ts`'s `forceSave` and the new `setDirty` IPC are stable; Phase C3's share/export flow can rely on them.
