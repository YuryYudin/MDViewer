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
  // Force sequential execution. Each session shares the same dataDir
  // (MDVIEWER_DATA_DIR), the same Vite port (1420), and the same
  // tauri-wd port (4444); parallel workers contend on all three.
  maxInstances: 1,
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
    // Belt-and-suspenders: nuke any stragglers from prior runs before we
    // start. tauri-wd's per-session cleanup is best-effort (a panicked
    // worker can leave the spawned mdviewer alive) and accumulating
    // WebView windows confuse the user.
    try { spawn('pkill', ['-9', '-f', 'mdviewer$']).on('error', () => {}); } catch {}
    try { spawn('pkill', ['-9', '-f', 'tauri-wd']).on('error', () => {}); } catch {}

    // Tauri's debug build always tries to load `devUrl` (localhost:1420)
    // before falling back to the embedded frontend bundle. On macOS the
    // fallback never fires, so we have to start Vite ourselves before the
    // driver spawns the app. Without this the WebView loads about:blank
    // and every eval-based WebDriver call times out.
    vite = spawn('npm', ['run', 'dev'], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, BROWSER: 'none' },
    });
    // Vite startup can be slow on cold CI: `npm run dev`'s `predev` hook
    // runs `cargo run --bin export_types`, which on a fresh runner without
    // a warm rust-cache rebuilds the full mdviewer_lib dep graph. 30s
    // wasn't enough on a CI cold start; 120s gives a comfortable cushion
    // (laptops still come up in 1-2s, so the upper bound only matters on
    // slow CI).
    await waitForHttp('http://localhost:1420/', 120_000);

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
  // Per-spec hook: wait for the WebView's app shell to mount before
  // running test assertions. Without this, tests that immediately query
  // `.isExisting()` on the workspace / start / profile-setup view race
  // against the WebView's first paint on slow CI runners. Locally the
  // paint is sub-second so the race never surfaces; on macos-14 GitHub
  // runners it shows up as 4 specs failing with `Received: false` on
  // the very first assertion.
  before: async () => {
    await browser.waitUntil(
      async () => {
        try {
          const ws = await browser.$('[data-view="workspace"]').isExisting();
          const ps = await browser.$('[data-view="profile-setup"]').isExisting();
          return ws || ps;
        } catch {
          return false;
        }
      },
      { timeout: 30_000, timeoutMsg: 'app shell (workspace or profile-setup) never mounted' },
    );
  },
  // Per-spec hook: after each session ends, wdio sends DELETE /session
  // which tells tauri-wd to kill the child. That syscall is async-best-
  // effort — under load it can return before SIGKILL actually reaps the
  // mdviewer PID, which is how stale windows pile up. Force-clean here.
  afterSession: async () => {
    await new Promise<void>((resolve) => {
      const p = spawn('pkill', ['-9', '-f', 'target/debug/mdviewer$']);
      p.on('exit', () => resolve());
      p.on('error', () => resolve());
    });
  },
  onComplete: () => {
    driver?.kill('SIGTERM');
    vite?.kill('SIGTERM');
    // Final sweep — any straggler from the last spec gets killed here.
    try { spawn('pkill', ['-9', '-f', 'mdviewer$']).on('error', () => {}); } catch {}
    try { spawn('pkill', ['-9', '-f', 'tauri-wd']).on('error', () => {}); } catch {}
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  },

  autoCompileOpts: {
    autoCompile: true,
    tsNodeOpts: { transpileOnly: true, project: 'tsconfig.json' },
  },
};
