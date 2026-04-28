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
 * Convenience: select all text inside an element via WebDriver's
 * `Element.scrollIntoView` + a triple-click. Tauri's WebView honors the
 * native selection API, so wdio's `browser.action('pointer')` with a
 * triple-click selects the surrounding paragraph the same way a user would.
 * Tests use this to simulate the user selecting a phrase before commenting.
 */
export async function tripleClick(selector: string): Promise<void> {
  const el = await browser.$(selector);
  await el.scrollIntoView();
  await browser.action('pointer')
    .move({ origin: el })
    .down().up().pause(50)
    .down().up().pause(50)
    .down().up()
    .perform();
}
