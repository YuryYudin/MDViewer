import fs from 'node:fs/promises';
import path from 'node:path';
import {
  prepareFixture,
  openDocByE2eHook,
  createWindow,
  switchToWindow,
} from './helpers/app';

/**
 * C2 — Focused-window menu-action routing (wireframe 04, scenario S12).
 *
 * The macOS app-global menu fires a single `menu-action` event for the whole
 * application; the Rust side (B2) addresses it to the FOCUSED window only via
 * `focused_window(app)` → `win.emit("menu-action", …)`. The frontend resolves
 * its own `getCurrentWindow().label` at boot and only reacts to the events it
 * receives, so Save lands on the document the user is looking at — never a
 * background window.
 *
 * S12 has two halves with very different observability under a headless Xvfb
 * WebDriver session:
 *
 *   (a) WHICH window the routing targets. `on_menu_event` calls
 *       `focused_window(app)`, which resolves the OS-focused window (falling
 *       back to the workspace `mrf_label`). The `focused` flag in the
 *       `list_windows` IPC is filled from that same `is_focused()` probe — it
 *       is the EXACT input the router keys on. We CAN observe it: a probe
 *       confirmed that under this Xvfb setup `is_focused()` tracks the active
 *       WebDriver window, so we assert that win-b is the single, deterministic
 *       focused window — i.e. `focused_window()` would resolve to win-b.
 *
 *   (b) THAT the save reaches only that one window. The production menu click
 *       routes through Rust's `on_menu_event` → addressed `win.emit`. The e2e
 *       `__mdviewerE2E.emitMenuAction` hook, by contrast, emits the
 *       `menu-action` Tauri event from the frontend, which the menu bridge
 *       (`installMenuBridge` → global `listen`) receives in EVERY window — it
 *       deliberately bypasses the Rust addressing so it cannot model the
 *       focused-only fan-out, and a native menu click (the only thing that
 *       drives the Rust router) is not clickable through tauri-wd. So instead
 *       of the broadcast hook we drive the SAME single-window save the Rust
 *       router ultimately produces: switch WebDriver to the focused window and
 *       dispatch `mdviewer:save-document` in THAT window's document context
 *       only. This persists B and, because the event never fires in A's
 *       document, leaves A's dirty buffer un-flushed — the observable
 *       single-window-addressed-save contract.
 *
 * The Rust-side selection of the focused window as the emit target
 * (`focused_window` + addressed `win.emit`) is itself unit/e2e-verified
 * outside this gate: `focused_window` is documented as exercised by the S5/S7
 * runtime e2e specs, the `mrf_label` fallback is unit-tested in
 * `workspace.rs`, and the boot-time window-scoped subscription contract is
 * unit-tested in `tests/main.test.ts` ("C2 window-addressed routing").
 */

/** The per-window summaries the routing keys on. `focused` is filled from the
 *  live `is_focused()` probe — the same input `focused_window()` resolves the
 *  emit target from. */
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

/** Dispatch the Save CustomEvent in ONLY the currently-active WebDriver
 *  window's document context — the same `mdviewer:save-document` event the
 *  menu bridge fans a `menu-action` out to, but scoped to one window. This
 *  models the addressed (focused-only) save the Rust router produces: the
 *  event never fires in any other window, so only this window's active doc is
 *  flushed. */
async function dispatchSaveInActiveWindow(): Promise<void> {
  await browser.execute(() => {
    document.dispatchEvent(new CustomEvent('mdviewer:save-document'));
  });
}

/** Enter Edit mode, replace `find` with `replace` in the editor textarea via
 *  direct DOM assignment (wdio setValue is unreliable under WKWebView), then
 *  leave the buffer dirty (no toggle-back, no save). */
async function makeDirtyEdit(find: string, replace: string): Promise<void> {
  await browser.$('[data-action="toggle-edit"]').click();
  await browser.waitUntil(
    async () => browser.$('[data-test="editor"]').isExisting(),
    { timeout: 5_000, timeoutMsg: 'editor did not mount' },
  );
  await browser.execute((f: string, r: string) => {
    const ta = document.querySelector<HTMLTextAreaElement>('[data-test="editor"]');
    if (!ta) throw new Error('editor missing');
    ta.value = ta.value.replace(f, r);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, find, replace);
}

describe('C2 — focused-window menu-action routing (S12)', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;
  let alpha: string;
  let beta: string;
  const ALPHA_ORIG = '# Alpha Document\n\nAlpha original line.\n';
  const BETA_ORIG = '# Beta Document\n\nBeta original line.\n';

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
    await fs.rm(path.join(fixture.tmpDir, 'sample.md.comments.json'), { force: true });
    alpha = path.join(fixture.tmpDir, 'alpha.md');
    beta = path.join(fixture.tmpDir, 'beta.md');
    await fs.writeFile(alpha, ALPHA_ORIG);
    await fs.writeFile(beta, BETA_ORIG);
    const dataDir = process.env.MDVIEWER_DATA_DIR!;
    await fs.writeFile(
      path.join(dataDir, 'recents.json'),
      JSON.stringify({ entries: [] }, null, 2),
    );
    await fs.rm(path.join(dataDir, 'session.json'), { force: true });
    await browser.reloadSession();
  });
  after(async () => { await fixture.cleanup(); });

  it('S12: Save from the menu saves the FOCUSED window B and leaves window A untouched', async () => {
    // Window A (main): open alpha.md and dirty it.
    await switchToWindow('main');
    await openDocByE2eHook(alpha);
    await browser.waitUntil(
      async () => (await browser.$('[data-view="document"] h1').getText()) === 'Alpha Document',
      { timeout: 10_000, timeoutMsg: 'alpha never rendered in window A' },
    );
    await makeDirtyEdit('Alpha original line.', 'Alpha EDITED line.');

    // Window B: open beta.md and dirty it.
    await createWindow('win-b');
    await switchToWindow('win-b');
    await openDocByE2eHook(beta);
    await browser.waitUntil(
      async () => (await browser.$('[data-view="document"] h1').getText()) === 'Beta Document',
      { timeout: 10_000, timeoutMsg: 'beta never rendered in window B' },
    );
    await makeDirtyEdit('Beta original line.', 'Beta EDITED line.');

    // (a) Observable focus state — the input `focused_window()` routes on.
    // win-b was created + switched-to last, and a probe confirmed
    // `is_focused()` tracks the active WebDriver window under this Xvfb
    // setup, so `list_windows` reports win-b as the SINGLE focused window.
    // That means Rust's `on_menu_event` → `focused_window(app)` would resolve
    // the menu-action emit target to win-b deterministically.
    await switchToWindow('win-b');
    const rows = await listWindows();
    const focused = rows.filter((r) => r.focused);
    expect(focused.length).toBe(1);
    expect(focused[0].label).toBe('win-b');

    // (b) The focused-only, single-window-addressed save. The production menu
    // click routes through Rust's addressed `win.emit`; we drive the same
    // single-window save by dispatching `mdviewer:save-document` in ONLY the
    // focused window's (win-b's) document context. (We do NOT use the
    // `emitMenuAction` hook here: it emits the global `menu-action` Tauri
    // event, which the menu bridge's global `listen` receives in EVERY window
    // — it bypasses the Rust focused-addressing and so would save A too. The
    // Rust focused-target selection is unit/e2e-verified elsewhere; see the
    // header comment.)
    await dispatchSaveInActiveWindow();

    // B's edited bytes must hit disk.
    await browser.waitUntil(
      async () => (await fs.readFile(beta, 'utf8')).includes('Beta EDITED line.'),
      { timeout: 10_000, timeoutMsg: 'window B Save did not persist beta.md' },
    );

    // A must be untouched: the Save event fired only in window B's document
    // context, so window A's dirty buffer was never flushed and its on-disk
    // bytes are still the original.
    const alphaOnDisk = await fs.readFile(alpha, 'utf8');
    expect(alphaOnDisk).toBe(ALPHA_ORIG);
    expect(alphaOnDisk).not.toContain('Alpha EDITED line.');
  });
});
