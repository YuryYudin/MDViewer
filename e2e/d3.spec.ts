import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture, switchToWindow } from './helpers/app';

/**
 * D3 — Open in New Window from a StartPage recent (scenario S3).
 *
 * Wireframe 06: each recents row carries an open-in-new-window affordance
 * (`data-test=recent-open-new-window`). Activating it must spawn a NEW native
 * window that holds the recent's document — without disturbing the click that
 * opens the recent in the current window (the affordance `stopPropagation`s so
 * the row body click still routes through `ipc.openDocument`).
 *
 * S3: with `report.md` present in recents but NOT currently open in any
 * window, activating its open-in-new-window affordance opens a fresh window
 * holding `report.md`. We assert a second WebDriver window handle appears and
 * that the new window renders the document.
 *
 * The fast, authoritative coverage for the affordance (renders the hook,
 * invokes `open_in_new_window` with the right path, stops propagation so the
 * row's own open still fires) is `tests/views/StartPage.test.ts`. The one-owner
 * focus-existing backend belongs to D1. The heavy WDIO run is the
 * orchestrator's phase-end (G2) gate.
 */

/** Count of native windows currently exposed as WebDriver handles. */
async function windowCount(): Promise<number> {
  return (await browser.getWindowHandles()).length;
}

describe('D3 — Open in New Window from a recent (S3)', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;
  let reportPath: string;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
    reportPath = path.join(fixture.tmpDir, 'report.md');
    await fs.writeFile(reportPath, '# Report\n\nNew-window-from-recent probe.\n');
    const dataDir = process.env.MDVIEWER_DATA_DIR!;
    // Seed recents with report.md so the StartPage renders its row — but the
    // doc is NOT open in any window (no session.json), so the affordance must
    // genuinely spawn a new window rather than focus an existing one.
    //
    // The on-disk recents schema is a BARE ARRAY OF PATH STRINGS
    // (`{"entries":["/abs/report.md"]}`) — `kind`/`mtime` are DERIVED at
    // materialize time (RecentsStore::list_with_mtime), never persisted (see
    // recents.rs `OnDisk { entries: Vec<PathBuf> }` + its
    // `on_disk_schema_unchanged_no_kind_field` test). The old object shape
    // (`{path,mtime,kind}`) failed to deserialize → empty recents → no row.
    // Local entries are pruned at load unless the path exists on disk; we
    // write report.md above first so the row survives the `.exists()` filter.
    await fs.writeFile(
      path.join(dataDir, 'recents.json'),
      JSON.stringify({ entries: [reportPath] }, null, 2),
    );
    await fs.rm(path.join(dataDir, 'session.json'), { force: true });
    await browser.reloadSession();
  });
  after(async () => { await fixture.cleanup(); });

  it('S3: activating a recent\'s open-in-new-window affordance opens a new window holding that document', async () => {
    await switchToWindow('main');
    await browser.waitUntil(
      async () => browser.$('[data-view="start"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'main never reached the StartPage' },
    );

    // Pre-condition: exactly one native window (main) and report.md's recents
    // row is present with an open-in-new-window affordance.
    const startingWindows = await windowCount();
    const row = await browser.$('[data-test="recent-item"]');
    await row.waitForExist({ timeout: 10_000, timeoutMsg: 'report.md recents row never rendered' });
    const affordance = await row.$('[data-test="recent-open-new-window"]');
    await affordance.waitForExist({
      timeout: 10_000,
      timeoutMsg: 'recents row has no open-in-new-window affordance',
    });

    // Activate the affordance — it must spawn a brand-new window for report.md
    // (and NOT navigate the main window away from the StartPage).
    await affordance.click();

    // A second native window appears as a fresh WebDriver handle.
    await browser.waitUntil(
      async () => (await windowCount()) > startingWindows,
      { timeout: 10_000, timeoutMsg: 'open-in-new-window affordance did not spawn a new window' },
    );

    // The new window holds report.md. Find the handle that is not main and
    // assert it renders the document.
    const handles = await browser.getWindowHandles();
    let rendered = false;
    for (const h of handles) {
      await browser.switchToWindow(h);
      const label = await browser.execute(function (): string | null {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cur = (window as any).__TAURI__?.webviewWindow?.getCurrentWebviewWindow?.();
        return cur?.label ?? null;
      });
      if (label === 'main') continue;
      const ok = await browser
        .$('[data-view="document"] h1')
        .waitUntil(
          async function (this: WebdriverIO.Element) {
            return (await this.getText()) === 'Report';
          },
          { timeout: 10_000, timeoutMsg: 'report.md never rendered in the new window' },
        )
        .then(() => true, () => false);
      if (ok) { rendered = true; break; }
    }
    expect(rendered).toBe(true);
  });
});
