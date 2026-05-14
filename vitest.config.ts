import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    // B3 (regression-net Layer 2): the oracle test spawns the
    // `render-cli` Rust bin to obtain View-mode HTML. The build is
    // gated on the `MDVIEWER_BUILD_ORACLE=1` env var inside the setup
    // module so a plain `npm test` does not pay the cargo cost.
    globalSetup: ['./tests/render/oracle.globalSetup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        // Auto-generated type-only file (ts-rs). Holds only `export type`
        // declarations that compile to nothing — v8 reports 0/0 for it,
        // which would otherwise sink the global threshold.
        'src/types-generated.ts',
      ],
    },
  },
});
