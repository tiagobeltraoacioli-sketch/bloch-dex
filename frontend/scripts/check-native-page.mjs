// Offline WebKit verification of the actual packaged Worker. No wallet or RPC writes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const { webkit, devices } = await import(process.env.POSTERN_PLAYWRIGHT_MODULE || 'playwright');
const captured = process.env.POSTERN_RELEASE_DIR;
assert.ok(captured, 'Set POSTERN_RELEASE_DIR');
const hashes = JSON.parse(await readFile(captured + '/capture-sha256.json'));
const types = { html:'text/html', js:'text/javascript', css:'text/css', woff2:'font/woff2', json:'application/json', svg:'image/svg+xml' };
const realFetch = globalThis.fetch;
globalThis.fetch = async request => {
  const url = new URL(request.url);
  const path = url.pathname === '/' ? '/index.html' : url.pathname;
  if (request.method !== 'GET' || !Object.hasOwn(hashes,path)) return new Response('Offline fixture unavailable',{status:503});
  const bytes = await readFile(captured + path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),hashes[path]);
  return new Response(bytes,{headers:{'Content-Type':types[path.split('.').at(-1)] || 'application/octet-stream'}});
};
const { default: worker } = await import('../dist/mobile-hotfix/worker.mjs');
globalThis.fetch = realFetch;
const browser = await webkit.launch();
try {
  for (const mobile of [false,true]) {
    const context = await browser.newContext(mobile ? {...devices['iPhone 13'], serviceWorkers:'block'} : {viewport:{width:1280,height:900},serviceWorkers:'block'});
    await context.route('**/*', async route => {
      const request = route.request();
      if (new URL(request.url()).hostname !== 'blochdex.com') return route.abort();
      const response = await worker.fetch(new Request(request.url(),{method:request.method()}));
      await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
    });
    if (!mobile) await context.addInitScript(() => {
      window.__nativeCalls = [];
      window.bloch = {isBloch:true,chain:'bloch-genesis4',signatureSuite:'ml-dsa-65+falcon-1024', async request(method) {
        window.__nativeCalls.push(method);
        if (method === 'bloch_connect') return {connected:true};
        if (method === 'bloch_getAccount') return {address:'bloch1t'+'a'.repeat(48)};
        throw Error('Unexpected native wallet call');
      }};
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('https://blochdex.com/');
    const native = page.locator('nav[aria-label="Main navigation"] a[href="/l1/"]');
    await native.waitFor();
    assert.equal(await page.locator('nav[aria-label="Main navigation"] a').count(),4);
    await native.click();
    await page.getByRole('heading',{name:'Native BLCH / USDT',exact:true}).waitFor();
    assert.equal(new URL(page.url()).pathname,'/l1/');
    assert.equal(await page.getByRole('link',{name:'Back to EVM testnet'}).getAttribute('href'),'/#/onchain');
    if (!mobile) assert.deepEqual(await page.evaluate(()=>window.__nativeCalls),[]);
    await page.getByRole('button',{name:'Connect Postern Wallet',exact:true}).click();
    if (mobile) await page.getByRole('status').filter({hasText:'Postern Wallet was not detected'}).waitFor();
    else {
      await page.getByText('bloch1t'+'a'.repeat(48),{exact:true}).waitFor();
      assert.deepEqual(await page.evaluate(()=>window.__nativeCalls),['bloch_connect','bloch_getAccount']);
    }
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    assert.deepEqual(errors,[]);
    await page.screenshot({path:`/tmp/postern-native-route-${mobile?'iphone':'desktop'}.png`,fullPage:true});
    await context.close();
    console.log(`Packaged Worker: ${mobile?'iPhone without provider':'desktop with mock native provider'} passed`);
  }
} finally { await browser.close(); }
