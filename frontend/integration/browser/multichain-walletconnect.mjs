// Browser scenarios of the multichain site's mobile-wallet connection (src/multichain/walletconnect.ts) against
// loopback forks (walletconnect-rehearsal.mjs starts the forks, builds the rehearsal bundle and runs this file):
//
//   node frontend/integration/browser/multichain-walletconnect.mjs <harness.json>
//
// One real browser engine (headless) with NO injected wallet, the production build of the multichain site, and a
// SCRIPTED WALLET: a WalletConnect sign-client in this process holding a throwaway key. The page and the scripted
// wallet talk through the real relay, as a phone wallet would. The page's pairing code is read the way a phone
// reads it: the QR image on screen is decoded (desktop), or the wallet-app link is followed (phone emulation).
// For two chains: connect, swap the native coin for the listed token, approve the token, swap it back; every
// transaction is signed by the scripted wallet and checked on that chain's fork. Then the refusals: sessions the
// page must not accept, events and updates that must end a session, a rejection in the wallet, and a transaction
// hash that the wallet invents. Exit status 0 only when every assertion held.
// A scripted wallet is not a wallet app, and browser emulation is not a phone: see the report's "not proven".
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { encodeFunctionData, keccak256, parseAbi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import decodeQR from 'qr/decode.js';
import { launch, openPage } from './cdp.mjs';

const require = createRequire(import.meta.url);
const wc = require('@walletconnect/sign-client');
const SignClient = wc.SignClient ?? wc.default;

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const loopback = (url) => /^http:\/\/127\.0\.0\.1:\d+(\/|$)/.test(url);
for (const url of [config.page, config.notLivePage, ...config.chains.flatMap((c) => [c.rpc, ...c.endpoints])])
  if (!loopback(url)) throw new Error(`${url} is not a loopback URL`);
mkdirSync(config.out, { recursive: true });
mkdirSync(config.shots, { recursive: true });
const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
]);
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const say = (line) => console.log(line);
const PROJECT_ID = 'e263eead656b6d61ecdee75a71e100bb';
const METHODS = ['eth_sendTransaction'];
const EVENTS = ['accountsChanged', 'chainChanged'];
const UNSUPPORTED =
  'The wallet approved something this page cannot use (networks that were not asked for, not this page’s network, more than one account, or without the permission to send transactions). Nothing was connected.';
// What MetaMask Mobile approves whatever is asked (metamask-mobile app/core/WalletConnect/wc-config.ts
// EVM_APPROVED_METHODS; review R412-1): the scripted wallet answers the first proposal this way.
const METAMASK_METHODS = ['eth_sendTransaction', 'eth_sign', 'eth_signTransaction', 'eth_signTypedData', 'eth_signTypedData_v3', 'eth_signTypedData_v4', 'personal_sign', 'eth_sendRawTransaction', 'eth_accounts', 'eth_getBalance', 'eth_call', 'eth_estimateGas', 'eth_blockNumber', 'eth_getCode', 'eth_getTransactionCount', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getBlockByHash', 'eth_getBlockByNumber', 'net_version', 'eth_chainId', 'eth_requestAccounts', 'wallet_addEthereumChain', 'wallet_switchEthereumChain', 'wallet_getPermissions', 'wallet_requestPermissions', 'wallet_watchAsset', 'wallet_scanQRCode', 'wallet_sendCalls', 'wallet_getCallsStatus', 'wallet_getCapabilities'];
const FAILED = 'The connection was closed or could not be made. Nothing was connected.';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

let rpcId = 0;
async function rpc(chain, method, params = []) {
  const response = await fetch(chain.rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const body = await response.json();
  if (body.error) throw Object.assign(new Error(`${method}: ${body.error.message}`), { code: body.error.code });
  return body.result;
}
const call = async (chain, to, data) => BigInt(await rpc(chain, 'eth_call', [{ to, data }, 'latest']));
const tokenBalance = (chain, holder) =>
  call(chain, chain.token.address, encodeFunctionData({ abi: ERC20, functionName: 'balanceOf', args: [holder] }));
const allowance = (chain, holder) =>
  call(
    chain,
    chain.token.address,
    encodeFunctionData({ abi: ERC20, functionName: 'allowance', args: [holder, chain.router] }),
  );
/** Enough blocks for the chain's confirmation rule (a depth, or anvil's `finalized` tag 64 behind the head). */
const settle = (chain) => rpc(chain, 'anvil_mine', [hex((chain.confirmation.settle.depth ?? 65) + 2)]);
const word = (chain) => ('depth' in chain.confirmation.settle ? 'confirmed' : 'finalized');
const Word = (chain) => word(chain).replace(/^./, (c) => c.toUpperCase());
const settleLag = (chain) => chain.confirmation.settle.depth ?? 64;
const byId = new Map(config.chains.map((c) => [c.chainId, c]));

const evidence = {
  schema: 'postern.frontend.multichain-walletconnect.v1',
  revision: config.revision,
  engine:
    'real browser engine (headless) without an injected wallet, production build of the multichain site with a rehearsal bundle, loopback anvil forks',
  wallet:
    'SCRIPTED: a WalletConnect sign-client in node with a throwaway key, paired with the page through the real relay (relay.walletconnect.org); not a wallet app, not a phone',
  chains: config.chains.map((c) => ({ key: c.key, chainId: c.chainId })),
  assertions: [],
};
const check = (what, ok, detail) => {
  evidence.assertions.push({ what, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  say(
    `  ${ok ? 'ok  ' : 'FAIL'} ${what}${ok || detail === undefined ? '' : ` (${JSON.stringify(detail, (_, v) => (typeof v === 'bigint' ? v.toString() : v))?.slice(0, 900)})`}`,
  );
};

// ---- the scripted wallet ----
const memory = () => {
  const m = new Map();
  return {
    getKeys: async () => [...m.keys()],
    getEntries: async () => [...m.entries()],
    getItem: async (k) => m.get(k),
    setItem: async (k, v) => void m.set(k, structuredClone(v)),
    removeItem: async (k) => void m.delete(k),
  };
};
const account = privateKeyToAccount(generatePrivateKey());
const address = account.address.toLowerCase();
const second = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
const client = await SignClient.init({
  projectId: PROJECT_ID,
  metadata: { name: 'Rehearsal wallet', description: 'scripted wallet of a loopback rehearsal', url: 'http://127.0.0.1', icons: [] },
  storage: memory(),
  telemetryEnabled: false,
  logger: 'silent',
});
const wallet = {
  /** How the next proposal is answered. */
  approve: 'exact',
  /** How the next transaction request is answered. */
  answer: 'sign',
  proposals: [],
  requests: [],
  sent: [],
  deleted: [],
  topic: null,
};
const namespaceFor = (mode, asked) => {
  const ids = asked.map((c) => Number(c.split(':')[1]));
  const ns = (chains, methods = METHODS, accounts) => ({
    accounts: accounts ?? chains.map((id) => `eip155:${id}:${account.address}`),
    chains: chains.map((id) => `eip155:${id}`),
    methods,
    events: EVENTS,
  });
  if (mode === 'exact') return ns(ids);
  if (mode === 'metamask') return { ...ns(ids, METAMASK_METHODS), events: ['chainChanged', 'accountsChanged'] };
  if (mode === 'other-account') return ns(ids, METAMASK_METHODS, ids.map((id) => `eip155:${id}:${second}`));
  if (mode === 'extra-method') return ns(ids, [...METHODS, 'personal_sign']);
  if (mode === 'no-send') return ns(ids, METAMASK_METHODS.filter((m) => m !== 'eth_sendTransaction'));
  if (mode === 'unasked-chain') return ns([...ids, 137]);
  if (mode === 'first-chain-only') return ns([ids[0]]);
  if (mode === 'two-accounts')
    return ns(ids, METHODS, ids.map((id, i) => `eip155:${id}:${i === 0 ? account.address : second}`));
  throw new Error(`unknown approval mode ${mode}`);
};
client.on('session_proposal', async ({ id, params }) => {
  const mode = wallet.approve;
  const eip155 = params.optionalNamespaces?.eip155 ?? {};
  wallet.proposals.push({
    mode,
    required: params.requiredNamespaces,
    optional: params.optionalNamespaces,
    proposer: params.proposer.metadata,
  });
  try {
    if (mode === 'reject') {
      await client.reject({ id, reason: { code: 5000, message: 'User rejected.' } });
      return;
    }
    const { topic, acknowledged } = await client.approve({ id, namespaces: { eip155: namespaceFor(mode, eip155.chains ?? []) } });
    wallet.topic = topic;
    await acknowledged().catch(() => {});
  } catch (error) {
    wallet.proposals.at(-1).walletError = String(error?.message ?? error);
  }
});
client.on('session_delete', ({ topic }) => wallet.deleted.push(topic));
client.on('session_request', async ({ id, topic, params }) => {
  const mode = wallet.answer;
  const entry = { topic, caip: params.chainId, method: params.request.method, params: params.request.params, mode };
  wallet.requests.push(entry);
  const respond = (body) => client.respond({ topic, response: { id, jsonrpc: '2.0', ...body } }).catch(() => {});
  try {
    if (params.request.method !== 'eth_sendTransaction')
      return respond({ error: { code: 4200, message: 'the scripted wallet only signs transactions' } });
    if (mode === 'reject') return respond({ error: { code: 5000, message: 'User rejected.' } });
    // MetaMask Mobile's own sentence for a rejection, under the code it uses for everything (5000).
    if (mode === 'reject-metamask') return respond({ error: { code: 5000, message: 'MetaMask Tx Signature: User denied transaction signature.' } });
    // The same code for a failure after the user confirmed: not a rejection (review R412-2).
    if (mode === 'fail-5000') return respond({ error: { code: 5000, message: 'Failed to publish message: relay timeout' } });
    if (mode === 'invent') {
      entry.invented = keccak256(hex(Date.now()));
      return respond({ result: entry.invented });
    }
    const chain = byId.get(Number(params.chainId.split(':')[1]));
    const request = params.request.params[0];
    if (!chain) throw new Error('no fork of this chain');
    // As a careful wallet would: the request's own chainId field must be the chain the request is scoped to.
    if (request.chainId === undefined || BigInt(request.chainId) !== BigInt(chain.chainId))
      throw new Error('the transaction names another chain than the request');
    if (String(request.from).toLowerCase() !== address) throw new Error('not this wallet’s account');
    const price = BigInt(await rpc(chain, 'eth_gasPrice')) * 2n + 1_000_000_000n;
    const nonce =
      request.nonce === undefined
        ? Number(BigInt(await rpc(chain, 'eth_getTransactionCount', [address, 'pending'])))
        : Number(BigInt(request.nonce));
    const raw = await account.signTransaction({
      type: 'eip1559',
      chainId: chain.chainId,
      nonce,
      to: request.to,
      data: request.data ?? '0x',
      value: BigInt(request.value ?? '0x0'),
      gas: BigInt(request.gas ?? '0x7a120'),
      maxFeePerGas: price,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
    const hash = await rpc(chain, 'eth_sendRawTransaction', [raw]);
    wallet.sent.push({ key: chain.key, chainId: chain.chainId, caip: params.chainId, hash, to: String(request.to).toLowerCase(), data: request.data, requestedChainId: request.chainId });
    return respond({ result: hash });
  } catch (error) {
    entry.walletError = String(error?.message ?? error);
    return respond({ error: { code: -32603, message: entry.walletError } });
  }
});

const browser = await launch(config.chrome, config.debugPort);
let unexpected = null;
/** A page in its own browser context, with every request and socket it makes recorded. */
async function newPage({ phone = false } = {}) {
  const { browserContextId } = await browser.send('Target.createBrowserContext');
  const page = await openPage(browser, browserContextId, { initScript: '', url: 'about:blank', log: say, onBinding: () => {} });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  const network = { requests: [], sockets: [], blocked: [] };
  browser.onSession(sessionId, (method, params) => {
    if (method === 'Network.requestWillBeSent') network.requests.push(params.request.url);
    else if (method === 'Network.webSocketCreated') network.sockets.push(params.url);
    else if (method === 'Network.loadingFailed' && params.blockedReason) network.blocked.push(params.blockedReason);
  });
  await browser.send('Network.enable', {}, sessionId);
  if (phone) {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await page.cdp('Emulation.setUserAgentOverride', { userAgent: IPHONE, platform: 'iPhone' });
    await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  } else await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  page.network = network;
  page.remote = () => [...new Set([...network.requests, ...network.sockets].filter((u) => /^(https?|wss?):/.test(u) && !loopback(u.replace(/^ws/, 'http'))).map((u) => new URL(u).origin))];
  page.shot = async (name) => {
    const { data } = await page.cdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(config.shots, name), Buffer.from(data, 'base64'));
  };
  page.flat = async () => (await page.text()).replace(/\s+/g, ' ');
  return page;
}
const scripts = (page) => page.network.requests.filter((u) => /\.js(\?|$)/.test(u)).map((u) => u.split('/').pop());
/** The pairing URI, read as a phone camera reads it: from the pixels of the QR image on screen. */
async function scan(page) {
  await page.waitFor('the QR code', `!!document.querySelector('.mobile-connect-code img')?.complete && document.querySelector('.mobile-connect-code img').naturalWidth > 0`);
  const pixels = await page.evaluate(`(() => {
    const img = document.querySelector('.mobile-connect-code img');
    const size = 660;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    let text = '';
    for (let i = 0; i < data.length; i += 0x8000) text += String.fromCharCode(...data.subarray(i, i + 0x8000));
    return { size, data: btoa(text) };
  })()`);
  return decodeQR({ width: pixels.size, height: pixels.size, data: Uint8Array.from(Buffer.from(pixels.data, 'base64')) });
}
const select = async (page, chain) => {
  await page.evaluate(`(() => { const a = [...document.querySelectorAll('nav[aria-label="Networks"] a')].find((x) => x.textContent.trim() === ${JSON.stringify(chain.name)}); if (!a) throw new Error('no network link'); a.click(); })()`);
  await page.waitText(`/Bloch DEX on ${chain.name}/`);
  await page.waitVisibleText(`/${Word(chain)} block \\d+ is /`, 90_000);
};
const fresh = async (page, chain) => {
  const want = Number(BigInt(await rpc(chain, 'eth_blockNumber'))) - settleLag(chain);
  const shown = `(() => { const m = /${Word(chain)} block (\\d+) is /.exec(window.__h.visibleText()); return m ? Number(m[1]) : -1; })()`;
  if ((await page.evaluate(shown)) < want) {
    if (await page.button('Refresh')) await page.click('Refresh');
    await page.waitFor(`${word(chain)} block ${want}`, `${shown} >= ${want}`, 90_000);
  }
};
const quote = async (page, chain, pay, receive, amount) => {
  for (let attempt = 0; ; attempt++) {
    await fresh(page, chain);
    await page.select('You pay', pay);
    await page.select('You receive', receive);
    await page.select('You pay', pay);
    await page.fill('Amount', amount);
    await page.click('Get quote');
    try {
      await page.waitFor('quote', `!!window.__h.labelled('Quote')`, 10_000);
      return;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
};
const waitRequest = async (count, timeoutMs = 60_000) => {
  const end = Date.now() + timeoutMs;
  while (wallet.requests.length < count) {
    if (Date.now() > end) throw new Error(`the scripted wallet did not receive request ${count}`);
    await delay(200);
  }
  return wallet.requests[count - 1];
};
const waitSent = async (count, timeoutMs = 60_000) => {
  const end = Date.now() + timeoutMs;
  while (wallet.sent.length < count) {
    if (Date.now() > end) throw new Error(`the scripted wallet did not send transaction ${count}: ${JSON.stringify(wallet.requests.at(-1))?.slice(0, 400)}`);
    await delay(200);
  }
  return wallet.sent[count - 1];
};
/** Press the connect button, read the code (scan, or the phone's link), hand it to the scripted wallet. */
async function pair(page, mode, { byLink = false } = {}) {
  wallet.approve = mode;
  const proposals = wallet.proposals.length;
  await page.click('Connect a mobile wallet');
  let uri;
  if (byLink) {
    await page.waitFor('the wallet app link', `!!document.querySelector('.mobile-connect-links a')`);
    uri = await page.evaluate(`document.querySelector('.mobile-connect-links a').getAttribute('href')`);
  } else uri = await scan(page);
  await client.pair({ uri });
  const end = Date.now() + 60_000;
  while (wallet.proposals.length === proposals) {
    if (Date.now() > end) throw new Error('the scripted wallet received no proposal');
    await delay(200);
  }
  return uri;
}
const connected = (page, chain, who = address) =>
  page.waitFor('the connected wallet line', `(() => { const t = document.body.innerText.replace(/\\s+/g, ' ').toLowerCase(); return t.includes('wallet ${who} on chain ${chain.chainId}'); })()`, 60_000);
const disconnectedStep = (page) =>
  page.waitFor('the connect step', `(() => { const b = window.__h.button('Connect a mobile wallet'); return !!b && !b.disabled && !document.querySelector('dialog[open]'); })()`, 60_000);
const dialogText = (page) => page.evaluate(`(document.querySelector('dialog[open]')?.innerText ?? '').replace(/\\s+/g, ' ')`);
const refusedPairing = async (page, mode, why, expected = UNSUPPORTED) => {
  const deleted = wallet.deleted.length;
  await pair(page, mode);
  await page.waitFor(`the refusal of ${mode}`, `(document.querySelector('dialog[open] [role="alert"]')?.innerText ?? '').length > 0`, 60_000);
  const text = await dialogText(page);
  const proposal = wallet.proposals.at(-1);
  if (expected === UNSUPPORTED) {
    const end = Date.now() + 30_000;
    while (wallet.deleted.length === deleted && Date.now() < end) await delay(200);
  }
  check(
    `refused: ${why}: the page says so, connects nothing${expected === UNSUPPORTED ? ', and closes the wallet’s session' : ''}`,
    text.includes(expected) && !(await page.flat()).toLowerCase().includes(`wallet ${address} on chain`) && (expected !== UNSUPPORTED || wallet.deleted.length === deleted + 1) && !proposal.walletError,
    { text: text.slice(0, 300), deleted: wallet.deleted.length - deleted, walletError: proposal.walletError },
  );
  await page.click('Cancel');
  await disconnectedStep(page);
};

try {
  for (const chain of config.chains) {
    await rpc(chain, 'anvil_setBalance', [address, hex(5n * 10n ** 18n)]);
    await rpc(chain, 'evm_setAutomine', [true]);
    await settle(chain);
  }
  const [first, secondChain] = config.chains;
  const asked = config.chains.map((c) => `eip155:${c.chainId}`);
  const csp = readFileSync(config.headers, 'utf8').split('\n').find((l) => l.includes('Content-Security-Policy')) ?? '';
  const directive = (name) => (new RegExp(`${name} ([^;]*)`).exec(csp)?.[1] ?? '').split(' ').filter(Boolean);
  const allowedOrigins = new Set([...directive('connect-src'), ...directive('frame-src'), ...directive('img-src')]);

  // ---- A. a site where no network is live: the header answers, nothing is loaded or asked ----
  say('== not live (the committed records)');
  for (const phone of [false, true]) {
    const page = await newPage({ phone });
    await page.goto(`${config.notLivePage}#/base`);
    await page.waitText('/Bloch DEX is not active yet/');
    await page.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Connect wallet').click()`);
    const note = 'Connecting a wallet becomes available when Base is live on Bloch DEX. Nothing was asked of any wallet.';
    await page.waitFor('the header note', `document.querySelector('[data-testid="wallet-unavailable"]')?.innerText.trim() === ${JSON.stringify(note)}`);
    const region = await page.evaluate(`(() => { const el = document.querySelector('[data-testid="wallet-unavailable"]'); const box = el.getBoundingClientRect(); return { role: el.getAttribute('role'), live: el.getAttribute('aria-live'), visible: box.width > 100 && box.height > 20 && box.top >= 0 && box.bottom <= innerHeight + 1 && box.left >= 0 && box.right <= innerWidth + 1, below: box.top >= [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Connect wallet').getBoundingClientRect().bottom, describes: document.activeElement?.getAttribute('aria-describedby') === el.id || [...document.querySelectorAll('button')].some((b) => b.getAttribute('aria-describedby') === el.id) }; })()`);
    await delay(400);
    await page.shot(`not-live-header-message--${phone ? 'phone-390' : 'desktop-1440'}.png`);
    check(`not live (${phone ? 'phone width' : 'desktop'}): the header "Connect wallet" shows its note on screen, below the header's button, in a status region tied to the button`, region.role === 'status' && region.live === 'polite' && region.visible && region.describes && region.below, region);
    check(`not live (${phone ? 'phone width' : 'desktop'}): no connect step, no socket, no request off this origin, and the WalletConnect code was not loaded`, page.network.sockets.length === 0 && page.remote().length === 0 && !scripts(page).some((s) => /walletconnect|^dist-|^qr-/.test(s)) && !(await page.evaluate(`!!document.querySelector('[data-wallet-connect], [data-mobile-wallet]')`)), { sockets: page.network.sockets, remote: page.remote(), scripts: scripts(page) });
    await page.close();
  }

  for (const width of [390, 360]) {
    const page = await newPage({ phone: true });
    await page.cdp('Emulation.setDeviceMetricsOverride', { width, height: 780, deviceScaleFactor: 2, mobile: true });
    await page.goto(`${config.notLivePage}#/base`);
    await page.waitText('/Bloch DEX is not active yet/');
    await page.evaluate(`document.querySelector('.header-actions .popover button').click()`);
    await delay(600);
    const sheet = await page.evaluate(`(() => { const el = document.querySelector('.header-actions .popover-panel'); const b = el.getBoundingClientRect(); const s = document.querySelector('.header-actions .popover-scrim').getBoundingClientRect(); const rows = [...el.querySelectorAll('a')]; return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), viewport: [innerWidth, innerHeight], rows: rows.length, onScreen: rows.filter((a) => { const r = a.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; }).length, scrim: [Math.round(s.top), Math.round(s.bottom)] }; })()`);
    // Restated in round 20 (agent 415): seven networks, the six public chains and the Bloch L2.
    check(`phone width ${width}: the header's network list is a sheet at the bottom of the screen with all seven networks on screen, over a scrim that covers the screen`, sheet.top >= 0 && Math.abs(sheet.bottom - sheet.viewport[1]) <= 1 && sheet.left === 0 && sheet.right === sheet.viewport[0] && sheet.rows === 7 && sheet.onScreen === 7 && sheet.scrim[0] === 0 && sheet.scrim[1] >= sheet.viewport[1], sheet);
    // Choosing a network from the sheet works: it is reachable, not only drawn.
    await page.evaluate(`[...document.querySelectorAll('.header-actions .popover-panel a')].find((a) => a.textContent.includes('Linea')).click()`);
    await page.waitText('/Bloch DEX on Linea/');
    check(`phone width ${width}: a network chosen from the sheet opens its page`, true);
    await page.close();
  }

  // ---- B. the live rehearsal build, desktop, no injected wallet ----
  say(`== ${first.key}: connect by QR code`);
  const page = await newPage();
  await page.goto(`${config.page}#/${first.key}`);
  await page.waitVisibleText(`/${Word(first)} block \\d+ is /`, 90_000);
  await disconnectedStep(page);
  const before = await page.visibleText();
  check('without an injected wallet the connect step says so and offers the mobile wallet', before.includes('No browser wallet found.') && before.includes('Connect a mobile wallet') && before.includes('QR code or wallet app · WalletConnect'));
  check('before the press: no socket, no request off loopback, and the WalletConnect code is not loaded', page.network.sockets.length === 0 && page.remote().length === 0 && !scripts(page).some((s) => /walletconnect|^dist-|^qr-/.test(s)), { sockets: page.network.sockets, remote: page.remote(), scripts: scripts(page) });
  await page.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Connect wallet').click()`);
  check('the header "Connect wallet" goes to the connect step: focus is on the mobile-wallet button, and no note is shown', await page.evaluate(`document.activeElement?.hasAttribute('data-mobile-wallet') === true && document.querySelector('[data-testid="wallet-unavailable"]').innerText.trim() === ''`));

  const uri = await pair(page, 'metamask');
  await page.shot('desktop-qr-dialog--1440.png');
  const shownDialog = await dialogText(page);
  check('the code on screen decodes to a WalletConnect v2 pairing URI', /^wc:[0-9a-f]{64}@2\?/.test(uri) && uri.includes('symKey='), uri.replace(/symKey=[0-9a-f]+/, 'symKey=…'));
  check('the dialog says what the wallet is asked for, on which networks', shownDialog.includes('The wallet is asked for one thing') && config.chains.every((c) => shownDialog.includes(c.name)) && shownDialog.includes('It is not asked to sign messages'), shownDialog.slice(0, 500));
  await connected(page, first);
  const proposal = wallet.proposals.at(-1);
  check(
    'the proposal the wallet received: nothing required, eip155 only, the live chains, one method, two events',
    Object.keys(proposal.required ?? {}).length === 0 &&
      JSON.stringify(Object.keys(proposal.optional)) === '["eip155"]' &&
      JSON.stringify(proposal.optional.eip155.chains) === JSON.stringify(asked) &&
      JSON.stringify(proposal.optional.eip155.methods) === JSON.stringify(METHODS) &&
      JSON.stringify(proposal.optional.eip155.events) === JSON.stringify(EVENTS),
    proposal,
  );
  // The page passes no icon; the client library fills in the page's own favicon. Nothing from another origin.
  check('the wallet is told the site is "Bloch DEX" at the page’s own origin, with no icon from elsewhere', proposal.proposer.name === 'Bloch DEX' && proposal.proposer.url === new URL(config.page).origin && proposal.proposer.icons.every((icon) => new URL(icon).origin === new URL(config.page).origin), proposal.proposer);
  check('a wallet that approves its whole method list, as MetaMask Mobile does (31 methods, personal_sign among them), is connected', wallet.proposals.at(-1).mode === 'metamask' && !wallet.proposals.at(-1).walletError);
  check('connected: the dialog is closed, the page shows the wallet’s account on this chain, and the header shows it', !(await page.evaluate(`!!document.querySelector('dialog[open]')`)) && (await page.evaluate(`document.querySelector('.wallet-button')?.innerText ?? ''`)).toLowerCase().includes(address.slice(0, 6)));
  const remote = page.remote();
  evidence.remoteOrigins = remote;
  evidence.sockets = [...new Set(page.network.sockets.map((u) => new URL(u).origin))];
  check('every origin the page contacted off loopback is named in the Content-Security-Policy, and the only socket is the relay', remote.length > 0 && remote.every((o) => allowedOrigins.has(o)) && evidence.sockets.every((o) => o === 'wss://relay.walletconnect.org'), { remote, sockets: evidence.sockets });

  /** connect is done; per chain: swap in, approve, swap back. */
  const trade = async (chain) => {
    const record = evidence.chains.find((c) => c.key === chain.key);
    const requestsBefore = wallet.requests.length;
    let sentBefore = wallet.sent.length;
    const tokenBefore = await tokenBalance(chain, address);
    await quote(page, chain, chain.native, chain.token.shown, '0.01');
    await page.click('Swap');
    const swapIn = await waitSent(++sentBefore);
    await settle(chain);
    await page.waitText(`/Swap 0\\.01 ${chain.native} for ${chain.token.shown.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}: mined/`, 120_000);
    const got = (await tokenBalance(chain, address)) - tokenBefore;
    const receiptIn = await rpc(chain, 'eth_getTransactionReceipt', [swapIn.hash]);
    check(`${chain.key}: swap through the session: one request scoped to eip155:${chain.chainId}, to this chain's router, mined on the fork, ${chain.token.symbol} arrived, and the page shows it mined`, swapIn.caip === `eip155:${chain.chainId}` && BigInt(swapIn.requestedChainId) === BigInt(chain.chainId) && swapIn.to === chain.router && receiptIn?.status === '0x1' && got > 0n, { swapIn, status: receiptIn?.status, got });
    // Approve, then swap the token back.
    const sell = '5';
    await quote(page, chain, chain.token.shown, chain.native, sell);
    await page.click(`Approve ${sell} ${chain.token.shown}`);
    const approval = await waitSent(++sentBefore);
    await settle(chain);
    await page.waitText(`/Approve ${sell} ${chain.token.shown.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}: mined/`, 120_000);
    const allowed = await allowance(chain, address);
    check(`${chain.key}: approve through the session: an approve call to the token for exactly the quoted amount, mined, and the page shows it mined`, approval.to === chain.token.address && approval.data.startsWith('0x095ea7b3') && approval.caip === `eip155:${chain.chainId}` && allowed > 0n && BigInt(`0x${approval.data.slice(74)}`) === allowed, { approval, allowed });
    const nativeBefore = BigInt(await rpc(chain, 'eth_getBalance', [address, 'latest']));
    await quote(page, chain, chain.token.shown, chain.native, sell);
    await page.click('Swap');
    const swapOut = await waitSent(++sentBefore);
    await settle(chain);
    await page.waitText(`/Swap ${sell} ${chain.token.shown.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} for ${chain.native}: mined/`, 120_000);
    const receiptOut = await rpc(chain, 'eth_getTransactionReceipt', [swapOut.hash]);
    const nativeAfter = BigInt(await rpc(chain, 'eth_getBalance', [address, 'latest']));
    check(`${chain.key}: swap of the approved token: mined on the fork to this chain's router, the allowance was spent and the native coin arrived`, swapOut.to === chain.router && receiptOut?.status === '0x1' && (await allowance(chain, address)) === 0n && nativeAfter + BigInt(receiptOut.gasUsed) * BigInt(receiptOut.effectiveGasPrice) > nativeBefore, { swapOut, status: receiptOut?.status });
    const these = wallet.requests.slice(requestsBefore);
    check(`${chain.key}: the wallet was asked three things, all eth_sendTransaction on eip155:${chain.chainId}`, these.length === 3 && these.every((r) => r.method === 'eth_sendTransaction' && r.caip === `eip155:${chain.chainId}` && !r.walletError), these.map((r) => [r.method, r.caip, r.walletError]));
    Object.assign(record, { swapIn: swapIn.hash, approve: approval.hash, swapOut: swapOut.hash });
  };
  await trade(first);

  say(`== ${secondChain.key}: the same session, another chain`);
  await select(page, secondChain);
  const other = await page.flat();
  check(`${secondChain.key}: the session is kept across pages, and the page says the wallet will be asked to switch`, other.toLowerCase().includes(`wallet ${address} on chain ${first.chainId}`) && other.includes(`(it will be asked to switch to chain ${secondChain.chainId})`), /Wallet 0x.{0,120}/.exec(other)?.[0]);
  await trade(secondChain);
  check(`${secondChain.key}: after the route's own switch the page shows the wallet on chain ${secondChain.chainId}`, (await page.flat()).toLowerCase().includes(`wallet ${address} on chain ${secondChain.chainId}`));
  check('in the whole flow the wallet, which had approved 31 methods, received nothing but eth_sendTransaction: no chain switch, no read, no message to sign', wallet.requests.length === 6 && wallet.requests.every((r) => r.method === 'eth_sendTransaction'), wallet.requests.map((r) => r.method));
  check('every transaction named its chain twice, the same: the request scope and the transaction field', wallet.sent.length === 6 && wallet.sent.every((s) => s.caip === `eip155:${Number(BigInt(s.requestedChainId))}`), wallet.sent.map((s) => [s.caip, s.requestedChainId]));

  // ---- C. refusals with a session open ----
  say('== a rejection in the wallet');
  for (const [mode, words] of [['reject', 'WalletConnect’s "User rejected."'], ['reject-metamask', 'MetaMask’s "User denied transaction signature."']]) {
    wallet.answer = mode;
    const requests = wallet.requests.length;
    await quote(page, secondChain, secondChain.native, secondChain.token.shown, '0.01');
    await page.click('Swap');
    await waitRequest(requests + 1);
    await page.waitFor('the rejection', `(() => { const t = document.body.innerText.replace(/\\s+/g, ' '); return t.split('The wallet request was rejected by you. Nothing was sent.').length - 1 >= 1 && !window.__h.button('Swap')?.disabled; })()`, 60_000);
    await quote(page, secondChain, secondChain.native, secondChain.token.shown, '0.01');
    check(`a request rejected in the wallet with code 5000 and ${words} is read as a rejection: nothing was sent and Swap is not held`, (await page.button('Swap'))?.disabled === false && wallet.sent.length === 6);
    wallet.answer = 'sign';
  }
  say('== events and updates of the session');
  {
    // The wallet reports networks the session does not hold (MetaMask Mobile reports the one selected in the app).
    const deleted = wallet.deleted.length;
    await client.emit({ topic: wallet.topic, event: { name: 'chainChanged', data: '0x89' }, chainId: `eip155:${secondChain.chainId}` });
    await client.emit({ topic: wallet.topic, event: { name: 'chainChanged', data: 'somewhere' }, chainId: `eip155:${secondChain.chainId}` });
    await delay(4000);
    const still = await page.flat();
    check('a chainChanged to a chain outside the session is ignored: the session stays, the page still shows the wallet on its chain, and nothing was closed', still.toLowerCase().includes(`wallet ${address} on chain ${secondChain.chainId}`) && wallet.deleted.length === deleted && !(await page.evaluate(`!!window.__h.button('Connect a mobile wallet')`)));
    // The next transaction still names the page's chain, twice, and is signed there.
    const sentBefore = wallet.sent.length;
    await quote(page, secondChain, secondChain.native, secondChain.token.shown, '0.01');
    await page.click('Swap');
    const after = await waitSent(sentBefore + 1);
    await settle(secondChain);
    await page.waitFor('the swap after the ignored report', `[...document.querySelectorAll('li[data-state="mined"]')].some((li) => li.textContent.includes(${JSON.stringify(after.hash)}))`, 120_000);
    check('after that report the next swap is still scoped to the page’s chain and mined there', after.caip === `eip155:${secondChain.chainId}` && BigInt(after.requestedChainId) === BigInt(secondChain.chainId), after);
    // The account moves only with the namespace.
    await client.update({ topic: wallet.topic, namespaces: { eip155: namespaceFor('other-account', asked) } }).then(({ acknowledged }) => acknowledged().catch(() => {}));
    await connected(page, secondChain, second);
    check('a session update that names another account (under the approval’s rules) is followed: the page shows the new account', wallet.deleted.length === deleted);
    await client.update({ topic: wallet.topic, namespaces: { eip155: namespaceFor('metamask', asked) } }).then(({ acknowledged }) => acknowledged().catch(() => {}));
    await connected(page, secondChain, address);
    // An accountsChanged event for an account the namespace does not hold ends the session (R412-3).
    await client.emit({ topic: wallet.topic, event: { name: 'accountsChanged', data: [second] }, chainId: `eip155:${secondChain.chainId}` });
    await disconnectedStep(page);
    const end = Date.now() + 30_000;
    while (wallet.deleted.length === deleted && Date.now() < end) await delay(200);
    const gone = await page.flat();
    check('an accountsChanged event for an account the session never approved ends the session: the page is back at the connect step, never showed that account, and closed the wallet’s session', wallet.deleted.length === deleted + 1 && !gone.toLowerCase().includes(`wallet ${second}`) && !gone.toLowerCase().includes(`wallet ${address}`));
  }
  say('== sessions the page must not accept');
  await refusedPairing(page, 'no-send', 'a wallet that approves thirty methods but not eth_sendTransaction');
  await refusedPairing(page, 'unasked-chain', 'a wallet that adds a chain that was not offered (137)');
  await refusedPairing(page, 'two-accounts', 'a wallet that approves a different account per chain');
  await refusedPairing(page, 'first-chain-only', `a wallet that approves only ${first.key} on the page of ${secondChain.key}`);
  await refusedPairing(page, 'reject', 'a wallet that declines the connection', FAILED);
  say('== an update and a disconnection by the wallet');
  {
    await pair(page, 'exact');
    await connected(page, secondChain);
    check('a wallet that approves exactly what was asked (one method, two events) is connected as well', wallet.proposals.at(-1).mode === 'exact' && !wallet.proposals.at(-1).walletError);
    let deleted = wallet.deleted.length;
    await client.update({ topic: wallet.topic, namespaces: { eip155: namespaceFor('extra-method', asked) } }).then(({ acknowledged }) => acknowledged().catch(() => {}), (error) => say(`  (the wallet library refused to send the update: ${error.message})`));
    await delay(4000);
    check('a session update that adds personal_sign is accepted and changes nothing: the session stays (the method cannot be sent: unit test)', wallet.deleted.length === deleted && (await page.flat()).toLowerCase().includes(`wallet ${address} on chain ${secondChain.chainId}`));
    await client.update({ topic: wallet.topic, namespaces: { eip155: namespaceFor('unasked-chain', asked) } }).then(({ acknowledged }) => acknowledged().catch(() => {}), (error) => say(`  (the wallet library refused to send the update: ${error.message})`));
    await disconnectedStep(page);
    const end = Date.now() + 30_000;
    while (wallet.deleted.length === deleted && Date.now() < end) await delay(200);
    check('a session update that adds a chain that was not asked for (137) ends the session, closed by the page', wallet.deleted.length === deleted + 1);
    await pair(page, 'exact');
    await connected(page, secondChain);
    await client.disconnect({ topic: wallet.topic, reason: { code: 6000, message: 'User disconnected.' } });
    await disconnectedStep(page);
    check('a session ended in the wallet returns the page to the connect step', !(await page.flat()).toLowerCase().includes(`wallet ${address}`));
    // The page's own way out: the line shown while the wallet is a mobile session.
    await pair(page, 'exact');
    await connected(page, secondChain);
    const line = await page.evaluate(`(() => { const el = document.querySelector('[data-testid="mobile-session"]'); return el && window.__h.reachable(el) ? el.innerText.replace(/\\s+/g, ' ') : ''; })()`);
    deleted = wallet.deleted.length;
    await page.click('Disconnect the mobile wallet');
    await disconnectedStep(page);
    const until = Date.now() + 30_000;
    while (wallet.deleted.length === deleted && Date.now() < until) await delay(200);
    check('while connected the page says the wallet is a mobile session and where requests are confirmed; "Disconnect the mobile wallet" closes the session in the wallet too', line.includes('Connected to a mobile wallet through WalletConnect.') && line.includes('open the wallet app to confirm there') && wallet.deleted.length === deleted + 1 && !(await page.evaluate(`!!document.querySelector('[data-testid="mobile-session"]')`)), { line, deleted: wallet.deleted.length - deleted });
  }
  say('== a transaction hash the wallet invents');
  {
    await pair(page, 'exact');
    await connected(page, secondChain);
    wallet.answer = 'invent';
    const requests = wallet.requests.length;
    await quote(page, secondChain, secondChain.native, secondChain.token.shown, '0.01');
    await page.click('Swap');
    const invented = await waitRequest(requests + 1);
    await page.waitText('/Do not resend with a new nonce; Swap stays disabled until the outcome is known\\./', 60_000);
    await settle(secondChain);
    await delay(15_000);
    const text = await page.flat();
    check('a hash that is on no chain is never shown as mined: the page looked it up on its own endpoints, keeps the swap held and Swap disabled', invented.invented && !new RegExp(`Swap 0\\.01 ${secondChain.native} for [^:]{1,30}: mined`).test(text.slice(text.lastIndexOf('Do not resend'))) && text.includes('Do not resend with a new nonce') && wallet.sent.length === 7 && (await rpc(secondChain, 'eth_getTransactionReceipt', [invented.invented])) === null, { invented: invented.invented });
    wallet.answer = 'sign';
  }
  say('== code 5000 that is not a rejection');
  {
    await select(page, first);
    wallet.answer = 'fail-5000';
    const requests = wallet.requests.length;
    await quote(page, first, first.native, first.token.shown, '0.01');
    await page.click('Swap');
    await waitRequest(requests + 1);
    await page.waitText('/no transaction hash was returned/', 60_000);
    const text = await page.flat();
    await quote(page, first, first.native, first.token.shown, '0.01').catch(() => {});
    check('code 5000 with a failure text (MetaMask Mobile answers every failure so) is NOT read as a rejection: the page does not say "rejected by you", keeps the request held as outcome unknown, and Swap stays disabled', !text.slice(text.lastIndexOf('no transaction hash was returned') - 600).includes('rejected by you') && (await page.button('Swap'))?.disabled === true && wallet.sent.length === 7, { tail: text.slice(text.lastIndexOf('no transaction hash was returned') - 200, text.lastIndexOf('no transaction hash was returned') + 120) });
    wallet.answer = 'sign';
  }
  evidence.console = page.console.filter((l) => /pageerror|Content Security Policy/i.test(l)).slice(0, 10);
  check('no page error and no Content-Security-Policy refusal in the console; no request blocked by the policy', evidence.console.length === 0 && page.network.blocked.filter((b) => b === 'csp').length === 0, { console: evidence.console, blocked: page.network.blocked });
  evidence.remoteOriginsAtEnd = page.remote();
  check('at the end the page had contacted, off loopback, only origins named in the policy', evidence.remoteOriginsAtEnd.every((o) => allowedOrigins.has(o)), evidence.remoteOriginsAtEnd);
  await page.close();

  // ---- D. phone emulation: the wallet-app link ----
  say(`== phone emulation (${first.key}): the wallet-app link`);
  {
    const phone = await newPage({ phone: true });
    await phone.goto(`${config.page}#/${first.key}`);
    await phone.waitVisibleText(`/${Word(first)} block \\d+ is /`, 90_000);
    await disconnectedStep(phone);
    await phone.evaluate(`document.querySelector('[data-wallet-connect]').scrollIntoView({ block: 'center' })`);
    await delay(400);
    await phone.shot('phone-connect-step--390.png');
    const fits = await phone.evaluate(`(() => { const b = document.querySelector('[data-mobile-wallet]').getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth && b.height >= 44 && document.documentElement.scrollWidth <= innerWidth; })()`);
    check('phone width: the mobile-wallet button fits the screen, is at least 44 px tall, and the page does not scroll sideways', fits);
    const link = await pair(phone, 'exact', { byLink: true });
    const links = await phone.evaluate(`[...document.querySelectorAll('.mobile-connect-links a')].map((a) => ({ text: a.innerText.trim(), href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel') }))`);
    await phone.shot('phone-connect-dialog--390.png');
    const encoded = encodeURIComponent(link);
    check(
      'phone: the dialog offers the wc: link first, then MetaMask and Rainbow by the link hosts read in their own code, each carrying only the pairing URI, and no other host',
      /^wc:[0-9a-f]{64}@2\?/.test(link) &&
        JSON.stringify(links.map((l) => [l.text, l.href, l.target])) ===
          JSON.stringify([
            ['Open in a wallet app', link, null],
            ['MetaMask', `https://metamask.app.link/wc?uri=${encoded}`, '_blank'],
            ['Rainbow', `https://rnbwapp.com/wc?uri=${encoded}`, '_blank'],
          ]) &&
        links.every((l) => l.rel === 'noopener noreferrer'),
      links.map((l) => [l.text, l.href.slice(0, 60), l.target]),
    );
    await connected(phone, first);
    check('phone: a wallet that receives the link’s URI connects, and the page shows its account', true);
    await phone.evaluate(`document.querySelector('[data-testid="mobile-session"]')?.scrollIntoView({ block: 'start' })`);
    await delay(400);
    await phone.shot('phone-connected--390.png');
    // The header's own popover at phone width (R410-O3): a sheet at the bottom of the screen, whole. This build
    // has a banner above the header, so the page is scrolled first: the header is then at the top, as on the
    // published site, where nothing is above it.
    await phone.evaluate(`window.scrollTo(0, 400)`);
    await delay(300);
    await phone.evaluate(`document.querySelector('.header-actions .wallet-button').click()`);
    await delay(600);
    const sheet = await phone.evaluate(`(() => { const el = document.querySelector('.wallet-status .popover-panel'); if (!el) return null; const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), viewport: innerHeight, text: el.innerText.replace(/\\s+/g, ' ').slice(0, 80) }; })()`);
    check('phone: the connected-wallet popover is a sheet at the bottom of the screen, wholly on screen', !!sheet && sheet.top >= 0 && Math.abs(sheet.bottom - sheet.viewport) <= 1 && sheet.text.includes('Rehearsal wallet'), sheet);
    await phone.shot('phone-connected-wallet-popover--390.png');
    const consoleLines = phone.console.filter((l) => /pageerror|Content Security Policy/i.test(l));
    check('phone: no page error and no Content-Security-Policy refusal', consoleLines.length === 0, consoleLines);
    await phone.close();
  }
} catch (error) {
  unexpected = String(error.stack ?? error).slice(0, 1500);
  say(`unexpected error: ${unexpected}`);
} finally {
  await browser.close();
}
const failed = evidence.assertions.filter((a) => !a.ok).length + (unexpected ? 1 : 0);
evidence.unexpected = unexpected;
evidence.walletRequests = wallet.requests.map((r) => ({ method: r.method, scope: r.caip, answer: r.mode, walletError: r.walletError }));
evidence.proposals = wallet.proposals.map((p) => ({ answered: p.mode, optional: p.optional, required: p.required, proposer: p.proposer, walletError: p.walletError }));
evidence.summary = { chains: config.chains.length, assertions: evidence.assertions.length, failed, result: failed === 0 ? 'PASS' : 'FAIL' };
writeFileSync(join(config.out, 'walletconnect-result.json'), `${JSON.stringify(evidence, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
say(`multichain WalletConnect scenarios: ${evidence.summary.result}, ${config.chains.length} chains, ${evidence.assertions.length} assertions, ${failed} failed (${join(config.out, 'walletconnect-result.json')})`);
process.exit(failed === 0 ? 0 : 1);
