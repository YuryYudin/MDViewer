import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
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
