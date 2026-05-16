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
        // SSH e2e fixture helpers — bulk is child_process.spawn lifecycle
        // that can't be unit-tested without testing the mock. End-to-end
        // coverage is provided by B5's WDIO suite. Matches Rust's
        // ssh_fixture.rs precedent (zero unit tests under #[cfg(unix)]
        // with the same shape).
        'e2e/helpers/sshd-fixture.ts',
        'e2e/helpers/independentSshRead.ts',
        'e2e/helpers/independentSshWrite.ts',
      ],
    },
  },
});
