import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture, openDocByE2eHook, switchToWindow } from './helpers/app';

/**
 * D1 — One-owner focus-existing on open (scenario S6).
 *
 * The one-owner invariant (contracts/02-ipc-window-commands.md): a document is
 * open in at most one window+tab across the whole app. Re-opening an
 * already-open `report.md` must NOT spawn a second copy — instead the window
 * that owns it is focused and its existing tab is activated.
 *
 * The resolution logic lives in A1's `Workspace::open_in_new_window_resolve` /
 * `owning_window_label` (unit-tested there); D1 wires `open_document` and
 * `open_in_new_window` to consult it before creating a tab. This spec drives
 * the user-visible contract: open report.md, then open it again, and assert
 * exactly one tab exists for it and the owning window is focused.
 *
 * The fast, authoritative coverage is the Workspace unit suite plus the
 * `tests/ipc_registration.rs` source-smoke + `tests/codegen.test.ts` checks.
 * The heavy WDIO run is the orchestrator's phase-end gate.
 */

/** Count of open tabs whose path ends in `report.md` across the active window. */
async function reportTabCountInActiveWindow(): Promise<number> {
  return browser.executeAsync(function (done: (v: unknown) => void): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tauri = (window as any).__TAURI_INTERNALS__;
    if (!tauri?.invoke) { done({ error: 'tauri runtime missing' }); return; }
    tauri.invoke('list_open_documents').then(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tabs: Array<{ id: string; path: string }>) =>
        done(tabs.filter((t) => t.path.endsWith('report.md')).length),
      (e: unknown) => done({ error: String(e) }),
    );
  }) as Promise<number>;
}

describe('D1 — One-owner focus-existing on open (S6)', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;
  let reportPath: string;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
    reportPath = path.join(fixture.tmpDir, 'report.md');
    await fs.writeFile(reportPath, '# Report\n\nOne-owner probe.\n');
    const dataDir = process.env.MDVIEWER_DATA_DIR!;
    await fs.writeFile(path.join(dataDir, 'recents.json'), JSON.stringify({ entries: [] }, null, 2));
    await fs.rm(path.join(dataDir, 'session.json'), { force: true });
    await browser.reloadSession();
  });
  after(async () => { await fixture.cleanup(); });

  it('S6: re-opening an already-open report.md focuses its window+tab, no second copy', async () => {
    await switchToWindow('main');
    await browser.waitUntil(
      async () => browser.$('[data-view="start"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'main never reached the StartPage' },
    );

    // First open: report.md lands in main as a single tab.
    await openDocByE2eHook(reportPath);
    await browser.waitUntil(
      async () => (await browser.$('[data-view="document"] h1').getText()) === 'Report',
      { timeout: 10_000, timeoutMsg: 'report never rendered in main' },
    );
    expect(await reportTabCountInActiveWindow()).toBe(1);

    // Second open of the SAME path: one-owner must focus the existing
    // window+tab rather than create a duplicate. Still exactly one tab.
    await openDocByE2eHook(reportPath);
    await browser.waitUntil(
      async () => (await reportTabCountInActiveWindow()) === 1,
      { timeout: 10_000, timeoutMsg: 'second open created a duplicate report.md tab' },
    );
    expect(await reportTabCountInActiveWindow()).toBe(1);

    // OBSERVABLE PROXY for "the owning window is focused":
    // tauri-wd does NOT implement the `isFocused` WebDriver command, and
    // `withGlobalTauri` is OFF so `window.__TAURI__` is undefined — neither
    // OS focus nor the focus query is observable headless. The PRODUCTION
    // focus-existing logic is unit-tested in `Workspace::open_in_new_window_resolve`
    // (workspace.rs). What IS observable here, and is the user-visible heart of
    // the one-owner contract, is that the second open did NOT spawn a second
    // window and the doc's single tab still lives in its owning window:
    //  - no extra WebDriver window handle appeared (still exactly one), and
    //  - report.md is the active/only tab of `main` (count === 1 above), and
    //  - main still renders report.md (it was raised into view, not duplicated).
    expect((await browser.getWindowHandles()).length).toBe(1);
    await switchToWindow('main');
    expect(await reportTabCountInActiveWindow()).toBe(1);
    expect(await browser.$('[data-view="document"] h1').getText()).toBe('Report');
  });
});
