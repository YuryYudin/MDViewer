import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture, openDocByE2eHook } from './helpers/app';

/**
 * Settings.appearance.startup_mode = "restore" should re-open the tabs
 * that were open at the previous shutdown. The state is mirrored to
 * `<data_dir>/session.json` on every Workspace::open_document and
 * Workspace::close_tab; the boot path in main.rs reads it when the
 * setting is "restore" and replays open_document for each saved path.
 *
 * This spec opens two docs, sets startup_mode to "restore", reloads the
 * session (which spawns a new mdviewer process pointing at the same
 * MDVIEWER_DATA_DIR), and asserts both tabs are back. The default
 * "clean" path is implicitly covered by every other e2e spec — they
 * all start with an empty workspace.
 */
describe('Startup setting — restore previous session', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
    await fs.rm(path.join(fixture.tmpDir, 'sample.md.comments.json'), { force: true });
    // Drop a second .md so the test exercises a multi-tab restore.
    await fs.writeFile(
      path.join(fixture.tmpDir, 'second.md'),
      '# Second Document\n\nSession-restore probe.\n',
    );
    const dataDir = process.env.MDVIEWER_DATA_DIR!;
    await fs.writeFile(
      path.join(dataDir, 'recents.json'),
      JSON.stringify({ entries: [] }, null, 2),
    );
    // Wipe any session.json the prior spec may have left behind so the
    // first reloadSession boots into a clean state.
    await fs.rm(path.join(dataDir, 'session.json'), { force: true });
    await browser.reloadSession();
  });
  after(async () => { await fixture.cleanup(); });

  it('with startup_mode=restore, both previously-open tabs reopen on next session', async () => {
    const first = path.join(fixture.tmpDir, 'sample.md');
    const second = path.join(fixture.tmpDir, 'second.md');

    // Open both docs.
    await openDocByE2eHook(first);
    await browser.waitUntil(
      async () => browser.$('[data-view="document"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'first doc never mounted' },
    );
    await openDocByE2eHook(second);
    await browser.waitUntil(
      async () => {
        const heading = await browser.$('[data-view="document"] h1').getText();
        return heading === 'Second Document';
      },
      { timeout: 10_000, timeoutMsg: 'second doc never rendered' },
    );

    // Two tabs visible.
    expect(await browser.execute(
      () => document.querySelectorAll('[data-test="tab"]').length,
    )).toBe(2);

    // Flip startup_mode → restore. Use the IPC directly so the change
    // is synchronous; opening Settings via menu would also work but
    // adds harness steps that aren't the point of this test.
    await browser.executeAsync(function (done: (v: unknown) => void): void {
      const w = window as unknown as {
        __mdviewerE2E?: unknown;
      };
      // Use the production IPC: read settings, mutate, write back.
      // The setSettings wrapper dispatches mdviewer:settings-changed
      // which is irrelevant here — we only care about the disk write.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tauri = (window as any).__TAURI_INTERNALS__;
      if (!tauri?.invoke) { done({ error: 'tauri runtime missing' }); return; }
      tauri.invoke('get_settings').then((settings: { appearance: { startup_mode: string } }) => {
        settings.appearance.startup_mode = 'restore';
        return tauri.invoke('set_settings', { settings });
      }).then(() => done(null), (e: unknown) => done({ error: String(e) }));
      void w; // silence unused
    });

    // Restart the session against the same MDVIEWER_DATA_DIR. The new
    // mdviewer process reads settings.toml (restore) and session.json
    // (the two saved tabs), then replays open_document for each.
    await browser.reloadSession();

    // Both tabs are back; the active one (the last one opened) should be
    // second.md per the saved session's active_tab.
    await browser.waitUntil(
      async () => {
        const count = await browser.execute(
          () => document.querySelectorAll('[data-test="tab"]').length,
        );
        return count === 2;
      },
      { timeout: 15_000, timeoutMsg: 'session restore did not bring both tabs back' },
    );

    // Active doc is the second one (it was active when the session was
    // saved). The Document view's heading reflects the active tab.
    const activeHeading = await browser.$('[data-view="document"] h1').getText();
    expect(activeHeading).toBe('Second Document');

    // Both tab labels are present so the user has the strip to switch
    // between docs without re-opening from the StartPage.
    const labels = await browser.execute(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-test="tab"] .tab-label'))
        .map((el) => el.textContent?.trim() ?? ''),
    );
    expect(labels.sort()).toEqual(['sample.md', 'second.md']);
  });
});
