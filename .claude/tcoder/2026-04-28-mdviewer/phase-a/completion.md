# Phase A — Completion Summary

**Status:** Complete (2026-04-29). 13/13 implementation tasks merged into `integrate/mdviewer`. Implementation review passed with zero issues.

## Coverage gate (enforce@90)

| File | Coverage | Notes |
|---|---|---|
| `src-tauri/src/anchor.rs` | 97.26% | UTF-8 multi-match regression covered |
| `src-tauri/src/bin/export_types.rs` | 98.92% | ts-rs codegen pipeline |
| `src-tauri/src/comments.rs` | 98.30% | RFC3339 timestamps, atomic ID counter |
| `src-tauri/src/document.rs` | 98.30% | GFM + data-src-offset annotations |
| `src-tauri/src/lib.rs` | 100% | re-exports + BuildInfo |
| `src-tauri/src/recents.rs` | 90.48% | corrupt-file fallback |
| `src-tauri/src/settings.rs` | 96.20% | std::sync::mpsc fan-out |
| `src-tauri/src/sidecar.rs` | 92.50% | JSON schema_version: 1 |
| `src-tauri/src/workspace.rs` | 95.60% | OpenOutcome (Document/Conflict shape ready for C2) |
| `src-tauri/src/main.rs` | 0% | **Exempt** per design Test Coverage section (Tauri framework wiring; A8b's tests/ipc_registration.rs covers handler shapes pure-Rust). |
| TypeScript overall | 99.59% | All `src/views/*` and `src/*.ts` ≥93% |

Threshold 90% met by every non-exempt file.

## Hand-off contracts in place for Phase B/C

- ts-rs codegen pipeline: any new `#[derive(ts_rs::TS)]` type just needs to be appended to `bin/export_types.rs::export_all` using `Type::export_to_string().unwrap()`. `tests/codegen.test.ts` is bit-exact and will fail loudly if a new type is added without the export.
- `Workspace::OpenOutcome::Document | Conflict` enum is shipped — Phase 3's C2 only needs to populate the `Conflict` variant from divergence detection.
- `CommentsStore::create_thread` returns `Thread` (not just an id) — Phase 3 IPC handlers and frontend consumers rely on this.
- Sidecar schema_version is hard-coded to `1` at two sites in `sidecar.rs`. C1 should gate both reads and writes through a shared constant or migration path.
- Settings is the single source of truth for `auto_merge` policy and `reattachment_confidence` threshold.
- `default_shortcuts()` action keys (`settings.rs`) match `keymap.ts` Action union exactly. Adding a new shortcut requires updating both.

## Phase-A success criteria delivered

C1 (GFM render + toggles), C2 (select → comment → reply → resolve), C3 (profile setup + edit later), C5 (sidecar exchange exact-anchor), C8 (themes), C9 (settings take effect immediately).
C4 (light editing), C6/C7 (CRDT auto-merge + conflict diff), C10 (per-OS bundling) are deferred to Phase B/C.

## E2E gate state

`npm run test:e2e` reports 10 ✖ on this macOS dev host (`tauri-driver` is not supported on macOS, so wdio session-start fails — that satisfies the Phase-A RED state). Linux/Windows runners will actually exercise the binary in Phase C5.

## Implementation review

Recorded as `impl-review / phase-a / pass` (zero issues) in `reviews.json`.
