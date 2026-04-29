# A6 Completion Notes

**Summary:** Added the `Anchor` model (W3C TextQuoteSelector + TextPositionSelector flattened into one struct) and `ResolveOutcome` tagged enum, plus a Phase-1 `resolve_anchor` that performs exact-quote search with prefix/suffix-length scoring and an offset-distance tiebreak. Fuzzy matching is intentionally deferred to Phase 2 (B1). The new types are wired through `export_types.rs` to `src/types-generated.ts` for the IPC layer.

**Deviations:** None. The plan was followed verbatim — same struct field order, same enum tag layout, same scoring algorithm, same helper signatures.

**Files Changed:**
- created `src-tauri/src/anchor.rs`
- created `src-tauri/tests/anchor.rs`
- modified `src-tauri/src/lib.rs` (added `pub mod anchor;`)
- modified `src-tauri/src/bin/export_types.rs` (appended Anchor + ResolveOutcome exports)
- regenerated `src/types-generated.ts` (auto-generated)

**Test Results:**
- `cargo test --test anchor`: 9 passed (5 from spec + 4 added for branch coverage: empty-exact orphan, multi-match nearest-offset tiebreak, ResolveOutcome::Resolved serde, ResolveOutcome::Orphan serde).
- `cargo test` (full suite): 0 failures across all integration tests.
- Coverage on `src-tauri/src/anchor.rs` (cargo llvm-cov --test anchor): **93.55% lines, 97.10% regions, 100% functions** — meets the enforce@90 threshold.
- The remaining 4 uncovered lines (56, 75–77) are defensive `is_char_boundary_pair` fallback branches; they are unreachable today because `str::find` on a UTF-8 substring always returns valid char-boundary indices, but kept as defense-in-depth for B1's fuzzy callers that may pass arbitrary indices.
- Frontend codegen test: `tests/codegen.test.ts` confirms `types-generated.ts` is bit-exact.

**Deferred Issues:**
- Frontend `npm run test:coverage` reports 0% on `main.ts` and fails the global 90% threshold. This is pre-existing (main.ts has had no tests since A1) and is not introduced by A6; it should be picked up by whichever later task adds the first frontend module under coverage.
