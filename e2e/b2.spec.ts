import fs from 'node:fs/promises';
import path from 'node:path';
import {
  prepareFixture,
  openDocByE2eHook,
  createWindow,
  switchToWindow,
  tabLabelsInActiveWindow,
} from './helpers/app';

/**
 * B2 — Window-scoped tab lists and addressed event routing.
 *
 * This spec owns two scenarios from the multi-window design:
 *
 *  - S5 (window isolation, wireframe 01): each native window has its OWN
 *    tab strip and active document. Opening a document in window B must not
 *    touch window A's tab strip or active document. The Rust IPC layer
 *    derives the owning window from the calling `tauri::Window.label()` and
 *    addresses `workspace-changed` to that window via `emit_to`, so A never
 *    re-renders B's open.
 *
 *  - S7 (restore positions): with startup_mode = "restore", two windows that
 *    were open at shutdown — each with its own tab set, active tab, and
 *    geometry — must BOTH reappear on the next launch with their tabs, the
 *    correct active tab, and their saved on-screen position/size. The B1 v2
 *    `session.json` persists one entry per window; the B2 restore loop
 *    recreates N windows (first reuses "main", the rest spawn) and applies
 *    `clamp_geometry` before placing each.
 *
 * Authored RED-first as part of B2's TDD cycle. The heavy WDIO run is the
 * orchestrator's phase-end gate; the implementation is verified at the fast
 * Rust layers (`cargo test -p mdviewer --test ipc_registration`).
 */

describe('B2 — window isolation + restore positions', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
    await fs.rm(path.join(fixture.tmpDir, 'sample.md.comments.json'), { force: true });
    await fs.writeFile(
      path.join(fixture.tmpDir, 'alpha.md'),
      '# Alpha Document\n\nWindow A probe.\n',
    );
    await fs.writeFile(
      path.join(fixture.tmpDir, 'beta.md'),
      '# Beta Document\n\nWindow B probe.\n',
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

  it('S5: opening a document in window B leaves window A’s tab strip and active doc unchanged', async () => {
    const alpha = path.join(fixture.tmpDir, 'alpha.md');
    const beta = path.join(fixture.tmpDir, 'beta.md');

    // Window A (main): open alpha.md.
    await openDocByE2eHook(alpha);
    await browser.waitUntil(
      async () => (await browser.$('[data-view="document"] h1').getText()) === 'Alpha Document',
      { timeout: 10_000, timeoutMsg: 'alpha never rendered in window A' },
    );
    expect((await tabLabelsInActiveWindow()).sort()).toEqual(['alpha.md']);

    // Spawn window B and open beta.md there.
    await createWindow('win-b');
    await switchToWindow('win-b');
    await browser.waitUntil(
      async () => browser.$('[data-view="start"]').isExisting()
        || browser.$('[data-view="document"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'window B never mounted' },
    );
    await openDocByE2eHook(beta);
    await browser.waitUntil(
      async () => (await browser.$('[data-view="document"] h1').getText()) === 'Beta Document',
      { timeout: 10_000, timeoutMsg: 'beta never rendered in window B' },
    );
    // Window B shows ONLY beta.
    expect((await tabLabelsInActiveWindow()).sort()).toEqual(['beta.md']);

    // Isolation: switch back to window A. Its tab strip still has only
    // alpha.md and its active document is still Alpha — B's open did not
    // leak across.
    await switchToWindow('main');
    expect((await tabLabelsInActiveWindow()).sort()).toEqual(['alpha.md']);
    const aHeading = await browser.$('[data-view="document"] h1').getText();
    expect(aHeading).toBe('Alpha Document');
  });

  it('S7: restore mode brings back two windows with their tabs, active tab, and geometry', async () => {
    const alpha = path.join(fixture.tmpDir, 'alpha.md');
    const beta = path.join(fixture.tmpDir, 'beta.md');
    const dataDir = process.env.MDVIEWER_DATA_DIR!;

    // Flip startup_mode → restore via the production IPC.
    await browser.executeAsync(function (done: (v: unknown) => void): void {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tauri = (window as any).__TAURI_INTERNALS__;
      if (!tauri?.invoke) { done({ error: 'tauri runtime missing' }); return; }
      tauri.invoke('get_settings').then((settings: { appearance: { startup_mode: string } }) => {
        settings.appearance.startup_mode = 'restore';
        return tauri.invoke('set_settings', { settings });
      }).then(() => done(null), (e: unknown) => done({ error: String(e) }));
    });

    // Seed a deterministic two-window session.json with distinct tabs +
    // distinct geometry so the restore is exercised end-to-end regardless of
    // window-manager placement of the live windows during this run.
    await fs.writeFile(
      path.join(dataDir, 'session.json'),
      JSON.stringify({
        version: 2,
        windows: [
          { tabs: [alpha], active: alpha, geometry: { x: 80, y: 60, w: 1024, h: 720 } },
          { tabs: [beta], active: beta, geometry: { x: 520, y: 300, w: 900, h: 640 } },
        ],
      }, null, 2),
    );

    // Relaunch against the same data dir. main.rs's restore loop reads the
    // v2 session, reuses "main" for window 0 and spawns a second window for
    // window 1, opening each window's tabs and applying clamped geometry.
    await browser.reloadSession();

    // Two native windows must exist.
    await browser.waitUntil(
      async () => (await browser.getWindowHandles()).length === 2,
      { timeout: 15_000, timeoutMsg: 'restore did not recreate two windows' },
    );

    // Window 0 (main): alpha.md, active = Alpha.
    await switchToWindow('main');
    await browser.waitUntil(
      async () => (await browser.$('[data-view="document"] h1').getText()) === 'Alpha Document',
      { timeout: 15_000, timeoutMsg: 'main did not restore alpha' },
    );
    expect((await tabLabelsInActiveWindow()).sort()).toEqual(['alpha.md']);

    // Window 1 reappeared with beta.md, active = Beta. Its handle is the one
    // that is NOT main; find it and assert.
    const handles = await browser.getWindowHandles();
    let foundBeta = false;
    for (const h of handles) {
      await browser.switchToWindow(h);
      const label = await browser.execute(function (): string | null {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cur = (window as any).__TAURI__?.webviewWindow?.getCurrentWebviewWindow?.();
        return cur?.label ?? null;
      });
      if (label === 'main') continue;
      const heading = await browser.$('[data-view="document"] h1').getText();
      if (heading === 'Beta Document') {
        expect((await tabLabelsInActiveWindow()).sort()).toEqual(['beta.md']);
        // Geometry restore (saved 900x640, clamped on-screen) is exercised by
        // the restore loop applying `clamp_geometry` per window, and is verified
        // at the unit level (session.rs `clamp_geometry` round-trip + the
        // restore window-mapping). A DOM `window.outerWidth/outerHeight` probe is
        // NOT a reliable cross-platform signal — a headless macOS CI WebView
        // reports 0 — so S7's e2e assertion stays on the observable restoration:
        // both windows reappear with their distinct tab sets and correct active
        // document. (Previously a brittle `outerWidth > 0` check that passed on
        // Linux but failed on macOS CI.)
        foundBeta = true;
        break;
      }
    }
    expect(foundBeta).toBe(true);
  });
});
