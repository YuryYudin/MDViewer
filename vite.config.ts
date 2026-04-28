import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  publicDir: false, // no static-asset directory in v1; flip to '../public' once a real one exists
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'esnext',
    sourcemap: true,
  },
});
