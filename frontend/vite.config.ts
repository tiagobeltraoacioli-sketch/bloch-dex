import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const env =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const committed = (path: string) => decodeURIComponent(new URL(path, import.meta.url).pathname);

// Mainnet route inputs, bundled at build time (see src/mainnet/config.ts). The
// committed files are the default; POSTERN_MAINNET_NETWORK and
// POSTERN_MAINNET_RECORD point a local render check at a throwaway anvil
// deployment (absolute paths). A production build must use the committed files.
const mainnetNetwork =
  env.POSTERN_MAINNET_NETWORK ?? committed('../deployments/mainnet/frontend.network.json');
const mainnetRecord =
  env.POSTERN_MAINNET_RECORD ?? committed('../deployments/mainnet/dex-mainnet.record.json');

// Devnet4 live route: the Bloch L2 settled RPC sends no CORS headers, so the
// dev and preview servers forward /devnet4-rpc to it (normally an SSH tunnel
// to the devnet4 host's 127.0.0.1:18945; see README).
const devnet4Proxy = {
  // Local mainnet render check only: VITE_MAINNET_RPC_URL=/mainnet-rpc.
  '/mainnet-rpc': {
    target: env.MAINNET_RPC_TARGET ?? 'http://127.0.0.1:18571',
    changeOrigin: true,
    rewrite: () => '/',
  },
  // Local render check of the bUSDC hold status: VITE_BRIDGE_ETH_RPC_URL=/eth-rpc.
  '/eth-rpc': {
    target: env.BRIDGE_ETH_RPC_TARGET ?? 'http://127.0.0.1:18572',
    changeOrigin: true,
    rewrite: () => '/',
  },
  '/devnet4-rpc': {
    target: env.DEVNET4_RPC_TARGET ?? 'http://127.0.0.1:18945',
    changeOrigin: true,
    rewrite: () => '/',
  },
};

// Any of these makes a build a local render build: loopback RPC URLs are then
// accepted, the RPC overrides apply and the page shows a "not for publication" banner.
const RENDER_OVERRIDES = [
  'POSTERN_MAINNET_NETWORK',
  'POSTERN_MAINNET_RECORD',
  'VITE_MAINNET_RPC_URL',
  'VITE_BRIDGE_ETH_RPC_URL',
];

export default defineConfig(({ command, mode }) => ({
  plugins: [react()],
  define: {
    __POSTERN_LOCAL_RENDER__: JSON.stringify(
      command === 'serve' ||
        RENDER_OVERRIDES.some((name) => Boolean(env[name] || loadEnv(mode, '.', 'VITE_')[name])),
    ),
  },
  base: './',
  resolve: {
    alias: {
      '@postern/mainnet-network': mainnetNetwork,
      '@postern/mainnet-record': mainnetRecord,
    },
  },
  server: {
    host: '127.0.0.1',
    // The project root plus the one shared chain-ID file (network-identity.ts).
    fs: {
      allow: [
        '.',
        '../deployments/networks.json',
        '../deployments/devnet4/mainnet-procedure-2pairs-20261016',
        '../deployments/mainnet',
        mainnetNetwork,
        mainnetRecord,
      ],
    },
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
}));
