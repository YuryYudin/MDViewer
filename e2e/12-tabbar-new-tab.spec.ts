import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture, openDocByE2eHook } from './helpers/app';

/**
 * Wireframe-03: the tab strip's "+" button must open the file dialog so
 * the user can add a second document to the workspace. Until this spec
 * existed, "+" dispatched `mdviewer:open-file` into the void — clicking
 * it produced no visible reaction (Screenshot regression).
 *
 * The OS file dialog can't be driven by tauri-webdriver-automation, so
 * the WebDriver branch of main.ts's open-file flow consumes a
 * `window.__mdviewerE2E.nextPick = absPath` hint set by the spec just
 * before the click. That side-channel is the e2e equivalent of the user
 * picking a file in the dialog.
 */
describe('TabBar "+" button → opens a second document', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
    // Drop the seeded sidecar so the open path matches the empty-
    // comments branch (independent of spec 03's state).
    await fs.rm(path.join(fixture.tmpDir, 'sample.md.comments.json'), { force: true });

    // Seed display_name so the session boots straight into Workspace.
    const dataDir = process.env.MDVIEWER_DATA_DIR!;
    await fs.writeFile(
      path.join(dataDir, 'recents.json'),
      JSON.stringify({ entries: [] }, null, 2),
    );
    // Drop a second .md file the test will open via "+".
    await fs.writeFile(
      path.join(fixture.tmpDir, 'second.md'),
      '# Second Document\n\nAnother file.\n',
    );
    await browser.reloadSession();
  });
  after(async () => { await fixture.cleanup(); });

  it('clicking + after a doc is open mounts a new tab for the picked file', async () => {
    // First, open the initial document via the existing e2e hook so we
    // have a Document view + tab strip on screen.
    const first = path.join(fixture.tmpDir, 'sample.md');
    await openDocByE2eHook(first);
    await browser.waitUntil(
      async () => browser.$('[data-view="document"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'first document never mounted' },
    );

    // Sanity: exactly one tab + the "+" button are present in the strip.
    const tabsBefore = await browser.execute(
      () => document.querySelectorAll('[data-test="tab"]').length,
    );
    expect(tabsBefore).toBe(1);
    expect(await browser.$('[data-test="new-tab"]').isExisting()).toBe(true);

    // Pre-arm the e2e side-channel and click "+". main.ts's
    // `mdviewer:open-file` listener consumes `nextPick` exactly once.
    const second = path.join(fixture.tmpDir, 'second.md');
    await browser.execute((p: string) => {
      const w = window as unknown as { __mdviewerE2E?: { nextPick?: string } };
      if (!w.__mdviewerE2E) throw new Error('e2e hook missing');
      w.__mdviewerE2E.nextPick = p;
    }, second);
    await browser.$('[data-test="new-tab"]').click();

    // The Workspace cache + refresh path mounts the second doc; its
    // `# Second Document` heading proves the picked path made it all
    // the way through openDocument → setActive → refresh.
    await browser.waitUntil(
      async () => {
        const heading = await browser.$('[data-view="document"] h1').getText();
        return heading === 'Second Document';
      },
      { timeout: 10_000, timeoutMsg: 'second document never rendered after + click' },
    );

    // Tab strip now lists both files. Two tabs + the "+" button.
    const tabsAfter = await browser.execute(
      () => document.querySelectorAll('[data-test="tab"]').length,
    );
    expect(tabsAfter).toBe(2);

    // The side-channel hint must be one-shot — leaving it set would let
    // an unrelated subsequent click silently re-open the same file.
    const leftover = await browser.execute(() => {
      const w = window as unknown as { __mdviewerE2E?: { nextPick?: string } };
      return w.__mdviewerE2E?.nextPick ?? null;
    });
    expect(leftover).toBeNull();
  });
});
