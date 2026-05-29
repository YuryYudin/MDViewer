import fs from 'node:fs/promises';
import path from 'node:path';
import {
  prepareFixture,
  switchToWindow,
  tabLabelsInActiveWindow,
  allWindowLabels,
} from './helpers/app';

/**
 * F1 — CLI `-w` / `--window` flag spawns a NEW window (scenario S9).
 *
 * Contract `01-cli-window-flag.md`: with the app already running, a
 * `mdviewer -w foo.md` invocation must SPAWN a fresh window holding foo.md
 * (relocating it if already open elsewhere) — distinct from the focused
 * window, which must NOT gain the tab. Absence of the flag keeps E2's
 * focused-window routing (covered by `e2e/e2.spec.ts`).
 *
 * The OS can't shell out a second `mdviewer -w foo.md` process under
 * WebDriver, so the spec drives the running-app dispatch through the
 * `__mdviewerE2E.dispatchCli` side-channel. That hook emits the same
 * `e2e-dispatch-cli` event the debug-only Rust setup() listener consumes,
 * which routes the FULL argv (flag included) through the production
 * `cli::parse_positional_args` → `dispatch_cli_targets` new-window path. So a
 * green run here exercises the real flag-recognition + spawn logic, not a
 * test-only shortcut.
 *
 * The fast, authoritative coverage for the flag parsing lives in
 * `src-tauri/src/cli.rs`'s unit suite. This heavy WDIO run is the
 * orchestrator's phase-end (G2) gate.
 */

/** Drive the running-app CLI dispatch through the e2e side-channel. */
async function dispatchCliByE2eHook(args: string[]): Promise<void> {
  await browser.executeAsync(
    function (argv: string[], done: (v: unknown) => void): void {
      const w = window as unknown as {
        __mdviewerE2E?: { dispatchCli?(a: string[]): Promise<void> };
      };
      if (!w.__mdviewerE2E || !w.__mdviewerE2E.dispatchCli) {
        done({ error: 'dispatchCli hook missing' });
        return;
      }
      w.__mdviewerE2E.dispatchCli(argv).then(
        () => done(null),
        (err: unknown) => done({ error: String(err) }),
      );
    },
    args,
  );
}

describe('F1 — CLI `-w` flag spawns a new window (S9)', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;
  let fooPath: string;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
    fooPath = path.join(fixture.tmpDir, 'foo.md');
    await fs.writeFile(fooPath, '# Foo\n\nCLI-new-window probe.\n');
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

  it('S9: `mdviewer -w foo.md` spawns a NEW window holding foo.md, distinct from the focused window', async () => {
    // Reach the StartPage in `main`. (No explicit OS-focus drive: the `-w`
    // flag spawns a fresh window regardless of which window is focused, so
    // the unobservable-headless OS-focus step the old spec attempted via
    // `window.__TAURI__` — undefined under tauri-wd with withGlobalTauri OFF —
    // is irrelevant to this scenario's contract.)
    await switchToWindow('main');
    await browser.waitUntil(async () => browser.$('[data-view="start"]').isExisting(), {
      timeout: 10_000,
      timeoutMsg: 'main never reached the StartPage',
    });

    // Pre-condition: `main` does not show foo.md, and it's the only window.
    expect(await tabLabelsInActiveWindow()).not.toContain('foo.md');
    const before = await allWindowLabels();

    // Drive the running-app CLI dispatch WITH the new-window flag.
    await dispatchCliByE2eHook(['mdviewer', '-w', fooPath]);

    // A brand-new window handle must appear (the flag spawns one).
    await browser.waitUntil(
      async () => (await allWindowLabels()).length > before.length,
      { timeout: 10_000, timeoutMsg: 'no new window was spawned for `mdviewer -w`' },
    );
    const after = await allWindowLabels();
    const spawned = after.filter((l) => !before.includes(l));
    expect(spawned.length).toBe(1);

    // The spawned window holds foo.md.
    await switchToWindow(spawned[0]);
    await browser.waitUntil(
      async () => (await tabLabelsInActiveWindow()).includes('foo.md'),
      { timeout: 10_000, timeoutMsg: 'foo.md never appeared in the spawned window' },
    );
    expect(await tabLabelsInActiveWindow()).toContain('foo.md');

    // The previously-focused `main` window must NOT have gained the tab — the
    // `-w` flag routes into the freshly-spawned window, not the focused one.
    await switchToWindow('main');
    expect(await tabLabelsInActiveWindow()).not.toContain('foo.md');
  });
});
