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
 * Place the editor selection over the first source-annotated inline carrier
 * and trigger SelectionPopover's mouseup listener via the LiveEditor's
 * `__mdviewerE2E.setLiveEditorSelection(start, end)` hook (A.1).
 *
 * Contract: the passed `selector` is IGNORED. By design the helper picks the
 * first `[data-src-offset]` span inside the `[data-region="rendered-shadow"]`
 * div (A.2). Specs 03 / 18 both pass
 * `'[data-view="document"] [data-src-offset]:first-of-type'` for legibility;
 * the effective behaviour ("first inline carrier in the document") is
 * unchanged from the pre-Phase-A helper. We no longer drive the Range /
 * Selection API directly because the live editor's source-of-truth is
 * CodeMirror's StateField — the visible DOM is a decoration tree, not the
 * authoritative text.
 *
 * Source byte offsets come from the explicit `data-src-offset` /
 * `data-src-end` attributes on the shadow span. We do NOT compute the end
 * from `textContent.length`: `render_markdown` HTML-escapes content (`<`
 * becomes `&lt;`), so the rendered span's textContent length and the source
 * byte range diverge.
 *
 * The mouseup synthesis happens INSIDE `setLiveEditorSelection` (it fires on
 * `view.contentDOM`, where SelectionPopover's listener is attached). The
 * helper therefore does NOT re-dispatch mouseup — doing so would produce two
 * mouseup events and race the popover open/close.
 */
export async function tripleClick(_selector: string): Promise<void> {
  await browser.execute(function (): void {
    const span = document.querySelector(
      '[data-region="rendered-shadow"] [data-src-offset]',
    ) as HTMLElement | null;
    if (!span) {
      throw new Error('tripleClick: no [data-src-offset] span in rendered-shadow');
    }
    const start = Number(span.getAttribute('data-src-offset'));
    const end = Number(span.getAttribute('data-src-end'));
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error(
        'tripleClick: invalid offsets start=' + start + ' end=' + end,
      );
    }
    const api = (window as unknown as {
      __mdviewerE2E?: { setLiveEditorSelection?: (s: number, e: number) => unknown };
    }).__mdviewerE2E;
    if (!api || typeof api.setLiveEditorSelection !== 'function') {
      throw new Error('tripleClick: __mdviewerE2E.setLiveEditorSelection not present');
    }
    api.setLiveEditorSelection(start, end);
    // NOTE: mouseup synth happens inside the hook (A.1); helper does NOT re-dispatch.
  });
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
