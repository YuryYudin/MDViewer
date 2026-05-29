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

/**
 * B2 (multi-window): spawn a second native window with the given label via
 * the e2e side-channel's `createWindow` hook, which invokes the
 * `e2e_create_window` IPC (registered only under `--features e2e`). The new
 * window loads the same app entry (a fresh Workspace shell) and registers
 * itself under the EXACT `label`, which the window-scoped IPC handlers key
 * on. Returns once the new window exists as a WebDriver handle that reports
 * the requested label, so the caller can switch to it.
 *
 * G2: this used to call `new WebviewWindow(...)` off `window.__TAURI__`, but
 * `withGlobalTauri` is OFF (the app bundles `@tauri-apps/api` imports), so
 * `window.__TAURI__` is undefined under tauri-wd. We drive the spawn through
 * the same e2e side-channel the other helpers use instead.
 *
 * The frontend wires the production "open in new window" affordance (C2/D1);
 * this helper drives the underlying primitive so the isolation contract (S5)
 * can be asserted independently of that UI landing.
 */
export async function createWindow(label: string): Promise<void> {
  const result = await browser.executeAsync(
    function (label: string, done: (v: unknown) => void): void {
      const w = window as unknown as {
        __mdviewerE2E?: { createWindow?(label: string): Promise<void> };
      };
      if (!w.__mdviewerE2E?.createWindow) {
        done({ error: 'e2e createWindow hook missing' });
        return;
      }
      w.__mdviewerE2E.createWindow(label).then(() => done(null), (e) => done({ error: String(e) }));
    },
    label,
  );
  if (result && typeof result === 'object' && 'error' in result) {
    throw new Error(`createWindow("${label}") failed: ${(result as { error: string }).error}`);
  }
  // Wait until the freshly-spawned window's own boot has reported its label
  // and surfaces as a WebDriver handle we can switch to.
  await switchToWindow(label);
}

/**
 * Switch the active WebDriver window to the one whose own boot reported the
 * given `label`. tauri-wd surfaces each native window as a separate WebDriver
 * handle; we identify the target by reading `window.__mdviewerE2E.windowLabel`
 * (set by each window's main.ts on boot — see src/main.ts G2) from each
 * handle.
 *
 * G2: replaces the old `window.__TAURI__...getCurrentWebviewWindow().label`
 * path (unavailable because `withGlobalTauri` is OFF). The label is set after
 * the window's async boot import resolves, so we poll a few times with a short
 * pause before giving up — a just-spawned window needs a moment to populate it.
 */
export async function switchToWindow(label: string): Promise<void> {
  const maxAttempts = 20;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const handles = await browser.getWindowHandles();
    for (const h of handles) {
      await browser.switchToWindow(h);
      const thisLabel = await browser.execute(function (): string | null {
        const w = window as unknown as { __mdviewerE2E?: { windowLabel?: string } };
        return w.__mdviewerE2E?.windowLabel ?? null;
      });
      if (thisLabel === label) return;
    }
    // The label populates after the window's async boot resolves; give a
    // just-spawned window time before the next sweep.
    await browser.pause(250);
  }
  throw new Error(`no WebDriver handle for window label "${label}"`);
}

/** Tab labels visible in the currently-active WebDriver window. */
export async function tabLabelsInActiveWindow(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-test="tab"] .tab-label'))
      .map((el) => el.textContent?.trim() ?? ''),
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
