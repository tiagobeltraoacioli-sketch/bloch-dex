// The multichain site (PosternDEX on public EVM chains other than the Bloch L2): its own entry (multichain.html)
// and its own output directory, so the Bloch L2 site (vite.config.ts) does not contain it.
//
//   node node_modules/vite/bin/vite.js build --config vite.multichain.config.ts
//   node scripts/multichain-finish.mjs
//
// (`npm run build:multichain` runs both.) POSTERN_MULTICHAIN_BUNDLE=<absolute path of a JSON file:
// [{ network, record }, …]> replaces the committed per-chain files for a local rehearsal against loopback forks;
// such a build shows a "not for publication" banner and is the only kind that accepts loopback endpoints.
// POSTERN_MULTICHAIN_OUT=<directory> replaces dist-multichain.
// The Bloch L2, the seventh network, is read from the Bloch L2 site's own two files (src/mainnet/config.ts), under
// the same aliases as in vite.config.ts and with the same two rehearsal overrides, POSTERN_MAINNET_NETWORK and
// POSTERN_MAINNET_RECORD (absolute paths; what scripts/staging and frontend/integration/browser write for the L2
// site's local render check). Either makes the build a local rehearsal build with the banner.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const env =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const here = (path: string) => decodeURIComponent(new URL(path, import.meta.url).pathname);
const bundle = env.POSTERN_MULTICHAIN_BUNDLE ?? here('./src/multichain/bundle.ts');
const mainnetNetwork =
  env.POSTERN_MAINNET_NETWORK ?? here('../deployments/mainnet/frontend.network.json');
const mainnetRecord =
  env.POSTERN_MAINNET_RECORD ?? here('../deployments/mainnet/dex-mainnet.record.json');

export default defineConfig({
  plugins: [react()],
  define: {
    __POSTERN_LOCAL_RENDER__: JSON.stringify(
      Boolean(
        env.POSTERN_MULTICHAIN_BUNDLE || env.POSTERN_MAINNET_NETWORK || env.POSTERN_MAINNET_RECORD,
      ),
    ),
  },
  base: './',
  resolve: {
    alias: {
      '@postern/multichain-bundle': bundle,
      '@postern/mainnet-network': mainnetNetwork,
      '@postern/mainnet-record': mainnetRecord,
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    outDir: env.POSTERN_MULTICHAIN_OUT ?? 'dist-multichain',
    emptyOutDir: true,
    rollupOptions: { input: here('./multichain.html') },
  },
});
