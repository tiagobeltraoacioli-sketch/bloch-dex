#!/usr/bin/env node
// Rehearsal of the multichain site's mobile-wallet connection (src/multichain/walletconnect.ts) without a real
// wallet:
//
//   node frontend/integration/browser/walletconnect-rehearsal.mjs --port BASE --out DIR [--chains key,key]
//
// The same stage as scripts/multichain/rehearse-page.mjs (its steps 1 to 3, with the same tools): one held anvil
// fork per chain with the DEX deployed and a pool opened (scripts/multichain/rehearse-fork.mjs --hold), two
// stand-in endpoints in front of each fork, the page's rehearsal files from each fork's gate report, a "not for
// publication" build of the multichain site served on loopback with its own headers. Then
// multichain-walletconnect.mjs drives the page in headless Chrome with NO injected wallet, and a WalletConnect
// sign-client in node, holding a throwaway key, plays the mobile wallet through the real relay.
// A second, ordinary build (the committed records, every chain "not-deployed") is served on BASE+12 for the
// not-live header message.
//
// A chain on which the DEX is already deployed (the planned CREATE2 addresses hold code on the real chain): the fork
// rehearsal deploys, and would find nothing to send. For such a chain this script first starts its own anvil fork
// of the public endpoint (BASE+40+i), empties the three planned addresses THERE (anvil_setCode, anvil_setNonce:
// loopback only), and gives that fork to rehearse-fork.mjs as its source (--fork-url). The rehearsal then deploys
// the same bytecode to the same addresses and opens its own pool, as on a chain without the deployment.
//
// Ports: forks BASE+i, page BASE+10, DevTools BASE+11, not-live page BASE+12, endpoints BASE+20+2i and +21+2i,
// fork sources BASE+40+i.
// Everything this starts listens on loopback only and is stopped at the end. What leaves the machine: the forks'
// read requests to the chains' public endpoints, and the WalletConnect relay traffic of the page and of the
// scripted wallet (end-to-end encrypted between the two). Exit status 0 only when every assertion held.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const { loadArtifacts, loadChain, loadShared, lower, planChain } = await import(
  join(ROOT, 'scripts/multichain/lib.mjs')
);
const argv = process.argv.slice(2);
const opt = Object.fromEntries(
  argv.reduce((out, v, i, all) => (v.startsWith('--') ? [...out, [v.slice(2), all[i + 1]]] : out), []),
);
if (!opt.port || !opt.out) {
  console.error('usage: walletconnect-rehearsal.mjs --port BASE --out DIR [--chains key,key]');
  process.exit(2);
}
const base = Number(opt.port);
const out = resolve(opt.out);
const keys = (opt.chains ?? 'base,op-mainnet').split(',');
if (keys.length < 2) throw new Error('at least two chains: the session must carry more than one');
const chrome =
  process.env.CHROME_EXE ??
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].find(existsSync);
if (!chrome) {
  console.error('no browser found; set CHROME_EXE to a Chrome or Chromium binary');
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const hold = join(out, 'hold');
writeFileSync(hold, 'the forks stay up while this file exists\n');
const children = [];
const pids = [];
const started = (child, what) => {
  children.push(child);
  pids.push(`${child.pid} ${what}`);
  writeFileSync(join(out, 'pids.txt'), `${pids.join('\n')}\n`);
  return child;
};
const stop = () => {
  // Removing the hold file ends each fork rehearsal, which stops its own anvil; SIGTERM does the same.
  rmSync(hold, { force: true });
  for (const child of children) child.kill('SIGTERM');
};
process.on('SIGINT', () => (stop(), process.exit(130)));
process.on('SIGTERM', () => (stop(), process.exit(143)));
const say = (line) => console.log(line);
// rehearse-fork.mjs's own fork sources (its FORK_SOURCE table), for the chains whose first endpoint cannot be one.
const FORK_SOURCE = { 'bnb-smart-chain': 'https://bsc-mainnet.public.blastapi.io' };
async function call(url, method, params = []) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}
/** A loopback fork of the chain without the DEX's code, or null when the chain does not hold it yet. */
async function sourceWithoutDeployment(key, chain, port) {
  const plan = planChain(loadShared(), chain, loadArtifacts(), { reference: true });
  const planned = ['factory', 'router', 'lens'].map((name) => plan.contracts[name].address);
  const upstream = FORK_SOURCE[key] ?? (key === 'ethereum' ? chain.rpc[1] : chain.rpc[0]);
  const deployed = [];
  for (const a of planned)
    if ((await call(upstream, 'eth_getCode', [a, 'latest'])) !== '0x') deployed.push(a);
  if (deployed.length === 0) return null;
  const url = `http://127.0.0.1:${port}`;
  started(
    spawn('anvil', ['--fork-url', upstream, '--host', '127.0.0.1', '--port', String(port), '--silent'], {
      stdio: 'ignore',
    }),
    `fork source ${key}`,
  );
  for (let i = 0; i < 150; i++) {
    await delay(200);
    if (await call(url, 'eth_chainId').catch(() => null)) break;
  }
  for (const a of deployed) {
    await call(url, 'anvil_setCode', [a, '0x']);
    await call(url, 'anvil_setNonce', [a, '0x0']);
  }
  // One local block, so that a fork of this fork starts from a state that holds the change.
  await call(url, 'anvil_mine', ['0x1']);
  for (const a of deployed)
    if ((await call(url, 'eth_getCode', [a, 'latest'])) !== '0x')
      throw new Error(`${key}: the fork source still holds code at ${a}`);
  say(`   the DEX is already deployed on ${key}: forking from a loopback copy without it (${url})`);
  return url;
}
let status = 1;
try {
  const chains = [];
  for (const [i, key] of keys.entries()) {
    const chain = loadChain(key);
    const dir = join(out, key);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const port = base + i;
    say(`== fork of ${key} on 127.0.0.1:${port}`);
    const source = await sourceWithoutDeployment(key, chain, base + 40 + i);
    const child = started(
      spawn(
        'node',
        [
          'scripts/multichain/rehearse-fork.mjs',
          key,
          '--port',
          String(port),
          '--out',
          dir,
          '--hold',
          hold,
          ...(source ? ['--fork-url', source] : []),
        ],
        { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
      ),
      `fork rehearsal ${key}`,
    );
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    let exited = null;
    child.on('exit', (code) => (exited = code));
    const ready = join(dir, 'ready');
    for (let waited = 0; !existsSync(ready) && exited === null && waited < 1200; waited++)
      await delay(1000);
    writeFileSync(join(dir, 'fork.log'), log);
    if (!existsSync(ready) || readFileSync(ready, 'utf8').trim() !== 'PASS')
      throw new Error(
        `the fork rehearsal of ${key} did not pass: ${log
          .split('\n')
          .filter((l) => /^FAIL|rror/.test(l))
          .slice(0, 3)
          .join(' | ')}`,
      );
    say('   fork rehearsal PASS');
    const report = JSON.parse(readFileSync(join(dir, 'gate-report.json'), 'utf8'));
    chains.push({
      key,
      name: chain.chain.name,
      chainId: chain.chain.chainId,
      rpc: `http://127.0.0.1:${port}`,
      endpoints: [0, 1].map((n) => `http://127.0.0.1:${base + 20 + 2 * i + n}`),
      native: chain.nativeCurrency.symbol,
      wrapped: { address: lower(chain.wrappedNative.address), symbol: chain.wrappedNative.symbol },
      token: {
        address: lower(chain.tokens[0].address),
        symbol: chain.tokens[0].symbol,
        shown: chain.tokens[0].label ?? chain.tokens[0].symbol,
      },
      router: lower(report.plan.contracts.router.address),
      confirmation: { settle: chain.confirmation.settle },
    });
  }
  const files = join(out, 'files');
  const bundle = [];
  for (const chain of chains) {
    const made = spawnSync(
      'node',
      [
        'scripts/multichain/frontend-files.mjs',
        chain.key,
        '--gate-report',
        join(out, chain.key, 'gate-report.json'),
        '--out',
        files,
        '--rpc',
        chain.rpc,
        '--rehearsal',
      ],
      { cwd: ROOT, encoding: 'utf8' },
    );
    if (made.status !== 0) throw new Error(`frontend-files.mjs ${chain.key}: ${made.stderr}`);
    const network = JSON.parse(readFileSync(join(files, chain.key, 'frontend.network.json'), 'utf8'));
    for (const endpoint of chain.endpoints)
      started(
        spawn('node', ['scripts/multichain/endpoint-proxy.mjs', new URL(endpoint).port, chain.rpc], {
          cwd: ROOT,
          stdio: 'ignore',
        }),
        `endpoint ${endpoint}`,
      );
    network.rpc.urls = chain.endpoints;
    bundle.push({
      network,
      record: JSON.parse(readFileSync(join(files, chain.key, 'frontend.record.json'), 'utf8')),
    });
  }
  const bundleFile = join(out, 'bundle.json');
  writeFileSync(bundleFile, `${JSON.stringify(bundle, null, 2)}\n`);
  const front = join(ROOT, 'frontend');
  const vite = ['node_modules/vite/bin/vite.js', 'build', '--config', 'vite.multichain.config.ts'];
  say('== build of the multichain site with the rehearsal bundle');
  const dist = join(out, 'dist');
  const build = spawnSync('node', vite, {
    cwd: front,
    encoding: 'utf8',
    env: { ...process.env, POSTERN_MULTICHAIN_BUNDLE: bundleFile, POSTERN_MULTICHAIN_OUT: dist },
  });
  if (build.status !== 0)
    throw new Error(`the build failed: ${`${build.stdout}\n${build.stderr}`.slice(-800)}`);
  const finish = spawnSync('node', ['scripts/multichain-finish.mjs', dist, '--bundle', bundleFile], {
    cwd: front,
    encoding: 'utf8',
  });
  if (finish.status !== 0) throw new Error(`multichain-finish.mjs: ${finish.stderr}`);
  say('== ordinary build of the multichain site (committed records: no chain is live)');
  const distNotLive = join(out, 'dist-not-live');
  const { POSTERN_MULTICHAIN_BUNDLE: _rehearsalBundle, ...withoutBundle } = process.env;
  const plain = spawnSync('node', vite, {
    cwd: front,
    encoding: 'utf8',
    env: { ...withoutBundle, POSTERN_MULTICHAIN_OUT: distNotLive },
  });
  if (plain.status !== 0)
    throw new Error(`the ordinary build failed: ${`${plain.stdout}\n${plain.stderr}`.slice(-800)}`);
  const finishPlain = spawnSync('node', ['scripts/multichain-finish.mjs', distNotLive], {
    cwd: front,
    encoding: 'utf8',
  });
  if (finishPlain.status !== 0) throw new Error(`multichain-finish.mjs: ${finishPlain.stderr}`);
  started(
    spawn('node', ['scripts/staging/render/serve.mjs', dist, String(base + 10)], { cwd: ROOT, stdio: 'ignore' }),
    'page server',
  );
  started(
    spawn('node', ['scripts/staging/render/serve.mjs', distNotLive, String(base + 12)], {
      cwd: ROOT,
      stdio: 'ignore',
    }),
    'not-live page server',
  );
  await delay(800);
  let revision = 'export';
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  if (head.status === 0) revision = head.stdout.trim();
  const harness = join(out, 'harness.json');
  writeFileSync(
    harness,
    `${JSON.stringify(
      {
        page: `http://127.0.0.1:${base + 10}/`,
        notLivePage: `http://127.0.0.1:${base + 12}/`,
        headers: join(dist, '_headers'),
        chrome,
        debugPort: base + 11,
        out,
        shots: opt.shots ? resolve(opt.shots) : join(out, 'shots'),
        revision,
        chains,
      },
      null,
      2,
    )}\n`,
  );
  if (opt.stage) {
    say(`== stage only: ${harness}; remove ${hold} to stop`);
    while (existsSync(hold)) await delay(1000);
    status = 0;
  } else {
    say('== browser scenarios in headless Chrome, with a scripted WalletConnect wallet');
    const run = spawnSync('node', ['frontend/integration/browser/multichain-walletconnect.mjs', harness], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    process.stdout.write(run.stdout);
    if (run.status !== 0) process.stderr.write(run.stderr);
    writeFileSync(join(out, 'browser.log'), `${run.stdout}\n${run.stderr}`);
    status = run.status === 0 ? 0 : 1;
  }
} catch (error) {
  console.error(String(error.message ?? error));
} finally {
  stop();
}
console.log(`multichain WalletConnect rehearsal: ${status === 0 ? 'PASS' : 'FAIL'} (${out})`);
process.exit(status);
