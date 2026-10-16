import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Devnet4 live route: the Bloch L2 settled RPC sends no CORS headers, so the
// dev and preview servers forward /devnet4-rpc to it (normally an SSH tunnel
// to the devnet4 host's 127.0.0.1:18945; see README).
const devnet4Proxy = {
  '/devnet4-rpc': {
    target:
      (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env
        .DEVNET4_RPC_TARGET ?? 'http://127.0.0.1:18945',
    changeOrigin: true,
    rewrite: () => '/',
  },
};

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    host: '127.0.0.1',
    // The project root plus the one shared chain-ID file (network-identity.ts).
    fs: { allow: ['.', '../deployments/networks.json', '../deployments/devnet4/mainnet-procedure-2pairs-20261016'] },
    proxy: devnet4Proxy,
  },
  preview: { host: '127.0.0.1', proxy: devnet4Proxy },
  build: { target: 'es2022', sourcemap: false },
  test: {
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'https://dex.invalid/' } },
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
  },
});
