import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

export interface FixtureSession {
  tmpDir: string;
  cleanup: () => Promise<void>;
}

/**
 * Prepares a per-test temp directory (optionally seeded from a fixture dir)
 * and returns its path. Tests pass the path into the Tauri binary via the
 * `MDVIEWER_DATA_DIR` env var, which `tauri-driver` reads from
 * `wdio.conf.ts`'s capability extras. tauri-driver in turn forwards the env
 * vars when it spawns the binary, so the running app reads its config from
 * the temp dir.
 *
 * If MDVIEWER_DATA_DIR is not honored by the running binary (Phase A has not
 * yet implemented the override), the fixture seeding is harmless — the
 * specs will still fail because the wdio session can't start without a
 * binary at src-tauri/target/debug/mdviewer.
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
