// Regression test — caught a real production bug in v0.5.0 where
// dense markdown documents (>~80 lines) showed RAW heading sigils
// (`#`, `##`, `###`) and bold markers (`**`) in the live editor's
// render mode. Root cause: lezer parses incrementally;
// `syntaxTree(state)` returned an unfinished tree on first
// decoration build, so nodes past the parse frontier never got
// their sigil-hide decorations applied.
//
// Fix lives in src/views/decorations/inlineMarks.ts:buildDecorations
// — `ensureSyntaxTree(state, doc.length, 200)` forces the parser to
// catch up before iterate() walks for decorations.
//
// This spec keeps the regression locked down by loading a dense,
// realistic markdown fixture (matches the size/structure of the
// user report that surfaced the bug) and asserting that the live
// editor's rendered textContent does NOT contain raw sigils on any
// non-caret line.
//
// The fixture is `e2e/fixtures/render-bug-repro.md` (~150 lines, 1
// h1 / 8 h2 / 15 h3 / 20 bold / 118 inline code). Density mirrors a
// real-world code-review document.

import { test, expect } from '@playwright/test';

test('render mode: dense document has no leaking markdown sigils', async ({ page }) => {
  test.setTimeout(60_000);
  // Tall viewport so CM6 materializes every .cm-line — same trick
  // the oracle test uses; otherwise CM's viewport virtualization
  // would mask whether the sigil-hide decorations actually fire on
  // the tail of the document.
  await page.setViewportSize({ width: 1024, height: 8000 });
  await page.goto('http://localhost:4174/?fixture=render-bug-repro');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });

  // Read the visible text the user actually sees in the editor.
  const editorText = await page.locator('#editor-host').innerText();
  expect(editorText.length, 'editor must have rendered content').toBeGreaterThan(1000);

  // Count any leaked heading sigils. By design, the heading-line
  // touching the caret keeps its `#` visible (reveal-on-caret UX).
  // The fixture's first line is the h1 and the caret defaults to
  // offset 0, so we accept at most ONE heading-prefix leak (the
  // first line). Every other line must be sigil-stripped.
  const headingLeaks = editorText.match(/^#{1,6}\s.*$/gm) ?? [];
  expect(
    headingLeaks.length,
    `unexpected raw heading sigils in render mode — got ${headingLeaks.length}, first 5: ${JSON.stringify(headingLeaks.slice(0, 5))}`,
  ).toBeLessThanOrEqual(1);

  // Bold sigils (`**...**`) should also be hidden on non-caret lines.
  // We allow at most one leak in case a `**...**` spans the caret
  // line. Filter out any false positives where `**` appears inside
  // an `inline code` span (which the user IS supposed to see verbatim).
  const stripCode = editorText.replace(/`[^`]+`/g, '');
  const boldLeaks = stripCode.match(/\*\*[^*\s][^*]*\*\*/g) ?? [];
  expect(
    boldLeaks.length,
    `unexpected raw bold sigils — got ${boldLeaks.length}, first 5: ${JSON.stringify(boldLeaks.slice(0, 5))}`,
  ).toBeLessThanOrEqual(1);
});
