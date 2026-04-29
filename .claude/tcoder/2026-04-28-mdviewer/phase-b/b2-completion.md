# B2 Completion Notes

**Summary:** Implemented a notify-based file watcher that tracks each open `.md` plus its sidecar (one notify handle per path, NonRecursive) and emits typed `ExternalChangeEvent`s whose `action` field honors the user's external-change behavior setting. The unsaved-edits dirty bit forces Ask regardless of setting, and self-write suppression via `record_self_write` + `quick_hash` (both `pub` for B3's cross-crate test access) blocks our own save_document writes from echoing back. main.rs registers `Mutex<Watcher>` as managed state and subscribes to settings changes so toggles take effect live.

**Deviations:**
- Added a `canonical(p)` helper that runs `std::fs::canonicalize` on every path the watcher stores or compares against — Rule 3 (auto-fix blocker). On macOS, `TempDir` paths resolve to `/var/folders/...` but FSEvents reports the canonical `/private/var/folders/...`, so a naive `HashSet<PathBuf>` lookup missed every event. The watcher now emits canonical paths to consumers.
- Added `Serialize` derives on `WatchedKind`, `ExternalChange`, and `ExternalChangeEvent` (plus `serde_json::Serialize`-friendly snake_case rename) — Rule 3. The plan's `app.emit("external-change", &ev)` line in main.rs requires the payload to be serializable; without `Serialize` it would not compile.
- Subscribed to `SettingsStore::ChangeEvent::Editor` in main.rs and re-applied behavior on each tick — followed the task's "// ... per the existing settings-subscribe pattern ..." note, since otherwise toggles from the Settings screen would not reach the watcher's snapshot until the next process restart.
- Updated test `external_md_change_emits_event_per_setting_ask` to compare the emitted path against `fs::canonicalize(&md)` rather than the raw `md` value — the watcher's contract is canonical paths, and consumers must read them as such.
- Added 3 extra tests (`record_self_write_suppresses_matching_event`, `record_self_write_does_not_suppress_other_paths`, `quick_hash_is_deterministic`) to bring `watcher.rs` coverage above the 90% threshold and to lock in the contract B3 will rely on.

**Files Changed:**
- Created `src-tauri/src/watcher.rs`
- Created `src-tauri/tests/watcher.rs`
- Modified `src-tauri/Cargo.toml` (added `notify = "6"`)
- Modified `src-tauri/Cargo.lock` (transitive lock updates from notify)
- Modified `src-tauri/src/lib.rs` (added `pub mod watcher;`)
- Modified `src-tauri/src/main.rs` (constructs `Watcher`, registers `Mutex<Watcher>`, spawns event-forwarder + settings-subscriber threads, imports `watcher::{ExternalChangeEvent, Watcher}`)

**Test Results:**
- `cargo test --test watcher`: 8 passed (5 plan-required + 3 coverage tests)
- `cargo test` (full suite): all 14 test files pass, 0 failures
- Coverage on `watcher.rs`: 93.01% regions / 92.05% lines / 91.67% functions (above 90% threshold)
- Remaining uncovered branches in `watcher.rs` are infrastructure error paths: notify worker error result, non-Modify/Create event kinds, path not in either set, fs::read failure, and `RecommendedWatcher::new` `?` failure. These require platform-specific or impossible-to-trigger conditions and are not worth synthetic mocks.

**Deferred Issues:** None.
