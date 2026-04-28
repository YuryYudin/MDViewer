import path from 'node:path';
import { prepareFixture } from './helpers/app';

describe('Edit the document and reattach anchors', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
  });
  after(async () => { await fixture.cleanup(); });

  it('reattaches t-1 and t-2 after a small edit, with no orphans', async () => {
    await browser.$('[data-action="open-file"]').click();
    const filePath = await browser.uploadFile(path.resolve('e2e/fixtures/sample.md'));
    await browser.$('[data-test="file-input"]').setValue(filePath);

    // Toggle into edit mode (Phase 2 turns this green).
    await browser.$('[data-action="toggle-edit"]').click();
    const editor = browser.$('[data-test="editor"]');
    const doc = await editor.getValue();
    const inserted = doc.replace('Selectable phrase one', ' edited Selectable phrase one');
    await editor.setValue(inserted);

    // Toggle back to view; the reattachment pass runs.
    await browser.$('[data-action="toggle-edit"]').click();

    // Both t-1 and t-2 should still be anchored; orphan count is zero.
    await expect(browser.$('[data-anchor="t-1"]')).toBeDisplayed();
    await expect(browser.$('[data-anchor="t-2"]')).toBeDisplayed();
    await expect(browser.$('[data-view="sidebar-comments"] [data-test="anchored-count"]'))
      .toHaveText('2');
    await expect(browser.$('[data-view="sidebar-comments"] [data-test="orphaned-count"]'))
      .toHaveText('0');
  });
});
