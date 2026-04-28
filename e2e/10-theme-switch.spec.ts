import path from 'node:path';
import { prepareFixture } from './helpers/app';

describe('Theme switch repaints all chrome regions', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
  });
  after(async () => { await fixture.cleanup(); });

  it('applies dark CSS variables across titlebar, tabs, editor, sidebar, status bar', async () => {
    await browser.$('[data-action="open-file"]').click();
    const filePath = await browser.uploadFile(path.resolve('e2e/fixtures/sample.md'));
    await browser.$('[data-test="file-input"]').setValue(filePath);

    await browser.$('[data-action="open-settings"]').click();
    await browser.$('[data-test="theme-select"]').selectByAttribute('value', 'dark');
    await browser.$('[data-action="close-settings"]').click();

    // For each chrome region, read --bg via getComputedStyle and assert it
    // matches the dark token. Different regions use the same custom property
    // name; if any one is unstyled the test fails.
    const regions = [
      '[data-view="titlebar"]',
      '[data-view="tabs"]',
      '[data-view="editor"]',
      '[data-view="sidebar-comments"]',
      '[data-view="status-bar"]',
    ];

    for (const sel of regions) {
      const bg = await browser.execute((s: string) => {
        const el = document.querySelector(s);
        return el ? getComputedStyle(el).getPropertyValue('--bg').trim() : '';
      }, sel);
      await expect(bg).toBe('#111418');
    }
  });
});
