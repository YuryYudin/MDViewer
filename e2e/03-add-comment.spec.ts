import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture, openDocByE2eHook, tripleClick } from './helpers/app';

describe('Add a comment to a selection', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
    // Start with no sidecar so the doc has zero threads — the spec asserts
    // exactly one new thread post-comment.
    await fs.rm(path.join(fixture.tmpDir, 'sample.md.comments.json'), { force: true });
  });
  after(async () => { await fixture.cleanup(); });

  it('attaches a new highlight + sidebar thread when a phrase is commented', async () => {
    await openDocByE2eHook(path.join(fixture.tmpDir, 'sample.md'));
    await browser.waitUntil(
      async () => browser.$('[data-view="document"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'document view did not mount' },
    );

    // Select a phrase inside an inline carrier that has data-src-offset.
    // Whole-paragraph selection won't work because pulldown-cmark only
    // annotates inline carriers (<span>/<code>) with offsets, not the
    // wrapping <p>. closestSrcEl in Document.ts walks UP the DOM looking
    // for data-src-offset, so we need a selection container that's at or
    // below an annotated element.
    const carrier = await browser.$('[data-view="document"] [data-src-offset]');
    expect(await carrier.isExisting()).toBe(true);
    // Use tripleClick on the carrier (e.g. the first inline span).
    await tripleClick('[data-view="document"] [data-src-offset]:first-of-type');

    expect(
      await browser.$('[data-view="selection-popover"]').isExisting(),
    ).toBe(true);
    await browser.$('[data-action="comment"]').click();

    // Compose the comment body and post it.
    await browser.$('[data-test="comment-body"]').setValue('First note');
    await browser.$('[data-action="post-comment"]').click();

    // The Document needs a refresh after createThread so the sidebar
    // re-renders. Workspace's refresh() picks up the new thread; wait
    // for it.
    await browser.waitUntil(
      async () =>
        browser.$('[data-view="sidebar-comments"] [data-test="thread"]').isExisting(),
      { timeout: 5_000, timeoutMsg: 'sidebar thread did not appear' },
    );

    expect(
      await browser.$('[data-view="document"] [data-anchor]').isExisting(),
    ).toBe(true);
    const sidebarThread = browser.$('[data-view="sidebar-comments"] [data-test="thread"]');
    expect(await sidebarThread.isExisting()).toBe(true);
    expect(await sidebarThread.$('[data-test="comment-body-rendered"]').getText()).toBe(
      'First note',
    );
  });
});
