#!/usr/bin/env node
// One command for the browser-engine wallet harness (see ../README.md):
//
//   SAFE_ARTIFACTS=<@safe-global/safe-contracts@1.4.1 build/artifacts> node frontend/integration/browser/run.mjs
//
// It runs scripts/staging/rehearse-mainnet-package.sh in anvil mode (throwaway keys, loopback only) with
// wallet-hook.sh as its browser phase: the whole package is deployed, the production bundle is built against that
// chain and scenarios.mjs drives the installed Chrome. Exit status 0 only when the rehearsal and every scenario
// assertion passed. Options (environment):
//   CHROME_EXE      browser binary (default: Google Chrome on macOS, else chromium/google-chrome on PATH)
//   WALLET_PORT     first of 13 consecutive loopback ports (default 28900): anvil, +1 finality shim, +10 RPC gateway,
//                   +11 static site, +12 DevTools
//   WALLET_OUT      evidence directory (default: a new temporary directory); result.json and rehearsal.log land there
//   WALLET_ONLY     comma-separated scenario names
//   WALLET_REVISION the 40-hex commit of an export without .git (default there: the committed configuration's revision)
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const fail = (message) => {
  console.error(`browser wallet harness: ${message}`);
  process.exit(2);
};
const chrome =
  process.env.CHROME_EXE ??
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync);
if (!chrome || !existsSync(chrome)) fail('no browser found; set CHROME_EXE to a Chrome or Chromium binary');
if (!existsSync(join(process.env.SAFE_ARTIFACTS ?? '', 'contracts'))) fail('SAFE_ARTIFACTS=<@safe-global/safe-contracts@1.4.1 build/artifacts> is required (docs/OPS-OPENING-KIT.md)');
if (!existsSync(join(root, 'frontend/node_modules/viem'))) fail('frontend/node_modules is missing; run `npm ci --ignore-scripts` in frontend/ first');
for (const tool of ['anvil', 'cast', 'forge']) {
  try {
    execFileSync(tool, ['--version'], { stdio: 'ignore' });
  } catch {
    fail(`${tool} is not on PATH`);
  }
}
const port = Number(process.env.WALLET_PORT ?? 28900);
if (!Number.isInteger(port) || port < 1024 || port > 65000) fail('WALLET_PORT must be a port number');
const out = resolve(process.env.WALLET_OUT ?? mkdtempSync(join(tmpdir(), 'postern-browser-wallet-')));
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'postern-browser-wallet-work-'));
// The revision is a label of the evidence and the `source.revision` of the rehearsal's configuration. In a git
// checkout it is HEAD; on a `git archive` export (no .git: review R309-2P-18) it is WALLET_REVISION when that is a
// 40-hex commit, else the revision the committed mainnet configuration names.
const revision = (() => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    const given = process.env.WALLET_REVISION ?? '';
    if (/^[0-9a-f]{40}$/.test(given)) return given;
    return JSON.parse(readFileSync(join(root, 'deployments/mainnet/dex-mainnet.config.json'), 'utf8')).source.revision;
  }
})();
if (!/^[0-9a-f]{40}$/.test(revision)) fail('no 40-hex revision: set WALLET_REVISION');
const log = openSync(join(out, 'rehearsal.log'), 'w');
console.log(`browser wallet harness: revision ${revision}, ports ${port}-${port + 12}, evidence ${out}`);
const run = spawnSync('bash', ['scripts/staging/rehearse-mainnet-package.sh', 'anvil', revision, String(port), work], {
  cwd: root,
  stdio: ['ignore', log, log],
  env: {
    ...process.env,
    CHROME_EXE: chrome,
    RENDER_HOOK: join(here, 'wallet-hook.sh'),
    WALLET_EVIDENCE: out,
    WALLET_REVISION: revision,
    // The harness uses the stand-in bridge token: the wallet flow does not depend on the bridge deployment.
    BRIDGE_REPO: '',
    HOLD_TOKEN: '',
  },
});
const text = readFileSync(join(out, 'rehearsal.log'), 'utf8');
const from = text.indexOf('== browser wallet: scenarios');
console.log(from >= 0 ? text.slice(from) : text.split('\n').slice(-30).join('\n'));
console.log(`browser wallet harness: ${run.status === 0 ? 'PASS' : 'FAIL'} (exit ${run.status}); ${join(out, 'result.json')}`);
process.exit(run.status === 0 ? 0 : 1);
