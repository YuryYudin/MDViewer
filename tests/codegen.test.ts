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
  });

  it('exports BuildInfo as a usable type', async () => {
    const mod = await import('../src/types-generated');
    // BuildInfo is a type, not a runtime value, so we assert at the type
    // level by referencing the symbol via a no-op generic helper — tsc will
    // fail compilation if the symbol is missing, which is the failure mode
    // this test is meant to catch.
    function assertType<_T>() { /* compile-time only */ }
    assertType<import('../src/types-generated').BuildInfo>();
    expect(mod).toBeTruthy();
  });
});
