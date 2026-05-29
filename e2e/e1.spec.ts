import fs from 'node:fs/promises';
import path from 'node:path';
import {
  prepareFixture,
  openDocByE2eHook,
  switchToWindow,
  createWindow,
  tabLabelsInActiveWindow,
  findOtherWindowLabel,
} from './helpers/app';

/**
 * E1 — Move tab to an existing window (scenario S4).
 *
 * Wireframe 03-move-to-window-submenu.html: right-clicking a tab opens the
 * in-DOM context menu (D2); its "Move to Window ▸" submenu lists every OTHER
 * open window (the current window is excluded), each labeled by the window's
 * active document name. Picking a target invokes `move_tab(tab_id, to_window)`,
 * relocating the document under the one-owner invariant: it leaves the source
 * window's tab strip and joins the target window's strip. Both windows refresh
 * via the window-addressed `workspace-changed` event (B2 emits to both).
 *
 * The fast, authoritative coverage for the submenu population + move wiring is
 * the TabBar unit suite (tests/views/TabBar.test.ts). This heavy WDIO run is
 * the orchestrator's phase-end gate; it asserts the user-visible relocate
 * across two WebDriver window handles.
 */

describe('E1 — Move tab to an existing window (S4)', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;
  let reportPath: string;
  let notesPath: string;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
    reportPath = path.join(fixture.tmpDir, 'report.md');
    notesPath = path.join(fixture.tmpDir, 'notes.md');
    await fs.writeFile(reportPath, '# Report\n\nLands in window B.\n');
    await fs.writeFile(notesPath, '# Notes\n\nMoves from A to B.\n');
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

  it('S4: right-click a tab in A → Move to Window → pick B; tab leaves A and joins B, both refresh', async () => {
    // Window A is `main`. Open notes.md there (the doc we will move).
    await switchToWindow('main');
    await browser.waitUntil(async () => browser.$('[data-view="start"]').isExisting(), {
      timeout: 10_000,
      timeoutMsg: 'main never reached the StartPage',
    });
    await openDocByE2eHook(notesPath);
    await browser.waitUntil(
      async () => (await tabLabelsInActiveWindow()).includes('notes.md'),
      { timeout: 10_000, timeoutMsg: 'notes.md never appeared in window A' },
    );

    // Window B is a second native window with report.md as its sole doc.
    await createWindow('win-b');
    await switchToWindow('win-b');
    await browser.waitUntil(async () => browser.$('[data-view="start"]').isExisting(), {
      timeout: 10_000,
      timeoutMsg: 'win-b never reached the StartPage',
    });
    await openDocByE2eHook(reportPath);
    await browser.waitUntil(
      async () => (await tabLabelsInActiveWindow()).includes('report.md'),
      { timeout: 10_000, timeoutMsg: 'report.md never appeared in window B' },
    );

    // Resolve B's window label (the move target) — it is the handle that is
    // not `main`.
    const targetLabel = await findOtherWindowLabel('main');

    // Back in window A, right-click the notes.md tab and open the
    // Move-to-Window submenu. It should list window B (excluding A itself).
    await switchToWindow('main');
    await browser.execute(() => {
      const tab = Array.from(document.querySelectorAll<HTMLElement>('[data-test="tab"]')).find(
        (t) => t.querySelector('.tab-label')?.textContent?.trim() === 'notes.md',
      );
      if (!tab) throw new Error('notes.md tab not found in A');
      tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await browser.waitUntil(
      async () => browser.$('[data-test="tab-context-menu"]').isExisting(),
      { timeout: 5_000, timeoutMsg: 'tab context menu never opened in A' },
    );
    await browser.waitUntil(
      async () =>
        (await browser.$$('[data-test="move-to-window-submenu"] [data-test="move-target"]')
          .length) >= 1,
      { timeout: 5_000, timeoutMsg: 'Move-to-Window submenu never listed a target' },
    );

    // Pick window B (the only other window). Use its data-window-label hook.
    await browser
      .$(`[data-test="move-target"][data-window-label="${targetLabel}"]`)
      .click();

    // The doc leaves A's strip.
    await browser.waitUntil(
      async () => !(await tabLabelsInActiveWindow()).includes('notes.md'),
      { timeout: 10_000, timeoutMsg: 'notes.md never left window A' },
    );
    expect(await tabLabelsInActiveWindow()).not.toContain('notes.md');

    // And appears in B's strip (alongside report.md): B refreshed.
    await switchToWindow(targetLabel);
    await browser.waitUntil(
      async () => (await tabLabelsInActiveWindow()).includes('notes.md'),
      { timeout: 10_000, timeoutMsg: 'notes.md never joined window B' },
    );
    expect(await tabLabelsInActiveWindow()).toEqual(
      expect.arrayContaining(['report.md', 'notes.md']),
    );
  });
});
