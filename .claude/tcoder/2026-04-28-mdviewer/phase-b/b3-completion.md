# B3 Completion Notes

**Summary:** Implemented atomic `save_document` (tmp + fsync + rename) returning a `SaveResult { bytes_written, content_hash }`, wired the matching `save_document` Tauri IPC command that records a self-write entry on the watcher and refreshes the in-memory tab via the new `Workspace::refresh_tab`. Added the `saveDocument(path, contents)` method to `src/ipc.ts` and an Ipc-shape unit test asserting all 15 methods are present.

**Deviations:** None. The plan was followed as written. The handler example in the spec records the self-write *after* `save_document` returns (i.e. after the rename); my implementation matches that ordering, and the integration test `save_document_does_not_trigger_reload` confirms the suppression works at that ordering — the tiny mutex-acquisition gap between rename and `record_self_write` is well within notify's debounce window.

**Files Changed:**
- `src-tauri/src/document.rs` — added `SaveResult` and `save_document` (atomic write + quick_hash)
- `src-tauri/src/main.rs` — added `save_document` Tauri command, registered it in `invoke_handler!`, updated module doc comment
- `src-tauri/src/workspace.rs` — added `Workspace::refresh_tab(&Path) -> Result<()>`
- `src-tauri/tests/document.rs` — 3 new tests (atomic-write+hash, extensionless-path tmp suffix, overwrite)
- `src-tauri/tests/watcher.rs` — 2 new B3 tests (`save_document_does_not_trigger_reload`, `external_write_after_save_still_triggers`)
- `src-tauri/tests/workspace.rs` — 2 new tests covering refresh_tab happy path and the no-open-tab error
- `src/ipc.ts` — added `saveDocument` to `Ipc` interface and `tauriIpc` adapter
- `tests/ipc.test.ts` — added per-method `saveDocument` test plus a 15-method shape pin

**Test Results:**
- `cargo test --test document` -> 21/21 passed (3 new)
- `cargo test --test watcher` -> 10/10 passed (2 new)
- `cargo test --test workspace` -> 14/14 passed (2 new)
- `cargo test --test ipc_registration` -> 9/9 passed
- `cargo test` (full suite) -> all green
- `npm run test -- tests/ipc.test.ts` -> 16/16 passed
- `npm run test` (full suite) -> 120/120 passed
- Coverage on touched files (cargo llvm-cov regions/lines):
  - `document.rs` 97.40% / 98.63%
  - `watcher.rs` 93.01% / 92.05%
  - `workspace.rs` 94.64% / 96.73%
  All exceed the 90% threshold. (Function-percentage figures from cargo-llvm-cov double-count duplicate symbols across multiple test binaries; region/line metrics are the meaningful ones.)
- JS coverage: `src/ipc.ts` at 100%/100%/100%/100%.

**Deferred Issues:** None.
