// Browser scenario of the liquidity dialog on a pair of two plain tokens (the router's `addLiquidity` and
// `removeLiquidity`, without the native entry points), against a loopback fork (round 20, agent 411, after review
// 413: these two calls had never run on a chain or a fork).
//
//   node frontend/integration/browser/liquidity-token-pair.mjs <harness.json>
//
// harness.json: { page, chrome, debugPort, out, revision, chain: { key, name, chainId, rpc, router, deadlineMinutes },
//   pair: { address, a: { address, symbol, decimals }, b: { … } },      (a is token0, b is token1)
//   funding: { router, wrapped } }      (a Uniswap V2 router of the forked chain: the wallet buys both tokens there)
// The pair exists on the fork ONLY: it is opened there by the record's first depositor (impersonated on loopback)
// for this rehearsal, and the rehearsal bundle of the page lists it. No public chain has such a pool of this DEX.
// One simulated wallet with a throwaway key. What the page predicted is compared with what the fork did, in base
// units, in <out>/liquidity-token-pair-evidence.json. Exit status 0 only when every assertion held.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { decodeFunctionData, encodeFunctionData, parseAbi, parseUnits } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { launch, openPage } from './cdp.mjs';
import { PROVIDER_SCRIPT } from './wallet.mjs';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { chain, pair, funding } = config;
for (const url of [config.page, chain.rpc])
  if (!/^http:\/\/127\.0\.0\.1:\d+(\/|$)/.test(url))
    throw new Error(`${url} is not a loopback URL`);
mkdirSync(config.out, { recursive: true });

const ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[])',
  'function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline)',
  'function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline)',
]);
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const say = (line) => console.log(line);
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
  schema: 'postern.frontend.liquidity-token-pair-browser.v1',
  revision: config.revision,
  chain: chain.key,
  pair,
  what: 'a pair of two plain tokens opened on the fork for this rehearsal only; simulated wallet with a throwaway key',
  comparisons: [],
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

const account = privateKeyToAccount(generatePrivateKey());
const address = account.address.toLowerCase();
const wallet = {
  sent: [],
  async handle(method, params) {
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address];
    if (method === 'eth_chainId') return hex(chain.chainId);
    if (method === 'wallet_switchEthereumChain') return null;
    if (method === 'eth_sendTransaction') {
      const request = params[0];
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
      this.sent.push({
        hash,
        to: String(request.to).toLowerCase(),
        data: request.data,
        value: BigInt(request.value ?? '0x0'),
        gas: BigInt(request.gas),
      });
      return hash;
    }
    throw { code: 4200, message: `the harness wallet does not implement ${method}` };
  },
};
const D = `document.querySelector('dialog[open]')`;
const dialogButton = (name) =>
  `[...(${D}?.querySelectorAll('button') ?? [])].find((b) => b.textContent.replace(/\\s+/g, ' ').trim().startsWith(${JSON.stringify(name)}))`;
const A = pair.a.symbol;
const B = pair.b.symbol;
const name = `${A}/${B}`;
const units = { [A]: pair.a.decimals, [B]: pair.b.decimals };

const browser = await launch(config.chrome, config.debugPort);
let unexpected = null;
let snapshot = null;
try {
  // As in liquidity.mjs: the fork is put back only on request (a reverted anvil fork cannot carry another run).
  if (process.env.LIQUIDITY_RESTORE === '1') snapshot = await rpc('evm_snapshot');
  await rpc('evm_setAutomine', [false]);
  await rpc('anvil_setBalance', [address, hex(50n * 10n ** 18n)]);
  const far = BigInt(Math.floor(Date.now() / 1000) + 86_400);
  // The wallet buys both tokens on a public exchange of the forked chain, with calls it signs itself.
  for (const [i, token] of [pair.a, pair.b].entries()) {
    const price = BigInt(await rpc('eth_gasPrice')) * 2n + 1_000_000_000n;
    const raw = await account.signTransaction({
      type: 'eip1559',
      chainId: chain.chainId,
      nonce: i,
      to: funding.router,
      value: 10n ** 18n,
      gas: 400_000n,
      maxFeePerGas: price,
      maxPriorityFeePerGas: 1_000_000_000n,
      data: encodeFunctionData({
        abi: ABI,
        functionName: 'swapExactETHForTokens',
        args: [1n, [funding.wrapped, token.address], account.address, far],
      }),
    });
    await rpc('eth_sendRawTransaction', [raw]);
  }
  await settle();
  const state = async () => ({
    a: await call(pair.a.address, 'balanceOf', [address]),
    b: await call(pair.b.address, 'balanceOf', [address]),
    shares: await call(pair.address, 'balanceOf', [address]),
    supply: await call(pair.address, 'totalSupply'),
    reserveA: await call(pair.a.address, 'balanceOf', [pair.address]),
    reserveB: await call(pair.b.address, 'balanceOf', [pair.address]),
  });
  const funded = await state();
  check(
    `the wallet holds both tokens before it starts (${A} and ${B})`,
    funded.a > 0n && funded.b > 0n,
    funded,
  );

  const { browserContextId } = await browser.send('Target.createBrowserContext');
  const page = await openPage(browser, browserContextId, {
    initScript: PROVIDER_SCRIPT,
    url: `${config.page}#/${chain.key}`,
    log: say,
    onBinding: (bridge, payload, from) => {
      if (bridge !== '__walletBridge') return;
      const { id, method, params } = JSON.parse(payload);
      wallet.handle(method, params).then(
        (value) =>
          from
            .evaluate(`window.__walletReply(${id}, true, ${JSON.stringify(value)})`)
            .catch(() => {}),
        (error) =>
          from
            .evaluate(
              `window.__walletReply(${id}, false, ${JSON.stringify({ code: error.code ?? -32603, message: error.message ?? String(error) })})`,
            )
            .catch(() => {}),
      );
    },
  });
  const flat = async (selector) =>
    (
      await page.evaluate(`(document.querySelector(${JSON.stringify(selector)})?.innerText ?? '')`)
    ).replace(/\s+/g, ' ');
  const tab = async (to) => {
    await page.evaluate(
      `[...document.querySelectorAll('nav[aria-label="Screens"] a')].find((a) => a.textContent.trim() === ${JSON.stringify(to)}).click()`,
    );
    await page.waitFor(
      `screen ${to}`,
      `document.querySelector('nav[aria-label="Screens"] a[aria-current="page"]')?.textContent.trim() === ${JSON.stringify(to)}`,
    );
  };
  const labelled = async (label) => {
    await page.waitFor(
      `button "${label}"`,
      `!!document.querySelector('button[aria-label=${JSON.stringify(label)}]')`,
      60_000,
    );
    await page.evaluate(
      `document.querySelector('button[aria-label=${JSON.stringify(label)}]').click()`,
    );
    await page.waitFor('the dialog', `!!${D}`);
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
  const figures = () =>
    page.evaluate(
      `(() => { const out = {}; const dl = ${D}?.querySelector('dl.live-figures'); if (!dl) return out; let key = null; for (const el of dl.children) { if (el.tagName === 'DT') key = el.textContent.trim(); else if (key) out[key] = el.textContent.replace(/\\s+/g, ' ').trim(); } return out; })()`,
    );
  const amounts = (text) =>
    Object.fromEntries(
      [...text.matchAll(new RegExp(`([0-9]+(?:\\.[0-9]+)?) (${A}|${B})(?![A-Za-z0-9])`, 'g'))].map(
        (m) => [m[2], parseUnits(m[1], units[m[2]])],
      ),
    );
  const noteText = () => flat('dialog[open] [data-testid="liquidity-note"]');
  const waitTracked = (pattern) =>
    page.waitFor(
      `tracked ${pattern}`,
      `(${pattern}).test((document.querySelector('dialog[open] .live-tracked')?.innerText ?? '').replace(/\\s+/g, ' '))`,
      90_000,
    );
  const press = async (text) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const before = wallet.sent.length;
      await dClick(text);
      for (let w = 0; w < 300 && wallet.sent.length === before; w++) {
        await delay(100);
        if (w > 5 && /nothing was sent/i.test(await noteText())) break;
      }
      if (wallet.sent.length > before) return wallet.sent.at(-1);
      const note = await noteText();
      if (!/read a newer .* block while the request was being prepared/.test(note))
        throw new Error(`the wallet received no "${text}": ${note}`);
      await delay(2500);
    }
    throw new Error(`the wallet received no "${text}"`);
  };
  const approveUntil = async (action) => {
    const made = [];
    for (let i = 0; i < 5; i++) {
      await page.waitFor(
        'a dialog action',
        `(() => { const a = ${dialogButton('Approve')}; const b = ${dialogButton(action)}; return (a && !a.disabled) || (b && !b.disabled); })()`,
        90_000,
      );
      if (!(await page.evaluate(`!!${dialogButton('Approve')}`))) return made;
      const label = await page.evaluate(`${dialogButton('Approve')}.textContent.trim()`);
      const sent = await press('Approve');
      await settle();
      await waitTracked('/: mined/');
      made.push({ label, ...sent });
      await delay(1500);
    }
    throw new Error('approvals did not end');
  };
  const closeDialog = () =>
    page.evaluate(`${D}?.querySelector('button[aria-label="Close dialog"]')?.click()`);

  await page.waitVisibleText(`/(Confirmed|Finalized) block \\d+ is /`, 60_000);
  await page.click('Connect Harness wallet');
  await page.waitFor(
    'balances',
    `!![...document.querySelectorAll('[aria-label]')].find((x) => / balances$/.test(x.getAttribute('aria-label')))`,
  );
  await tab('Pools');
  await page.waitFor(
    'the pair row',
    `!!document.querySelector('button[aria-label=${JSON.stringify(`Add liquidity to ${name}`)}]')`,
    60_000,
  );

  // ---- deposit: two approvals (the typed token, then the token of the ratio), then addLiquidity ----
  await labelled(`Add liquidity to ${name}`);
  await dFill(`Amount of ${A}`, '100');
  const approvals = await approveUntil('Add liquidity');
  let predicted = await figures();
  let want = amounts(predicted['You deposit']);
  let mins = amounts(predicted['Minimum deposited'].replace(/ \([0-9.]+% slippage\)$/, ''));
  const approved = approvals.map((x) => ({
    to: x.to,
    ...Object.fromEntries([
      ['amount', decodeFunctionData({ abi: ABI, data: x.data }).args[1]],
      ['spender', decodeFunctionData({ abi: ABI, data: x.data }).args[0].toLowerCase()],
    ]),
  }));
  check(
    `two approvals, one per token, each of exactly its amount, to the router: first ${A} (typed), then ${B} (the ratio's, fixed by its approval)`,
    approved.length === 2 &&
      approved[0].to === pair.a.address &&
      approved[1].to === pair.b.address &&
      approved.every((x) => x.spender === chain.router) &&
      approved[0].amount === parseUnits('100', pair.a.decimals) &&
      approved[0].amount >= want[A] &&
      approved[1].amount === want[B],
    approved,
  );
  let before = await state();
  let tx = await press('Add liquidity');
  const sentAt = Math.floor(Date.now() / 1000);
  await settle();
  await waitTracked('/Add liquidity.*: mined/');
  let receipt = await receiptOf(tx.hash);
  let after = await state();
  let decoded = decodeFunctionData({ abi: ABI, data: tx.data });
  const shares = parseUnits(predicted['Pool shares you receive'], 18);
  let rows = [
    row(`${A} deposited`, want[A], before.a - after.a),
    row(`${B} deposited`, want[B], before.b - after.b),
    row('pool shares received', shares, after.shares - before.shares),
    row(`minimum ${A} in the signed call`, mins[A], decoded.args[4]),
    row(`minimum ${B} in the signed call`, mins[B], decoded.args[5]),
    row('native value sent', 0n, tx.value),
  ];
  evidence.comparisons.push({
    step: `deposit of ${A} and ${B} through addLiquidity`,
    hash: tx.hash,
    status: receipt.status,
    gasUsed: Number(BigInt(receipt.gasUsed)),
    rows,
  });
  check(
    `the deposit went through the router's token/token call and did what the page predicted, to the base unit`,
    receipt.status === '0x1' &&
      decoded.functionName === 'addLiquidity' &&
      decoded.args[0].toLowerCase() === pair.a.address &&
      decoded.args[1].toLowerCase() === pair.b.address &&
      decoded.args[6].toLowerCase() === address &&
      Math.abs(Number(decoded.args[7]) - (sentAt + chain.deadlineMinutes * 60)) <= 30 &&
      tx.to === chain.router &&
      tx.gas === 400_000n &&
      rows.every((r) => r.equal),
    rows.filter((r) => !r.equal),
  );
  await closeDialog();

  // ---- the position, then the removal of everything through removeLiquidity ----
  await tab('Portfolio');
  await page.waitFor(
    'the position',
    `!!document.querySelector('button[aria-label=${JSON.stringify(`Remove liquidity from ${name}`)}]')`,
    60_000,
  );
  await delay(1500);
  const positionText = await flat(`[aria-label=${JSON.stringify(`Your position in ${name}`)}]`);
  const shownShares = parseUnits(/Pool shares ([0-9.]+)/.exec(positionText)?.[1] ?? '0', 18);
  check(
    'Portfolio shows the shares the chain holds for the account',
    shownShares === after.shares,
    { shown: shownShares, chain: after.shares },
  );
  await labelled(`Remove liquidity from ${name}`);
  await dClick('100%');
  await page.waitFor('figures', `/You receive/.test(${D}.innerText)`);
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
  decoded = decodeFunctionData({ abi: ABI, data: tx.data });
  rows = [
    row('pool shares removed', removing, before.shares - after.shares),
    row(
      'pool shares approved (exactly those)',
      removing,
      decodeFunctionData({ abi: ABI, data: shareApprovals[0].data }).args[1],
    ),
    row(`${A} received`, want[A], after.a - before.a),
    row(`${B} received`, want[B], after.b - before.b),
    row(`minimum ${A} in the signed call`, mins[A], decoded.args[3]),
    row(`minimum ${B} in the signed call`, mins[B], decoded.args[4]),
  ];
  evidence.comparisons.push({
    step: 'removal of everything through removeLiquidity',
    hash: tx.hash,
    status: receipt.status,
    gasUsed: Number(BigInt(receipt.gasUsed)),
    rows,
  });
  check(
    `the removal went through the router's token/token call and did what the page predicted, to the base unit`,
    receipt.status === '0x1' &&
      decoded.functionName === 'removeLiquidity' &&
      decoded.args[0].toLowerCase() === pair.a.address &&
      decoded.args[1].toLowerCase() === pair.b.address &&
      decoded.args[5].toLowerCase() === address &&
      shareApprovals.length === 1 &&
      shareApprovals[0].to === pair.address &&
      after.shares === 0n &&
      tx.value === 0n &&
      rows.every((r) => r.equal),
    rows.filter((r) => !r.equal),
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
  if (snapshot) {
    await rpc('evm_revert', [snapshot]).catch(() => {});
    await rpc('evm_setAutomine', [true]).catch(() => {});
  }
}
const failed = evidence.assertions.filter((a) => !a.ok).length + (unexpected ? 1 : 0);
evidence.result = failed === 0 ? 'PASS' : 'FAIL';
if (unexpected) evidence.error = String(unexpected.stack ?? unexpected);
writeFileSync(join(config.out, 'liquidity-token-pair-evidence.json'), `${json(evidence)}\n`);
say(
  `liquidity token-pair scenario: ${evidence.result}, ${evidence.assertions.length} assertions, ${failed} failed (${join(config.out, 'liquidity-token-pair-evidence.json')})`,
);
process.exit(failed === 0 ? 0 : 1);
