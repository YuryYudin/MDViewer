import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture, openDocByE2eHook } from '../../helpers/app';

/**
 * Phase-1 WYSIWYG acceptance: "Selection → comment posts a thread."
 *
 * Given the user selects a phrase in render mode and triggers the
 * popover as in `wireframes/08-selection-comment.html`, when they post a
 * comment, then a new thread appears in the sidebar quoting the exact
 * selected text and the selection range is highlighted with
 * `mark[data-anchor]`.
 *
 * RED until A.8 (SelectionPopover -> CodeMirror state.selection.main)
 * lands. The new selection path reads from EditorView.state, not from
 * DOM Range walks over data-src-offset spans.
 */
describe('WYSIWYG: selection → comment posts a thread quoting the selected text', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
    await fs.rm(path.join(fixture.tmpDir, 'sample.md.comments.json'), { force: true });
  });
  after(async () => { await fixture.cleanup(); });

  it('creates a thread + mark[data-anchor] highlight whose quote matches the selection', async () => {
    const target = path.join(fixture.tmpDir, 'sample.md');
    const source = await fs.readFile(target, 'utf8');
    await openDocByE2eHook(target);
    await browser.waitUntil(
      async () => browser.$('[data-testid="live-editor"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'live-editor surface never mounted' },
    );

    // Select the phrase "Selectable phrase one" in the fixture. The
    // SelectionPopover, rewired in A.8 to read EditorView.state.selection,
    // surfaces the popover at [data-testid="selection-popover"].
    const phrase = 'Selectable phrase one';
    const start = source.indexOf(phrase);
    expect(start).toBeGreaterThan(0);
    const end = start + phrase.length;

    await browser.executeAsync(
      function (s: number, e: number, done: (v: unknown) => void): void {
        const w = window as unknown as {
          __mdviewerE2E?: { setLiveEditorSelection?: (s: number, e: number) => Promise<void> };
        };
        if (!w.__mdviewerE2E?.setLiveEditorSelection) {
          done({ error: 'setLiveEditorSelection hook missing' });
          return;
        }
        w.__mdviewerE2E
          .setLiveEditorSelection(s, e)
          .then(() => done(null), (e2) => done({ error: String(e2) }));
      },
      start,
      end,
    );

    const popover = browser.$('[data-testid="selection-popover"]');
    await browser.waitUntil(
      async () => popover.isExisting(),
      { timeout: 5_000, timeoutMsg: 'selection popover did not appear' },
    );

    await popover.$('button[data-action="comment"]').click();

    // Compose and post the comment (existing data-test selectors).
    await browser.$('[data-test="comment-body"]').setValue('Live-edit thread');
    await browser.$('[data-action="post-comment"]').click();

    await browser.waitUntil(
      async () =>
        browser.$('[data-view="sidebar-comments"] [data-test="thread"]').isExisting(),
      { timeout: 5_000, timeoutMsg: 'sidebar thread did not appear' },
    );

    // The new thread quotes the EXACT selected text — the LiveEditor's
    // EditorView.doc.sliceString returns the same bytes the file shows.
    const sidebarThread = browser.$('[data-view="sidebar-comments"] [data-test="thread"]');
    const quoteText = await sidebarThread.$('.quote').getText();
    expect(quoteText).toContain(phrase);

    // The selection range is decorated by commentHighlights.ts as a
    // <mark data-anchor="..."> overlay in the live-editor surface.
    const anchor = browser.$('[data-testid="live-editor"] mark[data-anchor]');
    await browser.waitUntil(
      async () => anchor.isExisting(),
      { timeout: 5_000, timeoutMsg: 'mark[data-anchor] highlight never rendered' },
    );
    expect(await anchor.getText()).toContain(phrase);
  });
});
