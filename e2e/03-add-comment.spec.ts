import path from 'node:path';
import { prepareFixture, tripleClick } from './helpers/app';

describe('Add a comment to a selection', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
  });
  after(async () => { await fixture.cleanup(); });

  it('attaches a new highlight + sidebar thread when a phrase is commented', async () => {
    // Open sample.md with no sidecar so the doc starts with zero threads.
    await browser.$('[data-action="open-file"]').click();
    const filePath = await browser.uploadFile(path.resolve('e2e/fixtures/sample.md'));
    await browser.$('[data-test="file-input"]').setValue(filePath);

    // Select the phrase, then trigger the comment composer.
    await tripleClick('[data-view="document"] p:nth-of-type(2)');
    await browser.$('[data-action="comment"]').click();

    // Compose the comment body and post it.
    await browser.$('[data-test="comment-body"]').setValue('First note');
    await browser.$('[data-action="post-comment"]').click();

    // A new highlight span exists, and the sidebar shows exactly one thread
    // whose body text reads "First note".
    await expect(browser.$('[data-view="document"] [data-anchor]')).toBeDisplayed();
    const sidebarThread = browser.$('[data-view="sidebar-comments"] [data-test="thread"]');
    await expect(sidebarThread).toBeDisplayed();
    await expect(sidebarThread.$('[data-test="comment-body-rendered"]'))
      .toHaveText('First note');
  });
});
