import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture, openDocByE2eHook } from './helpers/app';

/**
 * Native menu wiring smoke test.
 *
 * The OS menu items themselves can't be driven by tauri-webdriver-
 * automation, but the runtime path is identical whether the click comes
 * from the OS or from `emit('menu-action', ...)` inside the WebView:
 *
 *   1. Rust `on_menu_event` → `app.emit("menu-action", action)`
 *   2. WebView `installMenuBridge` listener
 *   3. `dispatchMenuAction` → CustomEvent on `document`
 *   4. View handlers (Settings overlay, file dialog, close-tab, …)
 *
 * Steps 1–4 are joined by the Tauri event bus and the WebView's listener.
 * Firing `emit('menu-action', 'open-settings')` from within the WebView
 * exercises steps 2–4, which is exactly the surface the user reported as
 * broken ("no way to call settings after we went past the start page").
 *
 * Pre-existing unit coverage:
 *   - `tests/menuBridge.test.ts` for the JS dispatch contract
 *   - `src-tauri/src/menu.rs` `tests` for the id ↔ action mapping
 *
 * What this spec adds: a real-WebView verification that the bridge is
 * actually installed and routes events to the right handlers.
 */
async function emitMenuAction(action: string): Promise<void> {
  // `__mdviewerE2E.emitMenuAction` is bundled into the WebView at build
  // time, so the @tauri-apps/api/event import resolves correctly. An
  // inline `import()` from this WebDriver execute body would NOT resolve
  // because the script isn't part of the bundled module graph.
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

describe('Native menu → WebView CustomEvent bridge', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
    await fs.rm(path.join(fixture.tmpDir, 'sample.md.comments.json'), { force: true });
    const dataDir = process.env.MDVIEWER_DATA_DIR!;
    await fs.writeFile(
      path.join(dataDir, 'recents.json'),
      JSON.stringify({ entries: [] }, null, 2),
    );
    await browser.reloadSession();
  });
  after(async () => { await fixture.cleanup(); });

  it('Settings menu action mounts the Settings overlay even after a doc is open', async () => {
    // Reproduce the user's exact scenario: open a doc, lose StartPage.
    await openDocByE2eHook(path.join(fixture.tmpDir, 'sample.md'));
    await browser.waitUntil(
      async () => browser.$('[data-view="document"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'document never mounted' },
    );
    expect(await browser.$('[data-view="start"]').isExisting()).toBe(false);
    expect(await browser.$('[data-region="settings-overlay"]').isExisting()).toBe(false);

    await emitMenuAction('open-settings');

    await browser.waitUntil(
      async () => browser.$('[data-region="settings-overlay"]').isExisting(),
      { timeout: 5_000, timeoutMsg: 'Settings overlay did not mount from menu action' },
    );
    expect(await browser.$('[data-view="settings"]').isExisting()).toBe(true);

    // Close it again so the next test starts clean.
    await browser.$('[data-action="close-settings"]').click();
    await browser.waitUntil(
      async () => !(await browser.$('[data-region="settings-overlay"]').isExisting()),
      { timeout: 5_000 },
    );
  });

  it('Open File menu action triggers the same flow as TabBar +', async () => {
    // Pre-arm the e2e nextPick side-channel (same as spec 12) and fire
    // the menu-action event. The bridge → mdviewer:open-file →
    // runOpenFileFlow chain must reach the picked path.
    const second = path.join(fixture.tmpDir, 'second.md');
    await fs.writeFile(second, '# Second Document\n\nFrom menu.\n');
    await browser.execute((p: string) => {
      const w = window as unknown as { __mdviewerE2E?: { nextPick?: string } };
      if (!w.__mdviewerE2E) throw new Error('e2e hook missing');
      w.__mdviewerE2E.nextPick = p;
    }, second);

    await emitMenuAction('open-file');

    await browser.waitUntil(
      async () => {
        const heading = await browser.$('[data-view="document"] h1').getText();
        return heading === 'Second Document';
      },
      { timeout: 10_000, timeoutMsg: 'Open menu action did not open the picked file' },
    );
  });
});
