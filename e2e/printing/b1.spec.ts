import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture, openDocByE2eHook } from '../helpers/app';

/**
 * B1 — Print menu action + Cmd/Ctrl+P (scenarios S1, S9).
 *
 * The runtime path is identical whether the Print click comes from the OS
 * menu, the Cmd/Ctrl+P shortcut, or `emit('menu-action', 'print')` inside
 * the WebView:
 *
 *   1. Rust `on_menu_event` (menu-print) → `app.emit("menu-action", "print")`
 *   2. WebView `installMenuBridge` → `MENU_ACTION_TO_EVENT['print']`
 *   3. `dispatchMenuAction` → `mdviewer:print` CustomEvent on `document`
 *   4. main.ts `mdviewer:print` listener → `window.print()` (doc open) or a
 *      `No document to print` toast (no doc)
 *
 * Like 14-app-menu.spec.ts, we drive steps 2–4 via the bundled
 * `__mdviewerE2E.emitMenuAction('print')` hook — the OS menu item itself is
 * not driveable by tauri-webdriver-automation, but the emit path joins to
 * the exact same bridge the OS click would.
 *
 * `window.print()` opens a native print dialog that WebDriver can neither
 * see nor dismiss, so we stub `window.print` in the WebView with a
 * flag-setter BEFORE emitting and assert the flag — a faithful proxy for
 * "the print engine was invoked" without blocking on an OS dialog.
 *
 * Pre-existing unit coverage:
 *   - tests/menuBridge.test.ts  — print → mdviewer:print dispatch contract
 *   - tests/keymap.test.ts      — Mod+P → 'print' action
 *   - tests/main.test.ts        — the mdviewer:print listener + no-doc guard
 *   - src-tauri/src/menu.rs      — menu-print ↔ "print" id mapping
 * What this spec adds: a real-WebView verification that the bridge is wired
 * end to end and respects the no-document guard.
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

/**
 * Replace `window.print` with a no-op that records that it was called, and
 * clear any prior recording. Returns once the stub is installed.
 */
async function stubWindowPrint(): Promise<void> {
  await browser.execute(function (): void {
    const w = window as unknown as { __printCalled?: boolean };
    w.__printCalled = false;
    window.print = function (): void {
      w.__printCalled = true;
    };
  });
}

/** Whether the stubbed `window.print` has been invoked since the last stub. */
async function printWasCalled(): Promise<boolean> {
  return browser.execute(function (): boolean {
    const w = window as unknown as { __printCalled?: boolean };
    return w.__printCalled === true;
  });
}

describe('B1: Print menu action → window.print() with no-document guard', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
    await fs.rm(path.join(fixture.tmpDir, 'sample.md.comments.json'), { force: true });
    const dataDir = process.env.MDVIEWER_DATA_DIR!;
    // Start with no document so the no-doc (S9) state is the default; S1
    // opens a document explicitly.
    await fs.writeFile(
      path.join(dataDir, 'recents.json'),
      JSON.stringify({ entries: [] }, null, 2),
    );
    await browser.reloadSession();
  });
  after(async () => { await fixture.cleanup(); });

  it('S1: print is triggerable — emitting the print action fires window.print()', async () => {
    // Open a document so the body region carries `with-document`, which the
    // print handler guards on.
    await openDocByE2eHook(path.join(fixture.tmpDir, 'sample.md'));
    await browser.waitUntil(
      async () => browser.$('[data-view="document"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'document never mounted' },
    );

    await stubWindowPrint();
    await emitMenuAction('print');

    await browser.waitUntil(async () => printWasCalled(), {
      timeout: 5_000,
      timeoutMsg: 'window.print() was not called after emitting the print action',
    });
    expect(await printWasCalled()).toBe(true);
  });

  it('S9: no document open — print no-ops and shows the "No document to print" toast', async () => {
    // Close every open tab so no Document view is mounted and the body region
    // drops `with-document` — the no-doc state the print guard checks.
    await browser.execute(() => {
      document
        .querySelectorAll<HTMLElement>('[data-test="tab"] [data-test="tab-close"]')
        .forEach((el) => el.click());
    });
    await browser.waitUntil(
      async () => !(await browser.$('[data-view="document"]').isExisting()),
      { timeout: 10_000, timeoutMsg: 'document view never unmounted after closing tabs' },
    );

    await stubWindowPrint();
    await emitMenuAction('print');

    // The "No document to print" toast surfaces on the shared toast region.
    await browser.waitUntil(
      async () => {
        const text = await browser
          .$('[data-region="toast"]')
          .getText()
          .catch(() => '');
        return /No document to print/i.test(text);
      },
      { timeout: 8_000, timeoutMsg: '"No document to print" toast never appeared' },
    );

    // And window.print() must NOT have fired.
    expect(await printWasCalled()).toBe(false);
  });
});
