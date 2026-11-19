#!/usr/bin/env node
// Release gate for a built site: node scripts/check-production-bundle.mjs <dist> [--multichain]
// --multichain: <dist> is the multichain site (npm run build:multichain); its CSP is checked against the per-chain
// network files of deployments/multichain.json instead of the Bloch L2's (review R309-UI-6).
// (ported from the bridge frontend line, e3c9d31, by frontends-sec r10; the DEX tree has no bridge-only build)
// Fails on dev RPCs, loopback endpoints, test keys, source maps, or a CSP that
// does not allow the RPCs the committed config publishes.
//
// First-party code is held to the full list. The lazily loaded wallet SDK chunks
// are held to it too, except for the exact library literals in VENDOR_LITERALS,
// which are origin checks inside that SDK and not endpoints this site contacts.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const multichain = process.argv.includes('--multichain');
const [dist] = process.argv.slice(2).filter((a) => a !== '--multichain');
if (!dist) {
  console.error('usage: check-production-bundle.mjs <dist> [--multichain]');
  process.exit(2);
}

// Keys and first addresses of the public anvil/hardhat test mnemonic.
const TEST_VALUES = [
  'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '5de4111afa1a4b94908f83103eb1f1706367c2e68ea870594951c0dd29efaa5a',
  '7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  'f39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  '70997970c51812dc3a010c7d01b50e0d17dc79c8',
];
const FORBIDDEN = [
  ['localhost', /localhost/gi],
  ['loopback', /127\.0\.0\.1|\[::1\]|0\.0\.0\.0/g],
  ['private address', /\b(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)\b/g],
  [
    'project host',
    /45\.77\.\d+\.\d+|136\.244\.93\.186|209\.250\.236\.240|80\.240\.16\.185|199\.247\.22\.8|139\.180\.\d+\.\d+|140\.82\.35\.231/g,
  ],
  ['dev proxy path', /["'`]\/(?:devnet4-rpc|mainnet-rpc|eth-rpc)\b/g],
  ['dev port', /:(?:18945|18571|18572|8545)\b/g],
  ['test mnemonic', /test test test test/g],
  ['key material name', /PRIVATE_KEY|privateKey\s*:\s*["'`]0x/g],
  ['Ethereum testnet', /sepolia|holesky|hoodi|goerli/gi],
  ['build path', /\/home\/ubuntu|\/Users\/[a-z]/g],
  ['test wallet', /render-test|Render test wallet/g],
  ['local render build', /not for publication/gi],
];
const VENDOR_LITERALS = [
  'http://localhost:*',
  'https://localhost:*',
  'http://127.0.0.1:*',
  'https://127.0.0.1:*',
  '===`localhost`',
  '===`127.0.0.1`',
  'wss?://localhost(:d{2,5})?',
  'isLocalhostUrl',
];

// The multichain site shows real pools only (round 20: its Trade, Pools and Portfolio screens are drawn over the
// chain). Nothing of the sample-data preview (src/data.ts and the screens of App.tsx) may be in its bundle: these
// are literals that exist only there.
const DEMO_DATA = [
  ['sample-data preview', /USTAV|Ustav|blch-usdc|blch-ustav|ustav-usdc|Sample market data|Sample activity|Preview only|No funds will move|Review demo swap|does not update your position|Estimated at sample pool prices/g],
];

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const hits = [];
const files = walk(dist);
const isText = (path) => /\.(js|css|html|json|svg|txt|map|webmanifest)$|_headers$/.test(path);
const firstParty = (path) => !/assets\//.test(path) || /assets\/index-/.test(path);
for (const path of files) {
  const name = basename(path);
  if (name.endsWith('.map')) hits.push([name, 'source map', '']);
  if (!isText(path)) continue;
  const raw = readFileSync(path, 'utf8');
  const text = firstParty(path)
    ? raw
    : VENDOR_LITERALS.reduce((t, literal) => t.split(literal).join(''), raw);
  const lower = text.toLowerCase();
  for (const value of TEST_VALUES)
    if (lower.includes(value)) hits.push([name, 'test key or address', value.slice(0, 12)]);
  for (const [label, pattern] of multichain ? [...FORBIDDEN, ...DEMO_DATA] : FORBIDDEN)
    for (const match of text.matchAll(pattern))
      hits.push([name, label, text.slice(Math.max(0, match.index - 40), match.index + 40)]);
}

// A published RPC must be in the CSP, or the live page cannot reach it.
const committed = (file) =>
  JSON.parse(readFileSync(new URL(`../../deployments/mainnet/${file}`, import.meta.url), 'utf8'));
const csp = readFileSync(join(dist, '_headers'), 'utf8').match(/connect-src ([^;]*)/)?.[1] ?? '';
const network = committed('frontend.network.json');
const allowed = csp.split(' ').filter(Boolean);
if (multichain) {
  // Every reviewed endpoint of every chain, and nothing else that is an RPC: the Bloch L2's endpoint is not part
  // of this site.
  const deployments = (file) =>
    JSON.parse(readFileSync(new URL(`../../deployments/${file}`, import.meta.url), 'utf8'));
  const wanted = new Set();
  for (const key of deployments('multichain.json').chains)
    for (const url of deployments(`${key}/frontend.network.json`).rpc.urls) {
      wanted.add(new URL(url).origin);
      if (!allowed.includes(new URL(url).origin))
        hits.push(['_headers', 'RPC missing from connect-src', url]);
    }
  if (allowed.includes(new URL(network.rpc.url).origin))
    hits.push(['_headers', 'the Bloch L2 RPC is in the multichain connect-src', network.rpc.url]);
  console.log(`multichain: ${wanted.size} endpoint origin(s) required in connect-src`);
} else
  for (const url of [network.rpc.url, ...network.bridges.map((b) => b.status?.ethRpcUrl)]) {
    if (url && !allowed.includes(new URL(url).origin))
      hits.push(['_headers', 'RPC missing from connect-src', url]);
  }

for (const [file, label, context] of hits)
  console.log(`HIT ${file}: ${label}: ${context.replace(/\s+/g, ' ')}`);
console.log(`${hits.length} hit(s) in ${files.length} files of ${dist}`);
process.exit(hits.length ? 1 : 0);
