import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture, openDocByE2eHook } from './helpers/app';

/**
 * Regression: clicking another tab when multiple documents are open did
 * nothing on screen — the active id swapped on the Rust side but the
 * Workspace's cached payload (html, threads) wasn't refreshed, so the
 * re-mount used the previously-active doc's data and the click looked
 * like a no-op. Fix: TabBar's click flow now goes through openDocument
 * (which both activates the existing tab and returns its OpenResult so
 * the cache can be refreshed), mirroring the recents-click path.
 *
 * This spec opens two docs back-to-back (so the second is active),
 * clicks the first tab, and asserts the rendered heading swaps. Click
 * the second tab back and assert it swaps again — this rules out a
 * one-shot fix that only works for the initial click direction.
 */
describe('Tab strip — clicking another tab swaps the rendered document', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
    await fs.rm(path.join(fixture.tmpDir, 'sample.md.comments.json'), { force: true });
    await fs.writeFile(
      path.join(fixture.tmpDir, 'second.md'),
      '# Second Document\n\nSecond document body.\n',
    );
    const dataDir = process.env.MDVIEWER_DATA_DIR!;
    await fs.writeFile(
      path.join(dataDir, 'recents.json'),
      JSON.stringify({ entries: [] }, null, 2),
    );
    await browser.reloadSession();
  });
  after(async () => { await fixture.cleanup(); });

  it('clicking the inactive tab swaps the rendered HTML', async () => {
    const first = path.join(fixture.tmpDir, 'sample.md');
    const second = path.join(fixture.tmpDir, 'second.md');

    // Open both docs sequentially. The second open leaves it active.
    await openDocByE2eHook(first);
    await browser.waitUntil(
      async () => browser.$('[data-view="document"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'first document never mounted' },
    );
    await openDocByE2eHook(second);
    await browser.waitUntil(
      async () => {
        const heading = await browser.$('[data-view="document"] h1').getText();
        return heading === 'Second Document';
      },
      { timeout: 10_000, timeoutMsg: 'second document never rendered' },
    );

    // Two tabs visible.
    const tabsCount = await browser.execute(
      () => document.querySelectorAll('[data-test="tab"]').length,
    );
    expect(tabsCount).toBe(2);

    // Click the first tab. Find it by title (path).
    await browser.execute((targetPath: string) => {
      const tab = Array.from(document.querySelectorAll<HTMLElement>('[data-test="tab"]'))
        .find((t) => (t.title ?? '').includes(targetPath));
      if (!tab) throw new Error('first tab not found');
      tab.click();
    }, first);

    // Heading must change to the first doc's title — proves the cached
    // payload was refreshed AND the re-mount used the new data.
    await browser.waitUntil(
      async () => {
        const heading = await browser.$('[data-view="document"] h1').getText();
        return heading === 'Sample Document';
      },
      { timeout: 10_000, timeoutMsg: 'first tab click did not swap rendered HTML' },
    );

    // Sanity: clicking back to the second tab swaps again. Rules out a
    // one-shot fix that only works for the initial direction.
    await browser.execute((targetPath: string) => {
      const tab = Array.from(document.querySelectorAll<HTMLElement>('[data-test="tab"]'))
        .find((t) => (t.title ?? '').includes(targetPath));
      if (!tab) throw new Error('second tab not found');
      tab.click();
    }, second);
    await browser.waitUntil(
      async () => {
        const heading = await browser.$('[data-view="document"] h1').getText();
        return heading === 'Second Document';
      },
      { timeout: 10_000, timeoutMsg: 'second tab click did not swap back' },
    );
  });
});
