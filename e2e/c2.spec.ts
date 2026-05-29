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
 * `emit_to(focused_window(app).label(), "menu-action", …)`. The frontend
 * resolves its own `getCurrentWindow().label` at boot and only reacts to the
 * events it receives, so Save lands on the document the user is looking at —
 * never a background window.
 *
 * S12: with window B focused, invoking Save from the menu saves window B's
 * active document and leaves window A untouched. We open distinct dirty docs
 * in two windows, focus B, drive Save through the same `menu-action` event a
 * real menu click produces, and assert B's bytes hit disk while A's on-disk
 * bytes stay at their original (un-saved) content.
 *
 * Authored RED-first as part of C2's TDD cycle. The fast, authoritative
 * coverage for the routing logic is `tests/main.test.ts` (boot label
 * resolution, addressed listeners, `mdviewer:new-window` → `invoke('new_window')`)
 * and `tests/views/Workspace.test.ts` (window-scoped refresh). The heavy WDIO
 * run is the orchestrator's phase-end (G2) gate.
 */

/** Drive the `menu-action` Tauri event through the e2e side-channel — the
 *  same event the OS menu emits. After B2's focused-window addressing, this
 *  only reaches the WebView whose window is focused. */
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

    // Window B is the focused window (it was created + switched to last).
    // Save from the menu — B2 addresses `menu-action` to the focused window
    // only, so this reaches window B's WebView, not window A's.
    await emitMenuAction('save-file');

    // B's edited bytes must hit disk.
    await browser.waitUntil(
      async () => (await fs.readFile(beta, 'utf8')).includes('Beta EDITED line.'),
      { timeout: 10_000, timeoutMsg: 'window B Save did not persist beta.md' },
    );

    // A must be untouched: its on-disk bytes are still the original (the
    // Save event never reached window A, so its dirty edit was not flushed).
    const alphaOnDisk = await fs.readFile(alpha, 'utf8');
    expect(alphaOnDisk).toBe(ALPHA_ORIG);
    expect(alphaOnDisk).not.toContain('Alpha EDITED line.');
  });
});
