# B4 Completion Notes

**Summary:** Built the raw-textarea Edit view (wireframe 07) with frontend-debounced autosave, word-wrap and show-whitespace toggles, and a manual Save button; added the OrphanComments view (wireframe 09) with Relocate / Keep / Delete (confirm) actions; wired Document.ts to host a View/Edit mode toggle that flushes pending edits, re-renders the markdown, and re-resolves all anchors on return to View, routing any thread whose anchor falls below the reattachment-confidence threshold into a separate orphanThreads list which CommentsSidebar mounts at the top of the comments pane.

**Deviations:**
- Added an `onOrphansChanged` callback to `DocumentMountArgs` (Rule 2 — workspace needs a way to learn the new orphan list after a View↔Edit round-trip; without it the sidebar would never refresh). The plan implies a sidebar pass-through but does not name the callback shape.
- Made `source`, `path`, and `settings` on `DocumentMountArgs` optional (Rule 3 — keeping them required would have broken every existing A10 Document test caller; Document still works as a pure-view component when those fields are omitted, with the toggle button hidden).
- Replaced `vi.spyOn(window, 'confirm')` with manual save/restore of `window.confirm` (Rule 3 — the project's strict TS config rejected the `MockInstance` typing returned by `vi.spyOn` on `window` properties; the manual swap is the same observable behavior with a clean type).
- Documented that `editView.forceSave()` is awaited before `renderMarkdown` runs on the Edit→View transition (Rule 1 — without that flush, the re-render would still see the previous save's bytes and miss in-flight edits).

**Files Changed:**
- Created: `src/views/Edit.ts`
- Created: `src/views/OrphanComments.ts`
- Created: `tests/views/Edit.test.ts`
- Created: `tests/views/OrphanComments.test.ts`
- Modified: `src/views/Document.ts` (mode toggle, edit/view round-trip, orphan routing)
- Modified: `src/views/CommentsSidebar.ts` (optional orphan list at top)
- Modified: `tests/views/Document.test.ts` (mode-toggle tests)
- Modified: `tests/views/CommentsSidebar.test.ts` (orphan-section tests)

**Test Results:**
- `npm run test -- tests/views/Edit.test.ts tests/views/OrphanComments.test.ts`: 20/20 green (the task's stated verification command).
- Full suite: 153/153 green across 15 files.
- Coverage on touched src/views files: Edit 100% statements/branches/funcs/lines, OrphanComments 100% across the board, CommentsSidebar 100% across the board, Document 100% statements/funcs/lines + 95.91% branches — all comfortably above the 90% threshold.

**Deferred Issues:**
- Pre-existing `tsc --noEmit` errors in `src/types-generated.ts` (the file is concatenated module output that does not type-check under the project's `tsconfig.json` import-resolution mode) and in the WebdriverIO `e2e/` specs (`browser` global not declared in the unit-test tsconfig). Neither is caused by B4 and both predate this task.
