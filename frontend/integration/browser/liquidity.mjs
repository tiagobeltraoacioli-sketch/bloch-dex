// Browser scenarios of the liquidity screens of the multichain site against loopback forks (round 20, agent 411):
//
//   node frontend/integration/browser/liquidity.mjs <harness.json>
//
// harness.json: { page, chrome, debugPort, out, revision, chains: [...] } as scripts/multichain/rehearse-page.mjs
// writes it for multichain.mjs (each chain also needs `factory`). The forks hold pools opened by the owner's tools
// (rehearse-fork.mjs in hold mode); the site is a rehearsal build of the same bundle.
//
// One real browser engine (headless), one simulated wallet with a throwaway key per chain. On every chain: the
// refusals the page states before anything is sent; a deposit with the native coin (approve of the exact amount,
// then the deposit); the position; a removal of a quarter and then of everything; the refusal at the latest
// block; a deposit that reverts on chain on its minimum, one that a token refuses (Ethereum's USDC: the wallet is
// blacklisted on the fork by the token's own blacklister, impersonated), and one that reverts on its deadline.
// What the page PREDICTED (amounts, minimums, shares, share of the pool) is compared with what the chain DID, in
// base units, and written to <out>/liquidity-evidence.json. Exit status 0 only when every assertion held.
// A simulated wallet is not a wallet extension; a fork is not the chain.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { decodeFunctionData, encodeFunctionData, formatUnits, parseAbi, parseUnits } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { launch, openPage } from './cdp.mjs';
import { PROVIDER_SCRIPT } from './wallet.mjs';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
for (const url of [config.page, ...config.chains.flatMap((c) => [c.rpc, ...(c.endpoints ?? [])])])
  if (!/^http:\/\/127\.0\.0\.1:\d+(\/|$)/.test(url))
    throw new Error(`${url} is not a loopback URL`);
mkdirSync(config.out, { recursive: true });
const shotsDir = process.env.LIQUIDITY_SHOTS ?? null;

const ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function getPair(address,address) view returns (address)',
  'function blacklister() view returns (address)',
  'function blacklist(address)',
  'function unBlacklist(address)',
  'function swapExactBLCHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[])',
  'function swapExactTokensForBLCH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])',
  'function addLiquidityBLCH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountBLCHMin, address to, uint256 deadline) payable',
  'function removeLiquidityBLCH(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountBLCHMin, address to, uint256 deadline)',
]);
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const say = (line) => console.log(line);
let rpcId = 0;
async function rpc(chain, method, params = []) {
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
const call = async (chain, to, functionName, args = []) =>
  BigInt(
    await rpc(chain, 'eth_call', [
      { to, data: encodeFunctionData({ abi: ABI, functionName, args }) },
      'latest',
    ]),
  );
const nativeBalance = async (chain, who) =>
  BigInt(await rpc(chain, 'eth_getBalance', [who, 'latest']));
/** Blocks at the wall clock (interval 0): the page refuses a device clock far from the chain's. */
const mine = (chain, n = 1) => rpc(chain, 'anvil_mine', [hex(n), '0x0']);
/** One block that includes what is pending, then enough for every confirmation rule of the forks (anvil's `safe` and `finalized` tags trail the head by 32 and 64 blocks). */
const settle = async (chain) => (await mine(chain, 1), await mine(chain, 0x44));
async function receiptOf(chain, hash) {
  for (let i = 0; i < 50; i++) {
    const r = await rpc(chain, 'eth_getTransactionReceipt', [hash]);
    if (r) return r;
    await delay(100);
  }
  throw new Error(`no receipt for ${hash}`);
}
async function sendFrom(
  chain,
  account,
  { to, data = '0x', value = 0n },
  { priceFactor = 2n } = {},
) {
  const price = BigInt(await rpc(chain, 'eth_gasPrice')) * priceFactor + 1_000_000_000n;
  const nonce = Number(
    BigInt(await rpc(chain, 'eth_getTransactionCount', [account.address, 'pending'])),
  );
  const raw = await account.signTransaction({
    type: 'eip1559',
    chainId: chain.chainId,
    nonce,
    to,
    data,
    value,
    gas: 600_000n,
    maxFeePerGas: price,
    maxPriorityFeePerGas: price / 2n,
  });
  return rpc(chain, 'eth_sendRawTransaction', [raw]);
}

const evidence = {
  schema: 'postern.frontend.liquidity-browser.v1',
  revision: config.revision,
  engine:
    'real browser engine (headless), rehearsal build of the multichain site, loopback anvil forks with pools opened by the owner tools',
  wallet:
    'SIMULATED EIP-1193/EIP-6963 provider with one throwaway key per chain; not a wallet extension, not WalletConnect',
  chains: [],
  assertions: [],
};
const json = (value) =>
  JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
const check = (what, ok, detail) => {
  evidence.assertions.push({ what, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  say(
    `  ${ok ? 'ok  ' : 'FAIL'} ${what}${ok || detail === undefined ? '' : ` (${json(detail).replace(/\s+/g, ' ').slice(0, 600)})`}`,
  );
};

function makeWallet(chain) {
  const account = privateKeyToAccount(generatePrivateKey());
  const address = account.address.toLowerCase();
  return {
    account,
    address,
    requests: [],
    sent: [],
    next: [],
    async handle(method, params) {
      this.requests.push({ method, params });
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address];
      if (method === 'eth_chainId') return hex(chain.chainId);
      if (method === 'wallet_switchEthereumChain') return null;
      if (method === 'eth_sendTransaction') {
        if (this.next.shift() === 'reject')
          throw { code: 4001, message: 'User rejected the request.' };
        const request = params[0];
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
          gas: BigInt(request.gas),
          maxFeePerGas: price,
          maxPriorityFeePerGas: 1_000_000_000n,
        });
        const hash = await rpc(chain, 'eth_sendRawTransaction', [raw]);
        this.sent.push({
          hash,
          to: String(request.to).toLowerCase(),
          data: request.data,
          value: BigInt(request.value ?? '0x0'),
          gas: BigInt(request.gas),
          chainId: request.chainId,
        });
        return hash;
      }
      throw { code: 4200, message: `the harness wallet does not implement ${method}` };
    },
  };
}

// Dialog-scoped page helpers: the page behind an open dialog still has buttons of the same names.
const D = `document.querySelector('dialog[open]')`;
const dialogButton = (name) =>
  `[...(${D}?.querySelectorAll('button') ?? [])].find((b) => b.textContent.replace(/\\s+/g, ' ').trim().startsWith(${JSON.stringify(name)}))`;
const VARIANTS = [
  { theme: 'light', width: 1440, height: 900, dsf: 1, mobile: false, name: 'desktop-1440-light' },
  { theme: 'dark', width: 1440, height: 900, dsf: 1, mobile: false, name: 'desktop-1440-dark' },
  { theme: 'light', width: 390, height: 844, dsf: 2, mobile: true, name: 'phone-390-light' },
  { theme: 'dark', width: 390, height: 844, dsf: 2, mobile: true, name: 'phone-390-dark' },
];

const browser = await launch(config.chrome, config.debugPort);
let unexpected = null;
try {
  for (const chain of config.chains) {
    say(`== ${chain.key}`);
    const record = {
      key: chain.key,
      chainId: chain.chainId,
      comparisons: [],
      refusals: [],
      gas: {},
    };
    evidence.chains.push(record);
    const wallet = makeWallet(chain);
    const other = privateKeyToAccount(generatePrivateKey());
    const pair = `0x${(await call(chain, chain.factory, 'getPair', [chain.wrapped.address, chain.token.address])).toString(16).padStart(40, '0')}`;
    const tokenFirst = chain.token.address.toLowerCase() < chain.wrapped.address.toLowerCase();
    const T = chain.token.shown ?? chain.token.symbol;
    const N = chain.native;
    const units = { [N]: 18, [T]: chain.token.decimals };
    const far = BigInt(Math.floor(Date.now() / 1000) + 86_400);
    // The fork is put back as it was found at the end of this chain's scenarios (the last one moves its clock).
    const forkSnapshot = await rpc(chain, 'evm_snapshot');
    await rpc(chain, 'evm_setAutomine', [false]);
    for (const who of [wallet.address, other.address])
      await rpc(chain, 'anvil_setBalance', [who, hex(50n * 10n ** 18n)]);
    // The wallet buys the token it will deposit, with a call it signs itself (not through the page).
    for (const account of [wallet.account, other])
      await sendFrom(chain, account, {
        to: chain.router,
        value: 3n * 10n ** 18n,
        data: encodeFunctionData({
          abi: ABI,
          functionName: 'swapExactBLCHForTokens',
          args: [1n, [chain.wrapped.address, chain.token.address], account.address, far],
        }),
      });
    await settle(chain);
    const state = async () => {
      const [r0, r1] = await (async () => {
        const data = await rpc(chain, 'eth_call', [
          { to: pair, data: encodeFunctionData({ abi: ABI, functionName: 'getReserves' }) },
          'latest',
        ]);
        return [BigInt(`0x${data.slice(2, 66)}`), BigInt(`0x${data.slice(66, 130)}`)];
      })();
      return {
        native: await nativeBalance(chain, wallet.address),
        token: await call(chain, chain.token.address, 'balanceOf', [wallet.address]),
        shares: await call(chain, pair, 'balanceOf', [wallet.address]),
        supply: await call(chain, pair, 'totalSupply'),
        reserveToken: tokenFirst ? r0 : r1,
        reserveNative: tokenFirst ? r1 : r0,
      };
    };

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
    const flat = async (selector = 'body') =>
      (
        await page.evaluate(
          `(document.querySelector(${JSON.stringify(selector)})?.innerText ?? '')`,
        )
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
          join(shotsDir, `after-${chain.key}-${name}--${v.name}.png`),
          Buffer.from(data, 'base64'),
        );
      }
      await page.cdp('Emulation.clearDeviceMetricsOverride');
      await page.evaluate(`void (document.documentElement.dataset.theme = 'dark')`);
    };
    const tab = async (name) => {
      await page.evaluate(
        `[...document.querySelectorAll('nav[aria-label="Screens"] a')].find((a) => a.textContent.trim() === ${JSON.stringify(name)}).click()`,
      );
      await page.waitFor(
        `screen ${name}`,
        `document.querySelector('nav[aria-label="Screens"] a[aria-current="page"]')?.textContent.trim() === ${JSON.stringify(name)}`,
      );
    };
    const refresh = async () => {
      await page.evaluate(
        `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Refresh' && b.getClientRects().length > 0)?.click()`,
      );
      await delay(2500);
    };
    const dClick = async (name, timeoutMs = 60_000) => {
      await page.waitFor(
        `enabled dialog button "${name}"`,
        `(() => { const b = ${dialogButton(name)}; return !!b && !b.disabled; })()`,
        timeoutMs,
      );
      await page.evaluate(`${dialogButton(name)}.click()`);
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
    /** The dialog's figures, as written: { "You deposit": "…", … }. */
    const figures = () =>
      page.evaluate(
        `(() => { const out = {}; const dl = ${D}?.querySelector('dl.live-figures'); if (!dl) return out; let key = null; for (const el of dl.children) { if (el.tagName === 'DT') key = el.textContent.trim(); else if (key) out[key] = el.textContent.replace(/\\s+/g, ' ').trim(); } return out; })()`,
      );
    /** "0.5 ETH + 835.1 USDC (…)" -> { ETH: base units, USDC: base units } */
    const literal = (name) => name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const amounts = (text) =>
      Object.fromEntries(
        [
          ...text.matchAll(
            new RegExp(`([0-9]+(?:\\.[0-9]+)?) (${literal(T)}|${literal(N)})(?![A-Za-z0-9])`, 'g'),
          ),
        ].map((m) => [m[2], parseUnits(m[1], units[m[2]])]),
      );
    const trackedLine = () => flat('dialog[open] .live-tracked-line');
    const waitTracked = (pattern, timeoutMs = 90_000) =>
      page.waitFor(
        `tracked ${pattern}`,
        `(${pattern}).test((document.querySelector('dialog[open] .live-tracked')?.innerText ?? '').replace(/\\s+/g, ' '))`,
        timeoutMs,
      );
    const alerts = () =>
      page.evaluate(
        `[...(${D}?.querySelectorAll('[role="alert"]') ?? [])].map((e) => e.textContent.replace(/\\s+/g, ' ').trim())`,
      );
    const noteText = () => flat('dialog[open] [data-testid="liquidity-note"]');
    /** Approvals until the dialog's main action is the next step; returns the approvals the wallet sent. */
    const approveUntil = async (action) => {
      const made = [];
      for (let i = 0; i < 4; i++) {
        await page.waitFor(
          'a dialog action',
          `(() => { const a = ${dialogButton('Approve')}; const b = ${dialogButton(action)}; return (a && !a.disabled) || (b && !b.disabled); })()`,
          90_000,
        );
        if (!(await page.evaluate(`!!${dialogButton('Approve')}`))) return made;
        const before = wallet.sent.length;
        const label = await page.evaluate(`${dialogButton('Approve')}.textContent.trim()`);
        await dClick('Approve');
        for (let w = 0; w < 200 && wallet.sent.length === before; w++) await delay(100);
        if (wallet.sent.length === before)
          throw new Error(`the wallet received no approval: ${await noteText()}`);
        await settle(chain);
        await waitTracked('/: mined/');
        made.push({ label, ...wallet.sent.at(-1) });
        await delay(1500);
      }
      throw new Error('approvals did not end');
    };
    const sendAction = async (action) => {
      const before = wallet.sent.length;
      await dClick(action);
      for (let w = 0; w < 300 && wallet.sent.length === before; w++) await delay(100);
      if (wallet.sent.length === before)
        throw new Error(`the wallet received no ${action}: ${await noteText()}`);
      return wallet.sent.at(-1);
    };
    const closeDialog = () =>
      page.evaluate(`${D}?.querySelector('button[aria-label="Close dialog"]')?.click()`);

    // ---- connect: the new screens send the user to the route's own connect step ----
    await page.waitVisibleText(`/(Confirmed|Finalized) block \\d+ is /`, 60_000);
    await tab('Pools');
    await shots('1-pools-not-connected');
    await page.click('Connect a wallet on the Trade screen');
    await page.click('Connect Harness wallet');
    await page.waitFor(
      'balances',
      `!![...document.querySelectorAll('[aria-label]')].find((x) => / balances$/.test(x.getAttribute('aria-label')))`,
    );
    await shots('0-trade');
    await tab('Pools');
    await page.waitText('/0%|<0\\.0001%/', 60_000);
    const poolsText = await flat('[data-view="pools"]');
    check(
      `${chain.key}: Pools lists the open pool with its reserves, the pool fee, and says what it cannot show`,
      new RegExp(`${chain.wrapped.symbol}/|/${chain.wrapped.symbol}`).test(poolsText) &&
        poolsText.includes('0.30%') &&
        poolsText.includes('Not available') &&
        poolsText.includes('Before you provide liquidity') &&
        !/Bloch(?! DEX)|BLCH|bUSDC|Sample|Demo/.test(poolsText),
      poolsText.slice(0, 300),
    );
    await shots('2-pools');

    // ---- refusals stated before anything is sent ----
    await page.click('Add liquidity');
    await page.waitFor('the dialog', `!!${D}`);
    const sentAtStart = wallet.sent.length;
    await dFill(`Amount of ${N}`, '0.000000000000000001');
    let said = await alerts();
    check(
      `${chain.key}: one base unit of ${N} is refused before anything is sent (the pool would ask zero ${T}, or a minimum would round to zero)`,
      said.some((a) => /BDEX: INSUFFICIENT_AMOUNT|is so small that the minimum of .* rounds to zero/.test(a)) &&
        (await page.evaluate(`${dialogButton('Add liquidity')}?.disabled === true`)),
      said,
    );
    record.refusals.push({
      refusal: 'INSUFFICIENT_AMOUNT (router quote), or a minimum that rounds to zero',
      provoked: 'typed one base unit',
      page: said,
    });
    await dFill(`Amount of ${N}`, '1000');
    said = await alerts();
    check(
      `${chain.key}: an amount above the wallet's balance is refused before anything is sent`,
      said.some((a) =>
        /balance \([0-9.]+\) is below the amount; the deposit would revert/.test(a),
      ) &&
        (await page.evaluate(
          `[...${D}.querySelectorAll('button.primary')].every((b) => b.disabled)`,
        )),
      said,
    );
    record.refusals.push({
      refusal: 'balance below the amount (TRANSFER_FROM_FAILED / value)',
      provoked: 'typed 1000',
      page: said,
    });
    await dFill('Slippage tolerance', '9');
    said = await alerts();
    check(
      `${chain.key}: a tolerance above 3% is refused`,
      said.some((a) => a.includes('Use a slippage tolerance of 0.01% to 3.00%.')),
      said,
    );
    await dFill('Slippage tolerance', '0.50');

    // ---- deposit ----
    await dFill(`Amount of ${N}`, '0.5');
    await page.waitFor('figures', `!!${D}.querySelector('dl.live-figures dt')`);
    await shots('3-dialog-add-quoted', true);
    wallet.next.push('reject');
    await dClick('Approve');
    await page.waitFor(
      'the rejection note',
      `/rejected by you\\. Nothing was sent\\./.test(${D}.innerText)`,
      30_000,
    );
    check(
      `${chain.key}: a request rejected in the wallet says so, sends nothing and leaves no hold`,
      wallet.sent.length === sentAtStart &&
        !(await page.evaluate(`!!${D}.querySelector('.live-tracked-line')`)),
      await noteText(),
    );
    record.refusals.push({
      refusal: 'wallet rejection (4001)',
      provoked: 'the wallet rejected the approval',
      page: await noteText(),
    });
    const approvals = await approveUntil('Add liquidity');
    let predicted = await figures();
    let want = amounts(predicted['You deposit']);
    let mins = amounts(predicted['Minimum deposited'].replace(/ \([0-9.]+% slippage\)$/, ''));
    const approveCall = decodeFunctionData({ abi: ABI, data: approvals[0].data });
    check(
      `${chain.key}: one approval, of exactly the ${T} the deposit names, to the router, with an explicit gas limit`,
      approvals.length === 1 &&
        approvals[0].to === chain.token.address.toLowerCase() &&
        approveCall.functionName === 'approve' &&
        approveCall.args[0].toLowerCase() === chain.router &&
        approveCall.args[1] === want[T] &&
        approvals[0].gas === 100_000n,
      { approved: approveCall.args[1], figure: want[T] },
    );
    let before = await state();
    await shots('4-dialog-add-ready', true);
    let tx = await sendAction('Add liquidity');
    await delay(800);
    await shots('5-dialog-add-waiting', true);
    let sentAt = Math.floor(Date.now() / 1000);
    await settle(chain);
    await waitTracked('/: mined/');
    let receipt = await receiptOf(chain, tx.hash);
    let after = await state();
    let fee = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
    let decoded = decodeFunctionData({ abi: ABI, data: tx.data });
    record.gas.add = Number(BigInt(receipt.gasUsed));
    const expectShares = parseUnits(predicted['Pool shares you receive'], 18);
    const row = (what, pageValue, chainValue) => ({
      what,
      predicted: pageValue.toString(),
      actual: chainValue.toString(),
      equal: pageValue === chainValue,
    });
    let rows = [
      row(`${N} deposited`, want[N], before.native - after.native - fee),
      row(`${T} deposited`, want[T], before.token - after.token),
      row('pool shares received', expectShares, after.shares - before.shares),
      row(`minimum ${T} in the signed call`, mins[T], decoded.args[2]),
      row(`minimum ${N} in the signed call`, mins[N], decoded.args[3]),
      row(
        `${N} value sent (the typed amount; the ratio's remainder is returned)`,
        parseUnits('0.5', 18),
        tx.value,
      ),
    ];
    record.comparisons.push({
      step: `deposit of 0.5 ${N} with the ratio's ${T}`,
      hash: tx.hash,
      status: receipt.status,
      gasUsed: record.gas.add,
      rows,
    });
    check(
      `${chain.key}: the deposit did what the page predicted, to the base unit (amounts, shares, the minimums in the signed call)`,
      receipt.status === '0x1' &&
        decoded.functionName === 'addLiquidityBLCH' &&
        rows.every((r) => r.equal) &&
        decoded.args[4].toLowerCase() === wallet.address &&
        tx.gas === 400_000n,
      rows.filter((r) => !r.equal),
    );
    check(
      `${chain.key}: the deposit's deadline is this chain's ${chain.deadlineMinutes} minutes from the request`,
      Math.abs(Number(decoded.args[5]) - (sentAt + chain.deadlineMinutes * 60)) <= 30,
      { deadline: Number(decoded.args[5]), sentAt },
    );
    await shots('6-dialog-add-mined', true);
    await closeDialog();

    // ---- the position ----
    await tab('Portfolio');
    await page.waitText('/Liquidity position/', 60_000);
    await delay(1500);
    const positionText = await flat('[data-view="portfolio"]');
    const shownShares = /Pool shares ([0-9.]+)/.exec(positionText)?.[1] ?? '0';
    const shownPercent = /Pool share ([0-9.<]+%)/.exec(positionText)?.[1];
    const ppm = (after.shares * 1_000_000n) / after.supply;
    const percentText = `${ppm / 10_000n}.${(ppm % 10_000n).toString().padStart(4, '0')}%`;
    const shownAmounts = [
      ...positionText.matchAll(
        new RegExp(
          `(${literal(T)}|${literal(chain.wrapped.symbol)}) ([0-9]+(?:\\.[0-9]+)?) what a removal of every share would pay`,
          'g',
        ),
      ),
    ].map((m) => [m[1], m[2]]);
    const underlying = {
      [chain.wrapped.symbol]: (after.shares * after.reserveNative) / after.supply,
      [T]: (after.shares * after.reserveToken) / after.supply,
    };
    rows = [
      row('pool shares held', parseUnits(shownShares, 18), after.shares),
      {
        what: 'share of the pool',
        predicted: shownPercent,
        actual: percentText,
        equal: shownPercent === percentText,
      },
      ...shownAmounts.map(([symbol, value]) =>
        row(
          `${symbol} behind the position`,
          parseUnits(value, symbol === T ? chain.token.decimals : 18),
          underlying[symbol] ?? -1n,
        ),
      ),
    ];
    record.comparisons.push({ step: 'position on the Portfolio screen', rows });
    check(
      `${chain.key}: Portfolio shows the position the chain holds (shares, share of the pool, the two amounts)`,
      rows.length === 4 && rows.every((r) => r.equal),
      rows,
    );
    await shots('7-portfolio-position');

    // ---- removal of a quarter, then of everything ----
    for (const [percent, label] of [
      [25, 'a quarter'],
      [100, 'everything'],
    ]) {
      await page.click('Remove liquidity');
      await page.waitFor('the dialog', `!!${D}`);
      if (percent !== 25) await dClick(`${percent}%`);
      await page.waitFor('figures', `/You receive/.test(${D}.innerText)`);
      if (percent === 25) await shots('8-dialog-remove-quoted', true);
      const shareApprovals = await approveUntil('Remove liquidity');
      predicted = await figures();
      want = amounts(predicted['You receive']);
      mins = amounts(predicted['Minimum received'].replace(/ \([0-9.]+% slippage\)$/, ''));
      const removing = parseUnits(/^([0-9.]+) of/.exec(predicted['Pool shares removed'])[1], 18);
      const shareApprove = decodeFunctionData({ abi: ABI, data: shareApprovals[0].data });
      before = await state();
      tx = await sendAction('Remove liquidity');
      await settle(chain);
      await waitTracked('/Remove liquidity.*: mined/');
      receipt = await receiptOf(chain, tx.hash);
      after = await state();
      fee = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
      decoded = decodeFunctionData({ abi: ABI, data: tx.data });
      record.gas[`remove${percent}`] = Number(BigInt(receipt.gasUsed));
      rows = [
        row('pool shares removed', removing, before.shares - after.shares),
        row('pool shares approved (exactly those)', removing, shareApprove.args[1]),
        row(`${N} received`, want[N], after.native - before.native + fee),
        row(`${T} received`, want[T], after.token - before.token),
        row(`minimum ${T} in the signed call`, mins[T], decoded.args[2]),
        row(`minimum ${N} in the signed call`, mins[N], decoded.args[3]),
      ];
      record.comparisons.push({
        step: `removal of ${label} (${percent}%)`,
        hash: tx.hash,
        status: receipt.status,
        gasUsed: record.gas[`remove${percent}`],
        rows,
      });
      check(
        `${chain.key}: the removal of ${label} did what the page predicted, to the base unit, after one approval of exactly those shares`,
        receipt.status === '0x1' &&
          decoded.functionName === 'removeLiquidityBLCH' &&
          shareApprovals.length === 1 &&
          shareApprovals[0].to === pair.toLowerCase() &&
          rows.every((r) => r.equal) &&
          (percent !== 100 || after.shares === 0n),
        rows.filter((r) => !r.equal),
      );
      if (percent === 100) await shots('9-dialog-remove-all-mined', true);
      await closeDialog();
      await delay(1500);
    }
    await page.waitText('/No liquidity position on this network\\./', 60_000);
    check(
      `${chain.key}: after removing everything Portfolio says there is no position, and lists the page's liquidity transactions`,
      /Add liquidity: .* mined/.test(await flat('[data-view="portfolio"]')) &&
        /Remove liquidity: 100% of .* mined/.test(await flat('[data-view="portfolio"]')),
      (await flat('[data-view="portfolio"]')).slice(0, 400),
    );
    await shots('10-portfolio-empty');

    // ---- the pool moves after the page read it: refused at the latest block, nothing sent ----
    await tab('Pools');
    await page.click('Add liquidity');
    await page.waitFor('the dialog', `!!${D}`);
    await dFill(`Amount of ${N}`, '0.2');
    await approveUntil('Add liquidity');
    const moveBy = async (priceFactor) =>
      sendFrom(
        chain,
        other,
        {
          to: chain.router,
          value: 4n * 10n ** 18n,
          data: encodeFunctionData({
            abi: ABI,
            functionName: 'swapExactBLCHForTokens',
            args: [1n, [chain.wrapped.address, chain.token.address], other.address, far],
          }),
        },
        { priceFactor },
      );
    await moveBy(2n);
    await mine(chain, 1); // in a block, but the page's pinned block is older
    let sentBefore = wallet.sent.length;
    await dClick('Add liquidity');
    await page.waitFor(
      'the latest-block refusal',
      `/At the latest block: /.test(${D}.innerText)`,
      60_000,
    );
    let note = await noteText();
    check(
      `${chain.key}: a pool that moved beyond the tolerance since the pinned block is refused at the latest block; nothing is sent`,
      /At the latest block: The pool's ratio has moved by more than your tolerance: .* \(BDEX: INSUFFICIENT_[AB]_AMOUNT\)\. Nothing was sent\./.test(
        note,
      ) && wallet.sent.length === sentBefore,
      note,
    );
    record.refusals.push({
      refusal: 'INSUFFICIENT_A_AMOUNT / INSUFFICIENT_B_AMOUNT predicted at the latest block',
      provoked: 'another account moved the pool about 30% after the pinned block',
      page: note,
    });
    await shots('11-dialog-refused-at-latest', true);
    await closeDialog();

    // ---- reverts on chain ----
    const revertedDeposit = async (name, provoke, expected, shot) => {
      await settle(chain);
      await refresh();
      await page.click('Add liquidity');
      await page.waitFor('the dialog', `!!${D}`);
      await dFill(`Amount of ${N}`, '0.2');
      await approveUntil('Add liquidity');
      const sent = await sendAction('Add liquidity');
      await provoke();
      await settle(chain);
      await waitTracked('/Add liquidity.*: failed/');
      await page.waitFor(
        'the reason',
        `(() => { const el = ${D}.querySelector('[aria-label="Why it reverted"]'); return !!el && !/Reading from the chain/.test(el.textContent); })()`,
        60_000,
      );
      const why = await flat('dialog[open] [aria-label="Why it reverted"]');
      const r = await receiptOf(chain, sent.hash);
      check(
        `${chain.key}: ${name}: the deposit reverts on chain and the page says why`,
        r.status === '0x0' && expected.test(why) && why.includes('Only the gas was spent'),
        why,
      );
      record.refusals.push({
        refusal: name,
        provoked: 'on chain (reverted transaction)',
        hash: sent.hash,
        page: why,
      });
      if (shot) await shots(shot, true);
      await closeDialog();
    };
    await revertedDeposit(
      'BDEX: INSUFFICIENT_A_AMOUNT / INSUFFICIENT_B_AMOUNT (the ratio moved in front of the transaction)',
      () => moveBy(20n),
      /The pool's ratio has moved by more than your tolerance: the .* side was below its minimum and the deposit reverted \(BDEX: INSUFFICIENT_[AB]_AMOUNT\)\./,
      '12-dialog-reverted-on-minimum',
    );
    if (chain.chainId === 1 && chain.token.symbol === 'USDC') {
      const blacklister = `0x${(await call(chain, chain.token.address, 'blacklister')).toString(16).padStart(40, '0')}`;
      const asBlacklister = async (functionName) => {
        await rpc(chain, 'anvil_impersonateAccount', [blacklister]);
        await rpc(chain, 'anvil_setBalance', [blacklister, hex(10n ** 18n)]);
        await rpc(chain, 'eth_sendTransaction', [
          {
            from: blacklister,
            to: chain.token.address,
            data: encodeFunctionData({ abi: ABI, functionName, args: [wallet.address] }),
            gas: hex(200_000n),
            gasPrice: hex(BigInt(await rpc(chain, 'eth_gasPrice')) * 50n),
          },
        ]);
        await rpc(chain, 'anvil_stopImpersonatingAccount', [blacklister]);
      };
      await revertedDeposit(
        "the token's issuer blocks the account (USDC blacklist; the transfer is refused inside the deposit)",
        () => asBlacklister('blacklist'),
        /The page could not tell why from the chain\. .*a token may have refused the transfer/,
        null,
      );
      await asBlacklister('unBlacklist');
    }
    await revertedDeposit(
      'BDEX: EXPIRED (the deadline passed before the transaction was mined)',
      async () =>
        rpc(chain, 'evm_setNextBlockTimestamp', [
          hex(Math.floor(Date.now() / 1000) + (chain.deadlineMinutes + 5) * 60),
        ]),
      /It reverted because its deadline had passed when its block was made \(BDEX: EXPIRED\)\./,
      null,
    );
    const consoleErrors = page.console.filter(
      (l) => /^(error|pageerror)/.test(l) && !/Failed to load resource/.test(l),
    );
    check(
      `${chain.key}: the page logged no error`,
      consoleErrors.length === 0,
      consoleErrors.slice(0, 5),
    );
    await page.close();
    await rpc(chain, 'evm_revert', [forkSnapshot]);
    await rpc(chain, 'evm_setAutomine', [true]);
  }
} catch (error) {
  unexpected = error;
  console.error(error);
} finally {
  await browser.close();
}
const failed = evidence.assertions.filter((a) => !a.ok).length + (unexpected ? 1 : 0);
evidence.result = failed === 0 ? 'PASS' : 'FAIL';
if (unexpected) evidence.error = String(unexpected.stack ?? unexpected);
writeFileSync(join(config.out, 'liquidity-evidence.json'), `${json(evidence)}\n`);
say(
  `liquidity browser scenarios: ${evidence.result}, ${evidence.chains.length} chains, ${evidence.assertions.length} assertions, ${failed} failed (${join(config.out, 'liquidity-evidence.json')})`,
);
process.exit(failed === 0 ? 0 : 1);
