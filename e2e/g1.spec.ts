import fs from 'node:fs/promises';
import path from 'node:path';
import {
  prepareFixture,
  openDocByE2eHook,
  switchToWindow,
  tabLabelsInActiveWindow,
  findOtherWindowLabel,
} from './helpers/app';

/**
 * G1 — Drag a tab off the strip to detach (scenario S10).
 *
 * Wireframe 05-drag-detach.html: tabs are `draggable`. When the user drags a
 * tab off the strip and releases CLEAR of the strip's bounding rect, the tab
 * detaches into a brand-new window via the single backend `detach_tab` IPC
 * (spawn a fresh `win-{nanos}` window + relocate the tab under the one-owner
 * invariant). A drop INSIDE the strip is a no-op (no detach, no reorder).
 *
 * Both windows refresh via the window-addressed `workspace-changed` event
 * (the handler emits to BOTH the source window the tab left AND the new
 * window), mirroring the move_tab dual-emit fix.
 *
 * The fast, authoritative coverage for the drag detection (draggable,
 * outside-rect detach, inside-rect no-op) is the TabBar unit suite
 * (tests/views/TabBar.test.ts). This heavy WDIO run is the orchestrator's
 * phase-end gate; it asserts the user-visible detach across two WebDriver
 * window handles.
 */

/** Count of distinct native windows surfaced as WebDriver handles. */
async function windowHandleCount(): Promise<number> {
  return (await browser.getWindowHandles()).length;
}

describe('G1 — Drag a tab off the strip to detach (S10)', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;
  let aPath: string;
  let bPath: string;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
    aPath = path.join(fixture.tmpDir, 'a.md');
    bPath = path.join(fixture.tmpDir, 'b.md');
    await fs.writeFile(aPath, '# A\n\nStays in the source window.\n');
    await fs.writeFile(bPath, '# B\n\nGets dragged off into a new window.\n');
    const dataDir = process.env.MDVIEWER_DATA_DIR!;
    await fs.writeFile(
      path.join(dataDir, 'recents.json'),
      JSON.stringify({ entries: [] }, null, 2),
    );
    await fs.rm(path.join(dataDir, 'session.json'), { force: true });
    await browser.reloadSession();
  });
  after(async () => {
    await fixture.cleanup();
  });

  it('S10: drag a tab off a two-tab strip and release clear of it → detaches into a new window', async () => {
    // Source window is `main`; open a two-tab strip (a.md + b.md).
    await switchToWindow('main');
    await browser.waitUntil(async () => browser.$('[data-view="start"]').isExisting(), {
      timeout: 10_000,
      timeoutMsg: 'main never reached the StartPage',
    });
    await openDocByE2eHook(aPath);
    await openDocByE2eHook(bPath);
    await browser.waitUntil(
      async () => {
        const labels = await tabLabelsInActiveWindow();
        return labels.includes('a.md') && labels.includes('b.md');
      },
      { timeout: 10_000, timeoutMsg: 'two-tab strip (a.md + b.md) never formed in main' },
    );
    const beforeWindows = await windowHandleCount();

    // Drag the b.md tab off the strip and release CLEAR of the strip's
    // bounding rect (far below it). The dragend handler reads clientX/clientY
    // and, finding the drop outside the strip rect, calls detach_tab(tab.id).
    await browser.execute(() => {
      const strip = document.querySelector<HTMLElement>('[data-test="tabbar"]')!;
      const tab = Array.from(
        document.querySelectorAll<HTMLElement>('[data-test="tab"]'),
      ).find((t) => t.querySelector('.tab-label')?.textContent?.trim() === 'b.md');
      if (!tab) throw new Error('b.md tab not found in main');
      const r = strip.getBoundingClientRect();
      tab.dispatchEvent(new MouseEvent('dragstart', { bubbles: true }));
      tab.dispatchEvent(
        new MouseEvent('dragend', {
          bubbles: true,
          clientX: r.left + r.width / 2,
          clientY: r.bottom + 300, // well clear, below the strip
        }),
      );
    });

    // b.md leaves the source window's strip.
    await browser.waitUntil(
      async () => !(await tabLabelsInActiveWindow()).includes('b.md'),
      { timeout: 10_000, timeoutMsg: 'b.md never left the source window after detach' },
    );
    expect(await tabLabelsInActiveWindow()).toContain('a.md');
    expect(await tabLabelsInActiveWindow()).not.toContain('b.md');

    // A brand-new native window now exists …
    await browser.waitUntil(async () => (await windowHandleCount()) === beforeWindows + 1, {
      timeout: 10_000,
      timeoutMsg: 'detach did not spawn a new native window',
    });

    // … and it owns the detached b.md tab as its sole document.
    const newLabel = await findOtherWindowLabel('main');
    await switchToWindow(newLabel);
    await browser.waitUntil(
      async () => (await tabLabelsInActiveWindow()).includes('b.md'),
      { timeout: 10_000, timeoutMsg: 'b.md never joined the new detached window' },
    );
    expect(await tabLabelsInActiveWindow()).toEqual(['b.md']);
  });
});
