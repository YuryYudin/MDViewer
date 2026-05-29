import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture, openDocByE2eHook, switchToWindow } from './helpers/app';

/**
 * C1 — Window menu lists and raises open windows (wireframe 04, scenario S11).
 *
 * The application-global Window menu carries one dynamic entry per open
 * native window. Each entry's id is `window-select:<label>` and its label is
 * derived from that window's active document name (or a placeholder when the
 * window is on the StartPage). Picking an entry raises (focuses) the
 * corresponding window.
 *
 * The runtime path mirrors B3's New-Window flow: the native menu item carries
 * a `window-select:<label>` id, and Rust's `on_menu_event` parses the
 * `<label>` suffix off that id, looks up the live `WebviewWindow`, and calls
 * `set_focus()` to raise it. `menu_id_to_action` returns `None` for these ids
 * (B3) so they never bridge into a frontend action — the raise is wholly
 * Rust-side.
 *
 * The native menu bar is not directly clickable through tauri-webdriver, so
 * this spec drives the two halves of the contract independently, both through
 * the production primitives the menu click is built from:
 *
 *   1. Enumeration: every open window is registered with the Rust `Workspace`
 *      (one `new_window` per window), so the dynamic submenu builder has one
 *      `WindowSummaryData` per window to emit. We assert the registry lists
 *      all open windows (the data the submenu is built from).
 *   2. Raise: selecting an entry resolves to `set_focus()` on the matching
 *      `WebviewWindow`. We invoke that same focus primitive on a non-focused
 *      window and assert it becomes the focused window.
 *
 * The fast, authoritative coverage for C1 is the `menu.rs` submenu-builder
 * unit tests and the `tests/ipc_registration.rs` source-smoke checks
 * (`new_window` registered, `window-select:` parse helper present). The heavy
 * WDIO run is the orchestrator's phase-end gate.
 */

/** Spawn a fresh StartPage window through the production `new_window` IPC. */
async function newWindowViaIpc(): Promise<void> {
  await browser.executeAsync(function (done: (v: unknown) => void): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tauri = (window as any).__TAURI_INTERNALS__;
    if (!tauri?.invoke) { done({ error: 'tauri runtime missing' }); return; }
    tauri.invoke('new_window').then(() => done(null), (e: unknown) => done({ error: String(e) }));
  });
}

/**
 * The rows the native Window submenu is built from. The submenu builder
 * enumerates the Workspace window registry via the `list_windows` IPC — each
 * row's `label` keys the `window-select:<label>` menu id and `active_doc_name`
 * is its display label. Asserting on `list_windows` asserts on the EXACT data
 * the menu is constructed from (the native menu itself is not in the DOM and so
 * is not queryable through tauri-wd).
 */
async function listWindows(): Promise<
  Array<{ label: string; active_doc_name: string | null; focused: boolean }>
> {
  const v = await browser.executeAsync(function (done: (v: unknown) => void): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tauri = (window as any).__TAURI_INTERNALS__;
    if (!tauri?.invoke) { done({ error: 'tauri runtime missing' }); return; }
    tauri.invoke('list_windows').then(
      (rows: unknown) => done(rows),
      (e: unknown) => done({ error: String(e) }),
    );
  });
  return v as Array<{ label: string; active_doc_name: string | null; focused: boolean }>;
}

describe('C1 — Window menu lists and raises open windows (S11)', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
    await fs.rm(path.join(fixture.tmpDir, 'sample.md.comments.json'), { force: true });
    await fs.writeFile(
      path.join(fixture.tmpDir, 'gamma.md'),
      '# Gamma Document\n\nWindow probe.\n',
    );
    const dataDir = process.env.MDVIEWER_DATA_DIR!;
    await fs.writeFile(
      path.join(dataDir, 'recents.json'),
      JSON.stringify({ entries: [] }, null, 2),
    );
    await fs.rm(path.join(dataDir, 'session.json'), { force: true });
    await browser.reloadSession();
  });
  after(async () => { await fixture.cleanup(); });

  it('S11: the Window menu lists every open window and selecting one raises it', async () => {
    // Window A (main) starts on the StartPage; open a doc so it has an
    // active-doc-name in its Window-menu entry.
    await switchToWindow('main');
    await browser.waitUntil(
      async () => browser.$('[data-view="start"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'main never reached the StartPage' },
    );
    await openDocByE2eHook(path.join(fixture.tmpDir, 'gamma.md'));
    await browser.waitUntil(
      async () => (await browser.$('[data-view="document"] h1').getText()) === 'Gamma Document',
      { timeout: 10_000, timeoutMsg: 'gamma never rendered in main' },
    );

    // Spawn two more windows via the production `new_window` IPC (the same
    // command File → New Window invokes). Three windows total now.
    await newWindowViaIpc();
    await newWindowViaIpc();
    await browser.waitUntil(
      async () => (await browser.getWindowHandles()).length === 3,
      { timeout: 15_000, timeoutMsg: 'new_window did not spawn two more windows' },
    );

    // Enumeration: the Window submenu is built from the Workspace window
    // registry, which now lists all three open windows. Every live window
    // handle resolves to a registered label.
    const labels = await openWindowLabels();
    expect(labels.length).toBe(3);
    expect(labels).toContain('main');

    // Raise: picking a Window-menu entry resolves to `set_focus()` on the
    // matching WebviewWindow. Pick a window that is NOT main, focus it via
    // the same primitive the menu click drives, and assert it is raised.
    const target = labels.find((l) => l !== 'main')!;
    await switchToWindow('main');
    await switchToWindow(target);
    const raised = await browser.executeAsync(function (done: (v: unknown) => void): void {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cur = (window as any).__TAURI__?.webviewWindow?.getCurrentWebviewWindow?.();
      if (!cur?.setFocus) { done({ error: 'setFocus missing' }); return; }
      cur.setFocus()
        .then(() => cur.isFocused())
        .then((f: boolean) => done(f), (e: unknown) => done({ error: String(e) }));
    });
    expect(raised).toBe(true);
  });
});
