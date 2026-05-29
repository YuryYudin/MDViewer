import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture, openDocByE2eHook, switchToWindow } from './helpers/app';

/**
 * D2 — Open in New Window from the tab context menu (scenario S2).
 *
 * Wireframe 02-tab-context-menu.html: right-clicking a tab opens an in-DOM
 * context menu (NOT the OS menu, so it is driveable here) with "Open in New
 * Window" / "Move to Window ▸" / "Close". Activating "Open in New Window"
 * relocates the document under the one-owner invariant: it leaves the source
 * window's tab strip and appears as the sole tab of a freshly-raised window.
 *
 * The fast, authoritative coverage for the menu wiring is the TabBar unit
 * suite (tests/views/TabBar.test.ts) plus the `open_in_new_window` IPC
 * registration smoke. This heavy WDIO run is the orchestrator's phase-end
 * gate; it asserts the user-visible relocate across two WebDriver window
 * handles.
 */

/** Tab labels visible in the currently-active WebDriver window. */
async function tabLabels(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-test="tab"] .tab-label')).map(
      (el) => el.textContent?.trim() ?? '',
    ),
  );
}

/** Labels of every window the app currently knows about (via list_windows). */
async function windowCount(): Promise<number> {
  const v = await browser.executeAsync(function (done: (v: unknown) => void): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tauri = (window as any).__TAURI_INTERNALS__;
    if (!tauri?.invoke) {
      done({ error: 'tauri runtime missing' });
      return;
    }
    tauri.invoke('list_windows').then(
      (rows: unknown[]) => done(rows.length),
      (e: unknown) => done({ error: String(e) }),
    );
  });
  return v as number;
}

describe('D2 — Open in New Window from tab context menu (S2)', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;
  let reportPath: string;
  let notesPath: string;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
    reportPath = path.join(fixture.tmpDir, 'report.md');
    notesPath = path.join(fixture.tmpDir, 'notes.md');
    await fs.writeFile(reportPath, '# Report\n\nSource strip doc.\n');
    await fs.writeFile(notesPath, '# Notes\n\nThis one gets detached.\n');
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

  it('S2: right-click a tab → Open in New Window detaches the doc into a new raised window', async () => {
    await switchToWindow('main');
    await browser.waitUntil(async () => browser.$('[data-view="start"]').isExisting(), {
      timeout: 10_000,
      timeoutMsg: 'main never reached the StartPage',
    });

    // Open two docs in `main`: report.md (stays) and notes.md (gets detached).
    await openDocByE2eHook(reportPath);
    await openDocByE2eHook(notesPath);
    await browser.waitUntil(
      async () => (await tabLabels()).filter((l) => l === 'notes.md').length === 1,
      { timeout: 10_000, timeoutMsg: 'notes.md tab never appeared in main' },
    );
    expect(await tabLabels()).toEqual(expect.arrayContaining(['report.md', 'notes.md']));
    const windowsBefore = await windowCount();

    // Right-click the notes.md tab to open the in-DOM context menu.
    await browser.execute(() => {
      const tab = Array.from(document.querySelectorAll<HTMLElement>('[data-test="tab"]')).find(
        (t) => t.querySelector('.tab-label')?.textContent?.trim() === 'notes.md',
      );
      if (!tab) throw new Error('notes.md tab not found');
      tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await browser.waitUntil(
      async () => browser.$('[data-test="tab-context-menu"]').isExisting(),
      { timeout: 5_000, timeoutMsg: 'tab context menu never opened' },
    );

    // Activate "Open in New Window".
    await browser.$('[data-test="ctx-open-new-window"]').click();

    // The document leaves the source strip: main no longer shows notes.md,
    // and a new window now exists.
    await browser.waitUntil(
      async () => !(await tabLabels()).includes('notes.md'),
      { timeout: 10_000, timeoutMsg: 'notes.md never left the source strip' },
    );
    expect(await tabLabels()).toEqual(['report.md']);

    await browser.waitUntil(async () => (await windowCount()) === windowsBefore + 1, {
      timeout: 10_000,
      timeoutMsg: 'no new window was raised',
    });

    // The new window owns notes.md as its sole tab. Find the non-main handle.
    const handles = await browser.getWindowHandles();
    let foundSole = false;
    for (const h of handles) {
      await browser.switchToWindow(h);
      const label = await browser.execute(function (): string | null {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cur = (window as any).__TAURI__?.webviewWindow?.getCurrentWebviewWindow?.();
        return cur?.label ?? null;
      });
      if (label === 'main') continue;
      const labels = await tabLabels();
      if (labels.length === 1 && labels[0] === 'notes.md') {
        foundSole = true;
        break;
      }
    }
    expect(foundSole).toBe(true);
  });
});
