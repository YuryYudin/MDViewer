import path from 'node:path';
import { prepareFixture, openDocByE2eHook } from './helpers/app';

describe('Reply to and resolve an existing thread', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
  });
  after(async () => { await fixture.cleanup(); });

  it('appends a reply to t-1 and marks the thread resolved', async () => {
    await openDocByE2eHook(path.join(fixture.tmpDir, 'sample.md'));
    await browser.waitUntil(
      async () => browser.$('[data-view="document"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'document view did not mount' },
    );

    // CommentsSidebar mounts ThreadDetail inline under each thread, so
    // the reply composer is already visible — no need to click the t-1
    // highlight first. Re-fetch the article reference between actions
    // because Workspace.refreshThreads re-mounts the sidebar each time.
    const t1Selector =
      '[data-view="sidebar-comments"] [data-test="thread"][data-thread-id="t-1"]';
    expect(await browser.$(t1Selector).isExisting()).toBe(true);

    await browser.$(`${t1Selector} [data-test="reply-body"]`).setValue('Reply body');
    await browser.$(`${t1Selector} [data-action="post-reply"]`).click();
    // Wait for the re-mount to settle so subsequent queries hit the new DOM.
    await browser.waitUntil(
      async () => browser.$(`${t1Selector} [data-action="resolve"]`).isExisting(),
      { timeout: 5_000, timeoutMsg: 'resolve button missing after reply' },
    );
    await browser.$(`${t1Selector} [data-action="resolve"]`).click();

    // After resolveThread succeeds, the sidebar re-mounts with the resolved
    // thread carrying the `resolved` class on its article.
    await browser.waitUntil(
      async () => {
        const cls = await browser.$(t1Selector).getAttribute('class');
        return /\bresolved\b/.test(cls ?? '');
      },
      { timeout: 5_000, timeoutMsg: 't-1 article never gained resolved class' },
    );
  });
});
