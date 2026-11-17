#!/usr/bin/env node
// Screenshots of every state of the frontend, for design review. Not a test: it asserts nothing about the chain.
//
//   node screens.mjs <wallet-harness.json> [--only <state>[,<state>…]] [--variants dark-1440,light-390,…] [--out <dir>] [--list]
//
// <wallet-harness.json> is the file wallet-hook.sh writes while it holds the rehearsal chain (WALLET_HOOK_HOLD); the
// wrapper screens-run.sh brings that chain up, runs this file and releases it (or keeps it up: `--keep`). Like
// scenarios.mjs it drives the built production bundle in the installed Chrome, headless, over the DevTools protocol,
// with the simulated wallet of wallet.mjs and throwaway accounts on the loopback anvil chain. Node 24 built-ins and
// the locked frontend dependencies only.
//
// Every state is driven once and then captured in four variants without a reload: {dark, light} x {1440x900 desktop,
// 390x844 phone at device scale factor 2, mobile}. A capture is the full page (the whole scroll size). Files:
//
//   <out>/<nn>-<state>--<dark|light>--<390|1440>.png      and      <out>/screens.json  (state -> status, files, notes)
//
// <out> is SCREENS_OUT, --out, or ~/Desktop/BLOCH-L2-DEX-BRIDGE-20261030/agents/318-evidence/screens.
//
// Theme contract of the app: document.documentElement.dataset.theme = 'dark' | 'light', persisted in
// localStorage['postern.theme.v1']. Both are set, prefers-color-scheme is emulated to match, prefers-reduced-motion is
// emulated as `reduce`, and two animation frames pass before a capture.
//
// States are best effort and independent of each other: one line `OK`, `SKIP <reason>` or `FAIL <error>` per state,
// then a summary. States that share one account form a group (for example connected -> quoted -> pending -> confirmed);
// when a step of a group fails, the later steps of that group are SKIP. With --only the steps a selected state needs
// are driven but not captured. Exit status 1 when a state is FAIL. Controls are found by visible text, label text and
// aria-label, never by CSS class.
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { encodeFunctionData, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { launch, openPage } from './cdp.mjs';
import { createWallet, PROVIDER_SCRIPT, USER_REJECTED } from './wallet.mjs';

// ---- the states, in file-number order ----
const STATES = [
  'mainnet-loading',
  'mainnet-disconnected',
  'mainnet-connected-idle',
  'mainnet-quoted-swap-ready',
  'mainnet-needs-approval',
  'mainnet-awaiting-wallet',
  'mainnet-pending-hold',
  'mainnet-confirmed',
  'mainnet-rejected',
  'mainnet-fee-refused',
  'mainnet-reply-lost-recovery',
  'mainnet-needs-credit',
  'mainnet-gas-limit-cap',
  'mainnet-clock-disagreement',
  'mainnet-idle-chain',
  'mainnet-unreadable-hold',
  'mainnet-wrong-network',
  'mainnet-rpc-unreachable',
  'preview-trade',
  'preview-trade-amount',
  'preview-token-sheet',
  'preview-settings',
  'preview-wallet-dialog',
  'preview-network',
  'preview-pools',
  'preview-portfolio',
  'live-pools-unavailable',
  // Added after the header network control became a popover: the dialog behind its "About the preview network" action.
  'preview-network-about',
  // Second pass: the reference layer docked on the page because a pool carries a notice. Last: it leaves bUSDC
  // above the reserves of the pair.
  'mainnet-docked-pool-notice',
  // Design pass of round 17: the token sheet of the live route.
  'mainnet-token-sheet',
];
const VARIANTS = [
  { theme: 'dark', width: 1440, height: 900, dsf: 1, mobile: false },
  { theme: 'light', width: 1440, height: 900, dsf: 1, mobile: false },
  { theme: 'dark', width: 390, height: 844, dsf: 2, mobile: true },
  { theme: 'light', width: 390, height: 844, dsf: 2, mobile: true },
];
const THEME_KEY = 'postern.theme.v1';
/** Chrome cannot rasterize a surface taller than this many device pixels; a taller page is captured scaled down. */
const MAX_DEVICE_PIXELS = 16_000;

// ---- arguments ----
const argv = process.argv.slice(2);
const option = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const [, value] = argv.splice(i, 2);
  if (value === undefined) throw new Error(`${name} needs a value`);
  return value;
};
if (argv.includes('--list')) {
  console.log(STATES.join('\n'));
  process.exit(0);
}
const only = option('--only')?.split(',').filter(Boolean) ?? null;
const variantNames = option('--variants')?.split(',').filter(Boolean) ?? null;
const outDir = resolve(option('--out') ?? process.env.SCREENS_OUT ?? join(homedir(), 'Desktop/BLOCH-L2-DEX-BRIDGE-20261030/agents/318-evidence/screens'));
if (argv.length !== 1 || argv[0].startsWith('--')) {
  console.error('usage: node screens.mjs <wallet-harness.json> [--only a,b] [--variants dark-1440,light-390] [--out <dir>] [--list]');
  process.exit(2);
}
for (const name of only ?? []) if (!STATES.includes(name)) throw new Error(`unknown state ${name}; see --list`);
const variants = VARIANTS.filter((v) => !variantNames || variantNames.includes(`${v.theme}-${v.width}`));
if (variants.length === 0) throw new Error('--variants selects nothing; names are dark-1440, light-1440, dark-390, light-390');
const config = JSON.parse(readFileSync(argv[0], 'utf8'));
for (const url of [config.rpc, config.page])
  if (!/^http:\/\/127\.0\.0\.1:\d+(\/|$)/.test(url)) throw new Error(`${url} is not a loopback URL`);
mkdirSync(outDir, { recursive: true });
const site = config.page.replace(/#.*$/, '');
const wanted = (name) => !only || only.includes(name);
const say = (line) => console.log(line);
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const ERC20 = parseAbi(['function transfer(address,uint256)']);

// ---- chain (as scenarios.mjs) ----
let rpcId = 0;
async function rpc(method, params = []) {
  const response = await fetch(config.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const body = await response.json();
  if (body.error) throw Object.assign(new Error(`${method}: ${body.error.message}`), { code: body.error.code });
  return body.result;
}
const head = async () => BigInt(await rpc('eth_blockNumber'));
const mine = () => rpc('anvil_mine', ['0x1']);
/** Anvil's `finalized` tag trails `latest` by 64 blocks. */
const finalize = () => rpc('anvil_mine', ['0x41']);
const mineAndFinalize = async () => (await mine(), await finalize());
const issuer = privateKeyToAccount(config.issuerKey);
async function fund(address, { blch = 5n * 10n ** 18n, busdc = 0n } = {}) {
  await rpc('anvil_setBalance', [address, hex(blch)]);
  if (busdc > 0n) {
    const nonce = Number(await rpc('eth_getTransactionCount', [issuer.address, 'pending']));
    const raw = await issuer.signTransaction({ type: 'eip1559', chainId: config.chainId, nonce, to: config.asset, gas: 100_000n, maxFeePerGas: 5_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, data: encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [address, busdc] }) });
    await rpc('eth_sendRawTransaction', [raw]);
  }
  await mineAndFinalize();
}

// ---- the page's RPC: the CORS gateway of scenarios.mjs, which can also be made to keep every request waiting ----
/** A promise the gateway waits for before it forwards anything (the `mainnet-loading` state), or null. */
let stall = null;
/** `bloch_admissionQuote` of the candidate RPC, answered by the wallet's node model (the credit states), or null. */
let admissionQuote = null;
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
const gateway = createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (stall) await stall;
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
  } catch {
    res.destroy();
  }
});
await new Promise((ok, no) => {
  gateway.once('error', (error) => no(new Error(`the RPC gateway port ${config.gatewayPort} is not free (another screens.mjs or scenarios.mjs on this chain?): ${error.message}`)));
  gateway.listen(config.gatewayPort, '127.0.0.1', ok);
});

// ---- page side ----
// cdp.mjs installs window.__h (button by visible text, field by wrapping label). The restyle may move a control from
// a wrapping label to label[for] or to an aria-label, so both lookups are widened here; cdp.mjs's click/fill/select
// then keep working. window.__s holds what only this file needs.
const PAGE_HELPERS = String.raw`
(() => {
  const h = window.__h;
  const norm = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
  const strict = { button: h.button.bind(h), field: h.field.bind(h) };
  const controls = () => [...document.querySelectorAll('button, [role="button"], summary, a[href]')].filter((e) => h.visible(e));
  /** A control as a user names it: exact aria-label, exact text, text prefix, aria-label prefix. */
  const control = (name) => {
    const all = controls();
    return all.find((e) => e.getAttribute('aria-label') === name)
      ?? all.find((e) => norm(e.textContent) === name)
      ?? all.find((e) => norm(e.textContent).startsWith(name))
      ?? all.find((e) => (e.getAttribute('aria-label') ?? '').startsWith(name))
      ?? null;
  };
  h.button = (name) => strict.button(name) ?? [...document.querySelectorAll('button')].find((b) => h.visible(b) && (b.getAttribute('aria-label') ?? '').startsWith(name));
  h.field = (label) => {
    const wrapped = strict.field(label);
    if (wrapped) return wrapped;
    for (const l of document.querySelectorAll('label')) {
      if (!norm(l.textContent).startsWith(label) || !l.htmlFor) continue;
      const el = document.getElementById(l.htmlFor);
      if (el) return el;
    }
    return [...document.querySelectorAll('input, select, textarea')].find((e) => (e.getAttribute('aria-label') ?? '').startsWith(label)) ?? null;
  };
  window.__s = {
    control,
    click(name) { const el = control(name); if (!el) return false; el.click(); return true; },
    /** Opens the <details> whose summary contains the text. */
    openDetails(text) {
      const d = [...document.querySelectorAll('details')].find((x) => norm(x.querySelector('summary')?.textContent).includes(text));
      if (d) d.open = true;
      return !!d;
    },
    frames: () => new Promise((done) => {
      const timer = setTimeout(done, 800); // a tab that is not painting must not hang the capture
      requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); done(); }));
    }),
  };
})();`;

const clockScript = (seconds) =>
  seconds
    ? `(() => { const shift = ${Number(seconds) * 1000}; const Real = Date; const real = Real.now.bind(Real); class Shifted extends Real { constructor(...a) { if (a.length) super(...a); else super(real() + shift); } static now() { return real() + shift; } } globalThis.Date = Shifted; })();`
    : '';

async function setVariant(page, v) {
  await page.cdp('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: v.dsf, mobile: v.mobile, screenWidth: v.width, screenHeight: v.height });
  await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: v.mobile }).catch(() => {});
  await page.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: v.theme }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
  const theme = JSON.stringify(v.theme);
  // The media change may make the app follow the system theme; the explicit choice is applied after it.
  return page.evaluate(`(async () => {
    await window.__s.frames();
    try { localStorage.setItem(${JSON.stringify(THEME_KEY)}, ${theme}); } catch { /* storage refused */ }
    document.documentElement.dataset.theme = ${theme};
    await window.__s.frames();
    return document.documentElement.dataset.theme === ${theme};
  })()`);
}

const results = new Map(); // state -> { status, reason?, files, notes }
const fileOf = (state, v) => `${String(STATES.indexOf(state) + 1).padStart(2, '0')}-${state}--${v.theme}--${v.width}.png`;

async function capture(page, state) {
  const files = [];
  const notes = new Set();
  await page.evaluate('Promise.race([document.fonts ? document.fonts.ready.then(() => true) : true, new Promise((r) => setTimeout(r, 3000))])').catch(() => {});
  try {
    for (const v of variants) {
      if (!(await setVariant(page, v))) notes.add('the app reset document.documentElement.dataset.theme after it was set');
      await page.evaluate('window.scrollTo(0, 0)');
      await page.evaluate('window.__s.frames()');
      const { cssContentSize } = await page.cdp('Page.getLayoutMetrics');
      const width = Math.max(v.width, Math.ceil(cssContentSize.width));
      const height = Math.max(v.height, Math.ceil(cssContentSize.height));
      if (width > v.width) notes.add(`at ${v.width}px the content is ${width}px wide (horizontal overflow)`);
      let scale = 1;
      if (height * v.dsf > MAX_DEVICE_PIXELS) {
        scale = MAX_DEVICE_PIXELS / (height * v.dsf);
        notes.add(`at ${v.width}px the page is ${height}px tall; captured at scale ${scale.toFixed(3)}`);
      }
      const { data } = await page.cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale } });
      const file = fileOf(state, v);
      writeFileSync(join(outDir, file), Buffer.from(data, 'base64'));
      files.push(file);
    }
  } finally {
    await setVariant(page, VARIANTS[0]).catch(() => {}); // states are driven on the desktop layout
  }
  return { files, notes: [...notes] };
}

class Skip extends Error {}
const skip = (reason) => {
  throw new Skip(reason);
};
const record = (state, status, extra = {}) => {
  results.set(state, { status, files: [], notes: [], ...extra });
  say(`${status.padEnd(4)} ${state}${extra.reason ? ` — ${extra.reason}` : ''}${extra.notes?.length ? ` [${extra.notes.join('; ')}]` : ''}`);
};
const short = (error) => String(error?.message ?? error).split('\n')[0].slice(0, 300);

// ---- groups ----
const browser = await launch(config.chrome, config.debugPort);
const groups = [];
/** `states` lists every state the group captures, in the order its steps run. */
const group = (name, states, run) => groups.push({ name, states, run });

const READY = '/Pools at finalized block \\d+/';
const PENDING = '/Waiting for the next L2 block and canonical finality\\./';
const NO_HASH = '/Wallet submission outcome unknown: no transaction hash was returned\\./';
const AMOUNT = '0.01';
const SLOT_PRICE = 200_000_000_000_000n;

async function runGroup({ name, states, run }) {
  if (!states.some(wanted)) return;
  const { browserContextId } = await browser.send('Target.createBrowserContext');
  const wallet = createWallet({ rpc, chainId: config.chainId });
  const tabs = [];
  let broken = null;
  const world = {
    wallet,
    clockAheadSeconds: 0,
    /** A tab of this group's browser profile with the simulated wallet injected, on the desktop dark variant. */
    async tab(url = config.page) {
      const page = await openPage(browser, browserContextId, {
        initScript: `${clockScript(world.clockAheadSeconds)}\n${PROVIDER_SCRIPT}\n${PAGE_HELPERS}`,
        url,
        log: (line) => say(`     ${line.split('\n')[0]}`),
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
      await setVariant(page, VARIANTS[0]);
      return page;
    },
    async connect(page) {
      await page.waitText(READY);
      await page.click('Connect Harness wallet');
      await page.waitFor('finalized balances', `!!window.__h.labelled('Finalized balances')`);
    },
    /** Bring the page to the current finalized block, as the Refresh button does. */
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
          if (attempt === 2) throw error; // a refresh under way remounts the form and empties it
        }
      }
      await delay(700); // the latest-block cross-check ends before Swap can be judged
    },
    /** Fund the group's account, open one tab, connect. */
    async begin(funding) {
      await fund(wallet.address, funding);
      const page = await world.tab();
      await world.connect(page);
      return page;
    },
    async swapNative(page) {
      await world.quote(page, 'BLCH', 'bUSDC', AMOUNT);
      await page.click('Swap');
    },
    /** The credit rule of the L2 candidate, modelled in the wallet's node and (with `quote`) in the page's RPC. */
    credit(rule, { quote = true } = {}) {
      wallet.state.admission = { priceWei: SLOT_PRICE, credit: rule };
      if (quote) admissionQuote = (call) => wallet.quote(call);
    },
    /**
     * One state: `drive` brings a page to it and returns that page; it is then captured when selected. A failure
     * stops the later steps of the group unless the step is `independent`.
     */
    async step(state, drive, { independent = false } = {}) {
      if (!states.slice(states.indexOf(state)).some(wanted) || (independent && !wanted(state))) return;
      if (broken) return wanted(state) && record(state, 'SKIP', { reason: `the earlier step ${broken} of this group did not complete` });
      let page;
      try {
        page = await drive();
      } catch (error) {
        if (!independent) broken = state;
        if (!wanted(state)) return say(`     (step ${state}, needed by a selected state, did not complete: ${short(error)})`);
        if (error instanceof Skip) return record(state, 'SKIP', { reason: error.message });
        const last = tabs.at(-1);
        const failure = `_failed-${state}.png`;
        const shot = last ? await last.screenshot(join(outDir, failure)).then(() => true, () => false) : false;
        return record(state, 'FAIL', { reason: short(error), ...(shot ? { failureScreenshot: failure } : {}) });
      }
      if (!wanted(state)) return;
      try {
        const { files, notes } = await capture(page, state);
        record(state, 'OK', { files, notes });
      } catch (error) {
        record(state, 'FAIL', { reason: `capture: ${short(error)}` });
      }
    },
  };
  try {
    await run(world);
  } catch (error) {
    say(`     group ${name}: ${short(error)}`);
  } finally {
    for (const state of states) if (wanted(state) && !results.has(state)) record(state, 'FAIL', { reason: 'the group ended before this state was driven' });
    admissionQuote = null;
    if (stall) stall.release();
    const lines = [...new Set(tabs.flatMap((t) => t.console).filter((l) => /^(error|pageerror)/.test(l)))].slice(0, 20);
    for (const state of states) if (results.has(state) && lines.length) results.get(state).console = lines;
    await browser.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  }
}

// -- #/mainnet --
group('loading', ['mainnet-loading'], async (w) => {
  await w.step('mainnet-loading', async () => {
    // Every RPC answer waits, so the page stays where it is before the finalized snapshot arrives. Its own read
    // timeout is 20 s; the four captures take a few seconds.
    let release;
    stall = Object.assign(new Promise((done) => (release = done)), { release: () => (release(), (stall = null)) });
    const page = await w.tab();
    await page.waitFor('the page to render', `document.body.innerText.trim().length > 40`);
    await delay(400);
    const text = await page.text();
    if (/Pools at finalized block \d+/.test(text)) throw new Error('the snapshot arrived although the RPC was held');
    if (/Mainnet reads are unavailable/.test(text)) throw new Error('the page already reports the RPC as unavailable');
    return page;
  });
});

group('disconnected', ['mainnet-disconnected'], async (w) => {
  await w.step('mainnet-disconnected', async () => {
    const page = await w.tab();
    await page.waitText(READY);
    return page;
  });
});

group('swap-flow', ['mainnet-connected-idle', 'mainnet-quoted-swap-ready', 'mainnet-pending-hold', 'mainnet-confirmed'], async (w) => {
  let page;
  await w.step('mainnet-connected-idle', async () => (page = await w.begin()));
  await w.step('mainnet-quoted-swap-ready', async () => {
    await w.quote(page, 'BLCH', 'bUSDC', AMOUNT);
    await page.waitFor('an enabled Swap button', `(() => { const b = window.__h.button('Swap'); return !!b && !b.disabled; })()`, 8000);
    return page;
  });
  await w.step('mainnet-pending-hold', async () => {
    await page.click('Swap');
    await page.waitText(PENDING);
    return page;
  });
  await w.step('mainnet-confirmed', async () => {
    await mineAndFinalize();
    await page.waitText(`/Swap ${AMOUNT} BLCH for bUSDC: mined/`, 40_000);
    await page.waitText(READY);
    return page;
  });
});

group('needs-approval', ['mainnet-needs-approval'], async (w) => {
  await w.step('mainnet-needs-approval', async () => {
    const page = await w.begin({ busdc: 50_000_000n });
    await w.quote(page, 'bUSDC', 'BLCH', '10');
    await page.waitFor('the Approve button', `!!window.__h.button('Approve')`, 8000);
    return page;
  });
});

group('awaiting-wallet', ['mainnet-awaiting-wallet'], async (w) => {
  await w.step('mainnet-awaiting-wallet', async () => {
    const page = await w.begin();
    w.wallet.state.next.push('never-answer');
    await w.swapNative(page);
    for (let i = 0; i < 100 && w.wallet.open.length === 0; i++) await delay(100);
    if (w.wallet.open.length === 0) throw new Error('the page did not ask the wallet');
    await delay(500);
    return page;
  });
  w.wallet.open[0]?.reject(USER_REJECTED);
});

group('rejected', ['mainnet-rejected'], async (w) => {
  await w.step('mainnet-rejected', async () => {
    const page = await w.begin();
    w.wallet.state.next.push('reject');
    await w.swapNative(page);
    await page.waitText('/The wallet request was rejected by you\\. Nothing was sent\\./');
    return page;
  });
});

group('fee-refused', ['mainnet-fee-refused'], async (w) => {
  await w.step('mainnet-fee-refused', async () => {
    const page = await w.begin();
    w.wallet.state.next.push('error-fee-data');
    await w.swapNative(page);
    await page.waitText(NO_HASH);
    await page.waitText('/RPC fee diagnostic/', 8000);
    return page;
  });
});

group('reply-lost', ['mainnet-reply-lost-recovery'], async (w) => {
  await w.step('mainnet-reply-lost-recovery', async () => {
    const page = await w.begin();
    w.wallet.state.next.push('hold-reply-lost');
    await w.swapNative(page);
    await page.waitText(NO_HASH);
    await page.waitFor('the recovery panel', `!!window.__h.labelled('Recover transaction tracking')`);
    // Offered for an approval only: a swap is never requested from the wallet a second time.
    await page.evaluate(`window.__s.openDetails('Review the original request')`);
    return page;
  });
});

group('needs-credit', ['mainnet-needs-credit'], async (w) => {
  await w.step('mainnet-needs-credit', async () => {
    const page = await w.begin();
    // The limit of this node is below the swap's 250,000 gas: the refusal a longer route would meet.
    w.credit({ uncoveredMaxGas: 200_000n, maxTxGas: 5_000_000n });
    await w.swapNative(page);
    await page.waitText('/The L2 does not take this transaction from a wallet that has not paid for an L2 transaction yet/');
    return page;
  });
});

group('gas-limit-cap', ['mainnet-gas-limit-cap'], async (w) => {
  await w.step('mainnet-gas-limit-cap', async () => {
    const page = await w.begin();
    // As credit-refusal-through-wallet (no quote route on the page's RPC; the wallet's node refuses), with the node's
    // cap for any transaction below the swap's 250,000 gas: `sequencer-gas-limit-above-cap`.
    w.credit({ uncoveredMaxGas: 200_000n, maxTxGas: 200_000n }, { quote: false });
    await w.swapNative(page);
    await page.waitText(NO_HASH);
    await page.waitText('/RPC diagnostic/', 8000);
    if (!/gas limit/i.test(await page.text())) skip('the wallet refusal was shown but the page does not name the gas limit');
    return page;
  });
});

group('clock', ['mainnet-clock-disagreement'], async (w) => {
  await w.step('mainnet-clock-disagreement', async () => {
    w.clockAheadSeconds = 27 * 3600;
    const page = await w.begin();
    await w.swapNative(page);
    await page.waitText('/hours ahead of the latest L2 block/');
    return page;
  });
});

group('idle-chain', ['mainnet-idle-chain'], async (w) => {
  await w.step('mainnet-idle-chain', async () => {
    // The page's clock is 5 hours ahead of the latest block, as on a quiet chain. The chain clock is not moved: the
    // swap stays queued (it is taken by the next block any later state mines).
    w.clockAheadSeconds = 5 * 3600;
    const page = await w.begin();
    await w.swapNative(page);
    await page.waitText('/The L2 has made no block for \\d+ (hours|minutes): it is idle/');
    await page.waitText(PENDING);
    return page;
  });
});

group('unreadable-hold', ['mainnet-unreadable-hold'], async (w) => {
  await w.step('mainnet-unreadable-hold', async () => {
    const page = await w.begin();
    const key = `postern.mainnet.pendingSwap.v1.${config.chainId}.${w.wallet.address}`;
    await page.evaluate(`localStorage.setItem(${JSON.stringify(key)}, '{"schema": "corrupted by screens.mjs"')`);
    await page.reload();
    await setVariant(page, VARIANTS[0]);
    await page.waitText(READY);
    await page.click('Connect Harness wallet');
    await page.waitFor('the discard panel', `window.__s.openDetails('Discard the unreadable saved record')`);
    return page;
  });
});

group('wrong-network', ['mainnet-wrong-network'], async (w) => {
  await w.step('mainnet-wrong-network', async () => {
    const page = await w.begin();
    w.wallet.state.chainId = '0x1';
    await page.evaluate(`window.__walletEmit('chainChanged', '0x1')`);
    await page.waitFor('the page to notice chain 1', `!!window.__s.control('Add or switch to') || /it will be asked to switch to chain/.test(document.body.innerText)`, 10_000);
    return page;
  });
});

group('rpc-unreachable', ['mainnet-rpc-unreachable'], async (w) => {
  await w.step('mainnet-rpc-unreachable', async () => {
    const page = await w.tab('about:blank');
    await page.cdp('Network.enable');
    await page.cdp('Network.setBlockedURLs', { urls: [`*127.0.0.1:${config.gatewayPort}*`] });
    await page.goto(config.page);
    await setVariant(page, VARIANTS[0]);
    await page.waitText('/Mainnet reads are unavailable/', 90_000);
    return page;
  });
});

// -- preview routes: a new document for each, so no dialog of an earlier state is left open --
group('preview', STATES.filter((s) => s.startsWith('preview-') || s === 'live-pools-unavailable'), async (w) => {
  const page = await w.tab('about:blank');
  const route = async (hash) => {
    await page.goto('about:blank');
    await page.goto(`${site}${hash}`);
    await setVariant(page, VARIANTS[0]);
    await page.waitFor('the route to render', `document.body.innerText.trim().length > 40`);
    await delay(300);
  };
  const press = async (name) => {
    await page.waitFor(`control "${name}"`, `!!window.__s.control(${JSON.stringify(name)})`, 8000);
    await page.evaluate(`window.__s.click(${JSON.stringify(name)})`);
    await delay(300);
  };
  const dialog = (what) => page.waitFor(what, `!!document.querySelector('[role="dialog"], dialog[open], [aria-modal="true"]')`, 5000);
  const independent = { independent: true };
  await w.step('preview-trade', async () => (await route('#/trade'), page), independent);
  await w.step('preview-trade-amount', async () => {
    await route('#/trade');
    await page.fill('You pay', '100');
    await delay(400);
    return page;
  }, independent);
  await w.step('preview-token-sheet', async () => {
    await route('#/trade');
    await press('Select pay token');
    await page.waitFor('the token list', `!!document.querySelector('[aria-label="Search tokens"]') || !!document.querySelector('[role="dialog"], dialog[open], [aria-modal="true"]')`, 5000);
    return page;
  }, independent);
  await w.step('preview-settings', async () => (await route('#/trade'), await press('Swap settings'), await dialog('the settings dialog'), page), independent);
  await w.step('preview-wallet-dialog', async () => (await route('#/trade'), await press('Connect wallet'), await dialog('the wallet dialog'), page), independent);
  // The header network control: a button whose text holds the network name (or whose aria-label names the network).
  // It opens a dialog, or a popover (a panel labelled "Select network", the button then aria-expanded).
  const openNetwork = async () => {
    const found = await page.evaluate(`(() => {
      const text = (b) => b.textContent.replace(/\\s+/g, ' ').trim();
      const inHeader = [...document.querySelectorAll('header button')].filter((b) => window.__h.visible(b));
      const all = [...document.querySelectorAll('button')].filter((b) => window.__h.visible(b));
      const pick = (list) => list.find((x) => /Bloch L2/.test(text(x))) ?? list.find((x) => /network/i.test(x.getAttribute('aria-label') ?? ''));
      const b = pick(inHeader) ?? pick(all);
      if (b) b.click();
      return !!b;
    })()`);
    if (!found) throw new Error('no header network button (text holding "Bloch L2" or an aria-label naming the network)');
    await page.waitFor('the network dialog or popover', `!!document.querySelector('[role="dialog"], dialog[open], [aria-modal="true"], [aria-label="Select network"], header button[aria-expanded="true"]')`, 5000);
    await delay(300);
  };
  await w.step('preview-network', async () => (await route('#/trade'), await openNetwork(), page), independent);
  await w.step('preview-network-about', async () => {
    await route('#/trade');
    await openNetwork();
    if (!(await page.evaluate(`!!window.__s.control('About the preview network')`))) skip('the network control has no "About the preview network" action (it opens the dialog directly: see preview-network)');
    await press('About the preview network');
    await dialog('the network dialog');
    return page;
  }, independent);
  await w.step('preview-pools', async () => (await route('#/pools'), page), independent);
  await w.step('preview-portfolio', async () => (await route('#/portfolio'), page), independent);
  await w.step('live-pools-unavailable', async () => (await route('#/live-pools'), page), independent);
});

group('token-sheet', ['mainnet-token-sheet'], async (w) => {
  await w.step('mainnet-token-sheet', async () => {
    const page = await w.begin();
    if (!(await page.evaluate(`window.__s.click('You pay')`))) throw new Error('no pay token chip');
    await page.waitText('/Only the tokens of the verified deployment record are listed/');
    return page;
  });
});

group('docked-pool-notice', ['mainnet-docked-pool-notice'], async (w) => {
  await w.step('mainnet-docked-pool-notice', async () => {
    // A plain token transfer to the pair: 5 bUSDC above its reserves ("Pending excess", skim offered).
    await fund(config.pair, { busdc: 5_000_000n });
    const page = await w.begin();
    await page.waitText('/Pending excess/', 15_000);
    return page;
  });
});


// ---- run ----
const started = Date.now();
try {
  const latest = await rpc('eth_getBlockByNumber', ['latest', false]);
  const ahead = Number(BigInt(latest.timestamp)) - Math.floor(Date.now() / 1000);
  say(`screens: ${browser.product}; ${config.page}; chain block ${Number(BigInt(latest.number))}, its clock ${ahead >= 0 ? `${ahead} s ahead of` : `${-ahead} s behind`} this machine; output ${outDir}`);
  await rpc('evm_setAutomine', [false]);
  for (const g of groups) await runGroup(g);
} finally {
  await rpc('evm_setAutomine', [true]).catch(() => {});
  await browser.close();
  gateway.closeAllConnections();
  gateway.close();
}

// ---- index and summary: a partial run (--only) updates the states it ran and keeps the others ----
const indexFile = join(outDir, 'screens.json');
let index = { schema: 'postern.frontend.screens.v1', states: {} };
if (only && existsSync(indexFile)) {
  try {
    const previous = JSON.parse(readFileSync(indexFile, 'utf8'));
    if (previous.schema === index.schema) index = previous;
  } catch {
    /* rewritten */
  }
}
Object.assign(index, { revision: config.revision, workingTreeDirty: config.dirty, browser: browser.product, page: config.page, updatedAt: new Date().toISOString(), variants: VARIANTS.map((v) => `${v.theme}-${v.width}`) });
for (const state of STATES) if (results.has(state)) index.states[state] = { ...results.get(state), capturedAt: new Date().toISOString() };
index.states = Object.fromEntries(STATES.filter((s) => index.states[s]).map((s) => [s, index.states[s]]));
writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`);
const by = (status) => [...results].filter(([, r]) => r.status === status).map(([name]) => name);
say(`screens: ${by('OK').length} OK, ${by('SKIP').length} SKIP, ${by('FAIL').length} FAIL in ${Math.round((Date.now() - started) / 1000)} s; ${indexFile}`);
for (const status of ['SKIP', 'FAIL']) for (const name of by(status)) say(`  ${status} ${name}: ${results.get(name).reason}`);
const errors = [...new Set([...results.values()].flatMap((r) => r.console ?? []))];
if (errors.length) say(`  page and console errors seen (per state in screens.json):\n${errors.slice(0, 15).map((l) => `    ${l.slice(0, 240)}`).join('\n')}`);
process.exit(by('FAIL').length ? 1 : 0);
