import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Vitest globalSetup: builds the `render-cli` binary once per
 * invocation so the oracle test can spawn it. Gated behind
 * `MDVIEWER_BUILD_ORACLE=1` because globalSetup is unconditional —
 * without this gate every `npm test` would pay the multi-second cargo
 * build cost even when the developer didn't run the oracle test (e.g.
 * `npx vitest run tests/keymap.test.ts`). The design doc's Layer 2
 * description explicitly mandates the env opt-in.
 *
 * When the env var is set, runs `cargo build -p mdviewer-core --bin
 * render-cli` and exports the absolute binary path via
 * `MDVIEWER_RENDER_CLI` for the test to consume.
 *
 * When unset, returns early with a `console.warn` so the oracle test's
 * `test.skip()` branch can pick up the absence cleanly (the test reads
 * `process.env.MDVIEWER_RENDER_CLI` directly).
 */
export default function setup(): void {
  if (process.env.MDVIEWER_BUILD_ORACLE !== '1') {
    console.warn(
      '[oracle.globalSetup] MDVIEWER_BUILD_ORACLE != 1 — skipping render-cli build. The oracle test will skip.',
    );
    return;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  // tests/render/ → repo root is two levels up.
  const repo = path.resolve(here, '..', '..');
  execFileSync('cargo', ['build', '-p', 'mdviewer-core', '--bin', 'render-cli'], {
    cwd: repo,
    stdio: 'inherit',
  });
  process.env.MDVIEWER_RENDER_CLI = path.join(repo, 'target', 'debug', 'render-cli');
}
