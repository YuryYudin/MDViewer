import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

export interface FixtureSession {
  tmpDir: string;
  cleanup: () => Promise<void>;
}

/**
 * Prepares a per-test temp directory (optionally seeded from a fixture dir)
 * and returns its path. Tests will pass the path into the Tauri binary via
 * the `MDVIEWER_DATA_DIR` env var. The wiring — adding a `tauri:options.env`
 * field to wdio's capability so `tauri-driver` forwards env vars to the
 * spawned binary — is deferred to A8b, where the IPC layer stabilises and
 * we know which env vars the binary actually consumes.
 *
 * Today the temp dir is allocated and seeded but the running binary does
 * not yet read it. This is harmless during Phase A's RED state because
 * every wdio session start fails (no binary at src-tauri/target/debug/
 * mdviewer), so specs never reach the data-dir consumption path.
 */
export async function prepareFixture(opts?: { fixtureDir?: string; resetProfile?: boolean }): Promise<FixtureSession> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdviewer-e2e-'));
  if (opts?.fixtureDir) {
    await fs.cp(opts.fixtureDir, tmpDir, { recursive: true });
  }
  if (opts?.resetProfile) {
    // No profile file in the temp dir means the app prompts for setup.
  }
  return {
    tmpDir,
    cleanup: () => fs.rm(tmpDir, { recursive: true, force: true }),
  };
}

/**
 * Select all text inside the matched element and trigger SelectionPopover's
 * mouseup listener. We can't use a real triple-click via WebDriver actions
 * because the tauri-webdriver-automation plugin synthesizes pointer events
 * via dispatchEvent — the native browser doesn't update window.getSelection
 * from dispatched events. So we drive the Range/Selection API directly and
 * then fire the mouseup the popover listens for.
 */
export async function tripleClick(selector: string): Promise<void> {
  await browser.execute(function (sel: string): void {
    const el = document.querySelector(sel);
    if (!el) throw new Error('element not found: ' + sel);
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    if (!selection) throw new Error('no selection api');
    selection.removeAllRanges();
    selection.addRange(range);
    // Fire mouseup on the element so SelectionPopover.attachSelectionPopover's
    // listener picks up the new selection. mouseup bubbles so listening on
    // the document root catches it.
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, selector);
}

/**
 * E2E hook: open a .md by absolute path, bypassing the OS file dialog and
 * the `<input type=file>` flow (neither is driveable by tauri-webdriver-
 * automation on macOS — `setValue` uploads file contents, not a path).
 * The app exposes `window.__mdviewerE2E.open(path)` when running under
 * the WebDriver harness; this helper invokes it via a non-element script
 * call (which is the only execute_sync path the plugin handles correctly).
 */
export async function openDocByE2eHook(absPath: string): Promise<void> {
  await browser.executeAsync(
    function (path: string, done: (v: unknown) => void): void {
      const w = window as unknown as { __mdviewerE2E?: { open(p: string): Promise<void> } };
      if (!w.__mdviewerE2E) {
        done({ error: 'e2e hook missing' });
        return;
      }
      w.__mdviewerE2E.open(path).then(() => done(null), (e) => done({ error: String(e) }));
    },
    absPath,
  );
}

/** Spec 06: drive import_comments through the e2e side-channel. */
export async function importCommentsByE2eHook(
  tabId: string,
  incomingPath: string,
): Promise<void> {
  await browser.executeAsync(
    function (
      tabId: string,
      incomingPath: string,
      done: (v: unknown) => void,
    ): void {
      const w = window as unknown as {
        __mdviewerE2E?: { importComments(t: string, p: string): Promise<void> };
      };
      if (!w.__mdviewerE2E) {
        done({ error: 'e2e hook missing' });
        return;
      }
      w.__mdviewerE2E
        .importComments(tabId, incomingPath)
        .then(() => done(null), (e) => done({ error: String(e) }));
    },
    tabId,
    incomingPath,
  );
}
