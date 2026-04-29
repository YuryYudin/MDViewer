import path from 'node:path';
import { prepareFixture, openDocByE2eHook } from './helpers/app';

describe('Theme switch repaints all chrome regions', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
  });
  after(async () => { await fixture.cleanup(); });

  it('applies the dark --bg token across every chrome region', async () => {
    await openDocByE2eHook(path.join(fixture.tmpDir, 'sample.md'));
    await browser.waitUntil(
      async () => browser.$('[data-view="document"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'document view did not mount' },
    );

    // Capture the light --bg first as a baseline.
    const lightBg = await browser.execute(
      () => getComputedStyle(document.body).getPropertyValue('--bg').trim(),
    );

    // Open settings, switch to dark, close.
    await browser.execute(() =>
      document.dispatchEvent(new CustomEvent('mdviewer:open-settings')),
    );
    await browser.waitUntil(
      async () => browser.$('[data-view="settings"]').isExisting(),
      { timeout: 5_000 },
    );
    await browser.execute(() => {
      const sel = document.querySelector<HTMLSelectElement>('[data-test="theme-select"]');
      if (!sel) throw new Error('theme-select missing');
      sel.value = 'dark';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await browser.$('[data-action="close-settings"]').click();
    await browser.waitUntil(
      async () =>
        ((await browser.$('body').getAttribute('class')) ?? '').includes('theme-dark'),
      { timeout: 5_000, timeoutMsg: 'theme-dark class never applied' },
    );

    // Read --bg on every chrome region the wireframe styles. The custom
    // property is set on body via `.theme-dark` and inherited downward; a
    // region that's escaped the cascade (e.g. has its own --bg override)
    // would surface as a different value here.
    // The OS provides the title bar; the in-app titlebar region was
    // removed, so it's no longer in this list.
    const regions = [
      '[data-view="tabs"]',
      '[data-view="document"]',
      '[data-view="sidebar-comments"]',
      '[data-view="status-bar"]',
    ];

    const darkBg = await browser.execute(
      () => getComputedStyle(document.body).getPropertyValue('--bg').trim(),
    );
    expect(darkBg).not.toBe(lightBg);

    for (const sel of regions) {
      const bg = await browser.execute((s: string) => {
        const el = document.querySelector(s);
        return el ? getComputedStyle(el).getPropertyValue('--bg').trim() : '';
      }, sel);
      expect(bg).toBe(darkBg);
    }
  });
});
