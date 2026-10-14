import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    host: '127.0.0.1',
    // The project root plus the one shared chain-ID file (network-identity.ts).
    fs: { allow: ['.', '../deployments/networks.json'] },
  },
  build: { target: 'es2022', sourcemap: false },
  test: {
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'https://dex.invalid/' } },
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
  },
});
