// Run against the captured production assets, or POSTERN_LIVE=1 after publication.
// Providers are mocks; this never opens a real wallet or submits transactions.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createMobileWalletWorker } from '../edge/worker.mjs';

const { webkit, devices } = await import(process.env.POSTERN_PLAYWRIGHT_MODULE || 'playwright');
const release = JSON.parse(
  await readFile(new URL('../dist/mobile-hotfix/release.json', import.meta.url)),
);
const browserScript = await readFile(
  new URL('../dist/mobile-hotfix/mobile-wallet.js', import.meta.url),
  'utf8',
);
const live = process.env.POSTERN_LIVE === '1';
const captured = process.env.POSTERN_RELEASE_DIR;
assert.ok(live || captured, 'Set POSTERN_RELEASE_DIR to the captured Pages asset directory');
const evidence = process.env.POSTERN_EVIDENCE_DIR || '/tmp/blochdex-mobile-evidence';
await mkdir(evidence, { recursive: true });
const hashes = live ? null : JSON.parse(await readFile(join(captured, 'capture-sha256.json')));
const browser = await webkit.launch();
const errors = [];
const mime = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.html': 'text/html',
};
const context = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
try {
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'metamask.app.link') {
      return route.abort();
    }
    if (
      url.hostname !== 'blochdex.com' ||
      route.request().method() !== 'GET' ||
      url.pathname.startsWith('/api/')
    ) {
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"error":"Read-only browser test: network adapter unavailable"}',
      });
    }
    if (live) return route.continue();
    if (url.pathname === release.scriptPath) {
      return route.fulfill({ contentType: 'text/javascript', body: browserScript });
    }
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!Object.hasOwn(hashes, path))
      return route.fulfill({ status: 404, body: 'Fixture not found' });
    const data = await readFile(join(captured, path));
    assert.equal(createHash('sha256').update(data).digest('hex'), hashes[path]);
    if (path === '/index.html') {
      const worker = createMobileWalletWorker(
        browserScript,
        release.scriptPath,
        () => new Response(data, { headers: { 'Content-Type': 'text/html' } }),
      );
      const response = await worker.fetch(new Request(url));
      assert.equal(response.headers.get('X-Postern-Mobile-Hotfix'), '1');
      return route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()),
      });
    }
    const ext = path.slice(path.lastIndexOf('.'));
    return route.fulfill({ contentType: mime[ext] || 'application/octet-stream', body: data });
  });

  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const response = await page.goto('https://blochdex.com/');
  assert.equal(response.status(), 200);
  assert.equal(response.headers()['x-postern-mobile-hotfix'], '1');
  await page.locator('header.topbar .connect-button').click();
  const dialog = page.locator('dialog[open]');
  const handoff = dialog.getByRole('link', { name: 'Open MetaMask', exact: true });
  await handoff.waitFor({ state: 'visible' });
  assert.equal(
    await handoff.getAttribute('href'),
    'https://metamask.app.link/dapp/blochdex.com/?connect=metamask',
  );
  assert.equal(await page.evaluate(() => window.ethereum), undefined);
  const bounds = await handoff.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= page.viewportSize().width);
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= page.viewportSize().height);
  await page.screenshot({
    path: join(evidence, live ? 'live-iphone-safari.png' : 'iphone-safari.png'),
    fullPage: true,
  });
  await page.evaluate(() => {
    window.__handoffClicks = [];
    document.addEventListener('click', (event) => {
      const link = event.target.closest?.('[data-postern-mobile-handoff] a');
      if (!link) return;
      window.__handoffClicks.push({
        href: link.href,
        blocked: event.defaultPrevented,
        trusted: event.isTrusted,
      });
      // Record browser activation without asking macOS to open a real wallet app.
      event.preventDefault();
    });
  });
  await handoff.click();
  assert.deepEqual(await page.evaluate(() => window.__handoffClicks), [
    {
      href: 'https://metamask.app.link/dapp/blochdex.com/?connect=metamask',
      blocked: false,
      trusted: true,
    },
  ]);
  await page.close();

  const app = await context.newPage();
  app.on('pageerror', (error) => errors.push(error.message));
  await app.goto('https://blochdex.com/?connect=metamask');
  await app.locator('dialog[open]').waitFor();
  // Reproduce injection later than the old one-time 250ms scan and all retries.
  await app.waitForTimeout(6100);
  await app.evaluate(() => {
    window.__walletCalls = [];
    window.ethereum = {
      isMetaMask: true,
      async request({ method }) {
        window.__walletCalls.push(method);
        if (method === 'eth_requestAccounts') return ['0x1111111111111111111111111111111111111111'];
        if (method === 'eth_chainId') return '0x1';
        throw new Error('Unexpected mock wallet method: ' + method);
      },
      on() {},
      removeListener() {},
    };
    window.dispatchEvent(new Event('ethereum#initialized'));
  });
  const connect = app.getByRole('button', { name: 'Connect MetaMask', exact: true });
  await connect.waitFor({ state: 'visible' });
  assert.deepEqual(await app.evaluate(() => window.__walletCalls), []);
  assert.equal(
    await app
      .getByRole('link', { name: 'Open MetaMask', exact: true })
      .getAttribute('aria-disabled'),
    'true',
  );
  await connect.click();
  await app.getByRole('heading', { name: 'Connected wallet', exact: true }).waitFor();
  assert.deepEqual(await app.evaluate(() => window.__walletCalls), [
    'eth_requestAccounts',
    'eth_chainId',
  ]);
  assert.equal(await app.locator('[data-postern-mobile-handoff]').count(), 0);
  await app.screenshot({
    path: join(evidence, live ? 'live-iphone-connected-mock.png' : 'iphone-connected-mock.png'),
    fullPage: true,
  });
  await app.getByRole('button', { name: 'Disconnect from this app', exact: true }).click();
  await app.getByRole('heading', { name: 'Connect a wallet', exact: true }).waitFor();
  assert.equal(await app.locator('[data-postern-mobile-handoff]').count(), 1);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        mode: live ? 'published site' : 'captured production',
        browser: 'WebKit / iPhone 13',
        handoff: 'passed',
        delayedInjection: 'passed',
        explicitAuthorization: 'passed (mock)',
        disconnect: 'passed',
        pageErrors: errors.length,
        evidence,
      },
      null,
      2,
    ),
  );
} finally {
  await context.close();
  await browser.close();
}
