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
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const env =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const here = (path: string) => decodeURIComponent(new URL(path, import.meta.url).pathname);
const bundle = env.POSTERN_MULTICHAIN_BUNDLE ?? here('./src/multichain/bundle.ts');

export default defineConfig({
  plugins: [react()],
  define: { __POSTERN_LOCAL_RENDER__: JSON.stringify(Boolean(env.POSTERN_MULTICHAIN_BUNDLE)) },
  base: './',
  resolve: { alias: { '@postern/multichain-bundle': bundle } },
  build: {
    target: 'es2022',
    sourcemap: false,
    outDir: env.POSTERN_MULTICHAIN_OUT ?? 'dist-multichain',
    emptyOutDir: true,
    rollupOptions: { input: here('./multichain.html') },
  },
});
