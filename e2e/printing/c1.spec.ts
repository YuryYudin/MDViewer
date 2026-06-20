import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture, openDocByE2eHook } from '../helpers/app';

/**
 * C1 — Export to PDF: menu action + save-dialog flow (scenarios S5, S6, S7, S8).
 *
 * The runtime path is identical whether the Export click comes from the OS
 * menu or from `emit('menu-action', 'export-pdf')` inside the WebView:
 *
 *   1. Rust `on_menu_event` (menu-export-pdf) → `app.emit("menu-action", "export-pdf")`
 *   2. WebView `installMenuBridge` → `MENU_ACTION_TO_EVENT['export-pdf']`
 *   3. `dispatchMenuAction` → `mdviewer:export-pdf` CustomEvent on `document`
 *   4. main.ts `mdviewer:export-pdf` listener → resolve active doc → save()
 *      dialog (default `<stem>.pdf`) → `invoke('export_pdf', { path })` → toast
 *
 * Like 14-app-menu.spec.ts and b1.spec.ts we drive steps 2–4 via the bundled
 * `__mdviewerE2E.emitMenuAction('export-pdf')` hook — the OS menu item itself
 * is not driveable by tauri-webdriver-automation, but the emit path joins to
 * the exact same bridge the OS click would.
 *
 * The native save dialog opened by `@tauri-apps/plugin-dialog`'s `save()` can
 * neither be seen nor dismissed by WebDriver, so under `__WEBDRIVER__` the
 * listener bypasses the dialog and reads a pre-set path from
 * `window.__mdviewerE2E.nextSavePath` (string → confirm at that path; absent →
 * cancel). It also records the `defaultPath` the production dialog would have
 * received on `window.__mdviewerE2E.lastExportDefaultPath` so S6 can assert the
 * `<stem>.pdf` derivation. This spec therefore owns the DIALOG-WIRING half of
 * S5 (export flow reaches `invoke` + surfaces a toast); the actual PDF-file
 * production (S5's file bytes) is realized by D1's portable headless smoke,
 * because the native dialog is not WebDriver-controllable.
 *
 * Pre-existing unit coverage:
 *   - tests/menuBridge.test.ts — export-pdf → mdviewer:export-pdf dispatch
 *   - tests/main.test.ts       — listener: default name, cancel no-op, error toast
 *   - src-tauri/src/menu.rs     — menu-export-pdf ↔ "export-pdf" id mapping
 *   - src-tauri/src/pdf.rs      — default_pdf_filename / file_uri_for / no-doc err
 * What this spec adds: a real-WebView verification that the bridge is wired end
 * to end through the save-dialog flow, cancel no-ops, and a backend Err surfaces
 * as an error toast without crashing the shell.
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

/** Arm the save-dialog side-channel: `path` confirms, `null` cancels. */
async function setNextSavePath(p: string | null): Promise<void> {
  await browser.execute((next: string | null) => {
    const w = window as unknown as {
      __mdviewerE2E?: { nextSavePath?: string | null; lastExportDefaultPath?: string };
    };
    if (!w.__mdviewerE2E) throw new Error('e2e hook missing');
    if (next === null) {
      // Cancel: ensure no leftover path from a prior test is consumed.
      delete w.__mdviewerE2E.nextSavePath;
    } else {
      w.__mdviewerE2E.nextSavePath = next;
    }
    // Clear any recorded default so S6 reads a fresh value.
    delete w.__mdviewerE2E.lastExportDefaultPath;
  }, p);
}

/** The `defaultPath` the production save() dialog would have received. */
async function lastExportDefaultPath(): Promise<string | undefined> {
  return browser.execute(function (): string | undefined {
    const w = window as unknown as {
      __mdviewerE2E?: { lastExportDefaultPath?: string };
    };
    return w.__mdviewerE2E?.lastExportDefaultPath;
  });
}

/** Current text of the shared toast region (empty string when none). */
async function toastText(): Promise<string> {
  return browser
    .$('[data-region="toast"]')
    .getText()
    .catch(() => '');
}

describe('C1: Export to PDF → save dialog flow', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
    await fs.rm(path.join(fixture.tmpDir, 'sample.md.comments.json'), { force: true });
    const dataDir = process.env.MDVIEWER_DATA_DIR!;
    await fs.writeFile(
      path.join(dataDir, 'recents.json'),
      JSON.stringify({ entries: [] }, null, 2),
    );
    await browser.reloadSession();

    // Every scenario operates on an open document — open it once.
    await openDocByE2eHook(path.join(fixture.tmpDir, 'sample.md'));
    await browser.waitUntil(
      async () => browser.$('[data-view="document"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'document never mounted' },
    );
  });
  after(async () => { await fixture.cleanup(); });

  it('S5: export menu action runs the flow → invokes export_pdf and toasts the result', async () => {
    const out = path.join(fixture.tmpDir, 's5-export.pdf');
    await fs.rm(out, { force: true });
    await setNextSavePath(out);

    await emitMenuAction('export-pdf');

    // The dialog-wiring contract: the flow reached `invoke('export_pdf', …)`
    // and surfaced its outcome as a toast referencing the chosen path.
    await browser.waitUntil(
      async () => /Exported to/i.test(await toastText()),
      { timeout: 8_000, timeoutMsg: '"Exported to …" toast never appeared after export' },
    );
    expect(await toastText()).toContain('s5-export.pdf');
  });

  it('S6: save dialog defaults to <stem>.pdf derived from the active document', async () => {
    const out = path.join(fixture.tmpDir, 's6-export.pdf');
    await setNextSavePath(out);

    await emitMenuAction('export-pdf');

    // The default the native dialog would have received is `<dir>/sample.pdf`
    // (the document is `sample.md`). We assert the basename derivation rather
    // than the full directory so the check is path-separator agnostic.
    await browser.waitUntil(
      async () => {
        const def = await lastExportDefaultPath();
        return typeof def === 'string' && /(?:^|[/\\])sample\.pdf$/.test(def);
      },
      { timeout: 8_000, timeoutMsg: 'export default path was not derived as sample.pdf' },
    );
  });

  it('S7: cancelling the save dialog → export_pdf NOT invoked and no toast', async () => {
    const wouldBe = path.join(fixture.tmpDir, 's7-cancel.pdf');
    await fs.rm(wouldBe, { force: true });
    // Cancel: leave nextSavePath unset so the listener treats it as null.
    await setNextSavePath(null);

    await emitMenuAction('export-pdf');

    // Give the (cancelled) flow time to settle, then assert nothing happened:
    // no toast surfaced and no PDF file was written (export_pdf was not called).
    await browser.pause(1_500);
    expect(await toastText()).toBe('');
    await expect(fs.access(wouldBe)).rejects.toThrow();
  });

  it('S8: backend export_pdf failure → error toast appears and the shell survives', async () => {
    // Point the save at an unwritable destination (a nested path under a
    // non-existent, non-creatable parent) so the real `export_pdf` command
    // returns Err. The listener maps that rejection into a toast.
    const bad = path.join(fixture.tmpDir, 'does-not-exist-dir', 'nope', 'out.pdf');
    await setNextSavePath(bad);

    await emitMenuAction('export-pdf');

    await browser.waitUntil(
      async () => {
        const text = await toastText();
        return text.length > 0 && !/Exported to/i.test(text);
      },
      { timeout: 8_000, timeoutMsg: 'no error toast appeared after a failed export' },
    );
    expect(await toastText()).not.toMatch(/Exported to/i);

    // The app shell is still alive and interactive after the failure.
    expect(await browser.$('[data-view="document"]').isExisting()).toBe(true);
  });
});
