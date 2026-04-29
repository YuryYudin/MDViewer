import type { Options } from '@wdio/types';
import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const binaryName = process.platform === 'win32' ? 'mdviewer.exe' : 'mdviewer';
const binaryPath = path.resolve('src-tauri/target/debug', binaryName);

// Per-run data directory the spawned mdviewer binaries point at. Prevents
// the e2e suite from clobbering the developer's real ~/Library/.../com.mdviewer.app/.
// Pre-seeded with a settings.toml that has display_name set so the app
// boots into Workspace, not ProfileSetup (the latter is exercised by spec 02
// which deliberately resets the profile to test the first-run flow).
//
// Use a FIXED path (not mkdtemp) so the wdio launcher and per-spec workers
// see the same dataDir. wdio re-imports this config in every worker
// subprocess, and a `mkdtemp` at module-load would mint a different dir
// for each — the workers' specs would then write to dirs the launcher's
// driver never sees.
const dataDir = path.join(tmpdir(), 'mdviewer-e2e-data');
mkdirSync(dataDir, { recursive: true });
// Field types match src-tauri/src/settings.rs strictly. line_height is a
// percentage stored as u16 (100..=200), NOT a float — getting that wrong
// produces a silent parse-fail-and-fall-back-to-defaults, which manifests
// as the app booting into ProfileSetup with an empty display_name.
writeFileSync(
  path.join(dataDir, 'settings.toml'),
  [
    '[profile]',
    'user_id = "e2e-user"',
    'display_name = "E2E Tester"',
    'color = "#3366ff"',
    '',
    '[appearance]',
    'theme = "light"',
    'font_size_px = 14',
    'line_height = 150',
    'density = "comfortable"',
    '',
    '[editor]',
    'default_open_mode = "view"',
    'auto_save = false',
    'auto_save_debounce_ms = 500',
    'external_change_behavior = "ask"',
    'syntax_highlighting = true',
    'mermaid_enabled = true',
    'show_whitespace = false',
    'word_wrap = true',
    '',
    '[comments]',
    'auto_merge = "ask"',
    'reattachment_confidence = 75',
    'sidecar_pattern = "{name}.md.comments.json"',
    'show_resolved = true',
    '',
    '[advanced]',
    'verbose_logs = false',
    '',
    '[shortcuts]',
    '',
  ].join('\n'),
);

// On macOS the upstream `tauri-driver` is unsupported. We use
// `tauri-webdriver-automation` (CLI: `tauri-wd`) instead, which is a
// W3C-compliant WebDriver server that talks to the
// `tauri-plugin-webdriver-automation` plugin loaded into our debug build.
const driverBinary = 'tauri-wd';

// Expose the seeded dataDir to specs via process.env so they can find
// settings.toml (e.g. spec 02 needs to blank display_name and reload).
// This propagates through the wdio worker's env into mocha's `before`
// hooks because wdio runs each worker in the same Node process tree.
process.env.MDVIEWER_DATA_DIR = dataDir;

let driver: ChildProcess | undefined;
let vite: ChildProcess | undefined;

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${url} did not respond within ${timeoutMs}ms`);
}

async function waitForDriver(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = connect({ port, host: '127.0.0.1' });
      sock.once('connect', () => {
        sock.end();
        resolve(true);
      });
      sock.once('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${driverBinary} did not start on :${port} within ${timeoutMs}ms`);
}

export const config: Options.Testrunner = {
  runner: 'local',
  hostname: '127.0.0.1',
  port: 4444,
  framework: 'mocha',
  mochaOpts: { ui: 'bdd', timeout: 60_000 },
  specs: ['./e2e/**/*.spec.ts'],
  reporters: ['spec'],
  capabilities: [
    {
      // tauri-wd spawns the binary per session, watches its stdout for the
      // plugin's "[webdriver] listening on port N" line, and proxies W3C
      // commands to the dynamic port the plugin bound to. Don't pre-spawn
      // the app in onPrepare — that produces two instances.
      'tauri:options': { binary: binaryPath },
      browserName: 'tauri',
    } as WebdriverIO.Capabilities,
  ],

  onPrepare: async () => {
    // Tauri's debug build always tries to load `devUrl` (localhost:1420)
    // before falling back to the embedded frontend bundle. On macOS the
    // fallback never fires, so we have to start Vite ourselves before the
    // driver spawns the app. Without this the WebView loads about:blank
    // and every eval-based WebDriver call times out.
    vite = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, BROWSER: 'none' },
    });
    await waitForHttp('http://localhost:1420/', 30_000);

    driver = spawn(driverBinary, ['--port', '4444'], {
      stdio: 'inherit',
      env: {
        ...process.env,
        RUST_LOG: process.env.RUST_LOG ?? 'warn',
        // tauri-wd uses tokio::process::Command which inherits env. The
        // child mdviewer binary reads MDVIEWER_DATA_DIR to override the
        // OS default config directory (see main.rs setup hook).
        MDVIEWER_DATA_DIR: dataDir,
      },
    });
    await waitForDriver(4444, 10_000);
  },
  onComplete: () => {
    driver?.kill('SIGTERM');
    vite?.kill('SIGTERM');
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  },

  autoCompileOpts: {
    autoCompile: true,
    tsNodeOpts: { transpileOnly: true, project: 'tsconfig.json' },
  },
};
