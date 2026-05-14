// F1: Playwright oracle spec — Edit DOM ≡ View HTML block-tree.
//
// This is the SC #3 gate from the regression-net design doc:
// "The block tree extracted from Edit mode (CodeMirror live editor)
// and View mode (Rust pulldown-cmark HTML) for the same gallery
// fixture is deep-equal".
//
// Layer 2's vitest oracle (tests/render/oracle.test.ts) is permanently
// skipped because jsdom cannot host CodeMirror 6's decoration
// extensions faithfully (heading sigils leak as literal `#`, inline
// marks keep their `**…**` delimiters, block widgets never mount). The
// design doc's Risk paragraph authorized a Playwright fallback exactly
// for this reason — this spec is that fallback, running in a real
// Chromium so the full extension stack is live.
//
// Approach (per F1 task spec, choice (a)):
//   - Build the View tree from `render-cli` output (canonical Rust
//     pulldown-cmark pipeline) and project via `extractBlockTree`.
//   - Build the Edit tree from `#editor-host` in the live gallery page
//     and project via the same `extractBlockTree`.
//   - The two trees are NOT bit-for-bit deep-equal today — there are
//     real, documented asymmetries (whitespace collapse around inline
//     marks in B1/B2's known-quirks set; the mermaid widget shape;
//     code-block syntax-highlight spans). Rather than skip the
//     assertion, we capture the CURRENT diff as a snapshot. The diff
//     is a tightly-bounded structural diff: kind-mismatch, length
//     mismatch at a path, or scalar field mismatch. Any future drift
//     in either renderer surfaces as a snapshot-mismatch failure.
//
// What this catches:
//   - A new block kind appearing on one side only (e.g. an extra
//     `<hr>` slipping into the View HTML, or a stray paragraph from a
//     decoration regression).
//   - A field-shape change in `BlockNode` / `InlineNode` (the same
//     extractor walks both sides, so any shape change shows up
//     symmetrically and the snapshot length changes).
//   - Edit-mode losing or gaining a block (the `byPath` length on the
//     Edit side moves).
//
// What this does NOT catch (left as deferred SC #3 work):
//   - The whitespace-collapse asymmetries themselves. Closing those
//     gaps is a future task; SC #3 remains "partially met — drift
//     gate is live, full equivalence is documented but not enforced".

import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BlockNode, InlineNode } from '../src/views/render/blockTree.types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Repo root: e2e-visual/ → one level up.
const REPO_ROOT = path.resolve(__dirname, '..');
const GALLERY_FIXTURE = path.join(REPO_ROOT, 'e2e/fixtures/render-gallery.md');

/**
 * Run `render-cli <fixture>` and return its stdout (the View-mode
 * pulldown-cmark HTML). The binary path is exported by
 * `oracle.globalSetup.ts`.
 */
function renderViewHtml(): string {
  const bin = process.env.MDVIEWER_RENDER_CLI;
  if (!bin) {
    throw new Error(
      'MDVIEWER_RENDER_CLI not set — globalSetup did not run or failed. ' +
        'Check e2e-visual/oracle.globalSetup.ts.',
    );
  }
  return execFileSync(bin, [GALLERY_FIXTURE], { encoding: 'utf8' });
}

/**
 * Compute a structural diff between two block-tree projections. The
 * diff is a stable, sorted list of human-readable lines so it can be
 * snapshotted. Empty list ⇒ trees are deep-equal.
 *
 * Format per line:
 *   "PATH: <kind|description of mismatch>"
 *
 * We deliberately do NOT serialise the full trees into the snapshot
 * (they are thousands of lines each and a single character of text
 * drift would invalidate the whole baseline). The diff format is
 * narrow enough to make future regressions readable.
 */
function diffTrees(view: BlockNode[], edit: BlockNode[]): string[] {
  const out: string[] = [];
  diffBlockArray(view, edit, '$', out);
  out.sort();
  return out;
}

function diffBlockArray(
  view: BlockNode[],
  edit: BlockNode[],
  path: string,
  out: string[],
): void {
  if (view.length !== edit.length) {
    out.push(`${path}: length view=${view.length} edit=${edit.length}`);
  }
  const n = Math.min(view.length, edit.length);
  for (let i = 0; i < n; i++) {
    diffBlock(view[i], edit[i], `${path}[${i}]`, out);
  }
}

function diffBlock(
  v: BlockNode,
  e: BlockNode,
  path: string,
  out: string[],
): void {
  if (v.kind !== e.kind) {
    out.push(`${path}: kind view=${v.kind} edit=${e.kind}`);
    return;
  }
  switch (v.kind) {
    case 'heading': {
      const ee = e as Extract<BlockNode, { kind: 'heading' }>;
      if (v.level !== ee.level) {
        out.push(`${path}.level: view=${v.level} edit=${ee.level}`);
      }
      diffInlineArray(v.inline, ee.inline, `${path}.inline`, out);
      break;
    }
    case 'paragraph': {
      const ee = e as Extract<BlockNode, { kind: 'paragraph' }>;
      diffInlineArray(v.inline, ee.inline, `${path}.inline`, out);
      break;
    }
    case 'list': {
      const ee = e as Extract<BlockNode, { kind: 'list' }>;
      if (v.ordered !== ee.ordered) {
        out.push(`${path}.ordered: view=${v.ordered} edit=${ee.ordered}`);
      }
      if (v.items.length !== ee.items.length) {
        out.push(
          `${path}.items: length view=${v.items.length} edit=${ee.items.length}`,
        );
      }
      const m = Math.min(v.items.length, ee.items.length);
      for (let i = 0; i < m; i++) {
        diffBlockArray(v.items[i], ee.items[i], `${path}.items[${i}]`, out);
      }
      break;
    }
    case 'blockquote': {
      const ee = e as Extract<BlockNode, { kind: 'blockquote' }>;
      diffBlockArray(v.children, ee.children, `${path}.children`, out);
      break;
    }
    case 'code': {
      const ee = e as Extract<BlockNode, { kind: 'code' }>;
      if (v.language !== ee.language) {
        out.push(`${path}.language: view=${v.language} edit=${ee.language}`);
      }
      if (v.body !== ee.body) {
        out.push(`${path}.body: <mismatch len view=${v.body.length} edit=${ee.body.length}>`);
      }
      break;
    }
    case 'mermaid': {
      const ee = e as Extract<BlockNode, { kind: 'mermaid' }>;
      if (v.source !== ee.source) {
        out.push(
          `${path}.source: <mismatch len view=${v.source.length} edit=${ee.source.length}>`,
        );
      }
      break;
    }
    case 'table': {
      const ee = e as Extract<BlockNode, { kind: 'table' }>;
      if (v.headers.length !== ee.headers.length) {
        out.push(
          `${path}.headers: length view=${v.headers.length} edit=${ee.headers.length}`,
        );
      } else {
        for (let i = 0; i < v.headers.length; i++) {
          if (v.headers[i] !== ee.headers[i]) {
            out.push(`${path}.headers[${i}]: view=${JSON.stringify(v.headers[i])} edit=${JSON.stringify(ee.headers[i])}`);
          }
        }
      }
      if (v.rows.length !== ee.rows.length) {
        out.push(`${path}.rows: length view=${v.rows.length} edit=${ee.rows.length}`);
      } else {
        for (let i = 0; i < v.rows.length; i++) {
          const vr = v.rows[i];
          const er = ee.rows[i];
          if (vr.length !== er.length) {
            out.push(
              `${path}.rows[${i}]: length view=${vr.length} edit=${er.length}`,
            );
            continue;
          }
          for (let j = 0; j < vr.length; j++) {
            if (vr[j] !== er[j]) {
              out.push(
                `${path}.rows[${i}][${j}]: view=${JSON.stringify(vr[j])} edit=${JSON.stringify(er[j])}`,
              );
            }
          }
        }
      }
      break;
    }
    case 'hr':
      // Nothing to compare beyond kind.
      break;
  }
}

/**
 * Recursive InlineNode array diff. Kept narrow: only emit one line
 * per scalar field mismatch and one line per length mismatch.
 */
function diffInlineArray(
  view: InlineNode[],
  edit: InlineNode[],
  path: string,
  out: string[],
): void {
  if (view.length !== edit.length) {
    out.push(`${path}: length view=${view.length} edit=${edit.length}`);
  }
  const n = Math.min(view.length, edit.length);
  for (let i = 0; i < n; i++) {
    diffInline(view[i], edit[i], `${path}[${i}]`, out);
  }
}

function diffInline(
  v: InlineNode,
  e: InlineNode,
  path: string,
  out: string[],
): void {
  if (v.kind !== e.kind) {
    out.push(`${path}: kind view=${v.kind} edit=${e.kind}`);
    return;
  }
  switch (v.kind) {
    case 'text': {
      const ee = e as Extract<InlineNode, { kind: 'text' }>;
      if (v.text !== ee.text) {
        out.push(`${path}.text: view=${JSON.stringify(v.text)} edit=${JSON.stringify(ee.text)}`);
      }
      return;
    }
    case 'image': {
      const ee = e as Extract<InlineNode, { kind: 'image' }>;
      if (v.src !== ee.src) {
        out.push(`${path}.src: <mismatch>`);
      }
      if (v.alt !== ee.alt) {
        out.push(`${path}.alt: view=${JSON.stringify(v.alt)} edit=${JSON.stringify(ee.alt)}`);
      }
      return;
    }
    case 'link': {
      const ee = e as Extract<InlineNode, { kind: 'link' }>;
      if (v.href !== ee.href) {
        out.push(`${path}.href: view=${JSON.stringify(v.href)} edit=${JSON.stringify(ee.href)}`);
      }
      diffInlineArray(v.children, ee.children, `${path}.children`, out);
      return;
    }
    case 'strong':
    case 'em':
    case 'strike':
    case 'code': {
      const ee = e as Extract<InlineNode, { kind: 'strong' | 'em' | 'strike' | 'code' }>;
      diffInlineArray(v.children, ee.children, `${path}.children`, out);
      return;
    }
  }
}

test('block-tree oracle: View ≡ Edit (snapshot of known diff)', async ({ page }) => {
  // 1. Boot the gallery host (this is the same page gallery.spec.ts hits).
  await page.goto('/');
  await page.waitForSelector('body[data-ready="true"]');

  // 2. Pull View-mode HTML from render-cli (canonical Rust pipeline).
  const viewHtml = renderViewHtml();
  expect(viewHtml.length, 'render-cli must emit some HTML').toBeGreaterThan(0);

  // 3. In the page, project both DOMs onto canonical BlockNode trees
  //    using the SAME extractor (window.__extractBlockTree wired up
  //    by gallery-page/main.ts).
  const { viewTree, editTree } = await page.evaluate(async (html: string) => {
    const extract = (
      window as unknown as { __extractBlockTree?: (root: Element) => unknown }
    ).__extractBlockTree;
    if (!extract) {
      throw new Error(
        'window.__extractBlockTree missing — gallery-page/main.ts did not expose it',
      );
    }
    // Build a detached <div> with the View-mode HTML for the walker.
    const viewRoot = document.createElement('div');
    viewRoot.innerHTML = html;
    const editRoot = document.getElementById('editor-host');
    if (!editRoot) throw new Error('#editor-host missing in gallery page');
    return {
      viewTree: extract(viewRoot),
      editTree: extract(editRoot),
    };
  }, viewHtml);

  // 4. Sanity: both trees must be non-empty arrays. If either side
  //    extracts to [], the test fails loudly — that's a real regression
  //    in the harness, not an asymmetry to snapshot.
  expect(Array.isArray(viewTree), 'viewTree must be an array').toBe(true);
  expect(Array.isArray(editTree), 'editTree must be an array').toBe(true);
  expect((viewTree as unknown[]).length, 'viewTree must be non-empty').toBeGreaterThan(0);
  expect((editTree as unknown[]).length, 'editTree must be non-empty').toBeGreaterThan(0);

  // 5. Compute the structural diff and snapshot it. An empty diff
  //    means View ≡ Edit (full SC #3 met). A non-empty diff is the
  //    baseline of today's known asymmetries — future drift in either
  //    renderer changes this list and the snapshot mismatch fires.
  const diff = diffTrees(viewTree as BlockNode[], editTree as BlockNode[]);
  const snapshotText = diff.length === 0
    ? '<no diff: View ≡ Edit>\n'
    : diff.join('\n') + '\n';

  // Write the snapshot to the same baselines/linux/ tree that the
  // pixel-diff baselines live under. The custom extension keeps it
  // distinct from the .png shots.
  const baselinePath = path.join(
    __dirname,
    'baselines',
    'linux',
    'oracle.snap.txt',
  );

  let baseline: string | null = null;
  try {
    baseline = readFileSync(baselinePath, 'utf8');
  } catch {
    baseline = null;
  }

  if (baseline === null) {
    // First run: surface the actual diff in the failure so the
    // operator can pin it as the baseline. The CI gate is intentionally
    // strict — we don't auto-create baselines.
    throw new Error(
      `Baseline missing: ${baselinePath}\n\n` +
        `Write the file with the following contents to pin today's diff:\n\n` +
        snapshotText,
    );
  }

  // 6. The actual gate. Stable sort + trailing newline so diffs are
  //    line-oriented.
  expect(snapshotText, 'block-tree diff drifted from baseline').toBe(baseline);
});
