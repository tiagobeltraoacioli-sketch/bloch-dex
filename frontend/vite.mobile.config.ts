import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'dist/mobile-hotfix',
    emptyOutDir: true,
    lib: {
      entry: 'edge/mobile-entry.ts',
      name: 'PosternMobileHandoff',
      formats: ['iife'],
      fileName: () => 'mobile-wallet.js',
    },
  },
});
