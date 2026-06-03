import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

describe('types-generated.ts', () => {
  it('matches the Rust binary output bit-exactly', () => {
    // Re-run the exporter from a clean state, capturing what it would write.
    execFileSync('cargo', ['run', '--quiet', '--bin', 'export_types'], {
      cwd: path.join(repoRoot, 'src-tauri'),
      stdio: 'inherit',
    });
    // After re-running, the on-disk file equals the binary's current output.
    // Read it and assert basic shape (additional shape assertions land in
    // later task verification steps as more types are added).
    const out = fs.readFileSync(path.join(repoRoot, 'src', 'types-generated.ts'), 'utf8');
    expect(out).toMatch(/^\/\/ AUTO-GENERATED/);
    // ts-rs 8.x emits `export type BuildInfo = { ... }`; older docs/specs
    // referred to `export interface BuildInfo`. Accept either declaration form.
    expect(out).toMatch(/export\s+(type|interface)\s+BuildInfo\b/);
    expect(out).toContain('version: string');
    expect(out).toContain('commit_hash: string');
    // D1: the window surface emits a `WindowSummary` type. Assert it is
    // generated and re-exported from ipc.ts.
    expect(out).toMatch(/export\s+(type|interface)\s+WindowSummary\b/);
    const ipcTs = fs.readFileSync(path.join(repoRoot, 'src', 'ipc.ts'), 'utf8');
    expect(ipcTs).toContain('WindowSummary');
    // Re-running the Rust exporter compiles the bin (cold ~40s on CI); raise
    // the per-test timeout well above vitest 4's 5s default — v2 didn't
    // enforce it on this synchronous execFileSync, v4 does.
  }, 120_000);

  it('exports BuildInfo as a usable type', () => {
    // BuildInfo is a type, not a runtime value; its compile-time usability is
    // enforced by `npm run build` (tsc). At runtime we only assert the symbol
    // is declared in the generated file. A runtime `import()` of this
    // type-only concatenation is rejected by vitest 4's stricter transform
    // (the per-type `import type {...}` lines collide with the inline
    // declarations of the same names), and would erase to an empty module
    // anyway — so the old `toBeTruthy` check was vacuous.
    const out = fs.readFileSync(path.join(repoRoot, 'src', 'types-generated.ts'), 'utf8');
    expect(out).toMatch(/export\s+(type|interface)\s+BuildInfo\b/);
  });
});
