# A7 Completion Notes

**Summary:** Implemented `comments.rs` (in-memory thread/comment store with `std::sync::mpsc` change-event fan-out) and `sidecar.rs` (JSON sidecar IO at `schema_version: 1` plus a stubbed `merge_with_policy` for B2's auto-merge wiring). Added ts-rs exports for `Comment`, `Thread`, `NewComment`, `NewThread` and re-ran codegen.

**Deviations:**
- Added `Default for CommentsStore` and `#[derive(Debug)]` on `CommentsStore` — Rule 2 (critical). `Default` is idiomatic for an empty store and `Debug` is required by `Result::unwrap_err()` in negative-path tests; both are defensive plumbing rather than scope creep.
- Added a `MergeOutcome` enum and `merge_with_policy(local, incoming, mode, incoming_is_newer)` helper as the auto-merge attachment point referenced in the task's "done_when" — Rule 2. The task spec sketches `MergeOutcome` in Step 3 but doesn't include a working policy function or a test; I added both so B2 has a real symbol to call.
- Added a `replace_all` mutator that emits `ChangeEvent::Bulk` so subscribers redraw after a sidecar adopt — Rule 2. Required to make `ChangeEvent::Bulk` exercisable from outside and to give B2 a clean way to apply an adopted store.
- Added 10 extra tests beyond the 7 in the spec: error paths (post_reply / resolve_thread on unknown IDs, `get_thread` miss, invalid-JSON sidecar, unknown schema_version), boundary cases (`Default::default`, dropped-subscriber pruning, missing parent dir on save, distinct-anchor round-trip), and full coverage of `merge_with_policy` (Always-newer, Always-older, Ask, Manual). Needed to clear the 90% coverage threshold on the touched files. Threshold ended at comments.rs 100% / sidecar.rs 92.5%.
- Did not implement an injectable `Clock` trait per the "Avoid" guidance, since the spec test only asserts `resolved_at.is_some()` and the sample implementation in the task uses `now_rfc3339()` directly. If C1 needs deterministic timestamps for its migration test it can refactor then. — No rule, just declining gold-plating.

**Files Changed:**
- Created: `src-tauri/src/comments.rs`
- Created: `src-tauri/src/sidecar.rs`
- Created: `src-tauri/tests/comments.rs`
- Created: `src-tauri/tests/sidecar.rs`
- Modified: `src-tauri/src/lib.rs` (added `pub mod comments; pub mod sidecar;`)
- Modified: `src-tauri/src/bin/export_types.rs` (appended four `export_to_string` calls)
- Regenerated: `src/types-generated.ts`

**Test Results:**
- `cargo test --test comments`: 12 passed, 0 failed
- `cargo test --test sidecar`: 11 passed, 0 failed
- Full `cargo test`: all suites green
- Coverage on touched files: `comments.rs` 100% regions / 100% lines / 100% functions; `sidecar.rs` 92.5% regions / 95.9% lines / 100% functions. Both clear the 90% gate.

**Deferred Issues:**
- Pre-existing clippy warnings in `src/settings.rs` (auto-deref) and `src/bin/export_types.rs` (`single_char_add_str` from prior tasks A2-A6's `buf.push_str("\n")` pattern). My new `push_str("\n")` calls in `export_types.rs` match the established pattern; rewriting just my lines would create stylistic inconsistency in a file that's about to be deleted by the codegen pipeline. Better fixed wholesale in a followup. None of my own files emit clippy warnings.
