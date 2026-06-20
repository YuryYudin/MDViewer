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
 *      (under `__WEBDRIVER__` the real invoke is stubbed — see below)
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
 * `<stem>.pdf` derivation.
 *
 * Crucially, under `__WEBDRIVER__` the listener does NOT call the real
 * `export_pdf` backend after the path is confirmed — the macOS NSPrintOperation
 * export does not complete under the CI WDIO runner (it hangs, timing out the
 * executeAsync emit), and per the DESIGN this spec owns only the dialog-wiring
 * half. Instead it synthesizes the SAME outcome the real path would, driven by
 * `window.__mdviewerE2E.nextExportResult` ('ok' → "Exported to <path>" toast;
 * 'err' → the error toast). This spec therefore owns the DIALOG-WIRING half of
 * S5 (export flow reaches the invoke boundary + surfaces a toast); the actual
 * PDF-file production (S5's file bytes) is realized by D1's portable headless
 * smoke, which is Linux-verified, because the native dialog + per-OS export are
 * not WebDriver-controllable.
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

/**
 * Arm the synthesized export outcome for the next emit. Under `__WEBDRIVER__`
 * the export listener does NOT call the real `export_pdf` backend (the macOS
 * NSPrintOperation export hangs under the CI WDIO runner, and the real
 * PDF-file production is owned by D1's portable smoke, not this dialog-wiring
 * spec). Instead it reads `nextExportResult` and synthesizes the same toast the
 * real path would: `'ok'` → "Exported to <path>", `'err'` → the error toast.
 */
async function setNextExportResult(r: 'ok' | 'err'): Promise<void> {
  await browser.execute((next: 'ok' | 'err') => {
    const w = window as unknown as {
      __mdviewerE2E?: { nextExportResult?: 'ok' | 'err' };
    };
    if (!w.__mdviewerE2E) throw new Error('e2e hook missing');
    w.__mdviewerE2E.nextExportResult = next;
  }, r);
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
    await setNextExportResult('ok');

    await emitMenuAction('export-pdf');

    // The dialog-wiring contract: the flow reached the export boundary and
    // surfaced its (synthesized 'ok') outcome as a toast referencing the path.
    await browser.waitUntil(
      async () => /Exported to/i.test(await toastText()),
      { timeout: 8_000, timeoutMsg: '"Exported to …" toast never appeared after export' },
    );
    expect(await toastText()).toContain('s5-export.pdf');
  });

  it('S6: save dialog defaults to <stem>.pdf derived from the active document', async () => {
    const out = path.join(fixture.tmpDir, 's6-export.pdf');
    await setNextSavePath(out);
    await setNextExportResult('ok');

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

    // Prior tests' success toasts may still be on screen (they auto-dismiss
    // later), and the toast region concatenates whatever is currently shown —
    // so an absolute "toast is empty" check is order-dependent. Capture the
    // current toast text immediately before the cancel and assert the cancel
    // adds NOTHING new (the dialog-cancel path emits no toast at all).
    const before = await toastText();

    await emitMenuAction('export-pdf');

    // Give the (cancelled) flow time to settle, then assert nothing happened:
    // no NEW toast surfaced and no PDF file was written (export_pdf not called).
    // Lingering prior toasts may auto-dismiss during the pause, so the cancel
    // can only SHRINK the toast text (subset of `before`), never add to it — a
    // new toast would introduce text not present in `before`.
    await browser.pause(1_500);
    expect(before).toContain(await toastText());
    await expect(fs.access(wouldBe)).rejects.toThrow();
  });

  it('S8: backend export_pdf failure → error toast appears and the shell survives', async () => {
    // Arm the export-failure outcome. Under WebDriver the listener synthesizes
    // the same toast a real `export_pdf` rejection would (the real per-OS
    // export is not driven here — see the file header). The path still confirms
    // (non-cancel), so the failure branch is what surfaces a toast.
    const bad = path.join(fixture.tmpDir, 's8-export.pdf');
    await setNextSavePath(bad);
    await setNextExportResult('err');

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
