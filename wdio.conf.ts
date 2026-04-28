import type { Options } from '@wdio/types';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const binaryName = process.platform === 'win32' ? 'mdviewer.exe' : 'mdviewer';
const binaryPath = path.resolve('src-tauri/target/debug', binaryName);

let driver: ChildProcess | undefined;

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
    // Wait until tauri-driver is listening on :4444.
    await new Promise(r => setTimeout(r, 1500));
  },
  onComplete: () => { driver?.kill(); },

  autoCompileOpts: {
    autoCompile: true,
    tsNodeOpts: { transpileOnly: true, project: 'tsconfig.json' },
  },
};
