import type { Options } from '@wdio/types';
import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import path from 'node:path';

const binaryName = process.platform === 'win32' ? 'mdviewer.exe' : 'mdviewer';
const binaryPath = path.resolve('src-tauri/target/debug', binaryName);

let driver: ChildProcess | undefined;

// Poll TCP :4444 until tauri-driver accepts a connection or the timeout
// elapses. Replaces a fixed-sleep wait so slower CI hosts don't flake.
async function waitForDriver(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = connect({ port, host: '127.0.0.1' });
      sock.once('connect', () => { sock.end(); resolve(true); });
      sock.once('error', () => { resolve(false); });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`tauri-driver did not start on :${port} within ${timeoutMs}ms`);
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
      // The "tauri:options" capability tells tauri-driver which binary to
      // launch for each session. tauri-driver picks the platform-correct
      // WebView driver (msedgedriver on Windows, WebKitWebDriver on Linux,
      // WKWebView automation on macOS).
      'tauri:options': { application: binaryPath },
    } as WebdriverIO.Capabilities,
  ],

  onPrepare: async () => {
    driver = spawn('tauri-driver', [], { stdio: 'inherit' });
    // Poll :4444 until tauri-driver accepts connections (or the platform
    // doesn't support it — macOS prints "not supported" and exits, in which
    // case the wait will time out and every spec fails at session-start,
    // which is the desired RED state in Phase A).
    try {
      await waitForDriver(4444, 5_000);
    } catch (err) {
      // Don't crash onPrepare itself; let session-starts fail individually
      // so the spec reporter still produces ✖ markers per spec.
      // eslint-disable-next-line no-console
      console.warn('[wdio.conf] tauri-driver readiness check failed:', err);
    }
  },
  onComplete: () => { driver?.kill(); },

  autoCompileOpts: {
    autoCompile: true,
    tsNodeOpts: { transpileOnly: true, project: 'tsconfig.json' },
  },
};
