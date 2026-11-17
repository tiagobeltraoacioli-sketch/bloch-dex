// Wallet-behaviour scenarios for #/mainnet in a real browser engine, against the loopback anvil chain of
// rehearse-mainnet-package.sh. Started by wallet-hook.sh (see run.mjs and ../README.md):
//
//   node scenarios.mjs <wallet-harness.json> [--only <name>[,<name>…]]
//
// Each scenario gets a fresh throwaway account and an isolated browser context, drives the built production bundle
// like a user (visible text, labels, clicks), plays one wallet behaviour and then asserts chain facts (how many router
// calls of this account were mined, its nonce, balances) next to what the page shows. Exit status 0 only when every
// assertion of every scenario held. This is a simulated wallet, not a wallet extension: see docs/WALLET-MANUAL-TEST.md.
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { encodeFunctionData, keccak256, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { launch, openPage } from './cdp.mjs';
import { createWallet, PROVIDER_SCRIPT } from './wallet.mjs';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const only = process.argv[3] === '--only' ? process.argv[4].split(',') : null;
for (const url of [config.rpc, config.page])
  if (!/^http:\/\/127\.0\.0\.1:\d+(\/|$)/.test(url)) throw new Error(`${url} is not a loopback URL`);
mkdirSync(config.out, { recursive: true });
const ERC20 = parseAbi(['function transfer(address,uint256)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)']);
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const say = (line) => console.log(line);

// ---- chain ----
let rpcId = 0;
async function rpc(method, params = []) {
  const response = await fetch(config.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const body = await response.json();
  if (body.error) throw Object.assign(new Error(`${method}: ${body.error.message}`), { code: body.error.code });
  return body.result;
}
const head = async () => BigInt(await rpc('eth_blockNumber'));
/** One block that takes what is queued. */
const mine = () => rpc('anvil_mine', ['0x1']);
/** Anvil's `finalized` tag trails `latest` by 64 blocks. */
const finalize = () => rpc('anvil_mine', ['0x41']);
const mineAndFinalize = async () => (await mine(), await finalize());
const nonceOf = async (address, tag = 'latest') => Number(await rpc('eth_getTransactionCount', [address, tag]));
const tokenBalance = async (holder) => BigInt(await rpc('eth_call', [{ to: config.asset, data: encodeFunctionData({ abi: ERC20, functionName: 'balanceOf', args: [holder] }) }, 'latest']));
const allowance = async (holder) => BigInt(await rpc('eth_call', [{ to: config.asset, data: encodeFunctionData({ abi: ERC20, functionName: 'allowance', args: [holder, config.router] }) }, 'latest']));
/** Every mined transaction of `address` since block `from`: [{ hash, nonce, to, status, router }]. */
async function minedBy(address, from) {
  const found = [];
  for (let n = from + 1n, top = await head(); n <= top; n++) {
    const block = await rpc('eth_getBlockByNumber', [hex(n), true]);
    for (const tx of block.transactions) {
      if (tx.from.toLowerCase() !== address) continue;
      const receipt = await rpc('eth_getTransactionReceipt', [tx.hash]);
      found.push({ hash: tx.hash, nonce: Number(tx.nonce), to: tx.to?.toLowerCase(), ok: receipt.status === '0x1', router: tx.to?.toLowerCase() === config.router.toLowerCase(), block: Number(n) });
    }
  }
  return found;
}
const issuer = privateKeyToAccount(config.issuerKey);
async function fund(address, { blch = 5n * 10n ** 18n, busdc = 0n } = {}) {
  await rpc('anvil_setBalance', [address, hex(blch)]);
  if (busdc > 0n) {
    const raw = await issuer.signTransaction({ type: 'eip1559', chainId: config.chainId, nonce: await nonceOf(issuer.address, 'pending'), to: config.asset, gas: 100_000n, maxFeePerGas: 5_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, data: encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [address, busdc] }) });
    await rpc('eth_sendRawTransaction', [raw]);
  }
  await mineAndFinalize();
}

// ---- the page's RPC: a CORS gateway in front of anvil, as the public gateway is in front of the settled RPC ----
const pageCalls = [];
/** Set by a scenario: the candidate RPC's `bloch_admissionQuote`, answered by the wallet's node model. Null: the
 * launch RPC, which has no such method (anvil answers "method not found"). */
let admissionQuote = null;
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
const gateway = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try {
    const message = JSON.parse(raw);
    for (const call of Array.isArray(message) ? message : [message]) pageCalls.push(call.method);
  } catch {
    /* forwarded as is */
  }
  try {
    const message = JSON.parse(raw);
    if (admissionQuote && !Array.isArray(message) && message.method === 'bloch_admissionQuote') {
      const body = await admissionQuote(message.params[0]).then(
        (result) => ({ jsonrpc: '2.0', id: message.id, result }),
        (error) => ({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: String(error?.message ?? error) } }),
      );
      return res.writeHead(200, { 'content-type': 'application/json', ...cors }).end(JSON.stringify(body));
    }
  } catch {
    /* forwarded as is */
  }
  const upstream = await fetch(config.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
  res.writeHead(200, { 'content-type': 'application/json', ...cors }).end(await upstream.text());
}).listen(config.gatewayPort, '127.0.0.1');

// ---- scenarios ----
const browser = await launch(config.chrome, config.debugPort);
const evidence = {
  schema: 'postern.frontend.browser-wallet.v1',
  revision: config.revision,
  workingTreeDirty: config.dirty,
  browser: browser.product,
  engine: 'real browser engine (headless), production bundle, loopback anvil',
  wallet: 'SIMULATED EIP-1193/EIP-6963 provider with a throwaway key; not a wallet extension, not WalletConnect',
  finality: "anvil's `finalized` tag (latest - 64), advanced by anvil_mine; not Bloch settled finality",
  scenarios: [],
};
const scenarios = [];
const scenario = (name, covers, run) => scenarios.push({ name, covers, run });

const PENDING = /Waiting for the next L2 block and canonical finality\. Do not resend with a new nonce; Swap stays disabled until the outcome is known\./;
const NO_HASH = /Wallet submission outcome unknown: no transaction hash was returned\./;

async function runScenario({ name, covers, run }) {
  const record = { name, covers, assertions: [], page: {}, chain: {}, wallet: {} };
  evidence.scenarios.push(record);
  const check = (what, ok, detail) => {
    record.assertions.push({ what, ok: !!ok, ...(detail === undefined ? {} : { detail: typeof detail === 'bigint' ? detail.toString() : detail }) });
    say(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${ok || detail === undefined ? '' : ` (${JSON.stringify(detail, (_, v) => (typeof v === 'bigint' ? v.toString() : v))})`}`);
  };
  say(`== ${name}`);
  const { browserContextId } = await browser.send('Target.createBrowserContext');
  const wallet = createWallet({ rpc, chainId: config.chainId });
  const tabs = [];
  const callsFrom = pageCalls.length;
  try {
    const world = {
      wallet,
      check,
      record,
      start: 0n,
      /** A tab of this scenario's browser profile, with the wallet injected. */
      async tab() {
        const page = await openPage(browser, browserContextId, {
          // world.clockAheadSeconds: the page's clock runs that far ahead of the chain's, which is what a correct
          // clock sees on an L2 that has made no block for that long (the chain here cannot be made old instead).
          initScript: `${world.clockAheadSeconds ? `(() => { const shift = ${Number(world.clockAheadSeconds) * 1000}; const Real = Date; const real = Real.now.bind(Real); class Shifted extends Real { constructor(...a) { if (a.length) super(...a); else super(real() + shift); } static now() { return real() + shift; } } globalThis.Date = Shifted; })();` : ''}\n${PROVIDER_SCRIPT}`,
          url: config.page,
          log: say,
          onBinding: (bridge, payload, from) => {
            if (bridge !== '__walletBridge') return;
            const { id, method, params } = JSON.parse(payload);
            wallet.handle(method, params).then(
              (value) => from.evaluate(`window.__walletReply(${id}, true, ${JSON.stringify(value)})`).catch(() => {}),
              (error) => from.evaluate(`window.__walletReply(${id}, false, ${JSON.stringify({ code: error.code ?? -32603, message: error.message ?? String(error), ...('data' in error ? { data: error.data } : {}) })})`).catch(() => {}),
            );
          },
        });
        tabs.push(page);
        return page;
      },
      async connect(page) {
        await page.waitText('/Pools at finalized block \\d+/');
        await page.click('Connect Harness wallet');
        await page.waitFor('finalized balances', `!!window.__h.labelled('Finalized balances')`);
      },
      /** The page reads at the finalized block it loaded; bring it to the current one, as the Refresh button does. */
      async fresh(page) {
        const want = (await head()) - 64n;
        const shown = `(() => { const m = /Pools at finalized block (\\d+)/.exec(document.body.innerText); return m ? Number(m[1]) : -1; })()`;
        if (BigInt(await page.evaluate(shown)) < want) {
          if (await page.button('Refresh')) await page.click('Refresh');
          await page.waitFor(`finalized block ${want}`, `${shown} >= ${want}`);
        }
      },
      async quote(page, pay, receive, amount) {
        for (let attempt = 0; ; attempt++) {
          await world.fresh(page);
          await page.select('You pay', pay);
          await page.select('You receive', receive);
          await page.fill('Amount', amount);
          await page.click('Get quote');
          try {
            await page.waitFor('quote', `!!window.__h.labelled('Quote')`, 6000);
            break;
          } catch (error) {
            // A refresh that was already under way remounts the form and empties it; fill it again.
            if (attempt === 2) throw error;
          }
        }
        // The latest-block cross-check ends before Swap can be judged.
        await delay(700);
      },
      /** Fund, open one tab, connect. */
      async begin(funding) {
        await fund(wallet.address, funding);
        world.start = await head();
        const page = await world.tab();
        await world.connect(page);
        return page;
      },
      async facts(label = 'end') {
        const mined = await minedBy(wallet.address, world.start);
        const facts = {
          minedTransactions: mined,
          routerCallsMined: mined.filter((t) => t.router && t.ok).length,
          nonceLatest: await nonceOf(wallet.address),
          noncePending: await nonceOf(wallet.address, 'pending'),
          busdc: (await tokenBalance(wallet.address)).toString(),
          walletSendRequests: wallet.sends().length,
          walletSigned: wallet.signed.map((s) => ({ hash: s.hash, nonce: s.tx.nonce, origin: s.origin, broadcast: s.broadcast, requestedNonce: s.requestedNonce ?? null })),
        };
        record.chain[label] = facts;
        return facts;
      },
      note: async (page, label) => {
        record.page[label] = { transactions: await page.labelled('Transactions'), recovery: (await page.labelled('Recover transaction tracking'))?.slice(-600) ?? null };
      },
    };
    try {
      await run(world);
    } finally {
      admissionQuote = null;
    }
    const sent = pageCalls.slice(callsFrom).filter((m) => m === 'eth_sendRawTransaction' || m === 'eth_sendTransaction');
    check('the page itself never publishes or sends through its RPC', sent.length === 0, sent);
  } catch (error) {
    check(`scenario completed without an unexpected error`, false, String(error.message ?? error));
    for (const [i, page] of tabs.entries()) await page.screenshot(join(config.out, `${name}-failure-tab${i}.png`)).catch(() => {});
  } finally {
    record.console = tabs.flatMap((t) => t.console).filter((l) => !l.startsWith('debug')).slice(0, 40);
    await browser.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  }
}

const AMOUNT = '0.01';
const SWAP = `Swap ${AMOUNT} BLCH for bUSDC`;
const swapNative = async (w, page) => (await w.quote(page, 'BLCH', 'bUSDC', AMOUNT), await page.click('Swap'));
const openReview = (page) => page.evaluate(`(() => { const d = [...document.querySelectorAll('details')].find((x) => x.querySelector('summary')?.textContent.includes('Review the original request')); if (d) d.open = true; return !!d; })()`);
const pasteHash = (page, hash) => page.fill('Transaction hash from wallet activity', hash);
const disabled = async (page, name) => (await page.button(name))?.disabled === true;

scenario('normal-send', 'baseline: one request, one broadcast, finalized', async (w) => {
  const page = await w.begin();
  const before = await tokenBalance(w.wallet.address);
  await swapNative(w, page);
  await page.waitText(PENDING);
  w.check('while the swap is queued the Swap button is disabled', await disabled(page, 'Swap'));
  w.check('the site asked the wallet for the canonical nonce', w.wallet.sends()[0]?.params[0].nonce === '0x0', w.wallet.sends()[0]?.params[0].nonce);
  await mineAndFinalize();
  await page.waitText(`/${SWAP}: mined/`, 40_000);
  await w.note(page, 'mined');
  const f = await w.facts();
  w.check('exactly one router call of this account was mined', f.routerCallsMined === 1, f.routerCallsMined);
  w.check('the account nonce is 1', f.nonceLatest === 1, f.nonceLatest);
  w.check('the wallet got exactly one eth_sendTransaction', f.walletSendRequests === 1, f.walletSendRequests);
  w.check('bUSDC arrived', (await tokenBalance(w.wallet.address)) > before);
});

scenario('queued-at-sequencer', '(a) queued; (e) reload: no second swap and no wallet review while the first is queued', async (w) => {
  const page = await w.begin();
  await swapNative(w, page);
  await page.waitText(PENDING);
  w.check('queued: the node counts it as pending', (await nonceOf(w.wallet.address, 'pending')) === 1 && (await nonceOf(w.wallet.address)) === 0);
  w.check('queued: Swap is disabled', await disabled(page, 'Swap'));
  await w.quote(page, 'BLCH', 'bUSDC', '0.02');
  w.check('queued: Swap stays disabled for a new quote', await disabled(page, 'Swap'));
  w.check('queued: with a wallet hash known, no same-nonce wallet review is offered', (await openReview(page)) === false && (await page.button('Review same nonce in wallet')) === null);
  await page.reload();
  await w.connect(page);
  await page.waitText(PENDING);
  await w.quote(page, 'BLCH', 'bUSDC', AMOUNT);
  w.check('after a reload Swap is still disabled and no review is offered', (await disabled(page, 'Swap')) && (await openReview(page)) === false);
  w.check('the wallet got exactly one request', w.wallet.sends().length === 1, w.wallet.sends().length);
  await mineAndFinalize();
  await page.waitText(`/${SWAP}: mined/`, 40_000);
  const f = await w.facts();
  w.check('exactly one router call was mined', f.routerCallsMined === 1, f.routerCallsMined);
  w.check('the account nonce is 1', f.nonceLatest === 1, f.nonceLatest);
});

scenario('queued-reply-lost', '(a) published and queued, but the wallet reply was lost: a swap is never requested again (R309-A1); (e) reload', async (w) => {
  const page = await w.begin();
  w.wallet.state.next.push('broadcast-reply-lost');
  await swapNative(w, page);
  await page.waitText(NO_HASH);
  w.check('queued: the node counts it as pending', (await nonceOf(w.wallet.address, 'pending')) === 1 && (await nonceOf(w.wallet.address)) === 0);
  w.check('queued: Swap is disabled', await disabled(page, 'Swap'));
  w.check('no hash known: no same-nonce wallet review is offered for a swap', (await openReview(page)) === false && (await page.button('Review same nonce in wallet')) === null);
  w.check('queued: one wallet request only', w.wallet.sends().length === 1, w.wallet.sends().length);
  await page.reload();
  await w.connect(page);
  await page.waitText(NO_HASH);
  w.check('after a reload still no review is offered and no wallet request was made', (await openReview(page)) === false && w.wallet.sends().length === 1, w.wallet.sends().length);
  await mineAndFinalize();
  await pasteHash(page, w.wallet.signed[0].hash);
  await page.click('Check transaction hash');
  await page.waitText(`/${SWAP}: mined/`, 40_000);
  const f = await w.facts();
  w.check('exactly one router call was mined', f.routerCallsMined === 1, f.routerCallsMined);
  w.check('the account nonce is 1', f.nonceLatest === 1, f.nonceLatest);
});

scenario('held-in-wallet-review-refused', '(a) queued in the wallet only: the node sees nothing pending, the wallet returned a hash', async (w) => {
  const page = await w.begin();
  w.wallet.state.next.push('hold');
  await swapNative(w, page);
  await page.waitText(PENDING);
  w.check('held: the node sees nothing pending for the account', (await nonceOf(w.wallet.address, 'pending')) === 0);
  w.check('held: Swap is disabled', await disabled(page, 'Swap'));
  // A wallet that takes the nonce from its own tracker would sign a review at the next nonce: two swaps.
  w.wallet.state.ignoreNonce = true;
  const offered = await openReview(page);
  if (offered && (await page.button('Review same nonce in wallet'))) {
    await page.click('Review same nonce in wallet');
    await delay(2500);
  }
  await w.note(page, 'after-review-attempt');
  w.check('held: no same-nonce wallet review is offered once the wallet returned a hash', !offered);
  w.check('held: no second wallet request is made while the wallet already returned a hash', w.wallet.sends().length === 1, w.wallet.sends().length);
  await w.wallet.release(w.wallet.signed[0]);
  for (const s of w.wallet.signed.slice(1)) await w.wallet.release(s).catch(() => {});
  await mineAndFinalize();
  await page.waitText(`/${SWAP}: mined/`, 40_000);
  const f = await w.facts();
  w.check('exactly one router call was mined', f.routerCallsMined === 1, f.routerCallsMined);
  w.check('the account nonce is 1', f.nonceLatest === 1, f.nonceLatest);
});

scenario('reply-lost-wallet-ignores-nonce-no-review', 'R309-A1: the wallet holds the request, its reply was lost, and it would ignore a requested nonce: the page never asks it again, so one swap at most', async (w) => {
  const page = await w.begin();
  w.wallet.state.next.push('hold-reply-lost');
  await swapNative(w, page);
  await page.waitText(NO_HASH);
  w.wallet.state.ignoreNonce = true;
  w.check('reply lost: Swap is disabled', await disabled(page, 'Swap'));
  w.check('reply lost: no same-nonce wallet review is offered for a swap', (await openReview(page)) === false && (await page.button('Review same nonce in wallet')) === null);
  await page.reload();
  await w.connect(page);
  await page.waitText(NO_HASH);
  w.check('after a reload: still no review, still one wallet request', (await openReview(page)) === false && w.wallet.sends().length === 1, w.wallet.sends().length);
  await w.note(page, 'no-review');
  // The wallet publishes what it held. Recovered by its hash from wallet activity.
  await w.wallet.release(w.wallet.signed[0]);
  await mineAndFinalize();
  await pasteHash(page, w.wallet.signed[0].hash);
  await page.click('Check transaction hash');
  await page.waitText(`/${SWAP}: mined/`, 40_000);
  const f = await w.facts();
  w.check('exactly one router call was mined', f.routerCallsMined === 1, f.routerCallsMined);
  w.check('the account nonce is 1', f.nonceLatest === 1, f.nonceLatest);
});

scenario('reply-lost-replacement-refused', 'R309-2P-1: a swap without a wallet hash is not closed by another transaction at its nonce; no second swap is possible while the first request can still be signed', async (w) => {
  const page = await w.begin();
  w.wallet.state.next.push('hold-reply-lost');
  await swapNative(w, page);
  await page.waitText(NO_HASH);
  // The user sends another transaction at nonce 0 from the wallet (here: the wallet's own cancellation) and it is finalized.
  const other = await w.wallet.cancel(w.wallet.signed[0]);
  await mineAndFinalize();
  await pasteHash(page, other.hash);
  await page.click('Check cancellation or replacement');
  await page.waitText('/another transaction at the saved nonce does not prove that the swap cannot execute\\. The hold ends by itself once the swap deadline has passed in a finalized block/');
  await w.note(page, 'replacement-refused');
  w.check('the hold stays: Swap is disabled', await disabled(page, 'Swap'));
  w.check('no "Close local hold as replaced" is offered', (await page.button('Close local hold as replaced')) === null);
  await page.reload();
  await w.connect(page);
  await page.waitText(NO_HASH);
  w.check('after a reload the hold is still there and the wallet was asked once', (await disabled(page, 'Swap')) && w.wallet.sends().length === 1, w.wallet.sends().length);
  const f = await w.facts();
  w.check('no router call of this account was mined', f.routerCallsMined === 0, f.routerCallsMined);
});

scenario('speed-up', '(b) speed-up in the wallet; (e) reload before recovery', async (w) => {
  const page = await w.begin();
  await swapNative(w, page);
  await page.waitText(PENDING);
  const faster = await w.wallet.speedUp(w.wallet.signed[0]);
  await mineAndFinalize();
  await delay(12_000);
  w.check('the page does not claim an outcome for the replaced hash', PENDING.test((await page.text()).replace(/\s+/g, ' ')) && (await disabled(page, 'Swap')));
  await page.reload();
  await w.connect(page);
  await page.waitFor('recovery form', `!!window.__h.labelled('Recover transaction tracking')`);
  await pasteHash(page, faster.hash);
  await page.click('Check transaction hash');
  await page.waitText(`/${SWAP}: mined/`, 40_000);
  await w.note(page, 'recovered');
  const f = await w.facts();
  w.check('exactly one router call was mined, the sped-up one', f.routerCallsMined === 1 && f.minedTransactions[0].hash === faster.hash, f.minedTransactions);
  w.check('the original hash was never mined', (await rpc('eth_getTransactionReceipt', [w.wallet.signed[0].hash])) === null);
  w.check('the wallet got exactly one eth_sendTransaction from the site', f.walletSendRequests === 1, f.walletSendRequests);
});

scenario('cancel', '(c) cancel in the wallet: zero swaps, hold closed only on finalized proof; then one deliberate swap', async (w) => {
  const page = await w.begin();
  await swapNative(w, page);
  await page.waitText(PENDING);
  // A person takes seconds to cancel in the wallet; by then the page has read the queued transaction at the
  // saved nonce and recorded it (a cancellation faster than that read waits for the swap deadline instead).
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate(`Object.keys(localStorage).some((k) => (localStorage.getItem(k) ?? '').includes('"nonceSeen":["0x'))`)) break;
    await delay(250);
  }
  const cancelled = await w.wallet.cancel(w.wallet.signed[0]);
  await mine();
  await pasteHash(page, cancelled.hash);
  await page.click('Check cancellation or replacement');
  await page.waitText('/No canonical finalized replacement is available for that hash yet\\. The original hold remains\\./');
  w.check('a mined but not finalized cancellation does not close the hold', await disabled(page, 'Swap'));
  await finalize();
  await page.click('Check cancellation or replacement');
  await page.waitText('/Replacement verified\\. The original hold remains until you explicitly close it below\\./');
  w.check('a verified cancellation still keeps the hold until the user closes it', await disabled(page, 'Swap'));
  await page.click('Close local hold as replaced');
  await page.waitText('/A different transaction consumed nonce 0 in canonical finalized block \\d+\\. The original request did not execute\\./');
  let f = await w.facts('after-cancel');
  w.check('zero router calls were mined', f.routerCallsMined === 0, f.routerCallsMined);
  w.check('the cancellation consumed nonce 0', f.nonceLatest === 1 && f.minedTransactions[0]?.hash === cancelled.hash, f.minedTransactions);
  await page.waitText('/Pools at finalized block \\d+/');
  await swapNative(w, page);
  await page.waitText(PENDING);
  await mineAndFinalize();
  await page.waitText(`/${SWAP}: mined/`, 40_000);
  f = await w.facts();
  w.check('the deliberate swap after the cancellation was mined once', f.routerCallsMined === 1 && f.nonceLatest === 2, f);
});

scenario('dropped', '(d) the wallet returned a hash that never reaches a block; (e) reload', async (w) => {
  const page = await w.begin();
  await swapNative(w, page);
  await page.waitText(PENDING);
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate(`Object.keys(localStorage).some((k) => (localStorage.getItem(k) ?? '').includes('"nonceSeen":["0x'))`)) break;
    await delay(250);
  }
  await rpc('anvil_dropTransaction', [w.wallet.signed[0].hash]);
  w.check('dropped: the node no longer knows the transaction', (await rpc('eth_getTransactionByHash', [w.wallet.signed[0].hash])) === null);
  await mineAndFinalize();
  await delay(12_000);
  w.check('dropped: the hold stays and Swap stays disabled', PENDING.test((await page.text()).replace(/\s+/g, ' ')) && (await disabled(page, 'Swap')));
  w.check('dropped: the page did not ask the wallet again', w.wallet.sends().length === 1, w.wallet.sends().length);
  await page.reload();
  await w.connect(page);
  await page.waitText(PENDING);
  await w.quote(page, 'BLCH', 'bUSDC', AMOUNT);
  w.check('dropped, after a reload: Swap is still disabled', await disabled(page, 'Swap'));
  let f = await w.facts('while-dropped');
  w.check('dropped: nothing of this account was mined', f.minedTransactions.length === 0, f.minedTransactions);
  // The documented way out: the next transaction of the account at that nonce, sent from the wallet itself.
  const other = await w.wallet.sendOwn(0);
  await mineAndFinalize();
  await pasteHash(page, other.hash);
  await page.click('Check cancellation or replacement');
  await page.waitText('/Replacement verified\\./');
  await page.click('Close local hold as replaced');
  await page.waitText('/The original request did not execute\\./');
  await page.waitText('/Pools at finalized block \\d+/');
  await swapNative(w, page);
  await page.waitText(PENDING);
  await mineAndFinalize();
  await page.waitText(`/${SWAP}: mined/`, 40_000);
  f = await w.facts();
  w.check('the deliberate retry yields exactly one router call', f.routerCallsMined === 1, f.routerCallsMined);
  w.check('nonces: 0 other transaction, 1 the swap', f.nonceLatest === 2 && f.minedTransactions.find((t) => t.router)?.nonce === 1, f.minedTransactions);
  w.check('the site made exactly two wallet requests, one per deliberate click', f.walletSendRequests === 2, f.walletSendRequests);
});

scenario('rejected', 'user rejection (4001) releases the hold; the next swap is the only one', async (w) => {
  const page = await w.begin();
  w.wallet.state.next.push('reject');
  await swapNative(w, page);
  await page.waitText('/The wallet request was rejected by you\\. Nothing was sent\\./');
  w.check('rejected: no hold is left in storage', (await page.evaluate(`Object.keys(localStorage).filter((k) => k.startsWith('postern.mainnet.pendingSwap')).length`)) === 0);
  await swapNative(w, page);
  await page.waitText(PENDING);
  await mineAndFinalize();
  await page.waitText(`/${SWAP}: mined/`, 40_000);
  const f = await w.facts();
  w.check('exactly one router call was mined', f.routerCallsMined === 1 && f.nonceLatest === 1, f);
});

for (const [mode, expectNote] of [['error-fee-data', true], ['error-fee-data-lost', false]])
  scenario(`fee-refusal-${mode === 'error-fee-data' ? 'with-data' : 'data-lost'}`, `the wallet's node refuses the fee; the wallet ${expectNote ? 'passes error.data on' : 'loses error.data'}`, async (w) => {
    const page = await w.begin();
    w.wallet.state.next.push(mode);
    await swapNative(w, page);
    await page.waitText(NO_HASH);
    const text = (await page.text()).replace(/\s+/g, ' ');
    w.check(`the fee diagnostic is ${expectNote ? 'shown' : 'not invented'}`, /RPC fee diagnostic \(not bound to your wallet's signed transaction\)/.test(text) === expectNote);
    w.check('the hold stays and Swap is disabled', await disabled(page, 'Swap'));
    await delay(11_000);
    w.check('no retry and no fee increase: one wallet request', w.wallet.sends().length === 1, w.wallet.sends().length);
    await mineAndFinalize();
    const f = await w.facts();
    w.check('nothing was mined', f.minedTransactions.length === 0, f.minedTransactions);
    await w.note(page, 'refused');
  });

scenario('reload-while-wallet-open', '(e) the page is reloaded while the wallet prompt is open; the wallet then confirms', async (w) => {
  const page = await w.begin();
  w.wallet.state.next.push('never-answer');
  await swapNative(w, page);
  await page.waitFor('wallet prompt', `true`);
  for (let i = 0; i < 50 && w.wallet.open.length === 0; i++) await delay(100);
  w.check('the wallet prompt is open', w.wallet.open.length === 1);
  w.check('the intent is saved before the wallet answers', (await page.evaluate(`Object.keys(localStorage).filter((k) => k.startsWith('postern.mainnet.pendingSwap')).length`)) === 1);
  await page.reload();
  await w.connect(page);
  await page.waitText(NO_HASH);
  await w.quote(page, 'BLCH', 'bUSDC', AMOUNT);
  w.check('after the reload Swap is disabled', await disabled(page, 'Swap'));
  // The user confirms in the wallet after all; the reloaded page never sees the reply.
  const request = w.wallet.open[0].request;
  w.wallet.state.next.push('broadcast');
  const hash = await w.wallet.handle('eth_sendTransaction', [request]);
  await mineAndFinalize();
  await pasteHash(page, hash);
  await page.click('Check transaction hash');
  await page.waitText(`/${SWAP}: mined/`, 40_000);
  const f = await w.facts();
  w.check('exactly one router call was mined', f.routerCallsMined === 1 && f.nonceLatest === 1, f);
});

scenario('two-tabs', '(f) two tabs of one account: sequential and simultaneous clicks', async (w) => {
  const a = await w.begin();
  const b = await w.tab();
  await w.connect(b);
  await w.quote(a, 'BLCH', 'bUSDC', AMOUNT);
  await w.quote(b, 'BLCH', 'bUSDC', AMOUNT);
  w.wallet.state.next.push('never-answer');
  await Promise.all([a.click('Swap'), b.click('Swap')]);
  await delay(4000);
  w.check('simultaneous clicks in two tabs open exactly one wallet prompt', w.wallet.open.length === 1 && w.wallet.sends().length === 1, { open: w.wallet.open.length, sends: w.wallet.sends().length });
  w.record.page.tabA = await a.labelled('Transactions');
  w.record.page.tabB = await b.labelled('Transactions');
  w.check('both tabs have Swap disabled', (await disabled(a, 'Swap')) && (await disabled(b, 'Swap')));
  // The user confirms the one prompt.
  w.wallet.state.next.push('broadcast');
  const { request, resolve } = w.wallet.open[0];
  resolve(await w.wallet.handle('eth_sendTransaction', [request]));
  await a.waitText(PENDING).catch(() => {});
  await b.waitText(PENDING).catch(() => {});
  await w.quote(b, 'BLCH', 'bUSDC', '0.02');
  w.check('while it is queued the other tab cannot swap either', await disabled(b, 'Swap'));
  await mineAndFinalize();
  await delay(14_000);
  const f = await w.facts();
  // wallet.handle was called once more by the harness to play the confirmation: 2 entries, 1 prompt.
  w.check('exactly one router call was mined', f.routerCallsMined === 1 && f.nonceLatest === 1, f);
  const texts = [(await a.text()).replace(/\s+/g, ' '), (await b.text()).replace(/\s+/g, ' ')];
  w.check('one tab reports the swap mined and neither still shows a hold', texts.some((t) => new RegExp(`${SWAP}: mined`).test(t)) && texts.every((t) => !PENDING.test(t)), texts.map((t) => /: (mined|pending|unknown)/.exec(t)?.[0] ?? null));
  for (const t of [a, b]) await (await t.button('Refresh') ? t.click('Refresh') : null);
  await w.quote(b, 'BLCH', 'bUSDC', AMOUNT);
  w.check('after finality the other tab can swap again', !(await disabled(b, 'Swap')));
});

scenario('approve-then-swap', '(g) approve, then swap: order, exact allowance, no swap while the approval is queued', async (w) => {
  const page = await w.begin({ busdc: 50_000_000n });
  await w.quote(page, 'bUSDC', 'BLCH', '10');
  w.check('before the approval Swap is disabled', await disabled(page, 'Swap'));
  await page.click('Approve 10 bUSDC');
  await page.waitText(PENDING);
  w.check('approval queued: Swap and Approve are both disabled', (await disabled(page, 'Swap')) && (await page.button('Approve 10 bUSDC'))?.disabled !== false);
  await mineAndFinalize();
  await page.waitText('/Approve 10 bUSDC: mined/', 40_000);
  w.check('the allowance is exactly the quoted amount', (await allowance(w.wallet.address)) === 10_000_000n, await allowance(w.wallet.address));
  await page.waitText('/Pools at finalized block \\d+/');
  await w.quote(page, 'bUSDC', 'BLCH', '10');
  w.check('after the finalized approval no second approval is asked', (await page.button('Approve 10 bUSDC')) === null);
  await page.click('Swap');
  await page.waitText(PENDING);
  await mineAndFinalize();
  await page.waitText('/Swap 10 bUSDC for BLCH: mined/', 40_000);
  const f = await w.facts();
  w.check('approval at nonce 0, swap at nonce 1, one router call', f.routerCallsMined === 1 && f.minedTransactions.length === 2 && f.minedTransactions[0].to === config.asset.toLowerCase() && f.minedTransactions[1].router && f.minedTransactions[1].nonce === 1, f.minedTransactions);
  w.check('10 bUSDC left the account and the allowance is spent', (await tokenBalance(w.wallet.address)) === 40_000_000n && (await allowance(w.wallet.address)) === 0n);
});

scenario('wallet-ignores-site-fields', 'a wallet that picks nonce and fees itself, with nothing else queued', async (w) => {
  const page = await w.begin();
  w.wallet.state.ignoreNonce = true;
  w.wallet.state.ignoreFees = true;
  await swapNative(w, page);
  await page.waitText(PENDING);
  await mineAndFinalize();
  await page.waitText(`/${SWAP}: mined/`, 40_000);
  const f = await w.facts();
  w.check('exactly one router call was mined', f.routerCallsMined === 1 && f.nonceLatest === 1, f);
});

scenario('wallet-own-queue-ignores-nonce', 'a wallet with its own unpublished transaction ignores the requested nonce: the swap executes at another nonce', async (w) => {
  const page = await w.begin();
  // The wallet holds an older transaction of its own at nonce 0 that the node never saw (for example evicted).
  w.wallet.state.next.push('hold');
  const own = await w.wallet.handle('eth_sendTransaction', [{ from: w.wallet.address, to: `0x${'5e'.repeat(20)}`, value: '0x1', gas: '0x5208' }]);
  w.wallet.requests.pop();
  w.wallet.state.ignoreNonce = true;
  await swapNative(w, page);
  await page.waitText(PENDING);
  w.check('the site asked for nonce 0 and the wallet signed nonce 1', w.wallet.signed[1].requestedNonce === '0' && w.wallet.signed[1].tx.nonce === 1, w.wallet.signed[1]);
  // The user un-sticks the older transaction in the wallet; both are then mined in nonce order.
  await w.wallet.release(w.wallet.signed[0]);
  await mineAndFinalize();
  await delay(12_000);
  await w.note(page, 'after-both-mined');
  const f = await w.facts();
  w.check('one router call was mined, at nonce 1', f.routerCallsMined === 1 && f.minedTransactions.find((t) => t.router)?.nonce === 1, f.minedTransactions);
  const text = (await page.text()).replace(/\s+/g, ' ');
  w.check('the page reports the swap as mined although the wallet used another nonce', new RegExp(`${SWAP}: mined`).test(text), /: (mined|pending|unknown)[^.]*\./.exec(text)?.[0]);
  // The dangerous alternative: declaring the request "not executed" from the transaction at nonce 0.
  if (!new RegExp(`${SWAP}: mined`).test(text)) {
    await pasteHash(page, own);
    await page.click('Check cancellation or replacement');
    await delay(3000);
    const after = (await page.text()).replace(/\s+/g, ' ');
    w.check('the page does not offer to close the hold as "did not execute"', !/Replacement verified/.test(after), (await page.labelled('Recover transaction tracking'))?.slice(-300));
  }
});

// ---- the L2 new-slot price (frontend/src/mainnet/newslotfee.ts): the wallet's node applies the L2 admission rule ----
const SLOT_PRICE = 200_000_000_000_000n; // the network file's freshSlotPriceWei and the settler's fresh_slot_price_wei
const feesOf = (request) => ({ tip: request.maxPriorityFeePerGas === undefined ? null : BigInt(request.maxPriorityFeePerGas), max: request.maxFeePerGas === undefined ? null : BigInt(request.maxFeePerGas) });

scenario('first-approve-priced', 'item 2: a first approve passes the L2 admission rule on the first wallet request, with no fee typed', async (w) => {
  const page = await w.begin({ busdc: 50_000_000n });
  w.wallet.state.admission = { priceWei: SLOT_PRICE };
  await w.quote(page, 'bUSDC', 'BLCH', '10');
  await page.click('Approve 10 bUSDC');
  await page.waitText(PENDING);
  const [request] = w.wallet.sends().map((r) => r.params[0]);
  const fees = feesOf(request);
  const [verdict] = w.wallet.admissions;
  w.check('one wallet request, and it carries both fee fields', w.wallet.sends().length === 1 && fees.tip !== null && fees.max !== null, request);
  w.check('the node measured exactly one new storage slot (the allowance)', verdict?.freshSlots === 1n, verdict);
  w.check("the page's priority fee meets the node's rule and is admitted", verdict?.admitted === true && fees.tip >= verdict.required, { tip: fees.tip, required: verdict?.required, gasUsed: verdict?.gasUsed });
  w.check('the fee is not excessive: at most 1.5 x the required priority fee', fees.tip * 2n <= verdict.required * 3n, { tip: fees.tip, required: verdict?.required });
  w.check('the request still names the saved nonce', request.nonce === '0x0', request.nonce);
  await mineAndFinalize();
  await page.waitText('/Approve 10 bUSDC: mined/', 40_000);
  w.check('the allowance is exactly the quoted amount', (await allowance(w.wallet.address)) === 10_000_000n, await allowance(w.wallet.address));
  // The swap that follows: priced by the same rule, admitted on its first request.
  await page.waitText('/Pools at finalized block \\d+/');
  await w.quote(page, 'bUSDC', 'BLCH', '10');
  await page.click('Swap');
  await page.waitText(PENDING);
  const swapVerdict = w.wallet.admissions[1];
  w.check('the swap after it is admitted on its first request', w.wallet.sends().length === 2 && swapVerdict?.admitted === true, swapVerdict);
  await mineAndFinalize();
  await page.waitText('/Swap 10 bUSDC for BLCH: mined/', 40_000);
  const f = await w.facts();
  w.check('two transactions mined at nonces 0 and 1, one router call, nothing refused', f.minedTransactions.length === 2 && f.routerCallsMined === 1 && w.wallet.signed.every((s) => !s.refused), f.minedTransactions);
  w.record.admission = w.wallet.admissions;
});

scenario('first-swap-priced', 'item 2: a first swap into a token the account never held creates a balance slot and is admitted on the first request', async (w) => {
  const page = await w.begin();
  w.wallet.state.admission = { priceWei: SLOT_PRICE };
  await swapNative(w, page);
  await page.waitText(PENDING);
  const [request] = w.wallet.sends().map((r) => r.params[0]);
  const fees = feesOf(request);
  const [verdict] = w.wallet.admissions;
  w.check('the node measured at least one new slot (the bUSDC balance of a new holder)', verdict?.freshSlots >= 1n, verdict);
  w.check('one wallet request with both fee fields, admitted', w.wallet.sends().length === 1 && fees.tip !== null && verdict?.admitted === true && fees.tip >= verdict.required, { tip: fees.tip, required: verdict?.required, freshSlots: verdict?.freshSlots });
  await mineAndFinalize();
  await page.waitText(`/${SWAP}: mined/`, 40_000);
  const f = await w.facts();
  w.check('exactly one router call was mined', f.routerCallsMined === 1 && f.nonceLatest === 1, f);
  // The same swap again creates no slot: the page leaves the fee to the wallet.
  await page.waitText('/Pools at finalized block \\d+/');
  await swapNative(w, page);
  await page.waitText(PENDING);
  const second = w.wallet.sends()[1].params[0];
  const again = w.wallet.admissions[1];
  w.check('a repeat swap creates no slot: the page sends no fee fields and the node admits the wallet fee', again?.admitted === true && again.freshSlots === 0n && feesOf(second).tip === null, { again, second: feesOf(second) });
  await mineAndFinalize();
  await page.waitText(`/${SWAP}: mined/`, 40_000);
  w.record.admission = w.wallet.admissions;
});

scenario('first-approve-wallet-ignores-fees', 'item 2: a wallet that ignores the suggested fee is refused once; the same-nonce review then goes through without typing a fee', async (w) => {
  const page = await w.begin({ busdc: 50_000_000n });
  w.wallet.state.admission = { priceWei: SLOT_PRICE };
  w.wallet.state.ignoreFees = true;
  await w.quote(page, 'bUSDC', 'BLCH', '10');
  await page.click('Approve 10 bUSDC');
  await page.waitText(NO_HASH);
  const text = (await page.text()).replace(/\s+/g, ' ');
  w.check('the refusal is explained with the node figures and nothing was published', /RPC fee diagnostic \(not bound to your wallet's signed transaction\)/.test(text) && w.wallet.admissions[0]?.admitted === false && (await nonceOf(w.wallet.address, 'pending')) === 0, w.wallet.admissions[0]);
  // The user's wallet now takes the site's fee (or the user accepted "site suggested").
  w.wallet.state.ignoreFees = false;
  await openReview(page);
  await page.click('Review same nonce in wallet');
  await page.waitText('/Wallet returned 0x[0-9a-f]{64}\\./');
  const review = w.wallet.sends()[1]?.params[0];
  w.check('the review asks for the same nonce and carries the page fee', review?.nonce === '0x0' && feesOf(review).tip !== null, review);
  w.check('the node admits it', w.wallet.admissions[1]?.admitted === true, w.wallet.admissions[1]);
  await mineAndFinalize();
  await page.waitText('/Approve 10 bUSDC: mined/', 40_000);
  const f = await w.facts();
  w.check('one approval mined at nonce 0, allowance exact', f.minedTransactions.length === 1 && f.nonceLatest === 1 && (await allowance(w.wallet.address)) === 10_000_000n, f.minedTransactions);
  w.record.admission = w.wallet.admissions;
});

// ---- the L2 candidate's per-sender credit rule (bloch-l2-evm 1b55ce1/28b74c4): a MODEL of it in the wallet's node
// and in the page's RPC (bloch_admissionQuote); the real candidate RPC is exercised by newslot-rpc-check.mjs ----
const CREDIT = { uncoveredMaxGas: 1_500_000n, maxTxGas: 5_000_000n };
const NOT_PAID = /This wallet has not paid for an L2 transaction yet\. If L2 blocks are full, its first call can wait whatever fee it offers; one plain transfer first \(to your own address is enough\) with a priority fee of at least [0-9.]+ gwei avoids that\./;
const FEE_ADVICE = /raise the (fee|tip)|increase the (fee|tip)|higher (fee|tip) (will|would|helps)|try a higher|retry (at|with) a higher/i;
const flat = async (page) => (await page.text()).replace(/\s+/g, ' ');
const creditOn = (w, rule = CREDIT) => {
  w.wallet.state.admission = { priceWei: SLOT_PRICE, credit: rule };
  admissionQuote = (call) => w.wallet.quote(call);
};

scenario('credit-fresh-wallet-approve-then-swap', 'credit rule: a fresh wallet\'s first approve and the swap after it are executable under the 1,500,000 limit and admitted on the first request', async (w) => {
  const page = await w.begin({ busdc: 50_000_000n });
  creditOn(w);
  await w.quote(page, 'bUSDC', 'BLCH', '10');
  await page.click('Approve 10 bUSDC');
  await page.waitText(PENDING);
  const [request] = w.wallet.sends().map((r) => r.params[0]);
  const [verdict] = w.wallet.admissions;
  w.check('the page asked the node for its quote and the node called the approve executable for a wallet without credit', w.wallet.quotes[0]?.executable === true && w.wallet.quotes[0].covered === false && w.wallet.quotes[0].credit_wei === '0', w.wallet.quotes[0]);
  w.check('the gas limit the page asks is 100,000, below the 1,500,000 limit', BigInt(request.gas) === 100_000n && BigInt(request.gas) <= CREDIT.uncoveredMaxGas, request.gas);
  w.check('one wallet request, admitted by fee and by credit rule', w.wallet.sends().length === 1 && verdict?.admitted === true && verdict.credit.executable === true, verdict);
  await mineAndFinalize();
  await page.waitText('/Approve 10 bUSDC: mined/', 40_000);
  const earned = await w.wallet.creditWei();
  w.check('the included approve earned credit (gas used x tip)', earned > 0n, earned);
  await page.waitText('/Pools at finalized block \\d+/');
  await w.quote(page, 'bUSDC', 'BLCH', '10');
  await page.click('Swap');
  await page.waitText(PENDING);
  const swap = w.wallet.sends()[1]?.params[0];
  const swapVerdict = w.wallet.admissions[1];
  w.check('the swap asks 250,000 gas (one hop) and is admitted on its first request', BigInt(swap.gas) === 250_000n && swapVerdict?.admitted === true, { gas: swap.gas, swapVerdict });
  await mineAndFinalize();
  await page.waitText('/Swap 10 bUSDC for BLCH: mined/', 40_000);
  const f = await w.facts();
  w.check('two transactions mined at nonces 0 and 1, one router call, nothing refused', f.minedTransactions.length === 2 && f.routerCallsMined === 1 && w.wallet.signed.every((s) => !s.refused), f.minedTransactions);
  w.record.admission = { admissions: w.wallet.admissions, quotes: w.wallet.quotes };
});

scenario('credit-fresh-wallet-first-swap', 'credit rule: a fresh wallet\'s first swap is executable, and the page tells the wallet without credit about the plain transfer without advising a higher fee', async (w) => {
  const page = await w.begin();
  creditOn(w);
  // While the wallet is open the page tells the wallet without credit about the plain transfer.
  w.wallet.state.next.push('never-answer');
  await swapNative(w, page);
  for (let i = 0; i < 100 && w.wallet.open.length === 0; i++) await delay(100);
  w.check('while the wallet is open the page says what a wallet without credit can do first', NOT_PAID.test(await flat(page)), (await flat(page)).match(/Confirm in your wallet\..{0,500}/)?.[0]);
  w.wallet.open[0].reject({ code: 4001, message: 'User rejected the request.' });
  await page.waitText('/The wallet request was rejected by you\\. Nothing was sent\\./');
  await swapNative(w, page);
  await page.waitText(PENDING);
  const request = w.wallet.sends()[1].params[0];
  const [verdict] = w.wallet.admissions;
  w.check('the swap asks 250,000 gas, below the limit, and the node admits it from a wallet with no credit', BigInt(request.gas) === 250_000n && verdict?.admitted === true && verdict.credit.covered === false, verdict);
  w.check('the quote named a first-transfer fee for the wallet without credit', /^[1-9][0-9]*$/.test(w.wallet.quotes[0]?.first_transfer_priority_fee_wei ?? ''), w.wallet.quotes[0]);
  await mineAndFinalize();
  await page.waitText(`/${SWAP}: mined/`, 40_000);
  const f = await w.facts();
  w.check('exactly one router call was mined', f.routerCallsMined === 1 && f.nonceLatest === 1, f);
  w.check('the page never advised a higher fee', !FEE_ADVICE.test(await flat(page)));
  w.record.admission = { admissions: w.wallet.admissions, quotes: w.wallet.quotes };
});

scenario('credit-needs-credit-refused-then-transfer', 'credit rule: a call above the limit of a wallet without credit (stands for a route above 1,500,000 gas; the launch page builds one-hop routes only) sends nothing and says what helps; one plain transfer then makes it go', async (w) => {
  const page = await w.begin();
  // The limit of this node is below the swap's 250,000 gas, so the page meets the refusal a longer route would meet.
  creditOn(w, { uncoveredMaxGas: 200_000n, maxTxGas: 5_000_000n });
  await swapNative(w, page);
  await page.waitText('/The L2 does not take this transaction from a wallet that has not paid for an L2 transaction yet/');
  const text = await flat(page);
  w.check('the page names the gas limit and the limit of the node', /its gas limit of 250000 is above the 200000 the L2 allows such a wallet for one call/.test(text));
  w.check('it says a higher fee does not help and what does', /A higher fee does not help\. What helps: a smaller route \(fewer hops\), or one earlier transaction from this wallet/.test(text) && /Nothing was sent\./.test(text));
  w.check('no other fee advice anywhere on the page', !FEE_ADVICE.test(text.replaceAll('A higher fee does not help', '')));
  w.check('the wallet was not asked and no hold was created', w.wallet.sends().length === 0 && !(await disabled(page, 'Swap')), w.wallet.sends().length);
  // The user follows the text: one plain transfer to their own address at the fee the page named.
  const named = /one plain transfer with a priority fee of (\d+) wei per gas earns enough in one step/.exec(text);
  w.check('the page named the fee of the transfer', !!named, text.slice(text.indexOf('The L2 does not take'), text.indexOf('The L2 does not take') + 500));
  const base = BigInt((await rpc('eth_getBlockByNumber', ['latest', false])).baseFeePerGas);
  const transfer = await w.wallet.plainTransfer(BigInt(named[1]), base);
  w.check('the plain transfer of the wallet without credit is not refused by the credit rule', transfer.broadcast === true && w.wallet.admissions.at(-1)?.credit.executable === true, w.wallet.admissions.at(-1));
  await mineAndFinalize();
  await swapNative(w, page);
  await page.waitText(PENDING);
  const verdict = w.wallet.admissions.at(-1);
  w.check('the same swap is now covered by the credit the transfer earned, and admitted on its first request', w.wallet.sends().length === 1 && verdict?.admitted === true && verdict.credit.covered === true, verdict);
  await mineAndFinalize();
  await page.waitText(`/${SWAP}: mined/`, 40_000);
  const f = await w.facts();
  w.check('one transfer and one router call mined, nonces 0 and 1', f.minedTransactions.length === 2 && f.routerCallsMined === 1 && f.nonceLatest === 2, f.minedTransactions);
  w.record.admission = { admissions: w.wallet.admissions, quotes: w.wallet.quotes };
});

scenario('credit-refusal-through-wallet', 'credit rule: when the page\'s RPC has no quote (a gateway without the route) and the wallet\'s node refuses needs-credit, the refusal is explained without fee advice and nothing was published', async (w) => {
  const page = await w.begin();
  w.wallet.state.admission = { priceWei: SLOT_PRICE, credit: { uncoveredMaxGas: 200_000n, maxTxGas: 5_000_000n } };
  await swapNative(w, page);
  await page.waitText(NO_HASH);
  const text = await flat(page);
  w.check('the page priced with the access list (no quote route) and asked the wallet once', w.wallet.quotes.length === 0 && w.wallet.sends().length === 1, w.wallet.quotes.length);
  w.check('the node refused needs-credit and nothing was published', w.wallet.admissions[0]?.credit.not_executable_reason === 'needs-credit' && (await nonceOf(w.wallet.address, 'pending')) === 0, w.wallet.admissions[0]);
  w.check('the refusal is explained as the credit rule', /RPC diagnostic \(not bound to your wallet's signed transaction\): The L2 does not take this transaction from a wallet that has not paid for an L2 transaction yet/.test(text), text.slice(Math.max(0, text.indexOf('RPC diagnostic')), text.indexOf('RPC diagnostic') + 400));
  w.check('without the fee diagnostic and without fee advice', !/RPC fee diagnostic/.test(text) && !FEE_ADVICE.test(text.replaceAll('A higher fee does not help', '').replaceAll('no retry or fee increase was performed', '')));
  w.record.admission = { admissions: w.wallet.admissions };
});

scenario('clock-beyond-heartbeat-refused', 'R309-2P-5 kept: a device clock more than the heartbeat plus its margin ahead of the latest block builds no swap', async (w) => {
  w.clockAheadSeconds = 27 * 3600;
  const page = await w.begin();
  await swapNative(w, page);
  await page.waitText('/27 hours ahead of the latest L2 block\\. The L2 makes a block at least every 24 hours even when it is idle/');
  w.check('the wallet was not asked', w.wallet.sends().length === 0, w.wallet.sends().length);
  w.check('no hold was created: Swap is still offered', !(await disabled(page, 'Swap')));
});

// Kept last: it moves the chain clock two hours ahead of the wall clock, which later scenarios' deadlines would not survive.
scenario('reply-lost-never-published-expires', 'R309-A1: a swap the wallet never publishes: the hold ends by itself, with no wallet request, once the deadline has passed in a finalized block', async (w) => {
  const page = await w.begin();
  w.wallet.state.next.push('hold-reply-lost');
  await swapNative(w, page);
  await page.waitText(NO_HASH);
  w.check('reply lost: Swap is disabled', await disabled(page, 'Swap'));
  // Finalized blocks before the deadline release nothing.
  await mineAndFinalize();
  await delay(2500);
  w.check('before the deadline the hold stays', (await disabled(page, 'Swap')) && NO_HASH.test((await page.text()).replace(/\s+/g, ' ')));
  // Chain time passes the deadline (the default deadline is 60 minutes) and that block becomes final.
  await rpc('evm_increaseTime', [hex(2 * 3600)]);
  await mineAndFinalize();
  await page.waitText('/no transaction of this account used nonce 0 before it: sent from an ordinary wallet account this swap did not execute, and it can no longer execute/', 40_000);
  await w.note(page, 'expired');
  // The release refreshes the finalized view and drops the old quote: with a new quote Swap is offered again.
  await page.waitText('/Pools at finalized block \\d+/');
  await w.quote(page, 'BLCH', 'bUSDC', AMOUNT);
  let offered = false;
  for (let i = 0; i < 40 && !offered; i++) {
    offered = !(await disabled(page, 'Swap'));
    if (!offered) await delay(500);
  }
  w.check('the hold is gone: Swap is offered again', offered);
  const f = await w.facts();
  w.check('no router call of this account was mined', f.routerCallsMined === 0, f.routerCallsMined);
  w.check('the account nonce is still 0', f.nonceLatest === 0, f.nonceLatest);
  w.check('the wallet was asked exactly once', f.walletSendRequests === 1, f.walletSendRequests);
  // Signed late, the held request can only revert: it never becomes a second swap.
  await w.wallet.release(w.wallet.signed[0]).catch(() => {});
  await mineAndFinalize();
  const late = await w.facts();
  w.check('the held request, published after the deadline, executes nothing', late.routerCallsMined === 0, late.minedTransactions);
});

// After the expiry scenario (the chain clock is already ahead there) and last of all: it sets the next block's time.
scenario('idle-chain-swap-lands-in-the-second-block', 'R309-3P-1, 4P-3: an idle L2 does not close the page; the deadline is raised to cover the block after the next, the user is told the wait, and the swap is mined at a block time a 60-minute deadline would have missed', async (w) => {
  // The page's clock is 5 hours ahead of the wall clock: hours ahead of the latest block, as on a quiet chain.
  w.clockAheadSeconds = 5 * 3600;
  const page = await w.begin();
  const before = await tokenBalance(w.wallet.address);
  const deviceNow = Math.floor(Date.now() / 1000) + w.clockAheadSeconds;
  await swapNative(w, page);
  await page.waitText('/The L2 has made no block for \\d+ (hours|minutes): it is idle, and it makes a block only when it has work\\. Your swap starts it again: the first block after a pause takes no transactions, so the swap is included in the block after it, in about 60 minutes/');
  await page.waitText('/The deadline was raised from 60 to 75 minutes to cover that wait/');
  await page.waitText(PENDING);
  await w.note(page, 'idle-notice');
  w.check('the wallet was asked once', w.wallet.sends().length === 1, w.wallet.sends().length);
  // swapExactBLCHForTokens(amountOutMin, path, to, deadline): the deadline is the fourth head word.
  const signedDeadline = Number(BigInt(`0x${w.wallet.sends()[0].params[0].data.slice(10 + 3 * 64, 10 + 4 * 64)}`));
  w.check('the signed deadline is 75 minutes from the page clock', Math.abs(signedDeadline - (deviceNow + 75 * 60)) <= 90, signedDeadline - deviceNow);
  // What must be on screen WITHOUT a click while a swap is held (reviewer 309's ruling, items a to e), read with
  // visibleText: the text of clipped or inert regions does not count. Only the idle-chain explanation may sit
  // behind "Why is this waiting?"; it is checked after that one click, on screen.
  const seen = await page.visibleText();
  const QUIET = /on a quiet chain the finalized block that ends this wait can be up to 24 hours away/;
  w.check('held swap, on screen without a click: the transaction with its state and its hash', new RegExp(`${SWAP} ?: ?pending ?0x[0-9a-f]{64}`).test(seen), seen.slice(0, 600));
  w.check('held swap, on screen without a click: "Do not resend with a new nonce; Swap stays disabled until the outcome is known."', seen.includes('Do not resend with a new nonce; Swap stays disabled until the outcome is known.'));
  w.check('held swap, on screen without a click: how the hold ends, with the countdown to the saved deadline', seen.includes("This hold ends with the swap's finalized receipt, or once its deadline has passed in a finalized block.") && /Saved deadline in (\d+:)?\d{1,2}:\d\d \(at \d\d:\d\d\), by this device's clock\./.test(seen), /Saved deadline[^.]*\./.exec(seen)?.[0]);
  w.check('held swap, on screen without a click: time or an empty explorer result cannot clear the hold, and nothing else on the page clears it', seen.includes('Time passing or an empty explorer result cannot clear the hold.') && seen.includes('Nothing else on this page clears a hold.'));
  const reach = async (name) => (await page.reachableButton(name)) !== null;
  w.check('held swap, on screen without a click: the hash field and both checks', seen.includes('Transaction hash from wallet activity') && (await reach('Check transaction hash')) && (await reach('Check cancellation or replacement')));
  w.check('the idle-chain explanation is one click away: not on screen yet, and its button "Why is this waiting?" is', !QUIET.test(seen) && (await reach('Why is this waiting?')), QUIET.test(seen));
  await page.click('Why is this waiting?');
  w.check('the waiting user is told what ends the wait on a quiet chain (on screen after "Why is this waiting?")', QUIET.test(await page.visibleText()));
  // The block that takes the swap is the second after the pause: its time is 65 minutes after the swap was signed,
  // past what the default 60 minutes would have allowed and inside the raised deadline.
  await rpc('evm_setNextBlockTimestamp', [hex(deviceNow + 65 * 60)]);
  await mineAndFinalize();
  await page.waitText(`/${SWAP}: mined/`, 40_000);
  const f = await w.facts();
  w.check('exactly one router call was mined (not reverted EXPIRED)', f.routerCallsMined === 1, f.minedTransactions);
  w.check('bUSDC arrived', (await tokenBalance(w.wallet.address)) > before);
});

let failed = 0;
try {
  await rpc('evm_setAutomine', [false]);
  for (const s of scenarios) if (!only || only.includes(s.name)) await runScenario(s);
} finally {
  await rpc('evm_setAutomine', [true]).catch(() => {});
  await browser.close();
  gateway.close();
}
for (const s of evidence.scenarios) failed += s.assertions.filter((a) => !a.ok).length;
evidence.summary = {
  scenarios: evidence.scenarios.length,
  assertions: evidence.scenarios.reduce((n, s) => n + s.assertions.length, 0),
  failed,
  result: failed === 0 ? 'PASS' : 'FAIL',
};
writeFileSync(join(config.out, 'result.json'), `${JSON.stringify(evidence, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
say(`browser wallet scenarios: ${evidence.summary.result}, ${evidence.summary.scenarios} scenarios, ${evidence.summary.assertions} assertions, ${failed} failed (${join(config.out, 'result.json')})`);
process.exit(failed === 0 ? 0 : 1);
