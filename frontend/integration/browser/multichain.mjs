// Browser scenarios of the multichain site against loopback forks of the six chains
// (scripts/multichain/rehearse-page.mjs starts the forks, builds the rehearsal bundle and runs this file):
//
//   node frontend/integration/browser/multichain.mjs <harness.json>
//
// One real browser engine (headless), the production build of the multichain site, one simulated wallet with a
// throwaway key that knows only the first chain at the start. For every chain: select it in the page, let the page
// ask the wallet to switch (wallet_switchEthereumChain; wallet_addEthereumChain when the wallet answers 4902), swap
// the native coin for the listed token, and check on that chain's fork that the router call was mined for this
// account and the token arrived. After the wallet sent a swap, blocks are mined at the chain's measured block time
// and only as many as the chain's confirmation rule asks (review R309-MC-2): the page must show the outcome then,
// in seconds, while the fork's `finalized` block is still behind the swap. A swap left pending on one chain must
// not hold another chain, and must still hold its own. Exit status 0 only when every assertion held. A simulated wallet is not a wallet extension.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { encodeFunctionData, keccak256, parseAbi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { launch, openPage } from './cdp.mjs';
import { PROVIDER_SCRIPT } from './wallet.mjs';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
for (const url of [config.page, ...config.chains.map((c) => c.rpc)])
  if (!/^http:\/\/127\.0\.0\.1:\d+(\/|$)/.test(url)) throw new Error(`${url} is not a loopback URL`);
mkdirSync(config.out, { recursive: true });
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const say = (line) => console.log(line);
const AMOUNT = '0.01';

let rpcId = 0;
async function rpc(chain, method, params = []) {
  const response = await fetch(chain.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const body = await response.json();
  if (body.error) throw Object.assign(new Error(`${method}: ${body.error.message}`), { code: body.error.code });
  return body.result;
}
const tokenBalance = async (chain, holder) => BigInt(await rpc(chain, 'eth_call', [{ to: chain.token.address, data: encodeFunctionData({ abi: ERC20, functionName: 'balanceOf', args: [holder] }) }, 'latest']));
const mineAndFinalize = (chain) => rpc(chain, 'anvil_mine', ['0x42']);
const blockNumber = async (chain, tag = 'latest') => Number(BigInt((await rpc(chain, 'eth_getBlockByNumber', [tag, false])).number));
/** How far behind the head the page's settled block is on this fork: the rule's depth, or anvil's `finalized` lag. */
const settleLag = (chain) => chain.confirmation.settle.depth ?? 64;
/** The wait this margin allows on top of the chain's own block time: the page looks every 4 s, plus its reads. */
const SETTLE_MARGIN_SECONDS = 20;
/**
 * After the wallet sent `hash`: one block includes it, then blocks arrive at the chain's measured block time, and
 * only as many as the confirmation rule asks. Returns what was mined and how long the page took to show `text`.
 * For a chain that settles on its own `finalized` tag, anvil's tag is 64 blocks behind (the real chain's is one or
 * two): those blocks are mined at once.
 */
async function settleAtChainPace(chain, page, hash, text, startedAt) {
  const { settle, blockSeconds } = chain.confirmation;
  await delay(Math.min(blockSeconds, 12) * 1000);
  await rpc(chain, 'anvil_mine', ['0x1']);
  const receipt = await rpc(chain, 'eth_getTransactionReceipt', [hash]);
  const included = receipt ? Number(BigInt(receipt.blockNumber)) : null;
  let mined = 1;
  if ('depth' in settle) {
    const tick = Math.max(blockSeconds, 0.5);
    const perTick = Math.max(1, Math.round(tick / blockSeconds));
    while (mined < 1 + settle.depth) {
      await delay(tick * 1000);
      const n = Math.min(perTick, 1 + settle.depth - mined);
      await rpc(chain, 'anvil_mine', [hex(n)]);
      mined += n;
    }
  } else {
    await rpc(chain, 'anvil_mine', ['0x42']);
    mined += 66;
  }
  await page.waitText(text, 90_000);
  const seconds = (Date.now() - startedAt) / 1000;
  const finalized = await blockNumber(chain, 'finalized');
  const expected = 'depth' in settle ? (1 + settle.depth) * blockSeconds : 2 * blockSeconds;
  return { rule: settle, blockSeconds, included, blocksMined: mined, seconds: Math.round(seconds * 10) / 10, expectedSeconds: Math.round(expected * 10) / 10, forkFinalized: finalized, finalizedBehindTheSwap: included !== null && finalized < included };
}

// ---- the simulated wallet: one throwaway key, several chains ----
const account = privateKeyToAccount(generatePrivateKey());
const address = account.address.toLowerCase();
const byHex = new Map(config.chains.map((c) => [hex(c.chainId), c]));
const wallet = {
  current: hex(config.chains[0].chainId),
  known: new Set([hex(config.chains[0].chainId)]),
  requests: [],
  sent: [],
  async handle(method, params, emit) {
    this.requests.push({ method, params, chain: this.current });
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address];
    if (method === 'eth_chainId') return this.current;
    if (method === 'wallet_switchEthereumChain') {
      const wanted = String(params[0].chainId).toLowerCase();
      if (!this.known.has(wanted)) throw { code: 4902, message: 'Unrecognized chain ID. Try adding the chain using wallet_addEthereumChain first.' };
      this.current = wanted;
      emit('chainChanged', wanted);
      return null;
    }
    if (method === 'wallet_addEthereumChain') {
      const wanted = String(params[0].chainId).toLowerCase();
      if (!byHex.has(wanted)) throw { code: -32602, message: 'the harness has no fork of this chain' };
      this.known.add(wanted);
      this.current = wanted;
      emit('chainChanged', wanted);
      return null;
    }
    if (method === 'eth_sendTransaction') {
      const chain = byHex.get(this.current);
      const request = params[0];
      if (request.chainId !== undefined && String(request.chainId).toLowerCase() !== this.current) throw { code: -32603, message: 'the request names another chain than the wallet is on' };
      const price = BigInt(await rpc(chain, 'eth_gasPrice')) * 2n + 1_000_000_000n;
      const nonce = request.nonce === undefined ? Number(BigInt(await rpc(chain, 'eth_getTransactionCount', [address, 'pending']))) : Number(BigInt(request.nonce));
      const raw = await account.signTransaction({ type: 'eip1559', chainId: chain.chainId, nonce, to: request.to, data: request.data ?? '0x', value: BigInt(request.value ?? '0x0'), gas: BigInt(request.gas ?? '0x7a120'), maxFeePerGas: price, maxPriorityFeePerGas: 1_000_000_000n });
      const hash = await rpc(chain, 'eth_sendRawTransaction', [raw]);
      if (hash !== keccak256(raw)) throw new Error('the node returned another hash');
      this.sent.push({ chainId: chain.chainId, key: chain.key, hash, to: String(request.to).toLowerCase(), gas: request.gas, requestedChainId: request.chainId ?? null });
      return hash;
    }
    throw { code: 4200, message: `the harness wallet does not implement ${method}` };
  },
};

const evidence = {
  schema: 'postern.frontend.multichain-browser.v1',
  revision: config.revision,
  engine: 'real browser engine (headless), production build of the multichain site with a rehearsal bundle, loopback anvil forks of the six chains',
  wallet: 'SIMULATED EIP-1193/EIP-6963 provider with one throwaway key; not a wallet extension, not WalletConnect',
  finality: "each chain's own confirmation rule from its network file; on a depth rule the harness mines that many blocks at the chain's measured block time and anvil's `finalized` tag (latest - 64) stays behind the swap; on a `finalized` rule anvil's tag stands in for the chain's",
  chains: [],
  assertions: [],
};
const check = (what, ok, detail) => {
  evidence.assertions.push({ what, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  say(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${ok || detail === undefined ? '' : ` (${JSON.stringify(detail, (_, v) => (typeof v === 'bigint' ? v.toString() : v))})`}`);
};
const PENDING = /Waiting for the next block and canonical finality\. Do not resend with a new nonce; Swap stays disabled until the outcome is known\./;
const L2_WORDS = /Bloch|BLCH|bUSDC|\bL2\b|new storage slot|heartbeat|Safe\b/;

const browser = await launch(config.chrome, config.debugPort);
let unexpected = null;
try {
  for (const chain of config.chains) {
    await rpc(chain, 'anvil_setBalance', [address, hex(5n * 10n ** 18n)]);
    await rpc(chain, 'evm_setAutomine', [false]);
    await mineAndFinalize(chain);
  }
  const { browserContextId } = await browser.send('Target.createBrowserContext');
  const page = await openPage(browser, browserContextId, {
    initScript: PROVIDER_SCRIPT,
    url: `${config.page}#/${config.chains[0].key}`,
    log: say,
    onBinding: (bridge, payload, from) => {
      if (bridge !== '__walletBridge') return;
      const { id, method, params } = JSON.parse(payload);
      const emit = (name, value) => from.evaluate(`window.__walletEmit(${JSON.stringify(name)}, ${JSON.stringify(value)})`).catch(() => {});
      wallet.handle(method, params, emit).then(
        (value) => from.evaluate(`window.__walletReply(${id}, true, ${JSON.stringify(value)})`).catch(() => {}),
        (error) => from.evaluate(`window.__walletReply(${id}, false, ${JSON.stringify({ code: error.code ?? -32603, message: error.message ?? String(error) })})`).catch(() => {}),
      );
    },
  });
  const flat = async () => (await page.text()).replace(/\s+/g, ' ');
  // Optional (agent 318): MULTICHAIN_SHOTS=<dir> saves the quoted swap screen of each chain in both themes at 390 and
  // 1440 px. It changes the viewport and the theme attribute only, and restores both.
  const shots = async (chain) => {
    const dir = process.env.MULTICHAIN_SHOTS;
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    for (const v of [{ theme: 'dark', width: 1440, height: 900, dsf: 1, mobile: false }, { theme: 'light', width: 1440, height: 900, dsf: 1, mobile: false }, { theme: 'dark', width: 390, height: 844, dsf: 2, mobile: true }, { theme: 'light', width: 390, height: 844, dsf: 2, mobile: true }]) {
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: v.dsf, mobile: v.mobile });
      await page.evaluate(`(document.documentElement.dataset.theme = ${JSON.stringify(v.theme)}, new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))`);
      const { cssContentSize: size } = await page.cdp('Page.getLayoutMetrics');
      const { data } = await page.cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } });
      writeFileSync(join(dir, `mc-${chain.key ?? chain.name}-swap-quoted--${v.theme}--${v.width}.png`), Buffer.from(data, 'base64'));
    }
    await page.cdp('Emulation.clearDeviceMetricsOverride');
    await page.evaluate(`void (document.documentElement.dataset.theme = 'dark')`);
  };
  const select = async (chain) => {
    await page.evaluate(`(() => { const a = [...document.querySelectorAll('nav[aria-label="Networks"] a')].find((x) => x.textContent.trim() === ${JSON.stringify(chain.name)}); if (!a) throw new Error('no network link'); a.click(); })()`);
    await page.waitText(`/PosternDEX on ${chain.name} · Chain ${chain.chainId}/`);
    await page.waitText('/Pools at finalized block \\d+/', 60_000);
  };
  const fresh = async (chain) => {
    const want = Number(BigInt(await rpc(chain, 'eth_blockNumber'))) - settleLag(chain);
    const shown = `(() => { const m = /Pools at finalized block (\\d+)/.exec(document.body.innerText); return m ? Number(m[1]) : -1; })()`;
    if ((await page.evaluate(shown)) < want) {
      if (await page.button('Refresh')) await page.click('Refresh');
      await page.waitFor(`finalized block ${want}`, `${shown} >= ${want}`, 60_000);
    }
  };
  const quote = async (chain) => {
    for (let attempt = 0; ; attempt++) {
      await fresh(chain);
      await page.select('You pay', chain.native);
      await page.select('You receive', chain.token.symbol);
      await page.fill('Amount', AMOUNT);
      await page.click('Get quote');
      try {
        await page.waitFor('quote', `!!window.__h.labelled('Quote')`, 8000);
        break;
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
    await delay(700);
    await shots(chain);
  };
  const swapLabel = (chain) => `Swap ${AMOUNT} ${chain.native} for ${chain.token.symbol}`;
  const swapsOn = (chain) => wallet.sent.filter((s) => s.chainId === chain.chainId);
  const disabled = async (name) => (await page.button(name))?.disabled === true;

  // ---- every chain: select, switch the wallet, one swap ----
  const [first, second] = config.chains;
  for (const [index, chain] of config.chains.entries()) {
    say(`== ${chain.key}`);
    const record = { key: chain.key, chainId: chain.chainId };
    evidence.chains.push(record);
    await select(chain);
    if (index === 0) {
      await page.click('Connect Harness wallet');
      await page.waitFor('finalized balances', `!!window.__h.labelled('Finalized balances')`);
    }
    const text = await flat();
    check(`${chain.key}: the page shows this network's words and none of the Bloch L2's`, new RegExp(`PosternDEX on ${chain.name}`).test(text) && !L2_WORDS.test(text), L2_WORDS.exec(text)?.[0]);
    check(`${chain.key}: the pool of ${chain.wrapped.symbol} and ${chain.token.symbol} is shown and the native coin is ${chain.native}`, text.includes(`${chain.wrapped.symbol}/${chain.token.symbol}`) || text.includes(`${chain.token.symbol}/${chain.wrapped.symbol}`), text.slice(text.indexOf('Pools at finalized'), text.indexOf('Pools at finalized') + 300));
    const depth = chain.confirmation.settle.depth;
    check(
      `${chain.key}: the page says what "finalized" means on this network (${depth ? `${depth} block${depth === 1 ? '' : 's'} on top` : "the chain's own finalized block"})`,
      depth ? new RegExp(`On ${chain.name} this page treats a block as settled once ${depth} blocks? (is|are) on top of it`).test(text) : text.includes(`On ${chain.name} this page reads and settles at the chain's own finalized block.`),
    );
    const before = wallet.requests.length;
    // The last two chains are not switched by the button: the route itself must ask right before the transaction.
    const byButton = index > 0 && index < config.chains.length - 2;
    if (byButton) {
      await page.click(`Add or switch to ${chain.name}`);
      await page.waitText(`/Wallet is on chain ${chain.chainId}/`);
      const asked = wallet.requests.slice(before);
      const switched = asked.find((r) => r.method === 'wallet_switchEthereumChain');
      const added = asked.find((r) => r.method === 'wallet_addEthereumChain');
      check(`${chain.key}: the page asked the wallet to switch to chain ${chain.chainId}, and to add it when the wallet did not know it`, switched?.params[0].chainId === hex(chain.chainId) && !!added && wallet.current === hex(chain.chainId), asked.map((r) => r.method));
      check(`${chain.key}: the network entry names the chain, its coin and this build's endpoint`, added?.params[0].chainName === chain.name && added.params[0].nativeCurrency.symbol === chain.native && added.params[0].rpcUrls[0] === chain.rpc, added?.params[0]);
    }
    await quote(chain);
    check(`${chain.key}: the default deadline is this chain's ${chain.deadlineMinutes} minutes, not the Bloch L2's 60`, (await flat()).includes(`${chain.deadlineMinutes} minutes after you confirm`));
    const tokenBefore = await tokenBalance(chain, address);
    await page.click('Swap');
    const sentAt = Date.now();
    await page.waitText(PENDING, 60_000);
    const sent = swapsOn(chain);
    check(`${chain.key}: one wallet transaction, on chain ${chain.chainId}, to this chain's router, with the page's 250,000 gas limit`, sent.length === 1 && sent[0].to === chain.router && BigInt(sent[0].gas) === 250_000n && wallet.current === hex(chain.chainId), sent);
    if (!byButton && index > 0) {
      const asked = wallet.requests.slice(before).map((r) => r.method);
      check(`${chain.key}: without the button, the route asked the wallet to switch before the transaction`, asked.includes('wallet_switchEthereumChain') && asked.indexOf('wallet_switchEthereumChain') < asked.indexOf('eth_sendTransaction'), asked);
    }
    if (index === 0) {
      // Left pending: the hold of this chain must not hold the next chain, and must still hold this one.
      record.leftPending = true;
      continue;
    }
    const settled = await settleAtChainPace(chain, page, sent[0].hash, `/${swapLabel(chain)}: mined/`, sentAt);
    record.settle = settled;
    check(
      `${chain.key}: the swap flow completed ${settled.seconds} s after the wallet request, with ${settled.blocksMined} block${settled.blocksMined === 1 ? '' : 's'} at this chain's ${settled.blockSeconds} s block time (rule: ${JSON.stringify(settled.rule)}; chain time ${settled.expectedSeconds} s, plus at most ${SETTLE_MARGIN_SECONDS} s for the page)`,
      settled.seconds <= settled.expectedSeconds + SETTLE_MARGIN_SECONDS,
      settled,
    );
    if ('depth' in settled.rule) check(`${chain.key}: the page did not wait for finality: the fork's finalized block ${settled.forkFinalized} was still behind the swap's block ${settled.included}`, settled.finalizedBehindTheSwap, settled);
    const receipt = await rpc(chain, 'eth_getTransactionReceipt', [sent[0].hash]);
    const got = (await tokenBalance(chain, address)) - tokenBefore;
    check(`${chain.key}: the router call was mined on this chain's fork and ${chain.token.symbol} arrived`, receipt?.status === '0x1' && got > 0n, { status: receipt?.status, got });
    Object.assign(record, { hash: sent[0].hash, gasUsed: receipt ? BigInt(receipt.gasUsed) : null, received: got });
    if (index === 1) {
      // Back to the first chain: its swap is still pending, and its Swap button is still held.
      await select(first);
      await page.waitText(PENDING, 60_000);
      await quote(first);
      check(`${first.key}: after a swap on ${second.key}, this chain's own pending swap still holds it (Swap disabled)`, await disabled('Swap'));
      check(`${first.key}: no second transaction was asked for this chain`, swapsOn(first).length === 1, swapsOn(first).length);
      const tokenBeforeFirst = await tokenBalance(first, address);
      evidence.chains[0].settle = await settleAtChainPace(first, page, swapsOn(first)[0].hash, `/${swapLabel(first)}: mined/`, Date.now());
      if ('depth' in first.confirmation.settle) check(`${first.key}: its held swap was released ${evidence.chains[0].settle.seconds} s after its block, by the chain's rule, without waiting for finality`, evidence.chains[0].settle.seconds <= evidence.chains[0].settle.expectedSeconds + SETTLE_MARGIN_SECONDS && evidence.chains[0].settle.finalizedBehindTheSwap, evidence.chains[0].settle);
      const firstReceipt = await rpc(first, 'eth_getTransactionReceipt', [swapsOn(first)[0].hash]);
      check(`${first.key}: its swap was then mined on its own fork and ${first.token.symbol} arrived`, firstReceipt?.status === '0x1' && (await tokenBalance(first, address)) > tokenBeforeFirst, firstReceipt?.status);
      Object.assign(evidence.chains[0], { hash: swapsOn(first)[0].hash, gasUsed: firstReceipt ? BigInt(firstReceipt.gasUsed) : null });
    }
  }
  check('one swap per chain, each sent on its own chain id', config.chains.every((c) => swapsOn(c).length === 1) && wallet.sent.length === config.chains.length, wallet.sent.map((s) => [s.key, s.chainId]));
  check('the page itself published nothing: every transaction went through the wallet', wallet.sent.length === wallet.requests.filter((r) => r.method === 'eth_sendTransaction').length);
  evidence.walletRequests = wallet.requests.filter((r) => r.method.startsWith('wallet_')).map((r) => ({ method: r.method, chainId: r.params[0].chainId, walletWasOn: r.chain }));
  evidence.console = page.console.filter((l) => /pageerror|Content Security Policy/i.test(l)).slice(0, 10);
  check('no page error and no Content-Security-Policy refusal in the console', evidence.console.length === 0, evidence.console);
  await page.screenshot(join(config.out, 'multichain-last.png')).catch(() => {});
} catch (error) {
  unexpected = String(error.stack ?? error).slice(0, 1200);
  say(`unexpected error: ${unexpected}`);
} finally {
  for (const chain of config.chains) await rpc(chain, 'evm_setAutomine', [true]).catch(() => {});
  await browser.close();
}
const failed = evidence.assertions.filter((a) => !a.ok).length + (unexpected ? 1 : 0);
evidence.unexpected = unexpected;
evidence.summary = { chains: config.chains.length, assertions: evidence.assertions.length, failed, result: failed === 0 ? 'PASS' : 'FAIL' };
writeFileSync(join(config.out, 'multichain-result.json'), `${JSON.stringify(evidence, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
say(`multichain browser scenarios: ${evidence.summary.result}, ${config.chains.length} chains, ${evidence.assertions.length} assertions, ${failed} failed (${join(config.out, 'multichain-result.json')})`);
process.exit(failed === 0 ? 0 : 1);
