import path from 'node:path';
import { prepareFixture } from './helpers/app';

describe('Reply to and resolve an existing thread', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
  });
  after(async () => { await fixture.cleanup(); });

  it('appends a reply to t-1 and marks the thread resolved', async () => {
    await browser.$('[data-action="open-file"]').click();
    const filePath = await browser.uploadFile(path.resolve('e2e/fixtures/sample.md'));
    await browser.$('[data-test="file-input"]').setValue(filePath);

    // Click the t-1 highlight to open its sidebar thread.
    await browser.$('[data-anchor="t-1"]').click();

    // Reply, then resolve.
    await browser.$('[data-test="reply-body"]').setValue('Reply body');
    await browser.$('[data-action="post-reply"]').click();
    await browser.$('[data-action="resolve"]').click();

    const thread = browser.$('[data-view="sidebar-comments"] [data-test="thread"][data-thread-id="t-1"]');
    await expect(thread).toHaveElementClass('resolved');
  });
});
