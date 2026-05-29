import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture, switchToWindow } from './helpers/app';

/**
 * B3 — File → New Window (wireframe 04, scenario S1).
 *
 * Picking File → New Window (or ⇧⌘N) opens a second native window sitting on
 * the StartPage; the first window is left unchanged. The runtime path is the
 * same whether the click arrives from the OS menu or from
 * `emit('menu-action', 'new-window')` inside the WebView:
 *
 *   1. Rust `on_menu_event` → `app.emit("menu-action", "new-window")`
 *      (menu item id `menu-new-window`, accelerator CmdOrCtrl+Shift+N)
 *   2. WebView `installMenuBridge` listener
 *   3. `dispatchMenuAction('new-window')` → `mdviewer:new-window` CustomEvent
 *   4. Workspace handler → `new_window` IPC → second window spawns on StartPage
 *
 * Steps 1–3 land in this task (B3): the menu item + accelerator + id→action
 * map + the menuBridge mapping. Step 4 (the frontend handler that calls the
 * `new_window` IPC, and the Rust command + menu rebuild) lands in C1/C2/D1, so
 * this spec is RED-by-design at the end of phase B — the assertions describe
 * the end-state and go GREEN once the spawn wiring is present. The fast,
 * authoritative coverage for B3 is `tests/menuBridge.test.ts` (the
 * `new-window` → `mdviewer:new-window` mapping) and the `menu.rs` unit tests
 * (`menu-new-window` → `new-window`, `window-select:<label>` → None).
 */
async function emitMenuAction(action: string): Promise<void> {
  await browser.executeAsync(
    function (a: string, done: (v: unknown) => void): void {
      const w = window as unknown as {
        __mdviewerE2E?: { emitMenuAction(action: string): Promise<void> };
      };
      if (!w.__mdviewerE2E?.emitMenuAction) {
        done({ error: 'emitMenuAction hook missing' });
        return;
      }
      w.__mdviewerE2E.emitMenuAction(a).then(
        () => done(null),
        (e: unknown) => done({ error: String(e) }),
      );
    },
    action,
  );
}

describe('B3 — File → New Window (S1)', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
    await fs.rm(path.join(fixture.tmpDir, 'sample.md.comments.json'), { force: true });
    const dataDir = process.env.MDVIEWER_DATA_DIR!;
    await fs.writeFile(
      path.join(dataDir, 'recents.json'),
      JSON.stringify({ entries: [] }, null, 2),
    );
    await fs.rm(path.join(dataDir, 'session.json'), { force: true });
    await browser.reloadSession();
  });
  after(async () => { await fixture.cleanup(); });

  it('S1: File → New Window opens a second window on the StartPage, leaving the first unchanged', async () => {
    // Window A (main) starts on the StartPage.
    await switchToWindow('main');
    await browser.waitUntil(
      async () => browser.$('[data-view="start"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'main never reached the StartPage' },
    );

    const handlesBefore = await browser.getWindowHandles();
    expect(handlesBefore.length).toBe(1);

    // Fire the New Window menu action — the same payload the native File →
    // New Window item (id `menu-new-window`, ⇧⌘N) emits. The bridge maps it
    // to `mdviewer:new-window`, whose Workspace handler spawns a new window.
    await emitMenuAction('new-window');

    // A second native window appears, sitting on the StartPage.
    await browser.waitUntil(
      async () => (await browser.getWindowHandles()).length === 2,
      { timeout: 15_000, timeoutMsg: 'New Window did not spawn a second window' },
    );

    const handlesAfter = await browser.getWindowHandles();
    const fresh = handlesAfter.find((h) => !handlesBefore.includes(h));
    expect(fresh).toBeDefined();
    await browser.switchToWindow(fresh!);
    await browser.waitUntil(
      async () => browser.$('[data-view="start"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'the new window did not mount the StartPage' },
    );

    // The first window is unchanged: still on the StartPage, no document open.
    await switchToWindow('main');
    expect(await browser.$('[data-view="start"]').isExisting()).toBe(true);
    expect(await browser.$('[data-view="document"]').isExisting()).toBe(false);
  });
});
