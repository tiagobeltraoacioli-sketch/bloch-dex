// The Bloch L2 as the seventh network of the multichain site "Bloch DEX", in a real browser engine (agent 415,
// round 20). Two commands, both loopback only, with throwaway keys and a simulated wallet:
//
//   node bloch-l2-network.mjs not-live <dist-multichain> <port> <out-dir> [chrome]
//     The COMMITTED production build, served with its own _headers. For each of the seven routes: the page shows
//     "Not yet live", the header's "Connect wallet" is pressed, and the page must have asked nothing of anyone:
//     every resource the browser loaded is the site's own, no fetch / XHR / WebSocket / EventSource / beacon was
//     started, the injected wallet got no request, and the policy blocked nothing. The six public routes keep the
//     Bloch-words guard; the Bloch L2 route says why it is not live. Then the seven-network header, the switcher
//     (a sheet on a phone) and the Bloch L2 route at 1440, 1000, 390 and 360 px, dark and light, with screenshots.
//
//   node bloch-l2-network.mjs live <multichain-harness.json> <wallet-harness.json> <out-dir>
//     The two harness files of bloch-l2-network-hook.sh: both sites built from the same record and network file
//     of one rehearsal chain that carries the L2 exchange with its real constructor rules. The Bloch L2 route of
//     the multichain site is compared, screen by screen, with the Bloch L2 site's own #/mainnet: the page before a
//     wallet, the reference layer (pools, caps, network, deployment, bridged assets), a connected wallet, a quote,
//     an amount above the reserve cap (refused, with the cap named) and a swap that is sent and finalized. Then
//     what only the multichain shell adds or must not add, and screenshots of the live route in four variants.
//
// Exit status 0 only when every assertion held.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { launch, openPage } from './cdp.mjs';
import { createWallet, PROVIDER_SCRIPT } from './wallet.mjs';

const [command, ...args] = process.argv.slice(2);
const CHROME_DEFAULT = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const say = (line) => console.log(line);
const results = [];
const check = (what, ok, detail) => {
  results.push({ what, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
  say(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${ok || detail === undefined ? '' : ` (${JSON.stringify(detail).slice(0, 600)})`}`);
};
const loopback = (url) => {
  if (!/^http:\/\/127\.0\.0\.1:\d+(\/|$)/.test(url)) throw new Error(`${url} is not a loopback URL`);
  return url;
};

// Everything the page starts by itself is recorded in the page, before any page script runs: a request that the
// policy blocks or that fails is seen here too, which a list of completed loads would miss.
const NET_SPY = String.raw`
(() => {
  const net = (window.__net = { fetch: [], xhr: [], socket: [], source: [], beacon: [], csp: [], wallet: [] });
  const realFetch = window.fetch;
  window.fetch = function (input, init) { net.fetch.push(String(input?.url ?? input)); return realFetch.call(this, input, init); };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) { net.xhr.push(String(url)); return open.apply(this, arguments); };
  const Socket = window.WebSocket;
  window.WebSocket = function (url, protocols) { net.socket.push(String(url)); return new Socket(url, protocols); };
  window.WebSocket.prototype = Socket.prototype;
  if (window.EventSource) { const Source = window.EventSource; window.EventSource = function (url, o) { net.source.push(String(url)); return new Source(url, o); }; }
  const beacon = navigator.sendBeacon?.bind(navigator);
  if (beacon) navigator.sendBeacon = (url, data) => (net.beacon.push(String(url)), beacon(url, data));
  document.addEventListener('securitypolicyviolation', (e) => net.csp.push(e.violatedDirective + ' ' + e.blockedURI));
})();`;
// A browser wallet that is present and counts what it is asked (the not-live routes must ask it nothing).
const WALLET_SPY = String.raw`
(() => {
  const provider = { request(a) { window.__net.wallet.push(a?.method); return Promise.reject(Object.assign(new Error('not in this run'), { code: 4001 })); }, on() {}, removeListener() {} };
  window.ethereum = provider;
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: '6a0e7c1d-2b3f-4d5a-8c9e-1f2a3b4c5d6e', name: 'Spy wallet', icon: '', rdns: 'invalid.postern-spy' }, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
})();`;
const NET = `JSON.stringify({ ...window.__net, resources: performance.getEntriesByType('resource').map((r) => r.name) })`;
const PUBLIC = [
  ['ethereum', 'Ethereum', 1],
  ['base', 'Base', 8453],
  ['arbitrum-one', 'Arbitrum One', 42161],
  ['op-mainnet', 'OP Mainnet', 10],
  ['linea', 'Linea', 59144],
  ['bnb-smart-chain', 'BNB Smart Chain', 56],
];
const THEME_KEY = 'postern.theme.v1';
const VARIANTS = [1440, 1000, 390, 360].flatMap((width) => ['dark', 'light'].map((theme) => ({ theme, width, height: width >= 861 ? 900 : 844, mobile: width < 861 })));
async function setVariant(page, v) {
  await page.cdp('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: v.mobile ? 2 : 1, mobile: v.mobile, screenWidth: v.width, screenHeight: v.height });
  await page.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: v.theme }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
  await page.evaluate(`(() => { try { localStorage.setItem(${JSON.stringify(THEME_KEY)}, ${JSON.stringify(v.theme)}); } catch {} document.documentElement.dataset.theme = ${JSON.stringify(v.theme)}; return true; })()`);
  await delay(250);
}
const viewportShot = async (page, file) => {
  const { data } = await page.cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(file, Buffer.from(data, 'base64'));
};
/** The header as laid out: the seven links, whether each is whole inside the window, and whether the page scrolls sideways. */
const HEADER = `(() => {
  const nav = document.querySelector('nav.main-nav');
  const links = [...nav.querySelectorAll('a')].map((a) => { const r = a.getBoundingClientRect(); return { text: a.textContent, left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), height: Math.round(r.height) }; });
  const n = nav.getBoundingClientRect();
  return JSON.stringify({ width: innerWidth, pageScrollWidth: document.documentElement.scrollWidth, links, navLeft: Math.round(n.left), navRight: Math.round(n.right), navScrollWidth: nav.scrollWidth, navClientWidth: nav.clientWidth, current: nav.querySelector('[aria-current="page"]')?.textContent });
})()`;
const SHEET = `(() => {
  const panel = document.querySelector('.network-switcher .popover-panel');
  if (!panel) return null;
  const p = panel.getBoundingClientRect();
  const rows = [...panel.querySelectorAll('li')].map((li) => { const r = li.getBoundingClientRect(); return { text: li.innerText.replace(/\\s+/g, ' ').trim(), top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), link: li.querySelector('a')?.getAttribute('href') ?? null }; });
  return JSON.stringify({ height: innerHeight, width: innerWidth, top: Math.round(p.top), bottom: Math.round(p.bottom), left: Math.round(p.left), right: Math.round(p.right), scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight, overflowY: getComputedStyle(panel).overflowY, rows });
})()`;

async function notLive() {
  const [dist, portText, out, chrome = CHROME_DEFAULT] = args;
  const port = Number(portText);
  if (!dist || !port || !out) throw new Error('usage: bloch-l2-network.mjs not-live <dist-multichain> <port> <out-dir> [chrome]');
  mkdirSync(out, { recursive: true });
  const origin = `http://127.0.0.1:${port}`;
  const headers = readFileSync(join(dist, '_headers'), 'utf8');
  check('the served _headers is the committed policy: it does not name the Bloch L2 RPC', !/blochl1\.com/.test(headers));
  const server = spawn(process.execPath, [fileURLToPath(new URL('../../../scripts/staging/render/serve.mjs', import.meta.url)), dist, String(port)], { stdio: 'ignore' });
  await delay(600);
  const browser = await launch(chrome, port + 1);
  try {
    const { browserContextId } = await browser.send('Target.createBrowserContext');
    const page = await openPage(browser, browserContextId, { initScript: `${NET_SPY}\n${WALLET_SPY}`, url: `${origin}/#/ethereum`, log: say });
    const routes = [...PUBLIC, ['bloch-l2', 'Bloch L2', 700770]];
    for (const [key, name, chainId] of routes) {
      say(`== not live: #/${key}`);
      // A fresh document for every route: what is counted is this route's own page load and nothing before it.
      await page.goto('about:blank').catch(() => {});
      await page.goto(`${origin}/#/${key}`);
      await page.waitText('/Not yet live/');
      await page.waitText('/Bloch DEX is not active yet\\./');
      const heading = await page.evaluate(`document.querySelector('h1').textContent`);
      check(`#/${key}: the heading names the network`, heading === `Bloch DEX on ${name}`, heading);
      await page.click('Connect wallet');
      await page.waitText(`/Connecting a wallet becomes available when ${name} is live on Bloch DEX\\. Nothing was asked of any wallet\\./`);
      // The switcher opened and closed: a control every visitor uses.
      await page.evaluate(`document.querySelector('.network-button').click()`);
      await page.waitFor('switcher', `document.querySelectorAll('.network-switcher .popover-panel li').length === 7`);
      await page.evaluate(`document.querySelector('.network-button').click()`);
      await delay(1500);
      const net = JSON.parse(await page.evaluate(NET));
      const foreign = net.resources.filter((u) => !u.startsWith(`${origin}/`));
      check(`#/${key}: every resource the browser loaded is the site's own (${net.resources.length} loaded)`, foreign.length === 0 && net.resources.length > 0, foreign);
      check(`#/${key}: no fetch, XHR, WebSocket, EventSource or beacon was started`, [net.fetch, net.xhr, net.socket, net.source, net.beacon].every((l) => l.length === 0), net);
      check(`#/${key}: the browser wallet was asked nothing`, net.wallet.length === 0, net.wallet);
      check(`#/${key}: the policy blocked nothing (nothing was attempted)`, net.csp.length === 0, net.csp);
      check(`#/${key}: no connect step and no mobile-wallet button`, await page.evaluate(`!document.querySelector('[data-wallet-connect]') && !document.querySelector('[data-mobile-wallet]')`));
      check(`#/${key}: no WalletConnect code was loaded`, !net.resources.some((u) => /walletconnect|\/qr-|\/dist-/.test(u)), net.resources.filter((u) => /walletconnect|\/qr-|\/dist-/.test(u)));
      check(`#/${key}: no console error`, !page.console.some((l) => /^(error|pageerror)/.test(l)), page.console.filter((l) => /^(error|pageerror)/.test(l)));
      const main = await page.evaluate(`document.querySelector('main').innerText.replace(/\\s+/g, ' ')`);
      if (chainId === 700770) {
        // Restated on 2026-11-19 (agent 440): the committed network file pins the L2 genesis and names the public
        // explorer, so "The reviewed L2 genesis hash is not pinned yet." is no longer among the reasons (it was the
        // fourth), and the two facts are checked below.
        check('#/bloch-l2: says why it is not live: the deposit-only launch release, no record, the RPC not marked published', [
          'Bloch L2 runs its deposit-only launch release: it does not accept user transactions yet, so the exchange cannot be deployed on it and no swap can be sent there.',
          'No verified mainnet deployment record has been published.',
          'The public L2 RPC is not published yet.',
          'The DEX is not deployed on the Bloch L2 mainnet yet. This page sends no RPC request and no transaction until a verified deployment record is published with this site.',
        ].every((line) => main.includes(line)), main.slice(0, 900));
        check('#/bloch-l2: the reasons are exactly those three', (await page.evaluate(`document.querySelectorAll('[aria-label="Not yet live"] li').length`)) === 3 && !main.includes('The reviewed L2 genesis hash is not pinned yet.'), main.slice(0, 900));
        check('#/bloch-l2: the network block shows the pinned L2 genesis hash and the public explorer as a link that asks nothing by itself', main.includes('L2 genesis 0x632e45ae778da371a88dc1ae430193aa77eabb67a11de18e84fea7d20d11f468') && !main.includes('Not pinned yet') && await page.evaluate(`(() => { const a = [...document.querySelectorAll('[aria-label="Network"] a')]; return a.length === 1 && a[0].getAttribute('href') === 'https://blochl1.com/l2' && a[0].textContent === 'https://blochl1.com/l2' && a[0].target === '_blank' && a[0].rel === 'noopener noreferrer'; })()`), main.slice(0, 1600));
        check('#/bloch-l2: no control adds the network to a wallet while the route is not live', main.includes('Adding the network to a wallet is available once the public RPC is published.') && await page.evaluate(`![...document.querySelectorAll('main button')].some((b) => /Add or switch/.test(b.textContent))`));
        check('#/bloch-l2: the planned caps and the placeholder RPC are shown as on the Bloch L2 site', /WBLCH 10 WBLCH/.test(main) && /bUSDC 1000 bUSDC/.test(main) && main.includes('https://l2rpc.blochl1.com (placeholder, not published yet)'), main.slice(0, 1600));
        check('#/bloch-l2: no rule of a public chain is on the page', !/two endpoints|Settlement rule of this network|confirmed block/.test(await page.text()));
      } else {
        check(`#/${key}: nothing of the Bloch L2 inside the route (the site's name apart)`, !/Bloch|BLCH|bUSDC/.test(main.replaceAll('Bloch DEX', '')), main.match(/.{0,40}(Bloch(?! DEX)|BLCH|bUSDC).{0,40}/)?.[0]);
        const outside = await page.evaluate(`(() => { const c = document.body.cloneNode(true); const named = [...c.querySelectorAll('a[href="#/bloch-l2"]')]; const texts = named.map((a) => a.textContent); named.forEach((a) => a.remove()); return JSON.stringify({ texts, rest: /Bloch|BLCH|bUSDC/.test(c.textContent.replaceAll('Bloch DEX', '')) }); })()`);
        check(`#/${key}: outside the route the only Bloch words are the site's name and the link to the seventh network`, JSON.parse(outside).rest === false && JSON.parse(outside).texts.join('|') === 'Bloch L2', outside);
      }
    }

    say('== layout: seven networks in the header, the switcher, the Bloch L2 route');
    for (const v of VARIANTS) {
      const tag = `${v.width}-${v.theme}`;
      await setVariant(page, v);
      for (const key of ['ethereum', 'bloch-l2']) {
        await page.goto('about:blank').catch(() => {});
        await page.goto(`${origin}/#/${key}`);
        await page.waitText('/Not yet live/');
        await setVariant(page, v);
        const h = JSON.parse(await page.evaluate(HEADER));
        check(`${tag} #/${key}: seven links, Bloch L2 last, the current one marked`, h.links.length === 7 && h.links[6].text === 'Bloch L2' && h.current === (key === 'bloch-l2' ? 'Bloch L2' : 'Ethereum'), h.links.map((l) => l.text));
        check(`${tag} #/${key}: the page does not scroll sideways`, h.pageScrollWidth <= h.width, { scrollWidth: h.pageScrollWidth, width: h.width });
        if (v.width >= 861) {
          // On its own row: every name whole inside the window, on one line, without a sideways scroll of the list.
          check(`${tag} #/${key}: every network name is whole inside the window, on one row`, h.links.every((l) => l.left >= 0 && l.right <= h.width && l.top === h.links[0].top) && h.navScrollWidth <= h.navClientWidth + 1, h);
        } else {
          // A phone: the list scrolls sideways by design (styles/gate.css); the switcher's sheet is the full list.
          const visible = h.links.filter((l) => l.left >= 0 && l.right <= h.width).map((l) => l.text);
          check(`${tag} #/${key}: the header list is a sideways scroll on a phone and holds all seven`, h.navScrollWidth >= h.navClientWidth && h.links.length === 7, { visible, scroll: h.navScrollWidth, client: h.navClientWidth });
          check(`${tag} #/${key}: the selected network's name is whole inside the list's view`, visible.includes(h.current), { visible, current: h.current });
        }
        await viewportShot(page, join(out, `header-${key}-${tag}.png`));
        if (key === 'bloch-l2') await page.screenshot(join(out, `l2-not-live-${tag}.png`));
        await page.evaluate(`document.querySelector('.network-button').click()`);
        await page.waitFor('switcher', `document.querySelectorAll('.network-switcher .popover-panel li').length === 7`);
        await delay(250);
        const s = JSON.parse(await page.evaluate(SHEET));
        const reachable = s.rows.every((r) => r.left >= 0 && r.right <= s.width) && (s.rows.every((r) => r.top >= 0 && r.bottom <= s.height) || (s.scrollHeight > s.clientHeight && /auto|scroll/.test(s.overflowY)));
        check(`${tag} #/${key}: the switcher lists seven networks, the last one Bloch L2 with its route, all reachable`, s.rows.length === 7 && /^Bloch L2 Chain 700770 · Not yet live/.test(s.rows[6].text) && s.rows[6].link === '#/bloch-l2' && reachable && s.left >= 0 && s.right <= s.width, s);
        // The last row is brought into view as a user would scroll to it, and must then be whole inside the window.
        const last = JSON.parse(await page.evaluate(`(() => { const li = [...document.querySelectorAll('.network-switcher .popover-panel li')].at(-1); li.scrollIntoView({ block: 'nearest' }); const r = li.getBoundingClientRect(); return JSON.stringify({ top: Math.round(r.top), bottom: Math.round(r.bottom), height: innerHeight }); })()`));
        check(`${tag} #/${key}: the Bloch L2 row is whole inside the window`, last.top >= 0 && last.bottom <= last.height, last);
        await viewportShot(page, join(out, `switcher-${key}-${tag}.png`));
        await page.evaluate(`document.querySelector('.network-button').click()`);
      }
    }
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
}

async function live() {
  const [multichainFile, l2File, out] = args;
  if (!multichainFile || !l2File || !out) throw new Error('usage: bloch-l2-network.mjs live <multichain-harness.json> <wallet-harness.json> <out-dir>');
  const here = JSON.parse(readFileSync(multichainFile, 'utf8'));
  const own = JSON.parse(readFileSync(l2File, 'utf8'));
  for (const url of [here.rpc, here.page, own.page]) loopback(url);
  mkdirSync(out, { recursive: true });
  let rpcId = 0;
  const rpc = async (method, params = []) => {
    const response = await fetch(here.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
    const body = await response.json();
    if (body.error) throw Object.assign(new Error(`${method}: ${body.error.message}`), { code: body.error.code });
    return body.result;
  };
  const hex = (n) => `0x${BigInt(n).toString(16)}`;
  // The page's RPC: a CORS gateway in front of anvil, as the public gateway is in front of the settled RPC.
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
  const pageCalls = [];
  const gateway = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try {
      const message = JSON.parse(raw);
      for (const call of Array.isArray(message) ? message : [message]) pageCalls.push({ origin: req.headers.origin, method: call.method, tag: call.method === 'eth_getBlockByNumber' ? call.params?.[0] : call.params?.[1] });
    } catch {
      /* forwarded as is */
    }
    const upstream = await fetch(here.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
    res.writeHead(200, { 'content-type': 'application/json', ...cors }).end(await upstream.text());
  }).listen(here.gatewayPort, '127.0.0.1');
  const gatewayOrigin = `http://127.0.0.1:${here.gatewayPort}`;
  const browser = await launch(here.chrome, here.debugPort);
  try {
    // One account for both sites, in two separate browser profiles (two origins anyway).
    const wallet = createWallet({ rpc, chainId: here.chainId });
    // It starts on Ethereum and has never heard of the Bloch L2.
    wallet.state.chainId = '0x1';
    let chainAdded = false;
    await rpc('anvil_setBalance', [wallet.address, hex(5n * 10n ** 18n)]);
    await rpc('anvil_mine', ['0x41']);
    const open = async (config) => {
      const { browserContextId } = await browser.send('Target.createBrowserContext');
      return openPage(browser, browserContextId, {
        initScript: `${NET_SPY}\n${PROVIDER_SCRIPT}`,
        url: config.page,
        log: say,
        onBinding: (bridge, payload, from) => {
          if (bridge !== '__walletBridge') return;
          const { id, method, params } = JSON.parse(payload);
          // A wallet that does not list chain 700770: the switch is refused with 4902 until the network was added.
          const unknown = method === 'wallet_switchEthereumChain' && params[0]?.chainId === '0xab162' && !chainAdded;
          if (unknown) wallet.requests.push({ method, params, refused: 4902 });
          if (method === 'wallet_addEthereumChain') chainAdded = true;
          (unknown ? Promise.reject({ code: 4902, message: 'Unrecognized chain ID "0xab162".' }) : wallet.handle(method, params)).then(
            (value) => from.evaluate(`window.__walletReply(${id}, true, ${JSON.stringify(value)})`).catch(() => {}),
            (error) => from.evaluate(`window.__walletReply(${id}, false, ${JSON.stringify({ code: error.code ?? -32603, message: error.message ?? String(error) })})`).catch(() => {}),
          );
        },
      });
    };
    const site = { l2: await open(own), dex: await open(here) };
    for (const page of Object.values(site)) await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const both = (f) => Promise.all([f(site.l2), f(site.dex)]);
    // The route itself (the section MainnetLive renders), as text. `all`: with the regions a click opens.
    const routeText = (page, all = false) => page.evaluate(`(() => { const el = document.querySelector('section.mainnet-page'); return (${all} ? el.textContent : el.innerText).replace(/\\s+/g, ' ').trim(); })()`);
    // The two differences of wording this site makes on purpose (multichain/bloch-l2.ts BLOCH_L2_SITE_WORDING).
    const asOwn = (text) => text.replaceAll('Bloch DEX on Bloch L2', 'Bloch L2 mainnet').replaceAll('Bloch L2 reads', 'Mainnet reads');
    const same = async (what, part) => {
      const [a, b] = await both((p) => (part ? p.evaluate(part) : routeText(p, true)));
      const equal = a !== null && asOwn(String(b)) === String(a);
      let at = -1;
      if (!equal && a && b) for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== asOwn(String(b))[i]) { at = i; break; }
      check(`same on both sites: ${what}${equal ? ` (${String(a).length} characters)` : ''}`, equal, equal ? undefined : { at, l2Site: String(a).slice(Math.max(0, at - 80), at + 160), blochDex: asOwn(String(b)).slice(Math.max(0, at - 80), at + 160) });
      return String(a);
    };
    const labelled = (name) => `(() => { const el = [...document.querySelectorAll('section.mainnet-page [aria-label]')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(name)}); return el ? el.textContent.replace(/\\s+/g, ' ').trim() : null; })()`;
    const shot = async (state) => {
      await site.l2.screenshot(join(out, `compare-${state}--l2-site.png`));
      await site.dex.screenshot(join(out, `compare-${state}--bloch-dex.png`));
    };

    say('== 1 the route before a wallet');
    await both((p) => p.waitText('/Pools at finalized block \\d+/'));
    const heading = await both((p) => p.evaluate(`document.querySelector('h1').textContent`));
    check('the headings are each site\'s own', heading[0] === 'Bloch L2 mainnet' && heading[1] === 'Bloch DEX on Bloch L2', heading);
    const first = await same('the whole route, every region included (heading words apart)');
    check('the route shows the L2 rules: finalized L2 block, fixed reserve caps, caps in use', /finalized L2 block/.test(first) && /Pools have fixed reserve caps; this is a guarded launch\./.test(first) && /caps in use: \d/.test(first), first.slice(0, 400));
    await same('Pools table (reserves, caps, headroom)', `(() => { const t = document.querySelector('section.mainnet-page table'); return t ? t.textContent.replace(/\\s+/g, ' ') : null; })()`);
    await same('Network block', labelled('Network'));
    await same('Deployment record block', labelled('Deployment record'));
    await same('Bridges block (bridged assets)', labelled('Bridges'));
    await shot('1-before-wallet');

    say('== 2 a browser wallet on another network connects, and is asked to add Bloch L2');
    await both((p) => p.click('Connect Harness wallet'));
    await both((p) => p.waitFor('finalized balances', `!!window.__h.labelled('Finalized balances')`));
    await both((p) => p.waitText('/it will be asked to switch to chain 700770/'));
    await same('the whole route with a wallet that is on another network');
    await site.dex.click('Add or switch to Bloch L2');
    await site.dex.waitText('/Your wallet is on Bloch L2 \\(chain 700770\\)\\./');
    const chainRequests = wallet.requests.filter((r) => /^wallet_/.test(r.method));
    const added = chainRequests.find((r) => r.method === 'wallet_addEthereumChain')?.params?.[0] ?? {};
    check('the page asked to switch, was told 4902, then asked to add the network: one switch, one add', chainRequests.map((r) => `${r.method}${r.refused ? ':4902' : ''}`).join(' ') === 'wallet_switchEthereumChain:4902 wallet_addEthereumChain', chainRequests.map((r) => r.method));
    check('the network it adds is the L2 network file\'s: chain 0xab162, Bloch L2, BLCH, the one L2 endpoint', added.chainId === '0xab162' && added.chainName === 'Bloch L2' && added.nativeCurrency?.symbol === 'BLCH' && added.nativeCurrency?.decimals === 18 && JSON.stringify(added.rpcUrls) === JSON.stringify([gatewayOrigin]), added);
    check('nothing was sent while the wallet was on another network', wallet.sends().length === 0);
    // The same press on the Bloch L2 site: the wallet is on the chain by now, so it is asked nothing more.
    await site.l2.click('Add or switch to Bloch L2');
    await site.l2.waitText('/Your wallet is on Bloch L2 \\(chain 700770\\)\\./');
    check('the second site found the wallet on the chain and asked for no second switch or add', wallet.requests.filter((r) => /^wallet_/.test(r.method)).length === 2);
    // The wallet tells every page of the change, as an extension does.
    await both((p) => p.evaluate(`(window.__walletEmit('chainChanged', '0xab162'), true)`));
    await both((p) => p.waitFor('wallet on chain', `/on chain 700770/.test(document.body.innerText) && !/it will be asked to switch/.test(document.body.innerText)`));
    await same('Finalized balances', labelled('Finalized balances'));
    await same('the whole route with a wallet connected');

    say('== 3 a quote');
    const quote = async (pay, receive, amount) => {
      await both(async (p) => {
        await p.select('You pay', pay);
        await p.select('You receive', receive);
        await p.fill('Amount', amount);
        await p.click('Get quote');
      });
    };
    await quote('BLCH', 'bUSDC', '0.01');
    await both((p) => p.waitFor('quote', `!!window.__h.labelled('Quote')`));
    await delay(1200);
    const quoted = await same('Quote', labelled('Quote'));
    check('the quote is at the finalized block and carries the cap headroom', /Finalized block \d+/.test(quoted) && /headroom/.test(quoted), quoted.slice(0, 500));
    const reverts = await same('Revert conditions', labelled('Revert conditions'));
    check('the revert conditions name the reserve cap', /RESERVE_CAP/.test(reverts), reverts);
    await same('the whole route with a quote');
    await shot('3-quote');

    say('== 4 an amount above the reserve cap');
    // The WBLCH side of the pool is capped at 10 WBLCH: 4.9 BLCH more cannot flow in on top of the seeded reserve.
    await both(async (p) => { await p.fill('Amount', '4.9'); await p.click('Get quote'); });
    await both((p) => p.waitText('/reserve cap|No route can fill this amount/'));
    await delay(800);
    const refused = await same('the whole route with the over-cap amount');
    check('the refusal names the cap and offers no Swap', /cap/.test(refused) && /No route can fill this amount at the finalized block|would lift/.test(refused), refused.match(/.{0,200}(No route can fill|would lift).{0,300}/)?.[0] ?? refused.slice(0, 600));
    const swapOffered = await both(async (p) => (await p.button('Swap'))?.disabled === false);
    check('Swap is not available for it on either site', swapOffered[0] === false && swapOffered[1] === false, swapOffered);
    await shot('4-over-cap');

    say('== 5 a swap sent from the Bloch DEX site, seen by both');
    const p = site.dex;
    await p.fill('Amount', '0.01');
    await p.click('Get quote');
    await p.waitFor('quote', `!!window.__h.labelled('Quote')`);
    await delay(1200);
    const nonceBefore = Number(await rpc('eth_getTransactionCount', [wallet.address, 'latest']));
    await p.click('Swap');
    await p.waitText('/Waiting for the next L2 block and canonical finality\\./');
    check('while it is pending the page holds Swap and says not to resend', /Do not resend with a new nonce; Swap stays disabled until the outcome is known\./.test(await p.text()));
    await rpc('anvil_mine', ['0x1']);
    await rpc('anvil_mine', ['0x41']);
    await p.waitText('/verified canonical and finalized/', 60_000);
    const nonceAfter = Number(await rpc('eth_getTransactionCount', [wallet.address, 'latest']));
    check('exactly one transaction of the account was mined, to the router', nonceAfter === nonceBefore + 1 && wallet.sends().length === 1, { nonceBefore, nonceAfter, sends: wallet.sends().length });
    const asked = wallet.sends().at(-1)?.params?.[0] ?? {};
    check('the wallet was asked for chain 700770 (0xab162), from the account, to the router', asked.chainId === '0xab162' && String(asked.to).toLowerCase() === here.router.toLowerCase() && String(asked.from).toLowerCase() === wallet.address, { chainId: asked.chainId, to: asked.to, from: asked.from });
    check('the request carries the L2 priority fee the page priced for new storage slots, or none when the call creates none', asked.maxPriorityFeePerGas === undefined || /^0x[0-9a-f]+$/.test(asked.maxPriorityFeePerGas), { maxPriorityFeePerGas: asked.maxPriorityFeePerGas, maxFeePerGas: asked.maxFeePerGas });
    await site.l2.click('Refresh');
    await site.dex.click('Refresh').catch(() => {});
    await delay(2500);
    await same('Pools table after the swap', `(() => { const t = document.querySelector('section.mainnet-page table'); return t ? t.textContent.replace(/\\s+/g, ' ') : null; })()`);
    await same('Finalized balances after the swap', labelled('Finalized balances'));

    say('== 6 what only the shell of the Bloch DEX site adds, and what it must not');
    const shell = JSON.parse(await p.evaluate(`JSON.stringify({
      nav: [...document.querySelectorAll('nav.main-nav a')].map((a) => a.textContent),
      title: document.title,
      notes: document.querySelector('[data-testid="l2-route-notes"]')?.innerText ?? null,
      screens: !!document.querySelector('nav.live-tabs'),
      mobile: !!document.querySelector('[data-mobile-wallet]'),
      confirmation: !!document.querySelector('[data-testid="confirmation-rule"]'),
      banner: !!document.querySelector('[data-testid="not-active-banner"]'),
      local: document.querySelector('.local-render-banner')?.textContent ?? null,
      footer: document.querySelector('.footer').innerText.replace(/\\s+/g, ' '),
    })`));
    check('seven networks, the Bloch L2 route selected, the site\'s title', shell.nav.length === 7 && shell.nav[6] === 'Bloch L2' && shell.title === 'Bloch DEX — Bloch L2', shell);
    check('the route says it offers swaps only and which wallet connection works', /On Bloch L2 this site offers swaps only\./.test(shell.notes ?? '') && /Connect a browser wallet here/.test(shell.notes ?? '') && /\(WalletConnect\) is not offered on this network\./.test(shell.notes ?? ''), shell.notes);
    check('no Trade / Pools / Portfolio screens, no mobile-wallet button, no confirmation rule of a public chain', !shell.screens && !shell.mobile && !shell.confirmation, shell);
    check('the site is active (a network is live) and the build says it is a local rehearsal', !shell.banner && /not for publication/.test(shell.local ?? ''), shell);
    check('the footer is the L2\'s: finalized reads and fixed reserve caps, not two endpoints', /Finalized reads · Fixed reserve caps/.test(shell.footer) && !/two endpoints/.test(shell.footer), shell.footer);
    for (const [name, page] of Object.entries(site)) {
      const net = JSON.parse(await page.evaluate(NET));
      const pageOrigin = new URL(name === 'l2' ? own.page : here.page).origin;
      const elsewhere = [...net.resources, ...net.fetch].filter((u) => !u.startsWith(`${pageOrigin}/`) && !u.startsWith(gatewayOrigin));
      check(`${name === 'l2' ? 'Bloch L2 site' : 'Bloch DEX site'}: the page contacted its own origin and the L2 endpoint only; no socket; the policy blocked nothing`, elsewhere.length === 0 && net.socket.length === 0 && net.csp.length === 0 && net.fetch.length > 0, { elsewhere, socket: net.socket, csp: net.csp });
    }
    const byOrigin = (origin) => pageCalls.filter((c) => c.origin === origin);
    const [l2Calls, dexCalls] = [byOrigin(new URL(own.page).origin), byOrigin(new URL(here.page).origin)];
    const methods = (calls) => [...new Set(calls.map((c) => c.method))].sort();
    check('both sites used the same RPC methods on the L2 endpoint, and the snapshot is the `finalized` tag', dexCalls.some((c) => c.method === 'eth_getBlockByNumber' && c.tag === 'finalized') && methods(l2Calls).filter((m) => !methods(dexCalls).includes(m)).length === 0 && !dexCalls.some((c) => c.tag === 'safe' || c.method === 'eth_blockNumber'), { l2: methods(l2Calls), dex: methods(dexCalls) });
    check('neither page published a transaction through its RPC', !pageCalls.some((c) => /sendRawTransaction|sendTransaction/.test(c.method)));

    say('== 7 the live Bloch L2 route in four variants');
    for (const v of VARIANTS.filter((x) => x.width === 1440 || x.width === 390)) {
      await setVariant(p, v);
      await p.screenshot(join(out, `l2-live-${v.width}-${v.theme}.png`));
      const h = JSON.parse(await p.evaluate(HEADER));
      check(`${v.width}-${v.theme}: the live route does not scroll sideways and lists seven networks`, h.pageScrollWidth <= h.width && h.links.length === 7, { scrollWidth: h.pageScrollWidth, width: h.width });
    }
  } finally {
    await browser.close();
    gateway.close();
  }
}

if (command === 'not-live') await notLive();
else if (command === 'live') await live();
else {
  console.error('usage: bloch-l2-network.mjs not-live <dist-multichain> <port> <out-dir> [chrome] | live <multichain-harness.json> <wallet-harness.json> <out-dir>');
  process.exit(2);
}
const failed = results.filter((r) => !r.ok);
const outDir = command === 'not-live' ? args[2] : args[2];
writeFileSync(join(outDir, `bloch-l2-network-${command}.json`), JSON.stringify({ schema: 'postern.frontend.bloch-l2-network.v1', command, at: new Date().toISOString(), assertions: results }, null, 2));
say(`${failed.length === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed.length} of ${results.length} assertions held`);
process.exit(failed.length === 0 ? 0 : 1);
