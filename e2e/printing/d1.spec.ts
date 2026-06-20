import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * D1 — Headless `--export-pdf` mode + portable PDF smoke (scenario S10).
 *
 * S10's substantive assertion — that `mdviewer --export-pdf <in.md> <out.pdf>`
 * boots a single-shot runtime, renders the fixture under print media, waits for
 * the `mdviewer:render-complete` handshake, drives the SAME per-OS
 * `pdf::export_pdf_inner` backend the C1 IPC command uses, and writes a valid,
 * content-bearing PDF — is realized by the portable Node smoke at
 * `e2e/export-pdf-smoke.mjs`, run via:
 *
 *     npm run build:e2e && npm run test:e2e:pdf -- target/debug/mdviewer
 *
 * That smoke runs OUTSIDE WebDriver (it spawns the built binary directly under
 * a display and starts its own Vite dev server), because the headless export
 * has no WebDriver session to attach to and produces a file rather than a DOM
 * state. It is the single portable command that exercises the real per-OS
 * webview PDF backend end to end on any desktop OS — including macOS, where the
 * `NSPrintOperation` arm of `export_pdf_inner` is only reachable on the macOS
 * agent and is validated by this same smoke there.
 *
 * This WDIO spec is therefore the THIN ownership guard the scenario requires: it
 * asserts the headless contract surface is present and wired (the
 * `test:e2e:pdf` npm script is defined and points at the smoke, and the
 * `print-sample.md` fixture the smoke feeds exists with representative content),
 * and defers the byte-level file assertion to the smoke run in verification.
 * Keeping it minimal but present means S10 has its required owned spec without
 * duplicating the file-production check the smoke already owns.
 *
 * Substantive S10 verification: `npm run test:e2e:pdf -- target/debug/mdviewer`.
 */
describe('D1: headless --export-pdf contract surface (S10)', () => {
  const repoRoot = path.resolve('.');

  it('S10: the test:e2e:pdf script is defined and runs the headless PDF smoke', async () => {
    const pkgRaw = await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
    const script = pkg.scripts?.['test:e2e:pdf'];
    expect(script).toBeDefined();
    // The script must invoke the portable smoke that drives the real backend.
    expect(script).toContain('export-pdf-smoke.mjs');
  });

  it('S10: the smoke entry point exists', async () => {
    const smoke = path.join(repoRoot, 'e2e', 'export-pdf-smoke.mjs');
    await expect(fs.access(smoke)).resolves.toBeUndefined();
  });

  it('S10: the print-sample fixture exists with representative content', async () => {
    const fixture = path.join(repoRoot, 'e2e', 'fixtures', 'print-sample.md');
    const md = await fs.readFile(fixture, 'utf8');
    // Headings, a fenced code block, and a table — the content that exercises
    // the A1 page-break + syntax-color rules so the export proves real
    // rendering (a trivial fixture would clear the size floor without it).
    expect(md).toMatch(/^#\s/m); // an H1
    expect(md).toMatch(/```/); // a fenced code block
    expect(md).toMatch(/\|.*\|/); // a table row
  });
});
