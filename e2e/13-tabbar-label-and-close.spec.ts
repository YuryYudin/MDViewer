import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture, openDocByE2eHook } from './helpers/app';

/**
 * Two regressions surfaced together (Screenshot.png):
 *
 *   1. The tab label rendered the opaque tab id (a `tab-{nanos}` UUID)
 *      instead of the document filename. Root cause: the IPC's
 *      `list_open_documents` returned `Vec<String>` (just ids), and the
 *      Workspace mapped `path: id`. Fix: the IPC returns
 *      `Vec<TabSummary>` (id + path) and TabBar shows `basename(path)`.
 *
 *   2. Clicking × on a tab dispatched `closeTab` to Rust but the strip
 *      never repainted, so the closed tab stayed visible and StartPage
 *      never returned. Fix: TabBar takes an `onAfterChange` callback
 *      that the Workspace wires to its own `refresh()`.
 *
 * This spec drives the production tab strip to assert both fixes
 * end-to-end. It complements the unit-level coverage in TabBar.test.ts
 * and Workspace.test.ts.
 */
describe('TabBar — label shows filename, × actually closes', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
    // Strip the seeded sidecar so the open path matches the empty-comments
    // branch (independent of any other spec's state).
    await fs.rm(path.join(fixture.tmpDir, 'sample.md.comments.json'), { force: true });
    const dataDir = process.env.MDVIEWER_DATA_DIR!;
    await fs.writeFile(
      path.join(dataDir, 'recents.json'),
      JSON.stringify({ entries: [] }, null, 2),
    );
    await browser.reloadSession();
  });
  after(async () => { await fixture.cleanup(); });

  it('renders sample.md as the tab label, not the tab id', async () => {
    const target = path.join(fixture.tmpDir, 'sample.md');
    await openDocByE2eHook(target);
    await browser.waitUntil(
      async () => browser.$('[data-view="document"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'document never mounted' },
    );

    const labelInfo = await browser.execute(() => {
      const tab = document.querySelector<HTMLElement>('[data-test="tab"]');
      if (!tab) return null;
      return {
        labelText: tab.querySelector<HTMLElement>('.tab-label')?.textContent ?? '',
        tabIdAttr: tab.getAttribute('data-tab-id') ?? '',
        title: tab.title,
      };
    });
    expect(labelInfo).not.toBeNull();
    expect(labelInfo!.labelText).toBe('sample.md');
    // The tab id is an opaque `tab-{nanos}` from the Rust workspace and
    // must NOT leak into the user-facing label. This is the exact shape
    // of the regression the screenshot caught.
    expect(labelInfo!.labelText).not.toContain(labelInfo!.tabIdAttr);
    expect(labelInfo!.tabIdAttr.length).toBeGreaterThan(0);
    // Full path stays accessible via the title tooltip so the user can
    // still recover where the file lives.
    expect(labelInfo!.title).toContain('sample.md');
  });

  it('clicking × closes the tab and falls back to StartPage', async () => {
    // The previous test left one tab + Document mounted. Click ×.
    const closeButton = browser.$('[data-test="tab"] [data-test="tab-close"]');
    expect(await closeButton.isExisting()).toBe(true);
    await closeButton.click();

    // The StartPage must be back; the document and the tab strip's
    // tab row must both be gone. Use waitUntil because the click →
    // closeTab → refresh chain is async.
    await browser.waitUntil(
      async () => browser.$('[data-view="start"]').isExisting(),
      { timeout: 5_000, timeoutMsg: 'StartPage did not return after × click' },
    );
    expect(await browser.$('[data-view="document"]').isExisting()).toBe(false);
    const remainingTabs = await browser.execute(
      () => document.querySelectorAll('[data-test="tab"]').length,
    );
    expect(remainingTabs).toBe(0);
  });
});
