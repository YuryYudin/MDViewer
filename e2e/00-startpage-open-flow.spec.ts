import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture } from './helpers/app';

/**
 * Cover the production "click to open" plumbing that
 * `openDocByE2eHook` (used by the other specs) bypasses. StartPage has
 * three paths into `ipc.openDocument`:
 *   - the OS dialog (Open… button outside e2e mode)
 *   - the hidden <input type=file> change handler (e2e mode)
 *   - the recents list click
 *
 * All three discarded the OpenOutcome until the onOpened callback was
 * wired through Workspace → StartPage. Recents is the simplest of the
 * three to exercise: pre-populate recents.json before the session
 * starts, click the entry, assert the document mounts. If any of the
 * three paths regresses the same way again, this catches it.
 */
describe('StartPage → click a recent → document mounts', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
    // Strip the pre-seeded sidecar so the doc starts empty (matches
    // wireframe-03's empty-comments path).
    await fs.rm(path.join(fixture.tmpDir, 'sample.md.comments.json'), { force: true });

    // Pre-populate recents.json in MDVIEWER_DATA_DIR with the fixture path
    // so StartPage renders a recent-item the test can click.
    const dataDir = process.env.MDVIEWER_DATA_DIR;
    if (!dataDir) throw new Error('MDVIEWER_DATA_DIR env not set; check wdio.conf.ts');
    const target = path.join(fixture.tmpDir, 'sample.md');
    await fs.writeFile(
      path.join(dataDir, 'recents.json'),
      JSON.stringify({ entries: [target] }, null, 2),
    );
    // Force a fresh session so the running app re-reads recents.json.
    await browser.reloadSession();
  });
  after(async () => { await fixture.cleanup(); });

  it('clicking a recent path opens the document and renders it', async () => {
    expect(await browser.$('[data-view="start"]').isExisting()).toBe(true);

    // Recent items are <li>s with [data-test='recent-item'] containing
    // the textContent path. Click the first one (we pre-seeded exactly
    // one).
    const recent = browser.$('[data-test="recent-item"]');
    expect(await recent.isExisting()).toBe(true);
    await recent.click();

    // After the click, Workspace's onOpened callback runs setActive +
    // refresh, which mounts the document view.
    await browser.waitUntil(
      async () => browser.$('[data-view="document"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'document view did not mount after recent click' },
    );

    const doc = browser.$('[data-view="document"]');
    expect(await doc.$('h1').getText()).toBe('Sample Document');
  });
});
