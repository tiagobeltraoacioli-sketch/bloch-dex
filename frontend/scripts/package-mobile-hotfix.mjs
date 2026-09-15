import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { validateRecovery } from '../edge/worker.mjs';

const directory = new URL('../dist/mobile-hotfix/', import.meta.url);
const script = await readFile(new URL('mobile-wallet.js', directory), 'utf8');
const hash = createHash('sha256').update(script).digest('hex');
const scriptPath = `/__postern/mobile-wallet-${hash.slice(0, 16)}.js`;
const adapter = await readFile(new URL('../edge/worker.mjs', import.meta.url), 'utf8');
// Optional operator-selected artifact; never take recovery configuration from a URL.
const recovery = process.env.POSTERN_RECOVERY_ARTIFACT
  ? validateRecovery(JSON.parse(await readFile(process.env.POSTERN_RECOVERY_ARTIFACT, 'utf8')))
  : null;
// Native assets are build-time inputs only; never read paths from a request.
let nativeAssets = null;
if (process.env.POSTERN_NATIVE_PAGE === '1') {
  nativeAssets = Object.create(null);
  const nativeDir = new URL('../dist/native-page/', import.meta.url);
  const html = await readFile(new URL('index.html', nativeDir));
  nativeAssets['/l1/'] = { type: 'text/html; charset=utf-8', base64: html.toString('base64') };
  const types = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', woff2: 'font/woff2' };
  for (const name of await readdir(new URL('assets/', nativeDir))) {
    const extension = name.split('.').at(-1);
    if (!/^[a-zA-Z0-9_-]+\.(js|css|woff2)$/.test(name)) throw new Error('Unexpected native asset');
    const bytes = await readFile(new URL('assets/' + name, nativeDir));
    nativeAssets['/__postern/native/assets/' + name] = { type: types[extension], base64: bytes.toString('base64') };
  }
}
await writeFile(
  new URL('worker.mjs', directory),
  `${adapter}\nexport default createMobileWalletWorker(${JSON.stringify(script)}, ${JSON.stringify(scriptPath)}, fetch, ${JSON.stringify(recovery)}, ${JSON.stringify(nativeAssets)});\n`,
);
await writeFile(
  new URL('release.json', directory),
  JSON.stringify(
    { scriptPath, scriptSha256: hash, originalDeployment: '0438e8a9-12b1-4180-885e-a68abf3f82bf', recovery,
      nativeAssets: nativeAssets ? Object.fromEntries(Object.entries(nativeAssets).map(([path, asset]) => [path, createHash('sha256').update(Buffer.from(asset.base64, 'base64')).digest('hex')])) : null },
    null,
    2,
  ) + '\n',
);
console.log(`Packaged mobile wallet adapter: ${scriptPath}`);
