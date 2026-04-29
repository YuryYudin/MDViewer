# A4 Completion Notes

**Summary:** Implemented `RecentsStore` — a JSON-backed MRU list at `<data_dir>/recents.json`, capped at 10, with canonicalize+fallback dedupe in `push()` and existence-pruning in `open()`. Added `pub mod recents;` to `lib.rs` so the integration test crate (and later A8b IPC handlers) can use it.

**Deviations:**
- Updated assertions in `push_moves_existing_to_top` and `missing_paths_are_pruned_on_load` to compare against `path.canonicalize().unwrap()` — Rule 1 — the spec snippet asserted against the as-given paths but `push` canonicalizes, so on macOS (`/var/folders → /private/var/folders`) those assertions would fail. Same reasoning the task highlight gave for fixing `cap_of_ten`; applied consistently to all tests that observe pushed paths.
- Added a 4th test `push_falls_back_when_canonicalize_fails` — Rule 2 (auto-add critical) — to lock in the documented `unwrap_or_else` fallback behavior. Without it the fallback branch was uncovered and the contract was untested.

**Files Changed:**
- Created `src-tauri/src/recents.rs`
- Created `src-tauri/tests/recents.rs`
- Modified `src-tauri/src/lib.rs` (added `pub mod recents;`)

**Test Results:**
- `cargo test --test recents`: 4 passed, 0 failed
- Full `cargo test` workspace: 13 passed, 0 failed (recents 4, scaffold 1, settings 7, export_types_bin 1)
- Coverage on `recents.rs`: 93.85% regions, 97.14% lines, 100% functions — above the 90% threshold. The single uncovered line is the `?` propagation on `std::fs::write` failure (disk-full error path).

**Deferred Issues:** None. Frontend `npm run test:coverage` was not exercised because no frontend files were touched in this task; the worktree's `node_modules` was not provisioned and `vitest` is not on PATH, but this is an environment issue rather than a code issue.
