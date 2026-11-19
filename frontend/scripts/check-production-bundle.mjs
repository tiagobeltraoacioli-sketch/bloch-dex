#!/usr/bin/env node
// Release gate for a built site: node scripts/check-production-bundle.mjs <dist> [--multichain]
// --multichain: <dist> is the multichain site (npm run build:multichain); its CSP is checked against the per-chain
// network files of deployments/multichain.json instead of the Bloch L2's (review R309-UI-6), and, since the Bloch
// L2 is that site's seventh network (round 20), against the Bloch L2's two files as well: its endpoints must be in
// the policy when they make its route live and must not be while they do not, and the whole _headers file must be
// the one the committed files give. A build whose Bloch L2 route would be live is refused while
// deployments/mainnet/l2-phase.json says the L2 takes no user transaction (review R416-2).
// (ported from the bridge frontend line, e3c9d31, by frontends-sec r10; the DEX tree has no bridge-only build)
// Fails on dev RPCs, loopback endpoints, test keys, source maps, or a CSP that
// does not allow the RPCs the committed config publishes.
//
// First-party code is held to the full list. The lazily loaded wallet SDK chunks
// are held to it too, except for the exact library literals in VENDOR_LITERALS,
// which are origin checks inside that SDK and not endpoints this site contacts.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { renderHeadersFile } from '../src/mainnet/headers.ts';
import { blochL2PolicyUrls, multichainHeadersFile } from '../src/multichain/headers.ts';

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
  // Every reviewed endpoint of every chain, and nothing else that is an RPC. The Bloch L2's endpoints are part of
  // this site's policy exactly when its committed record and network file make its route live (restated in round
  // 20 from "never": the L2 is the site's seventh network; while its route cannot read, its RPC in the policy is
  // still a hit).
  const deployments = (file) =>
    JSON.parse(readFileSync(new URL(`../../deployments/${file}`, import.meta.url), 'utf8'));
  const wanted = new Set();
  for (const key of deployments('multichain.json').chains)
    for (const url of deployments(`${key}/frontend.network.json`).rpc.urls) {
      wanted.add(new URL(url).origin);
      if (!allowed.includes(new URL(url).origin))
        hits.push(['_headers', 'RPC missing from connect-src', url]);
    }
  const l2Urls = blochL2PolicyUrls(network, committed('dex-mainnet.record.json'));
  if (l2Urls.length === 0 && allowed.includes(new URL(network.rpc.url).origin))
    hits.push([
      '_headers',
      'the Bloch L2 RPC is in the multichain connect-src while its route cannot be live',
      network.rpc.url,
    ]);
  for (const url of l2Urls) {
    wanted.add(new URL(url).origin);
    if (!allowed.includes(new URL(url).origin))
      hits.push(['_headers', 'Bloch L2 endpoint missing from connect-src', url]);
  }
  // The reviewed switch of the L2 route on this site (review R416-2). The route goes live by the L2's record and
  // network file, which the L2 deployment procedure writes for the L2 site; deployments/mainnet/l2-phase.json is
  // this site's own statement of whether the L2 takes user transactions. A build in which those two files make
  // the route live while the phase file still says it takes none is refused: publishing swaps on the L2 from
  // this site takes the reviewed line that sets `userTransactions: "enabled"`. Anything but that exact word
  // keeps the gate shut. The other direction ("enabled" with a record that is not deployed) is not a hit: the
  // route is not live and only drops its first reason.
  if (l2Urls.length > 0 && committed('l2-phase.json').userTransactions !== 'enabled')
    hits.push([
      'l2-phase.json',
      'the Bloch L2 route would be live on this site while deployments/mainnet/l2-phase.json says the L2 takes no user transaction',
      `set userTransactions to "enabled" in a reviewed change, once an L2 release that accepts user transactions is the one in production (docs/MAINNET-READINESS.md, section 6)`,
    ]);
  // Nothing broader: the file is exactly the one these committed files give (the same call as
  // scripts/multichain-finish.mjs makes).
  const publicUrls = deployments('multichain.json').chains.flatMap(
    (key) => deployments(`${key}/frontend.network.json`).rpc.urls,
  );
  if (
    readFileSync(join(dist, '_headers'), 'utf8') !==
    multichainHeadersFile([...publicUrls, ...l2Urls], renderHeadersFile)
  )
    hits.push(['_headers', '_headers is not the policy the committed files give', '']);
  console.log(
    `multichain: ${wanted.size} endpoint origin(s) required in connect-src (Bloch L2: ${l2Urls.length})`,
  );
  // The files this site shares with the Bloch L2 site's public/ and that name the site: the multichain site is
  // "Bloch DEX" (scripts/multichain-finish.mjs puts the three right; review R412-7).
  const title =
    /<title>([^<]*)<\/title>/.exec(readFileSync(join(dist, '404.html'), 'utf8'))?.[1] ?? '';
  if (title !== 'Bloch DEX: no gate here') hits.push(['404.html', 'title of another site', title]);
  const notices = readFileSync(join(dist, 'THIRD-PARTY-NOTICES.txt'), 'utf8')
    .split('\n')
    .slice(0, 6)
    .join(' ');
  if (!notices.includes("This page is built from Bloch DEX's own code") || /Postern/.test(notices))
    hits.push([
      'THIRD-PARTY-NOTICES.txt',
      'first sentence names another site',
      notices.slice(0, 120),
    ]);
  const preview = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
  const rendered = JSON.parse(
    readFileSync(new URL('../multichain-public/social-preview.json', import.meta.url), 'utf8'),
  );
  if (preview(join(dist, 'social-preview.png')) !== rendered.image.sha256)
    hits.push(['social-preview.png', 'not the multichain image', '']);
} else
  for (const url of [network.rpc.url, ...network.bridges.map((b) => b.status?.ethRpcUrl)]) {
    if (url && !allowed.includes(new URL(url).origin))
      hits.push(['_headers', 'RPC missing from connect-src', url]);
  }

for (const [file, label, context] of hits)
  console.log(`HIT ${file}: ${label}: ${context.replace(/\s+/g, ' ')}`);
console.log(`${hits.length} hit(s) in ${files.length} files of ${dist}`);
process.exit(hits.length ? 1 : 0);
