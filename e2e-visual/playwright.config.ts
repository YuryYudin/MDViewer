import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  fullyParallel: false, // visual specs share a single Vite preview server
  // F1 oracle spec: build `render-cli` once before any test runs and
  // export its absolute path via MDVIEWER_RENDER_CLI. The vitest Layer
  // 2 oracle (tests/render/oracle.test.ts) stays skipped because jsdom
  // can't host CodeMirror 6 faithfully — this Playwright spec is the
  // real SC #3 gate.
  globalSetup: './oracle.globalSetup.ts',
  timeout: 4_000, // per-shot budget from success criteria
  expect: {
    // Tight tolerance: the v0.5.0 resolved-thread color regression
    // would slip past Playwright's defaults.
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.001,
      threshold: 0.02,
    },
  },
  use: {
    // Spread the Desktop Chrome device first so our explicit viewport
    // override wins. `devices['Desktop Chrome']` carries its own 1280×720
    // viewport that would otherwise clobber the success-criteria pin.
    ...devices['Desktop Chrome'],
    viewport: { width: 1024, height: 768 },
  },
  // Linux-only baselines: snapshots live under e2e-visual/baselines/linux.
  snapshotPathTemplate: '{testDir}/baselines/linux/{arg}{ext}',
  webServer: {
    command: 'npm run preview:visual',
    port: 4174,
    timeout: 5_000, // webServer-boot budget from success criteria
    reuseExistingServer: !process.env.CI,
  },
  reporter: [['list'], ['html', { outputFolder: 'test-results-html', open: 'never' }]],
});
