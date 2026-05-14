import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  root: __dirname,
  publicDir: path.resolve(__dirname, '..', '..', 'e2e/fixtures'),
  resolve: {
    alias: {
      // Resolve the bare specifier `mermaid` to the stub at bundle time.
      // The block-widgets decoration module's dynamic import('mermaid')
      // honours this alias. Two-instance hazard: do NOT also alias
      // 'mermaid/dist/...' — leave deeper paths alone.
      mermaid: path.resolve(__dirname, 'mermaid-stub.ts'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 4174,
    strictPort: true,
  },
  preview: {
    port: 4174,
    strictPort: true,
  },
});
