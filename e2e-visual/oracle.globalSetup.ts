import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FullConfig } from '@playwright/test';

/**
 * Playwright globalSetup: builds the `render-cli` binary once per
 * invocation and exports its absolute path via `MDVIEWER_RENDER_CLI`
 * for the F1 oracle spec to consume.
 *
 * Mirrors `tests/render/oracle.globalSetup.ts` (the vitest Layer 2
 * setup) but is UNGATED — the Playwright oracle is the actual SC #3
 * gate, so the cargo build cost is part of the normal `npm run
 * test:visual` budget rather than opt-in. (The vitest version gates on
 * MDVIEWER_BUILD_ORACLE=1 because a plain `npm test` shouldn't pay
 * the cargo cost when the developer is iterating on TS unit tests.)
 *
 * Playwright invokes this with the resolved `FullConfig`; we don't
 * read from it. The function may be sync or async — we use sync
 * execFileSync since the cargo build is a one-shot blocking
 * dependency for every spec in the directory.
 */
export default function globalSetup(_config: FullConfig): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // e2e-visual/ → repo root is one level up.
  const repo = path.resolve(here, '..');
  execFileSync('cargo', ['build', '-p', 'mdviewer-core', '--bin', 'render-cli'], {
    cwd: repo,
    stdio: 'inherit',
  });
  process.env.MDVIEWER_RENDER_CLI = path.join(repo, 'target', 'debug', 'render-cli');
}
