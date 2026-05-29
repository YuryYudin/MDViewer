import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture, createWindow, switchToWindow } from './helpers/app';

/**
 * E2 — CLI default routing to the focused window (scenario S8).
 *
 * Contract `01-cli-window-flag.md`: with the app already running, a default
 * (no-flag) `mdviewer foo.md` invocation must add foo.md as a tab in the
 * MOST-RECENTLY-FOCUSED window and raise it — NOT always land in `main`.
 *
 * The OS can't shell out a second `mdviewer` process under WebDriver, so the
 * spec drives the running-app dispatch through the `__mdviewerE2E.dispatchCli`
 * side-channel (mirroring `e2e/21-ssh-open-from-cli.spec.ts`'s
 * `__mdviewerE2E.openSshUrl` hook). That hook emits the same `e2e-dispatch-cli`
 * event the debug-only Rust setup() listener consumes, which routes the argv
 * through the production `cli::parse_positional_args` → `dispatch_cli_targets`
 * focused-window path. So a green run here exercises the real routing logic,
 * not a test-only shortcut.
 *
 * The fast, authoritative coverage for the routing decision is the
 * `route_target_label` mirror + dispatch source-smoke in
 * `tests/ipc_registration.rs`. This heavy WDIO run is the orchestrator's
 * phase-end (G2) gate.
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

/** Tab labels visible in the currently-active WebDriver window. */
async function tabLabelsInActiveWindow(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-test="tab"] .tab-label')).map(
      (el) => el.textContent?.trim() ?? '',
    ),
  );
}

/** The label of the currently-active WebDriver window. */
async function currentWindowLabel(): Promise<string | null> {
  return browser.execute(function (): string | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cur = (window as any).__TAURI__?.webviewWindow?.getCurrentWebviewWindow?.();
    return cur?.label ?? null;
  });
}

describe('E2 — CLI default routing to the focused window (S8)', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;
  let fooPath: string;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
    fooPath = path.join(fixture.tmpDir, 'foo.md');
    await fs.writeFile(fooPath, '# Foo\n\nCLI-default-routing probe.\n');
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

  it('S8: a default `mdviewer foo.md` opens foo.md as a tab in the focused window and raises it', async () => {
    // Reach the StartPage in `main`.
    await switchToWindow('main');
    await browser.waitUntil(async () => browser.$('[data-view="start"]').isExisting(), {
      timeout: 10_000,
      timeoutMsg: 'main never reached the StartPage',
    });

    // Spawn a SECOND window and focus it — it becomes the most-recently-
    // focused window, the one the CLI default routing must target.
    await createWindow('win-2');
    await switchToWindow('win-2');
    await browser.waitUntil(async () => browser.$('[data-view="start"]').isExisting(), {
      timeout: 10_000,
      timeoutMsg: 'win-2 never reached the StartPage',
    });
    // Ensure win-2 holds OS focus so focused_window(app) resolves to it.
    await browser.execute(function (): void {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cur = (window as any).__TAURI__?.webviewWindow?.getCurrentWebviewWindow?.();
      cur?.setFocus?.();
    });
    await browser.waitUntil(
      async () => {
        const f = await browser.executeAsync(function (done: (v: unknown) => void): void {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const cur = (window as any).__TAURI__?.webviewWindow?.getCurrentWebviewWindow?.();
          if (!cur?.isFocused) { done(false); return; }
          cur.isFocused().then((v: boolean) => done(v), () => done(false));
        });
        return f === true;
      },
      { timeout: 10_000, timeoutMsg: 'win-2 never took focus' },
    );

    // Pre-condition: neither window shows foo.md yet.
    expect(await tabLabelsInActiveWindow()).not.toContain('foo.md');

    // Drive the running-app CLI dispatch: `mdviewer <foo.md>`.
    await dispatchCliByE2eHook(['mdviewer', fooPath]);

    // The focused window (win-2) gains foo.md as a tab and is raised.
    await browser.waitUntil(
      async () => (await tabLabelsInActiveWindow()).includes('foo.md'),
      { timeout: 10_000, timeoutMsg: 'foo.md never appeared in the focused window' },
    );
    expect(await currentWindowLabel()).toBe('win-2');
    expect(await tabLabelsInActiveWindow()).toContain('foo.md');

    // `main` must NOT have gained the tab — the default routing targets the
    // focused window, not the always-present `main`.
    await switchToWindow('main');
    expect(await tabLabelsInActiveWindow()).not.toContain('foo.md');
  });
});
