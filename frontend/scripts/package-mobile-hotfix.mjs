import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
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
await writeFile(
  new URL('worker.mjs', directory),
  `${adapter}\nexport default createMobileWalletWorker(${JSON.stringify(script)}, ${JSON.stringify(scriptPath)}, fetch, ${JSON.stringify(recovery)});\n`,
);
await writeFile(
  new URL('release.json', directory),
  JSON.stringify(
    { scriptPath, scriptSha256: hash, originalDeployment: '0438e8a9-12b1-4180-885e-a68abf3f82bf', recovery },
    null,
    2,
  ) + '\n',
);
console.log(`Packaged mobile wallet adapter: ${scriptPath}`);
