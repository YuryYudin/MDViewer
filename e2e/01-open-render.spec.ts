import path from 'node:path';
import { prepareFixture } from './helpers/app';

describe('Open a .md and view it rendered', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
  });
  after(async () => { await fixture.cleanup(); });

  it('mounts the start view and renders sample.md after Open', async () => {
    await expect(browser.$('[data-view="start"]')).toBeDisplayed();
    await browser.$('[data-action="open-file"]').click();

    // wdio < 9 supported `setValue` on file inputs to upload a path; in
    // wdio 9 use `browser.uploadFile` followed by `setValue` on the input.
    const filePath = await browser.uploadFile(path.resolve('e2e/fixtures/sample.md'));
    await browser.$('[data-test="file-input"]').setValue(filePath);

    // wireframes/03-document-view.html: rendered MD with no comments shown
    const doc = browser.$('[data-view="document"]');
    await expect(doc.$('h1')).toHaveText('Sample Document');
    await expect(doc.$('table')).toBeDisplayed();
    await expect(browser.$('[data-view="sidebar-comments"] [data-empty="true"]')).toBeDisplayed();
  });
});
