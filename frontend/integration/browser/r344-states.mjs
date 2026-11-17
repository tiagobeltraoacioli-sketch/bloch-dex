// Review 344 demonstrations on the multichain site (run by scripts/review/r344-rehearse.mjs with one chain, Base):
// the states the line's rehearsal does not produce, measurements of the automatic re-read and of the renewed
// snapshot, keyboard order, and screenshots in both themes at 1440 and 390 px. Observations are written to
// r344-result.json; nothing here is a pass/fail gate.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { keccak256 } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { launch, openPage } from './cdp.mjs';
import { PROVIDER_SCRIPT } from './wallet.mjs';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const SHOTS = process.env.R344_SHOTS ?? join(config.out, 'screens');
mkdirSync(SHOTS, { recursive: true });
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const say = (line) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
const chain = config.chains[0];
const AMOUNT = '0.01';
const out = { revision: config.revision, chain: chain.key, observations: {} };
const note = (key, value) => {
  out.observations[key] = value;
  say(`${key}: ${JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 1500)}`);
  writeFileSync(join(config.out, 'r344-result.json'), `${JSON.stringify(out, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
};

let rpcId = 0;
async function rpc(method, params = []) {
  const response = await fetch(chain.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}
const control = async (i, body) => (await fetch(`${chain.endpoints[i]}/__control`, body ? { method: 'POST', body: JSON.stringify(body) } : undefined)).json();
const modes = async (a, b = a) => (await control(0, typeof a === 'string' ? { mode: a } : a), await control(1, typeof b === 'string' ? { mode: b } : b));
const counts = async () => {
  const [a, b] = [await control(0), await control(1)];
  return { total: a.requests + b.requests, methods: [a.methods, b.methods], log: [a.log, b.log] };
};
const delta = (before, after) => {
  const m = {};
  for (const i of [0, 1]) for (const [name, n] of Object.entries(after.methods[i])) { const d = n - (before.methods[i][name] ?? 0); if (d > 0) m[name] = (m[name] ?? 0) + d; }
  return { total: after.total - before.total, methods: m };
};

const account = privateKeyToAccount(generatePrivateKey());
const address = account.address.toLowerCase();
const wallet = {
  requests: [],
  sent: [],
  async handle(method, params) {
    this.requests.push({ method, at: Date.now() });
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address];
    if (method === 'eth_chainId') return hex(chain.chainId);
    if (method === 'wallet_switchEthereumChain') return null;
    if (method === 'eth_sendTransaction') {
      const request = params[0];
      const price = BigInt(await rpc('eth_gasPrice')) * 2n + 1_000_000_000n;
      const nonce = request.nonce === undefined ? Number(BigInt(await rpc('eth_getTransactionCount', [address, 'pending']))) : Number(BigInt(request.nonce));
      const raw = await account.signTransaction({ type: 'eip1559', chainId: chain.chainId, nonce, to: request.to, data: request.data ?? '0x', value: BigInt(request.value ?? '0x0'), gas: BigInt(request.gas ?? '0x7a120'), maxFeePerGas: price, maxPriorityFeePerGas: 1_000_000_000n });
      const hash = await rpc('eth_sendRawTransaction', [raw]);
      if (hash !== keccak256(raw)) throw new Error('the node returned another hash');
      this.sent.push({ hash, data: request.data, at: Date.now() });
      return hash;
    }
    throw { code: 4200, message: `the harness wallet does not implement ${method}` };
  },
};

const browser = await launch(config.chrome, config.debugPort);
let unexpected = null;
try {
  await rpc('anvil_setBalance', [address, hex(5n * 10n ** 18n)]);
  await rpc('evm_setAutomine', [false]);
  await rpc('anvil_mine', ['0x42']);
  const { browserContextId } = await browser.send('Target.createBrowserContext');
  const page = await openPage(browser, browserContextId, {
    initScript: PROVIDER_SCRIPT,
    url: `${config.page}#/${chain.key}`,
    log: say,
    onBinding: (bridge, payload, from) => {
      if (bridge !== '__walletBridge') return;
      const { id, method, params } = JSON.parse(payload);
      wallet.handle(method, params).then(
        (value) => from.evaluate(`window.__walletReply(${id}, true, ${JSON.stringify(value)})`).catch(() => {}),
        (error) => from.evaluate(`window.__walletReply(${id}, false, ${JSON.stringify({ code: error.code ?? -32603, message: error.message ?? String(error) })})`).catch(() => {}),
      );
    },
  });
  // Every origin the page contacts.
  const origins = new Map();
  await page.cdp('Network.enable');
  const prior = browser.onSession;
  // openPage registered its own session handler; requests are read from the performance entries instead.
  void prior;

  const VARIANTS = [
    { theme: 'dark', width: 1440, height: 900, dsf: 1, mobile: false },
    { theme: 'light', width: 1440, height: 900, dsf: 1, mobile: false },
    { theme: 'dark', width: 390, height: 844, dsf: 2, mobile: true },
    { theme: 'light', width: 390, height: 844, dsf: 2, mobile: true },
  ];
  const setView = async (v) => {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: v.dsf, mobile: v.mobile });
    await page.evaluate(`(document.documentElement.dataset.theme = ${JSON.stringify(v.theme)}, new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))`);
  };
  const resetView = async () => {
    await page.cdp('Emulation.clearDeviceMetricsOverride');
    await page.evaluate(`void (document.documentElement.dataset.theme = 'dark')`);
  };
  const capture = async (file, full = true) => {
    const { cssContentSize: size } = await page.cdp('Page.getLayoutMetrics');
    const { data } = await page.cdp('Page.captureScreenshot', full ? { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } } : { format: 'png' });
    writeFileSync(join(SHOTS, file), Buffer.from(data, 'base64'));
  };
  const shots = async (state, variants = VARIANTS, measure) => {
    const measured = {};
    for (const v of variants) {
      await setView(v);
      await capture(`r344-${state}--${v.theme}--${v.width}.png`);
      if (measure && v.theme === 'dark') measured[v.width] = await page.evaluate(measure);
    }
    await resetView();
    return measured;
  };
  // Where things are on the page (document coordinates) and whether they fit the first screen.
  const where = (selectors) => `(() => { const fold = window.innerHeight; const o = { fold, pageHeight: document.documentElement.scrollHeight, scrollX: document.documentElement.scrollWidth > window.innerWidth }; for (const [name, sel] of Object.entries(${JSON.stringify(selectors)})) { const el = document.querySelector(sel); if (!el) { o[name] = null; continue; } const b = el.getBoundingClientRect(); o[name] = { top: Math.round(b.top + scrollY), bottom: Math.round(b.bottom + scrollY), aboveFold: b.bottom + scrollY <= fold, reachable: window.__h.reachable(el), clipped: el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1 }; } return o; })()`;
  const visible = () => page.visibleText();
  const reach = async (name) => (await page.reachableButton(name)) !== null;
  const settledBlock = () => page.evaluate(`(() => { const m = /Confirmed block (\\d+) is /.exec(window.__h.visibleText()); return m ? Number(m[1]) : -1; })()`);
  const cardState = `(() => { const card = document.querySelector('.swap-card'); const q = window.__h.labelled('Quote'); const swap = window.__h.button('Swap'); const min = q ? (/Minimum received\\s*([^\\n]*)/.exec(q) ?? [])[1] ?? null : null; const amount = document.querySelector('input[data-field="amount"]'); return { card: !!card, getQuote: !!(window.__h.button('Get quote') && window.__h.reachable(window.__h.button('Get quote'))), quote: !!q, min, swapEnabled: !!swap && !swap.disabled, amount: amount ? amount.value : null, failure: !!document.querySelector('.read-failure'), block: (/Confirmed block (\\d+) is /.exec(document.body.innerText) ?? [])[1] ?? null, quotedAt: q ? (/block (\\d+)/.exec(q.split('Quoted at')[1] ?? '') ?? [])[1] ?? null : null }; })()`;
  /** Samples the card every 150 ms for `ms` and returns the distinct states in order with their times. */
  const sample = async (ms) => {
    const start = Date.now();
    const seen = [];
    while (Date.now() - start < ms) {
      const s = JSON.stringify(await page.evaluate(cardState).catch(() => null));
      if (seen.length === 0 || seen.at(-1).s !== s) seen.push({ t: Math.round((Date.now() - start) / 100) / 10, s });
      await delay(150);
    }
    return seen.map((x) => ({ t: x.t, ...JSON.parse(x.s) }));
  };
  const waitFresh = async () => {
    const want = Number(BigInt(await rpc('eth_blockNumber'))) - chain.confirmation.settle.depth;
    if ((await settledBlock()) < want) {
      if (await page.button('Refresh')) await page.click('Refresh');
      await page.waitFor(`confirmed block ${want}`, `(() => { const m = /Confirmed block (\\d+) is /.exec(window.__h.visibleText()); return (m ? Number(m[1]) : -1) >= ${want}; })()`, 60_000);
    }
  };
  const quote = async () => {
    for (let attempt = 0; ; attempt++) {
      await waitFresh();
      await page.select('You pay', chain.native);
      await page.select('You receive', chain.token.symbol);
      await page.fill('Amount', AMOUNT);
      await page.click('Get quote');
      try {
        await page.waitFor('quote', `!!window.__h.labelled('Quote')`, 8000);
        return;
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
  };
  const KEYS = { rule: '.confirmation-rule', card: '.swap-card', getQuote: '.get-quote', finality: '.finality-line', trust: '.trust-strip', failure: '.read-failure', refresh: '.section-heading > .button', nextStep: '[data-testid="next-step"]', swapActions: '.swap-actions', quoteAlert: '.swap-card .form-error[role="alert"]', hold: '.hold-recovery', tracked: '.devnet4-steps[aria-label="Transactions"]', progress: '[data-testid="confirmation-progress"]', deadline: '.deadline-clock', heading: '.section-heading > div', reference: '.reference' };

  // ---- 1. idle and connected ----
  await page.waitVisibleText('/Confirmed block \\d+ is /', 90_000);
  await page.click('Connect Harness wallet');
  await page.waitFor('balances', `!!window.__h.labelled('Confirmed balances')`);
  note('1-idle-positions', await shots('01-idle', VARIANTS, where(KEYS)));

  // ---- 2. a long amount on a phone ----
  await setView(VARIANTS[2]);
  await page.fill('Amount', '123456789012345.123456');
  note('2-long-amount-390', await page.evaluate(`(() => { const i = document.querySelector('input[data-field="amount"]'); const s = getComputedStyle(i); return { value: i.value, clientWidth: i.clientWidth, scrollWidth: i.scrollWidth, truncated: i.scrollWidth > i.clientWidth, fontSize: s.fontSize, textOverflow: s.textOverflow, focused: document.activeElement === i }; })()`));
  await capture('r344-02-long-amount--dark--390.png');
  await resetView();
  await page.fill('Amount', '');

  // ---- 3. what an idle, visible page asks of the endpoints per renewal ----
  {
    const before = await counts();
    const b0 = await settledBlock();
    await delay(65_000);
    const after = await counts();
    note('3-idle-requests-65s', { ...delta(before, after), blockBefore: b0, blockAfter: await settledBlock(), walletConnected: true });
  }

  // ---- 4. a quote on screen when the snapshot is renewed ----
  {
    await quote();
    const first = await page.evaluate(cardState);
    await rpc('anvil_mine', [hex(60)]);
    const seen = await sample(45_000);
    note('4-quote-through-renewal', { first, transitions: seen, clicks: 'none after the first Get quote' });
    note('4-visible-after-renewal', (await visible()).slice(0, 1200));
    await shots('04-quote-after-renewal', [VARIANTS[0], VARIANTS[2]], where(KEYS));
  }

  // ---- 5. a quote refused inside the card (the second endpoint has no state for the snapshot block) ----
  {
    await modes('ok');
    await page.click('Refresh');
    await delay(2500);
    await page.fill('Amount', AMOUNT);
    await modes('ok', 'stale');
    await page.click('Get quote');
    await page.waitFor('the refused quote', `!!document.querySelector('.swap-card .form-error[data-kind]')`, 20_000);
    const text = await page.evaluate(`document.querySelector('.swap-card .form-error[data-kind]').innerText.replace(/\\s+/g, ' ')`);
    const positions = await shots('05-refused-quote', VARIANTS, where(KEYS));
    note('5-refused-quote', { text, kind: await page.evaluate(`document.querySelector('.swap-card .form-error[data-kind]')?.dataset.kind ?? null`), refreshInAlert: await page.evaluate(`(() => { const b = document.querySelector('.swap-card .form-error[data-kind] button'); return b ? { text: b.textContent.trim(), reachable: window.__h.reachable(b), disabled: b.disabled } : null; })()`), swapReachable: await reach('Swap'), positions });
    // What follows by itself: the next timed renewal cannot read the snapshot either.
    const seen = await sample(40_000);
    note('5-after-the-refusal-by-itself', seen);
    note('5-page-level-text', (await visible()).slice(0, 900));
  }

  // ---- 6. the endpoints limit requests while a quote is on screen: the automatic re-read ----
  {
    await modes('ok');
    if (await page.button('Read now')) await page.click('Read now');
    await page.waitFor('the form back', `!!window.__h.button('Get quote')`, 60_000);
    await quote();
    const quoted = await page.evaluate(cardState);
    await modes('limit');
    const t0 = Date.now();
    const before = await counts();
    const seen = await sample(125_000);
    const mid = await counts();
    const log = [0, 1].flatMap((i) => mid.log[i].filter((e) => e[0] >= t0).map((e) => [Math.round((e[0] - t0) / 100) / 10, e[1], e[2] ? 'pinned' : '']));
    log.sort((a, b) => a[0] - b[0]);
    // Bursts of requests: a new burst starts after 5 s of silence.
    const bursts = [];
    for (const e of log) { const last = bursts.at(-1); if (!last || e[0] - last.end > 5) bursts.push({ start: e[0], end: e[0], n: 1, pinned: e[2] ? 1 : 0 }); else { last.end = e[0]; last.n++; if (e[2]) last.pinned++; } }
    note('6-rate-limited-with-a-quote', { quoted, transitions: seen, requests: delta(before, mid), bursts });
    await shots('06-rate-limited-page', VARIANTS, where(KEYS));
    // The same with the tab hidden: does the page keep asking?
    await page.evaluate(`(Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }), Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }), document.dispatchEvent(new Event('visibilitychange')), true)`);
    const hiddenBefore = await counts();
    const tHidden = Date.now();
    await delay(250_000);
    const hiddenAfter = await counts();
    const hiddenLog = [0, 1].flatMap((i) => hiddenAfter.log[i].filter((e) => e[0] >= tHidden).map((e) => Math.round((e[0] - tHidden) / 1000)));
    note('6-hidden-tab-250s-rate-limited', { ...delta(hiddenBefore, hiddenAfter), secondsOfRequests: [...new Set(hiddenLog)].sort((a, b) => a - b) });
    // Hidden and healthy: the timed renewal stops (326's rule); for comparison.
    await modes('ok');
    await page.waitFor('the form back while hidden', `!!window.__h.button('Get quote')`, 150_000).catch(() => {});
    const okBefore = await counts();
    await delay(65_000);
    note('6-hidden-tab-65s-healthy', delta(okBefore, await counts()));
    await page.evaluate(`(delete document.hidden, delete document.visibilityState, document.dispatchEvent(new Event('visibilitychange')), true)`);
  }

  // ---- 7. one endpoint is behind the other ----
  {
    await modes('ok');
    await rpc('anvil_mine', [hex(12), hex(30)]);
    await modes('ok', { mode: 'behind', lag: 6 });
    if (await page.button('Refresh')) await page.click('Refresh');
    await page.waitVisibleText('/One endpoint is behind the other/', 60_000).catch(() => {});
    const text = await visible();
    const positions = await shots('07-behind', VARIANTS, where(KEYS));
    note('7-behind', { shown: text.includes('One endpoint is behind the other'), text: text.slice(Math.max(0, text.indexOf('One endpoint is behind')), text.indexOf('One endpoint is behind') + 700), countdown: /Reading again in \d:\d\d/.test(text), swapReachable: await reach('Swap'), getQuoteReachable: await reach('Get quote'), noteOnScreen: text.includes(`On ${chain.name} this page treats a block as settled once`), positions });
    await modes('ok');
    if (await page.button('Read now')) await page.click('Read now');
    await page.waitFor('the form back', `!!window.__h.button('Get quote')`, 150_000);
  }

  // ---- 8. a held swap: what is on screen, keyboard order, the endpoint line, and the form after it is mined ----
  {
    await quote();
    await page.click('Swap');
    await page.waitText('/Do not resend with a new nonce/', 60_000);
    await page.waitFor('the count', `!!document.querySelector('[data-testid="confirmation-progress"]')`, 20_000).catch(() => {});
    const positions = await shots('08-hold-pending', VARIANTS, where(KEYS));
    note('8-hold-positions', positions);
    note('8-hold-visible-text', (await visible()).slice(0, 3000));
    // Keyboard order from the top of the page: where Tab goes, and whether a stop is not on screen.
    await page.evaluate(`(document.activeElement?.blur?.(), window.scrollTo(0, 0), true)`);
    const stops = [];
    for (let i = 0; i < 45; i++) {
      await page.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      stops.push(await page.evaluate(`(() => { const el = document.activeElement; if (!el || el === document.body) return 'body'; const b = el.getBoundingClientRect(); const name = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim().slice(0, 40); return el.tagName.toLowerCase() + (el.disabled ? '[disabled]' : '') + ' "' + name + '" y=' + Math.round(b.top + scrollY) + (window.__h.reachable(el) ? '' : ' NOT-ON-SCREEN') + (el.closest('[aria-hidden="true"]') ? ' ARIA-HIDDEN' : ''); })()`));
    }
    note('8-hold-tab-order', stops);
    // The endpoint line of a held swap cannot occur at this tip (the tracker swallows the cause). Its markup, as
    // MainnetLive.tsx writes it, is injected into the real page to see how the stylesheet draws it.
    await page.evaluate(`(() => { const li = document.querySelector('.devnet4-steps[aria-label="Transactions"] li:last-child'); const after = li.querySelector('.muted'); const s = document.createElement('span'); s.className = 'confirm-trouble hold-trouble'; s.setAttribute('role', 'status'); s.dataset.r344 = 'injected'; s.innerHTML = '<strong>A second endpoint has not confirmed.</strong> The page keeps trying by itself; the hold stays until the outcome is verified. Your transaction is not affected.'; after.after(s); return true; })()`);
    note('8-hold-endpoint-line-injected', await shots('08-hold-endpoint-line-INJECTED', VARIANTS, `(() => { const el = document.querySelector('[data-r344]'); const s = getComputedStyle(el); const b = el.getBoundingClientRect(); return { display: s.display, color: s.color, background: s.backgroundColor, borderLeft: s.borderLeftWidth + ' ' + s.borderLeftColor, fontSize: s.fontSize, height: Math.round(b.height), width: Math.round(b.width), reachable: window.__h.reachable(el) }; })()`));
    await page.evaluate(`(document.querySelector('[data-r344]')?.remove(), true)`);
    // The reference panel: Tab stays inside, Escape closes, focus returns.
    // (Closed while a hold is open only if nothing needs attention.)
    const hash = wallet.sent.at(-1).hash;
    await rpc('anvil_mine', [hex(chain.confirmation.settle.depth + 2)]);
    await page.waitFor('the held swap shown as mined', `[...document.querySelectorAll('li[data-state="mined"]')].some((li) => li.textContent.includes(${JSON.stringify(hash)}))`, 120_000);
    const after = await sample(40_000);
    note('8-form-after-the-swap-was-mined', { transitions: after, walletRequestsAfterMined: wallet.requests.filter((r) => r.method === 'eth_sendTransaction').length, sent: wallet.sent.length });
    await shots('08-after-mined', [VARIANTS[0], VARIANTS[2]]);
  }

  // ---- 9. the side panel and the token sheet with the keyboard ----
  {
    await page.evaluate(`(document.querySelector('.trust-details').focus(), true)`);
    await page.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await delay(600);
    const opened = await page.evaluate(`document.querySelector('.reference')?.dataset.open === 'true' && !document.querySelector('.reference').inert`);
    const inside = [];
    for (let i = 0; i < 30; i++) {
      await page.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      inside.push(await page.evaluate(`!!document.activeElement && document.querySelector('.reference').contains(document.activeElement)`));
    }
    await shots('09-reference-panel', VARIANTS);
    await page.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await delay(400);
    note('9-reference-panel-keyboard', { opened, tabStaysInside: inside.every(Boolean), escapedClosed: await page.evaluate(`!document.querySelector('.reference').dataset.open`), focusReturned: await page.evaluate(`document.activeElement?.className ?? null`) });
    await page.evaluate(`(document.querySelector('[data-testid="token-chip-pay"]').click(), true)`);
    await delay(500);
    await shots('09-token-sheet', VARIANTS);
    note('9-token-sheet', await page.evaluate(`(() => { const d = document.querySelector('dialog[open]'); return d ? { modal: d.matches(':modal'), text: d.innerText.replace(/\\s+/g, ' ').slice(0, 200) } : null; })()`));
    await page.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  }

  // ---- 10. every origin the page contacted, and the console ----
  note('10-origins', await page.evaluate(`[...new Set(performance.getEntriesByType('resource').map((e) => new URL(e.name).origin))]`));
  note('10-console', page.console.filter((l) => /pageerror|Content Security Policy|error:/i.test(l)).slice(0, 20));
  note('10-wallet', { sendRequests: wallet.requests.filter((r) => r.method === 'eth_sendTransaction').length, sent: wallet.sent.length });
  void origins;
} catch (error) {
  unexpected = String(error.stack ?? error).slice(0, 1500);
  note('unexpected', unexpected);
} finally {
  await rpc('evm_setAutomine', [true]).catch(() => {});
  await modes('ok').catch(() => {});
  await browser.close();
}
process.exit(unexpected ? 1 : 0);
