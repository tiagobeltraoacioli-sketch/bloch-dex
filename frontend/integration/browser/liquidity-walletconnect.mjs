// A deposit and a removal of liquidity signed END TO END THROUGH A WALLETCONNECT SESSION, on the merged build
// (round 20 integration, agent 411): agent 410's mobile-wallet connection and agent 411's liquidity screens.
//
//   node frontend/integration/browser/liquidity-walletconnect.mjs <harness.json>
//
// <harness.json> is the stage of walletconnect-rehearsal.mjs (`--stage 1` keeps it up): held loopback forks with
// the DEX deployed and a pool opened, a "not for publication" build of the multichain site on loopback. One real
// browser engine (headless) with NO injected wallet, and the SCRIPTED WALLET of multichain-walletconnect.mjs: a
// WalletConnect sign-client in this process holding a throwaway key, reached through the real relay. The page is
// connected FROM THE POOLS SCREEN (the connect slot there), by scanning the QR image on screen. Then, on the first
// chain of the harness: approve of the exact token amount, the deposit, the position, approve of exactly the pool
// shares, the removal of everything; every transaction is a session request the scripted wallet signs and
// publishes on that chain's fork. What the page predicted is compared with what the fork did, in base units, in
// <out>/liquidity-walletconnect-evidence.json. Exit status 0 only when every assertion held.
// A scripted wallet is not a wallet app, and a fork is not the chain.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { decodeFunctionData, encodeFunctionData, parseAbi, parseUnits } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import decodeQR from 'qr/decode.js';
import { launch, openPage } from './cdp.mjs';

const require = createRequire(import.meta.url);
const wc = require('@walletconnect/sign-client');
const SignClient = wc.SignClient ?? wc.default;

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const loopback = (url) => /^http:\/\/127\.0\.0\.1:\d+(\/|$)/.test(url);
for (const url of [config.page, ...config.chains.flatMap((c) => [c.rpc, ...c.endpoints])])
  if (!loopback(url)) throw new Error(`${url} is not a loopback URL`);
mkdirSync(config.out, { recursive: true });
const shotsDir = process.env.LIQUIDITY_SHOTS ?? null;
const chain = config.chains[0];
const ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function getPair(address,address) view returns (address)',
  'function factory() view returns (address)',
  'function swapExactBLCHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[])',
  'function addLiquidityBLCH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountBLCHMin, address to, uint256 deadline) payable',
  'function removeLiquidityBLCH(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountBLCHMin, address to, uint256 deadline)',
]);
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const say = (line) => console.log(line);
// The project id of the site's own WalletConnect configuration, as multichain-walletconnect.mjs uses it.
const PROJECT_ID = 'e263eead656b6d61ecdee75a71e100bb';
let rpcId = 0;
async function rpc(method, params = []) {
  const response = await fetch(chain.rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const body = await response.json();
  if (body.error)
    throw Object.assign(new Error(`${method}: ${body.error.message}`), { code: body.error.code });
  return body.result;
}
const call = async (to, functionName, args = []) =>
  BigInt(
    await rpc('eth_call', [
      { to, data: encodeFunctionData({ abi: ABI, functionName, args }) },
      'latest',
    ]),
  );
const mine = (n = 1) => rpc('anvil_mine', [hex(n), '0x0']);
const settle = async () => (await mine(1), await mine(0x44));
async function receiptOf(hash) {
  for (let i = 0; i < 50; i++) {
    const r = await rpc('eth_getTransactionReceipt', [hash]);
    if (r) return r;
    await delay(100);
  }
  throw new Error(`no receipt for ${hash}`);
}
const evidence = {
  schema: 'postern.frontend.liquidity-walletconnect-browser.v1',
  revision: config.revision,
  chain: chain.key,
  engine:
    'real browser engine (headless), rehearsal build of the merged multichain site, loopback anvil fork',
  wallet:
    'SCRIPTED WalletConnect wallet (a sign-client in node with a throwaway key) through the real relay; no injected wallet; not a wallet app',
  comparisons: [],
  requests: [],
  assertions: [],
};
const json = (value) =>
  JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
const check = (what, ok, detail) => {
  evidence.assertions.push({ what, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  say(
    `  ${ok ? 'ok  ' : 'FAIL'} ${what}${ok || detail === undefined ? '' : ` (${json(detail).replace(/\s+/g, ' ').slice(0, 700)})`}`,
  );
};
const row = (what, predicted, actual) => ({
  what,
  predicted: predicted.toString(),
  actual: actual.toString(),
  equal: predicted === actual,
});

// ---- the scripted wallet (the peer of multichain-walletconnect.mjs, its "exact" approval and "sign" answer) ----
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
const client = await SignClient.init({
  projectId: PROJECT_ID,
  metadata: {
    name: 'Rehearsal wallet',
    description: 'scripted wallet of a loopback rehearsal',
    url: 'http://127.0.0.1',
    icons: [],
  },
  storage: memory(),
  telemetryEnabled: false,
  logger: 'silent',
});
const wallet = { proposals: [], requests: [], sent: [], deleted: [] };
client.on('session_proposal', async ({ id, params }) => {
  const asked = params.optionalNamespaces?.eip155 ?? {};
  wallet.proposals.push({
    optional: params.optionalNamespaces,
    proposer: params.proposer.metadata,
  });
  const ids = (asked.chains ?? []).map((c) => Number(c.split(':')[1]));
  const { acknowledged } = await client.approve({
    id,
    namespaces: {
      eip155: {
        accounts: ids.map((n) => `eip155:${n}:${account.address}`),
        chains: ids.map((n) => `eip155:${n}`),
        methods: ['eth_sendTransaction'],
        events: ['accountsChanged', 'chainChanged'],
      },
    },
  });
  await acknowledged().catch(() => {});
});
client.on('session_delete', ({ topic }) => wallet.deleted.push(topic));
client.on('session_request', async ({ id, topic, params }) => {
  const entry = {
    caip: params.chainId,
    method: params.request.method,
    params: params.request.params,
  };
  wallet.requests.push(entry);
  const respond = (body) =>
    client.respond({ topic, response: { id, jsonrpc: '2.0', ...body } }).catch(() => {});
  try {
    if (params.request.method !== 'eth_sendTransaction')
      return respond({
        error: { code: 4200, message: 'the scripted wallet only signs transactions' },
      });
    const request = params.request.params[0];
    if (Number(params.chainId.split(':')[1]) !== chain.chainId)
      throw new Error('no fork of this chain');
    // As a careful wallet would: the transaction's own chainId must be the chain the request is scoped to.
    if (request.chainId === undefined || BigInt(request.chainId) !== BigInt(chain.chainId))
      throw new Error('the transaction names another chain than the request');
    if (String(request.from).toLowerCase() !== address)
      throw new Error('not this wallet’s account');
    const price = BigInt(await rpc('eth_gasPrice')) * 2n + 1_000_000_000n;
    const raw = await account.signTransaction({
      type: 'eip1559',
      chainId: chain.chainId,
      nonce: Number(BigInt(request.nonce)),
      to: request.to,
      data: request.data ?? '0x',
      value: BigInt(request.value ?? '0x0'),
      gas: BigInt(request.gas),
      maxFeePerGas: price,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
    const hash = await rpc('eth_sendRawTransaction', [raw]);
    wallet.sent.push({
      caip: params.chainId,
      hash,
      to: String(request.to).toLowerCase(),
      data: request.data,
      value: BigInt(request.value ?? '0x0'),
      gas: BigInt(request.gas),
      requestedChainId: request.chainId,
      fields: Object.keys(request).sort(),
    });
    return respond({ result: hash });
  } catch (error) {
    entry.walletError = String(error?.message ?? error);
    return respond({ error: { code: -32603, message: entry.walletError } });
  }
});

const D = `document.querySelector('dialog[open]')`;
const dialogButton = (name) =>
  `[...(${D}?.querySelectorAll('button') ?? [])].find((b) => b.textContent.replace(/\\s+/g, ' ').trim().startsWith(${JSON.stringify(name)}))`;
const T = chain.token.shown ?? chain.token.symbol;
const N = chain.native;
const VARIANTS = [
  { theme: 'light', width: 1440, height: 900, dsf: 1, mobile: false, name: 'desktop-1440-light' },
  { theme: 'dark', width: 1440, height: 900, dsf: 1, mobile: false, name: 'desktop-1440-dark' },
  { theme: 'light', width: 390, height: 844, dsf: 2, mobile: true, name: 'phone-390-light' },
  { theme: 'dark', width: 390, height: 844, dsf: 2, mobile: true, name: 'phone-390-dark' },
];

const browser = await launch(config.chrome, config.debugPort);
let unexpected = null;
try {
  const factory = `0x${(await call(chain.router, 'factory')).toString(16).padStart(40, '0')}`;
  const pair = `0x${(await call(factory, 'getPair', [chain.wrapped.address, chain.token.address])).toString(16).padStart(40, '0')}`;
  const decimals = Number(
    BigInt(await rpc('eth_call', [{ to: chain.token.address, data: '0x313ce567' }, 'latest'])),
  );
  const units = { [N]: 18, [T]: decimals };
  const literal = (name) => name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const amounts = (text) =>
    Object.fromEntries(
      [
        ...text.matchAll(
          new RegExp(`([0-9]+(?:\\.[0-9]+)?) (${literal(T)}|${literal(N)})(?![A-Za-z0-9])`, 'g'),
        ),
      ].map((m) => [m[2], parseUnits(m[1], units[m[2]])]),
    );
  await rpc('evm_setAutomine', [false]);
  await rpc('anvil_setBalance', [address, hex(50n * 10n ** 18n)]);
  // The wallet buys the token it will deposit with a call it signs itself, outside the session.
  {
    const price = BigInt(await rpc('eth_gasPrice')) * 2n + 1_000_000_000n;
    const raw = await account.signTransaction({
      type: 'eip1559',
      chainId: chain.chainId,
      nonce: 0,
      to: chain.router,
      value: 2n * 10n ** 18n,
      gas: 400_000n,
      maxFeePerGas: price,
      maxPriorityFeePerGas: 1_000_000_000n,
      data: encodeFunctionData({
        abi: ABI,
        functionName: 'swapExactBLCHForTokens',
        args: [
          1n,
          [chain.wrapped.address, chain.token.address],
          account.address,
          BigInt(Math.floor(Date.now() / 1000) + 86_400),
        ],
      }),
    });
    await rpc('eth_sendRawTransaction', [raw]);
  }
  await settle();
  const state = async () => ({
    native: BigInt(await rpc('eth_getBalance', [address, 'latest'])),
    token: await call(chain.token.address, 'balanceOf', [address]),
    shares: await call(pair, 'balanceOf', [address]),
  });

  const { browserContextId } = await browser.send('Target.createBrowserContext');
  const page = await openPage(browser, browserContextId, {
    initScript: '',
    url: 'about:blank',
    log: say,
    onBinding: () => {},
  });
  await page.cdp('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.goto(`${config.page}#/${chain.key}/pools`);
  const flat = async (selector) =>
    (
      await page.evaluate(`(document.querySelector(${JSON.stringify(selector)})?.innerText ?? '')`)
    ).replace(/\s+/g, ' ');
  const shots = async (name, tall) => {
    if (!shotsDir) return;
    mkdirSync(shotsDir, { recursive: true });
    for (const v of VARIANTS) {
      await page.cdp('Emulation.setDeviceMetricsOverride', {
        width: v.width,
        height: v.height,
        deviceScaleFactor: v.dsf,
        mobile: v.mobile,
      });
      await page.evaluate(
        `(document.documentElement.dataset.theme = ${JSON.stringify(v.theme)}, new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))`,
      );
      if (tall) {
        const need = await page.evaluate(`Math.ceil((${D}?.scrollHeight ?? 0) + 96)`);
        if (need > v.height)
          await page.cdp('Emulation.setDeviceMetricsOverride', {
            width: v.width,
            height: need,
            deviceScaleFactor: v.dsf,
            mobile: v.mobile,
          });
      } else await page.evaluate('window.scrollTo(0, 0)');
      await delay(300);
      const { cssContentSize: size } = await page.cdp('Page.getLayoutMetrics');
      const { data } = await page.cdp('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 },
      });
      writeFileSync(
        join(shotsDir, `integration-wc-${chain.key}-${name}--${v.name}.png`),
        Buffer.from(data, 'base64'),
      );
    }
    await page.cdp('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.evaluate(`void (document.documentElement.dataset.theme = 'dark')`);
  };
  const tab = async (to) => {
    await page.evaluate(
      `[...document.querySelectorAll('nav[aria-label="Screens"] a')].find((a) => a.textContent.trim() === ${JSON.stringify(to)}).click()`,
    );
    await page.waitFor(
      `screen ${to}`,
      `document.querySelector('nav[aria-label="Screens"] a[aria-current="page"]')?.textContent.trim() === ${JSON.stringify(to)}`,
    );
  };
  const dClick = async (text) => {
    await page.waitFor(
      `enabled dialog button "${text}"`,
      `(() => { const b = ${dialogButton(text)}; return !!b && !b.disabled; })()`,
      90_000,
    );
    await page.evaluate(`${dialogButton(text)}.click()`);
  };
  const dFill = async (label, value) => {
    await page.waitFor(
      `dialog field "${label}"`,
      `!![...(${D}?.querySelectorAll('label') ?? [])].find((l) => l.textContent.trim().startsWith(${JSON.stringify(label)}))`,
    );
    await page.evaluate(
      `(() => { const l = [...${D}.querySelectorAll('label')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)})); window.__h.set(l.querySelector('input'), ${JSON.stringify(value)}); })()`,
    );
    await delay(250);
  };
  const fieldValue = (label) =>
    page.evaluate(
      `(() => { const l = [...${D}.querySelectorAll('label')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)})); return l.querySelector('input').value; })()`,
    );
  const figures = () =>
    page.evaluate(
      `(() => { const out = {}; const dl = ${D}?.querySelector('dl.live-figures'); if (!dl) return out; let key = null; for (const el of dl.children) { if (el.tagName === 'DT') key = el.textContent.trim(); else if (key) out[key] = el.textContent.replace(/\\s+/g, ' ').trim(); } return out; })()`,
    );
  const noteText = () => flat('dialog[open] [data-testid="liquidity-note"]');
  const waitTracked = (pattern) =>
    page.waitFor(
      `tracked ${pattern}`,
      `(${pattern}).test((document.querySelector('dialog[open] .live-tracked')?.innerText ?? '').replace(/\\s+/g, ' '))`,
      120_000,
    );
  /** Presses a dialog button until the scripted wallet has signed and published the request it brings. */
  const press = async (text) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const before = wallet.sent.length;
      await dClick(text);
      for (let w = 0; w < 600 && wallet.sent.length === before; w++) {
        await delay(100);
        if (w > 5 && /nothing was sent/i.test(await noteText())) break;
      }
      if (wallet.sent.length > before) return wallet.sent.at(-1);
      const note = await noteText();
      if (!/read a newer .* block while the request was being prepared/.test(note))
        throw new Error(
          `the scripted wallet received no "${text}": ${note} ${json(wallet.requests.at(-1) ?? null).slice(0, 300)}`,
        );
      await delay(2500);
    }
    throw new Error(`the scripted wallet received no "${text}"`);
  };
  const approveUntil = async (action) => {
    const made = [];
    for (let i = 0; i < 4; i++) {
      await page.waitFor(
        'a dialog action',
        `(() => { const a = ${dialogButton('Approve')}; const b = ${dialogButton(action)}; return (a && !a.disabled) || (b && !b.disabled); })()`,
        120_000,
      );
      if (!(await page.evaluate(`!!${dialogButton('Approve')}`))) return made;
      const sent = await press('Approve');
      await settle();
      await waitTracked('/: mined/');
      made.push(sent);
      await delay(1500);
    }
    throw new Error('approvals did not end');
  };
  const closeDialog = () =>
    page.evaluate(`${D}?.querySelector('button[aria-label="Close dialog"]')?.click()`);

  // ---- connect from the Pools screen, by the QR code, through the relay ----
  say(`== ${chain.key}: connect a mobile wallet from the Pools screen`);
  await page.waitFor(
    'the Pools screen',
    `!!document.querySelector('[data-view="pools"] table')`,
    90_000,
  );
  const reaches = await page.evaluate(
    `(() => { const step = document.querySelector('[data-wallet-connect]'); const first = step?.querySelector('button:not(:disabled)'); return { inPools: !!step && !!document.querySelector('[data-view="pools"]')?.contains(step), first: first?.textContent.trim() ?? null, visible: !!first && first.getClientRects().length > 0 }; })()`,
  );
  check(
    'with no browser wallet, the header’s connect button reaches the mobile-wallet button on the Pools screen itself',
    reaches.inPools && reaches.visible && (reaches.first ?? '').startsWith('Connect a mobile wallet'),
    reaches,
  );
  await shots('1-pools-connect-step');
  await page.click('Connect a mobile wallet');
  await page.waitFor(
    'the QR code',
    `!!document.querySelector('.mobile-connect-code img')?.complete && document.querySelector('.mobile-connect-code img').naturalWidth > 0`,
    60_000,
  );
  const pixels = await page.evaluate(
    `(() => { const img = document.querySelector('.mobile-connect-code img'); const size = 660; const canvas = document.createElement('canvas'); canvas.width = canvas.height = size; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size); ctx.drawImage(img, 0, 0, size, size); const data = ctx.getImageData(0, 0, size, size).data; let text = ''; for (let i = 0; i < data.length; i += 0x8000) text += String.fromCharCode(...data.subarray(i, i + 0x8000)); return { size, data: btoa(text) }; })()`,
  );
  const uri = decodeQR({
    width: pixels.size,
    height: pixels.size,
    data: Uint8Array.from(Buffer.from(pixels.data, 'base64')),
  });
  await client.pair({ uri });
  await page.waitFor(
    'the connected account on the Pools screen',
    `(() => { const cell = document.querySelector('[data-view="pools"] td[data-label="Your share"]'); return !!cell && /^(0%|<0\\.0001%|[0-9.]+%)$/.test(cell.innerText.trim()); })()`,
    90_000,
  );
  check(
    'the session is connected and the Pools screen reads the wallet’s share (still on Pools; one proposal, for eth_sendTransaction only)',
    wallet.proposals.length === 1 &&
      JSON.stringify(wallet.proposals[0].optional?.eip155?.methods) === '["eth_sendTransaction"]' &&
      (await page.evaluate(
        `document.querySelector('nav[aria-label="Screens"] a[aria-current="page"]')?.textContent.trim()`,
      )) === 'Pools' &&
      !(await page.evaluate(`!!document.querySelector('dialog[open]')`)),
    wallet.proposals[0]?.optional,
  );
  await shots('2-pools-connected');

  // ---- deposit ----
  say(`== ${chain.key}: a deposit signed through the session`);
  await page.click('Add liquidity');
  await page.waitFor('the dialog', `!!${D}`);
  await dFill(`Amount of ${N}`, '0.5');
  await shots('3-dialog-add-quoted', true);
  const approvals = await approveUntil('Add liquidity');
  let predicted = await figures();
  let want = amounts(predicted['You deposit']);
  let mins = amounts(predicted['Minimum deposited'].replace(/ \([0-9.]+% slippage\)$/, ''));
  const nativeInForm = parseUnits(await fieldValue(`Amount of ${N}`), 18);
  const approve = decodeFunctionData({ abi: ABI, data: approvals[0].data });
  check(
    `the approval was a session request: one, of exactly the ${T} of the deposit, to the router`,
    approvals.length === 1 &&
      approvals[0].to === chain.token.address &&
      approve.functionName === 'approve' &&
      approve.args[0].toLowerCase() === chain.router &&
      approve.args[1] === want[T] &&
      approvals[0].caip === `eip155:${chain.chainId}`,
    { approved: approve.args[1], figure: want[T] },
  );
  let before = await state();
  let tx = await press('Add liquidity');
  const sentAt = Math.floor(Date.now() / 1000);
  await delay(800);
  await shots('4-dialog-add-waiting', true);
  await settle();
  await waitTracked('/Add liquidity.*: mined/');
  let receipt = await receiptOf(tx.hash);
  let after = await state();
  let fee = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
  let decoded = decodeFunctionData({ abi: ABI, data: tx.data });
  let rows = [
    row(`${N} deposited`, want[N], before.native - after.native - fee),
    row(`${T} deposited`, want[T], before.token - after.token),
    row(
      'pool shares received',
      parseUnits(predicted['Pool shares you receive'], 18),
      after.shares - before.shares,
    ),
    row(`minimum ${T} in the signed call`, mins[T], decoded.args[2]),
    row(`minimum ${N} in the signed call`, mins[N], decoded.args[3]),
    row(`${N} value sent (the amount in the form at the press)`, nativeInForm, tx.value),
  ];
  evidence.comparisons.push({
    step: `deposit through the session`,
    hash: tx.hash,
    status: receipt.status,
    gasUsed: Number(BigInt(receipt.gasUsed)),
    rows,
  });
  check(
    'the deposit, signed by the scripted wallet through the session, did what the page predicted, to the base unit',
    receipt.status === '0x1' &&
      decoded.functionName === 'addLiquidityBLCH' &&
      decoded.args[4].toLowerCase() === address &&
      Math.abs(Number(decoded.args[5]) - (sentAt + chain.deadlineMinutes * 60)) <= 45 &&
      tx.to === chain.router &&
      tx.gas === 400_000n &&
      tx.caip === `eip155:${chain.chainId}` &&
      rows.every((r) => r.equal),
    rows.filter((r) => !r.equal),
  );
  await shots('5-dialog-add-mined', true);
  await closeDialog();

  // ---- the position and the removal of everything ----
  say(`== ${chain.key}: the position, and a removal signed through the session`);
  await tab('Portfolio');
  await page.waitText('/Liquidity position/', 90_000);
  await delay(1500);
  const shownShares = parseUnits(
    /Pool shares ([0-9.]+)/.exec(await flat('[data-view="portfolio"]'))?.[1] ?? '0',
    18,
  );
  check(
    'Portfolio shows the shares the chain holds for the session’s account',
    shownShares === after.shares && after.shares > 0n,
    { shown: shownShares, chain: after.shares },
  );
  await shots('6-portfolio-position');
  await page.click('Remove liquidity');
  await page.waitFor('the dialog', `!!${D}`);
  await dClick('100%');
  await page.waitFor('figures', `/You receive/.test(${D}.innerText)`);
  await shots('7-dialog-remove-quoted', true);
  const shareApprovals = await approveUntil('Remove liquidity');
  predicted = await figures();
  want = amounts(predicted['You receive']);
  mins = amounts(predicted['Minimum received'].replace(/ \([0-9.]+% slippage\)$/, ''));
  const removing = parseUnits(/^([0-9.]+) of/.exec(predicted['Pool shares removed'])[1], 18);
  before = await state();
  tx = await press('Remove liquidity');
  await settle();
  await waitTracked('/Remove liquidity.*: mined/');
  receipt = await receiptOf(tx.hash);
  after = await state();
  fee = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
  decoded = decodeFunctionData({ abi: ABI, data: tx.data });
  rows = [
    row('pool shares removed', removing, before.shares - after.shares),
    row(
      'pool shares approved (exactly those)',
      removing,
      decodeFunctionData({ abi: ABI, data: shareApprovals[0].data }).args[1],
    ),
    row(`${N} received`, want[N], after.native - before.native + fee),
    row(`${T} received`, want[T], after.token - before.token),
    row(`minimum ${T} in the signed call`, mins[T], decoded.args[2]),
    row(`minimum ${N} in the signed call`, mins[N], decoded.args[3]),
  ];
  evidence.comparisons.push({
    step: 'removal of everything through the session',
    hash: tx.hash,
    status: receipt.status,
    gasUsed: Number(BigInt(receipt.gasUsed)),
    rows,
  });
  check(
    'the removal, signed through the session after one approval of exactly those shares, did what the page predicted, to the base unit',
    receipt.status === '0x1' &&
      decoded.functionName === 'removeLiquidityBLCH' &&
      shareApprovals.length === 1 &&
      shareApprovals[0].to === pair.toLowerCase() &&
      after.shares === 0n &&
      tx.value === 0n &&
      tx.caip === `eip155:${chain.chainId}` &&
      rows.every((r) => r.equal),
    rows.filter((r) => !r.equal),
  );
  await closeDialog();
  await delay(1500);
  await shots('8-portfolio-after');

  // ---- what the wallet was asked, in all ----
  evidence.requests = wallet.requests.map((r) => ({
    caip: r.caip,
    method: r.method,
    to: r.params?.[0]?.to,
    chainId: r.params?.[0]?.chainId,
    fields: Object.keys(r.params?.[0] ?? {}).sort(),
    walletError: r.walletError ?? null,
  }));
  check(
    'in the whole flow the wallet received four requests and nothing else: all eth_sendTransaction, all scoped to this chain, each naming the same chain in its transaction, none refused by the wallet',
    wallet.requests.length === 4 &&
      wallet.sent.length === 4 &&
      wallet.requests.every(
        (r) =>
          r.method === 'eth_sendTransaction' &&
          r.caip === `eip155:${chain.chainId}` &&
          BigInt(r.params[0].chainId) === BigInt(chain.chainId) &&
          !r.walletError,
      ),
    evidence.requests,
  );
  check(
    'the session was not closed by the page or the wallet during the flow',
    wallet.deleted.length === 0,
    wallet.deleted,
  );
  const consoleErrors = page.console.filter(
    (l) => /^(error|pageerror)/.test(l) && !/Failed to load resource/.test(l),
  );
  check('the page logged no error', consoleErrors.length === 0, consoleErrors.slice(0, 5));
  await page.close();
} catch (error) {
  unexpected = error;
  console.error(error);
} finally {
  await browser.close();
}
const failed = evidence.assertions.filter((a) => !a.ok).length + (unexpected ? 1 : 0);
evidence.result = failed === 0 ? 'PASS' : 'FAIL';
if (unexpected) evidence.error = String(unexpected.stack ?? unexpected);
writeFileSync(join(config.out, 'liquidity-walletconnect-evidence.json'), `${json(evidence)}\n`);
say(
  `liquidity through WalletConnect: ${evidence.result}, ${evidence.assertions.length} assertions, ${failed} failed (${join(config.out, 'liquidity-walletconnect-evidence.json')})`,
);
process.exit(failed === 0 ? 0 : 1);
