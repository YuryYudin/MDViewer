import { describe, it } from 'vitest';

/**
 * Layer 2 of the regression-net suite — the block-tree oracle test.
 *
 * Status: this file is INTENTIONALLY a thin skip-with-message wrapper.
 *
 * The B3 task spec's Step 4 ("Handle the jsdom-spike outcome") calls
 * out the design-doc risk: CodeMirror 6's decoration extensions
 * (`inlineMarks`, `blockWidgets`, `tables`, `commentHighlights`) rely
 * on live DOM measurements and the browser's contenteditable
 * rendering pipeline. jsdom does not run those code paths the same
 * way a real browser does, so the Edit-mode DOM the extractor walks
 * is materially different from the View-mode HTML pulldown-cmark
 * produces:
 *
 *   - heading sigils (`#`, `##`, …) are emitted as literal text
 *     instead of being wrapped in `.sigil.hidden` spans the walker
 *     knows how to strip;
 *   - inline marks (`**bold**`, `*italic*`, `~~strike~~`) keep their
 *     markdown delimiters in the rendered text rather than mapping
 *     to `<strong>`/`<em>`/`<del>` equivalents;
 *   - block widgets (tables, fenced code, mermaid) do not mount,
 *     so the canonical tree's `kind:'table'` / `kind:'code'` /
 *     `kind:'mermaid'` nodes are missing on the Edit side.
 *
 * The Step 4 documented mitigation is to land the SAME oracle as a
 * Playwright spec at `e2e-visual/oracle.spec.ts` once C1/C2 stand up
 * the Vite-served gallery page that mounts the full extension stack
 * in a real browser. B3's contribution is the surrounding harness
 * (the globalSetup module that gates the `render-cli` build behind
 * `MDVIEWER_BUILD_ORACLE=1`, and the `vitest.config.ts` wiring), so
 * the bin is built and the path is exported regardless of the test
 * outcome — Playwright (or whichever later task picks this up) just
 * reads `process.env.MDVIEWER_RENDER_CLI`.
 *
 * The env-gated skip path here is the contract: `MDVIEWER_BUILD_ORACLE=1`
 * still builds `render-cli` via the globalSetup so downstream consumers
 * have the binary; the test itself reports skipped with a message
 * pointing at the Playwright follow-up. When the env var is unset the
 * globalSetup also skips the build and the message says so.
 *
 * Why a skip and not a deletion: the file's presence keeps the
 * `vitest.config.ts` `globalSetup` reference live (Vitest errors out
 * when a registered globalSetup module disappears) and gives the
 * follow-up task a single place to find the documented contract.
 */
describe('block-tree oracle: View HTML ≡ Edit DOM', () => {
  if (process.env.MDVIEWER_RENDER_CLI === undefined) {
    it.skip(
      'MDVIEWER_BUILD_ORACLE not set — skipping. Run `MDVIEWER_BUILD_ORACLE=1 npm test` ' +
        'to build render-cli; the oracle assertions themselves live in the Playwright ' +
        'spec at e2e-visual/oracle.spec.ts (added by C1/C2 once the gallery page exists).',
      () => {
        /* harness-only skip */
      },
    );
    return;
  }
  it.skip(
    'jsdom cannot host CodeMirror 6 decoration extensions faithfully — the oracle ' +
      'assertions run as a Playwright spec at e2e-visual/oracle.spec.ts (C1/C2 ' +
      'milestone). The `render-cli` binary is built by the globalSetup; its absolute ' +
      'path is exported via MDVIEWER_RENDER_CLI for Playwright to consume.',
    () => {
      /* harness-only skip */
    },
  );
});
