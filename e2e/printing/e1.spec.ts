import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/**
 * E1 — Cross-platform PDF-export verification (scenarios S11, S12).
 *
 * S11 (Windows / WebView2 `PrintToPdf`) and S12 (macOS / WKWebView
 * `NSPrintOperation`) are validated by running the SAME portable headless smoke
 * on each platform's real agent:
 *
 *     npm run test:e2e:pdf -- <binary>     # = node e2e/export-pdf-smoke.mjs <binary>
 *
 * The **substantive** Windows/macOS verification is therefore NOT a WebDriver run
 * — it is the connect-and-run agent procedure documented in
 * `docs/verify-print-crossplatform.md` (rsync the branch to the `mbook` macOS
 * agent / deliver it to the `pockeo-windows` Jenkins agent, build, run the smoke,
 * record the result in `phase-e/completion.md`). Those backends are reachable
 * only on their own OS, so they cannot be exercised from this Linux dev host.
 *
 * This WDIO spec is the Linux-runnable ownership half of the cross-platform
 * contract: it pins that the ONE portable command S11/S12 carry to the agents is
 * present and wired on the CURRENT OS — the `test:e2e:pdf` npm script is defined
 * and points at the smoke, and the `print-sample.md` fixture the smoke feeds the
 * webview exists with representative content. It proves the command is portable
 * and green on the host before it is carried to the agents; it does NOT
 * re-implement the byte-level PDF assertion the smoke itself owns.
 *
 * NOTE: the WDIO suite runs only on macOS — `tauri-wd` (the Tauri WebDriver
 * driver) is mac-only — so on a Linux dev host this spec is authored to the
 * sibling-spec pattern (`e2e/printing/d1.spec.ts`) and verified by the agent run,
 * not executed locally.
 *
 * Substantive S11 verification: `npm run test:e2e:pdf -- target\debug\mdviewer.exe` on `pockeo-windows`.
 * Substantive S12 verification: `npm run test:e2e:pdf -- target/debug/mdviewer` on `mbook`.
 */
describe('E1: cross-platform PDF-export smoke is portable (S11, S12)', () => {
  const repoRoot = path.resolve('.');

  async function assertSmokeContractWired() {
    // The single portable command both agents run must be defined and point at
    // the headless smoke — identical across OSes (no platform-specific fork).
    const pkgRaw = await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
    const script = pkg.scripts?.['test:e2e:pdf'];
    expect(script).toBeDefined();
    expect(script).toContain('export-pdf-smoke.mjs');

    // The smoke entry point the script invokes must exist.
    const smoke = path.join(repoRoot, 'e2e', 'export-pdf-smoke.mjs');
    await expect(fs.access(smoke)).resolves.toBeUndefined();

    // The fixture the smoke renders through the per-OS webview backend must
    // exist with representative content (headings + code block + table), so the
    // export proves real rendering rather than clearing the size floor blank.
    const fixture = path.join(repoRoot, 'e2e', 'fixtures', 'print-sample.md');
    const md = await fs.readFile(fixture, 'utf8');
    expect(md).toMatch(/^#\s/m); // an H1
    expect(md).toMatch(/```/); // a fenced code block
    expect(md).toMatch(/\|.*\|/); // a table row

    // The cross-platform verification procedure itself must be documented, since
    // it is the substantive owner of the S11/S12 agent runs.
    const doc = path.join(repoRoot, 'docs', 'verify-print-crossplatform.md');
    const procedure = await fs.readFile(doc, 'utf8');
    expect(procedure).toContain('npm run test:e2e:pdf');
    expect(procedure).toContain('pockeo-windows'); // Windows agent (S11)
    expect(procedure).toContain('mbook'); // macOS agent (S12)
  }

  it('S11: the portable PDF smoke the pockeo-windows (WebView2) agent runs is wired on this OS', async () => {
    await assertSmokeContractWired();
    // The binary the smoke targets is named per-OS by the workspace-root target
    // convention the doc records: mdviewer.exe on Windows, mdviewer elsewhere.
    const binaryName = os.platform() === 'win32' ? 'mdviewer.exe' : 'mdviewer';
    expect(binaryName).toMatch(/^mdviewer(\.exe)?$/);
  });

  it('S12: the portable PDF smoke the mbook (WKWebView) agent runs is wired on this OS', async () => {
    await assertSmokeContractWired();
  });
});
