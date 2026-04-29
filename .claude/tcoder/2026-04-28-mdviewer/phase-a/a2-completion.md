# A2 Completion Notes

**Summary:** Scaffolded the Tauri 2 Rust crate (`src-tauri/`), the Vite-rooted frontend bootstrap (`src/index.html`, `src/main.ts`, `vite.config.ts`), and a `build.rs` that injects `MDVIEWER_VERSION` and `MDVIEWER_COMMIT_HASH` constants exposed via `mdviewer_lib::build_info()`. A scaffold integration test asserts both constants are non-empty and that the version matches `CARGO_PKG_VERSION`.

**Deviations:**
- Added `src-tauri/icons/icon.png` (32x32 transparent placeholder PNG) — Rule 3 (auto-fix blocker). Reason: `tauri::generate_context!()` proc-macro in `main.rs` panics at compile time with `failed to open icon icons/icon.png: No such file or directory` even though `tauri.conf.json` declares `bundle.icon = []`. The macro hard-codes the default-window-icon path lookup independent of the bundle config (see `tauri-codegen-2.5.5/src/context.rs:213-246`). Without a placeholder file the entire crate fails to compile, blocking both the scaffold test and `cargo build`. The placeholder is overwritten by Phase C/C4 (icon pipeline). Plan path `files.create` has been augmented locally with this file.
- `package.json` was not modified — A1 already includes `"tauri": "tauri"` and all build/test scripts the task references. Listed under `files.modify` but no change needed (matches Step 8's note: "the npm run scripts from A1 already cover most").

**Files Changed:**
- Created: `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`, `src-tauri/tests/scaffold.rs`, `src/index.html`, `src/main.ts`, `vite.config.ts`, `src-tauri/icons/icon.png` (deviation, see above).
- Modified: none (`package.json` unchanged — already correct from A1).

**Test Results:**
- `cd src-tauri && cargo test --test scaffold` -> `1 passed; 0 failed` (verified RED first: pre-Cargo.toml run failed with "could not find Cargo.toml"; after writing the crate, test passes).
- `npm run build` -> succeeds, emits `dist/index.html` + `dist/assets/index-*.js` (gzip 0.23 kB / 0.61 kB).
- `cargo build` (release of debug binary at `src-tauri/target/debug/mdviewer`) succeeds.
- `cargo clippy --no-deps` -> clean, no warnings.
- Coverage (`cargo llvm-cov --test scaffold --summary-only`):
  - `lib.rs` (production target of this task): **100%** lines / 100% functions — exceeds the 90% threshold.
  - `main.rs` is 0% as expected; it is the Tauri runtime entry (`tauri::Builder::default().run(...)`) which blocks until the GUI exits and is exercised by the headless harness in A8b, not Phase-A unit tests.

**Deferred Issues:**
- `npm install` produced 11 npm-audit findings (8 moderate, 3 high) inherited from the A1 dev-dependency tree. Pre-existing — not introduced by A2 — so left for a future sweep.
- The placeholder `icons/icon.png` is a 1x1-content 32x32 transparent PNG; real branded icon assets are scoped to Phase C/C4.
