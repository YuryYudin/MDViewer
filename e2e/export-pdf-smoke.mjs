#!/usr/bin/env node
// Portable headless PDF export smoke (D1, scenario S10).
//
// This is the ONE cross-platform command that exercises the per-OS `export_pdf`
// backend end-to-end without a WebDriver session. It spawns the built binary in
// headless export mode:
//
//   <binary> --export-pdf e2e/fixtures/print-sample.md <tmp>/out.pdf
//
// The headless arm (main.rs `run_headless_export`) starts its OWN single-shot
// Tauri runtime, opens a hidden window, renders the fixture, waits for the
// `mdviewer:render-complete` handshake, drives the SAME `export_pdf_inner`
// backend C1 ships, writes the PDF, and exits 0. This smoke asserts:
//
//   1. exit code 0,
//   2. the output starts with the `%PDF-` signature,
//   3. the output is comfortably above a blank-PDF size floor, AND
//   4. a page-content check — the PDF declares at least one `/Page` object and
//      a content stream (`/Contents` + a `stream` ... `endstream` whose body is
//      non-trivial). A blank or prematurely-snapshotted (empty-DOM) export
//      fails #3/#4 even when it passes the bare `%PDF-` signature.
//
// On any OS this proves that OS's webview PDF backend actually rendered the
// document. On Linux it must be run under a display (`xvfb-run -a ...`).
//
// Usage:  node e2e/export-pdf-smoke.mjs [path/to/binary]
//         (default binary: target/debug/mdviewer)

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

// The Tauri debug build ALWAYS loads `devUrl` (http://localhost:1420) before
// falling back to the embedded bundle (see wdio.conf.ts onPrepare, ~L171).
// The headless export arm spawns the SAME debug binary, so the WebView only
// renders the document if Vite is serving the frontend. We therefore start
// the Vite dev server ourselves before spawning the binary and tear it down
// (plus any straggler mdviewer) in a finally block — exactly mirroring the
// WDIO harness. Vite itself needs no display; only the binary does.
const DEV_URL = 'http://localhost:1420/';
const VITE_BOOT_TIMEOUT_MS = 120_000;

// Floor tuned to the deterministic fixture's real output. A blank single-page
// PDF from the webview backends is well under 3 KB; the rendered sample (with a
// code block + table + prose) lands comfortably above this. The floor is the
// primary "did it actually render?" guard alongside the content check.
const SIZE_FLOOR_BYTES = 3000;

// Generous wall-clock budget: the binary has to boot a Tauri runtime, paint a
// webview, and run an async print operation. The Rust side has its own 30s
// render-complete timeout; this outer guard is a backstop against a true hang.
const SPAWN_TIMEOUT_MS = 90_000;

// Module-scoped handle so `fail()` (which exits the process, bypassing any
// try/finally) can still tear Vite down before it bails.
let viteProc;

function fail(message) {
  console.error(`\n[export-pdf-smoke] FAIL: ${message}\n`);
  teardownVite(viteProc);
  process.exit(1);
}

function ok(message) {
  console.log(`[export-pdf-smoke] ${message}`);
}

const binaryArg = process.argv[2] || join('target', 'debug', 'mdviewer');
const binary = resolve(repoRoot, binaryArg);
if (!existsSync(binary)) {
  fail(`binary not found at ${binary} (build it with \`npm run build:e2e\`)`);
}

const fixture = join(repoRoot, 'e2e', 'fixtures', 'print-sample.md');
if (!existsSync(fixture)) {
  fail(`fixture not found at ${fixture}`);
}

const workDir = mkdtempSync(join(tmpdir(), 'mdviewer-pdf-smoke-'));
const outPdf = join(workDir, 'out.pdf');

ok(`binary:  ${binary}`);
ok(`fixture: ${fixture}`);
ok(`output:  ${outPdf}`);

function cleanup() {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${url} did not respond within ${timeoutMs}ms`);
}

// Start the Vite dev server and resolve once it answers on DEV_URL. Returns
// the child process so the caller can tear it down in a finally block.
async function startVite() {
  ok('starting Vite dev server (npm run dev)...');
  // `detached: true` puts `npm run dev` (and the `vite` child it spawns) in
  // their own process group, so teardown can signal the WHOLE group with
  // `kill(-pid)` — signalling just the npm wrapper would orphan the actual
  // vite server and leak the listening port.
  const vite = spawn('npm', ['run', 'dev'], {
    cwd: repoRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, BROWSER: 'none' },
    detached: true,
  });
  vite.on('error', (err) => {
    fail(`failed to start Vite: ${err.message}`);
  });
  await waitForHttp(DEV_URL, VITE_BOOT_TIMEOUT_MS);
  ok(`Vite is serving ${DEV_URL}`);
  return vite;
}

// Tear down Vite (the whole process group) and force-reap any straggler
// mdviewer binary so the smoke leaves nothing running, mirroring
// wdio.conf.ts onComplete.
function teardownVite(vite) {
  if (vite?.pid) {
    try {
      // Negative PID targets the process group, killing npm AND its vite
      // child. SIGKILL because vite ignores SIGTERM during some HMR work.
      process.kill(-vite.pid, 'SIGKILL');
    } catch {
      // Group already gone — fall back to the direct handle.
      try {
        vite.kill('SIGKILL');
      } catch {
        /* best-effort */
      }
    }
  }
  try {
    spawn('pkill', ['-9', '-f', 'target/debug/mdviewer$']).on('error', () => {});
  } catch {
    /* best-effort */
  }
}

function runExport() {
  return new Promise((resolvePromise) => {
    const child = spawn(binary, ['--export-pdf', fixture, outPdf], {
      cwd: repoRoot,
      stdio: ['ignore', 'inherit', 'inherit'],
      // Keep the detach guard from re-spawning us into the background and the
      // process never reporting its real exit code.
      env: { ...process.env, MDVIEWER_DETACHED: '1' },
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolvePromise({ timedOut: true, code: null });
    }, SPAWN_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ error: err, code: null });
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
  });
}

// Page-content check: confirm the PDF declares at least one page object AND
// carries a content stream whose body is non-trivial. We scan the raw bytes as
// latin1 so binary stream content survives the string round-trip. A blank
// export either lacks a `/Page` object, lacks a `stream`, or carries only a
// near-empty stream — all of which this rejects.
function assertHasPageContent(buf) {
  const text = buf.toString('latin1');

  if (!/\/Type\s*\/Page[^s]/.test(text) && !text.includes('/Page')) {
    fail('PDF declares no /Page object (looks blank/structureless)');
  }
  ok('content check: /Page object present');

  if (!text.includes('/Contents')) {
    fail('PDF declares no /Contents (no page content stream)');
  }
  ok('content check: /Contents present');

  // Find a content stream and confirm its payload is non-trivial. Streams are
  // delimited by `stream` ... `endstream`; the body between them carries the
  // drawing operators (often Flate-compressed). A blank page's stream is a few
  // bytes; we require a meaningful minimum so an empty paint fails.
  let maxStreamBody = 0;
  const streamRe = /stream\r?\n/g;
  let match;
  while ((match = streamRe.exec(text)) !== null) {
    const bodyStart = match.index + match[0].length;
    const end = text.indexOf('endstream', bodyStart);
    if (end === -1) continue;
    const len = end - bodyStart;
    if (len > maxStreamBody) maxStreamBody = len;
  }
  if (maxStreamBody < 200) {
    fail(
      `largest content stream is only ${maxStreamBody} bytes — looks like a ` +
        'blank/empty-DOM export',
    );
  }
  ok(`content check: largest content stream is ${maxStreamBody} bytes`);
}

async function runSmoke() {
  const result = await runExport();

  if (result.error) {
    cleanup();
    fail(`failed to spawn binary: ${result.error.message}`);
  }
  if (result.timedOut) {
    cleanup();
    fail(`export did not finish within ${SPAWN_TIMEOUT_MS} ms (hung?)`);
  }
  if (result.code !== 0) {
    cleanup();
    fail(
      `export exited with code ${result.code}` +
        (result.signal ? ` (signal ${result.signal})` : ''),
    );
  }
  ok('exit code 0');

  if (!existsSync(outPdf)) {
    cleanup();
    fail(`export reported success but no file at ${outPdf}`);
  }

  const buf = readFileSync(outPdf);
  ok(`output size: ${buf.length} bytes`);

  // 1. Signature.
  const signature = buf.subarray(0, 5).toString('latin1');
  if (signature !== '%PDF-') {
    cleanup();
    fail(`output does not start with %PDF- (got ${JSON.stringify(signature)})`);
  }
  ok('signature: %PDF- present');

  // 2. Size floor.
  if (buf.length <= SIZE_FLOOR_BYTES) {
    cleanup();
    fail(
      `output is ${buf.length} bytes, at/below the ${SIZE_FLOOR_BYTES}-byte ` +
        'floor (likely blank)',
    );
  }
  ok(`size floor: ${buf.length} > ${SIZE_FLOOR_BYTES} bytes`);

  // 3 + 4. Page-content checks.
  assertHasPageContent(buf);

  cleanup();
  console.log('\n[export-pdf-smoke] PASS: valid, content-bearing PDF\n');
}

async function main() {
  try {
    viteProc = await startVite();
    await runSmoke();
  } finally {
    teardownVite(viteProc);
  }
  process.exit(0);
}

main().catch((err) => {
  cleanup();
  fail(`unexpected error: ${err?.stack || err}`);
});
