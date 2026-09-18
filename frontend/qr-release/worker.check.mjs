import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const fixtureDirectory = await mkdtemp(join(tmpdir(), 'postern-qr-worker-'));
await copyFile(new URL('./worker.mjs', import.meta.url), join(fixtureDirectory, 'worker.mjs'));
await writeFile(
  join(fixtureDirectory, 'previous-worker.mjs'),
  'export default { fetch(request, env, ctx) { return globalThis.__posternPreviousFetch(request, env, ctx); } };\n',
);
const { default: worker } = await import(pathToFileURL(join(fixtureDirectory, 'worker.mjs')).href);
after(async () => {
  delete globalThis.__posternPreviousFetch;
  delete globalThis.HTMLRewriter;
  await rm(fixtureDirectory, { recursive: true, force: true });
});

function assetEnvironment(fetch) {
  return { QR_ASSETS: { fetch } };
}

test('delegates unknown hosts and non-preview routes to the preserved worker', async () => {
  const calls = [];
  globalThis.__posternPreviousFetch = (request, env, ctx) => {
    calls.push({ request, env, ctx });
    return new Response('preserved', { status: 202 });
  };
  const assets = assetEnvironment(() => assert.fail('Unexpected asset request'));
  const context = { marker: true };
  for (const url of ['https://unrelated.example/preview/', 'https://blochdex.com/api/rpc']) {
    const request = new Request(url);
    const response = await worker.fetch(request, assets, context);
    assert.equal(response.status, 202);
    assert.equal(await response.text(), 'preserved');
    assert.equal(calls.at(-1).request, request);
    assert.equal(calls.at(-1).env, assets);
    assert.equal(calls.at(-1).ctx, context);
  }
});

test('redirects the preview root and rejects unsupported methods and paths', async () => {
  globalThis.__posternPreviousFetch = () => assert.fail('Unexpected preserved-worker request');
  const assets = assetEnvironment(() => assert.fail('Unexpected asset request'));
  const redirect = await worker.fetch(
    new Request('https://blochdex.com/preview?ignored=1'),
    assets,
    {},
  );
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('Location'), 'https://blochdex.com/preview/');

  const rejected = await worker.fetch(
    new Request('https://blochdex.com/preview/index.html', { method: 'POST' }),
    assets,
    {},
  );
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get('Allow'), 'GET, HEAD');
  assert.equal(
    (await worker.fetch(new Request('https://blochdex.com/preview/file..js'), assets, {})).status,
    404,
  );
  assert.equal(
    (await worker.fetch(new Request('https://blochdex.com/preview/%2Fetc'), assets, {})).status,
    404,
  );
});

test('serves preview assets with bounded cache policy and security headers', async () => {
  globalThis.__posternPreviousFetch = () => assert.fail('Unexpected preserved-worker request');
  const requested = [];
  const assets = assetEnvironment((request) => {
    requested.push(request);
    const path = new URL(request.url).pathname;
    if (path === '/missing.js') return new Response('missing', { status: 404 });
    return new Response(path === '/index.html' ? '<html></html>' : 'asset', {
      headers: { 'Content-Type': path === '/index.html' ? 'text/html' : 'text/javascript' },
    });
  });

  const index = await worker.fetch(
    new Request('https://blochdex.com/preview/?discarded=1'),
    assets,
    {},
  );
  assert.equal(new URL(requested[0].url).pathname, '/index.html');
  assert.equal(new URL(requested[0].url).search, '');
  assert.equal(index.headers.get('Cache-Control'), 'no-store');
  assert.equal(index.headers.get('X-Postern-QR-Release'), '2026-09-16');
  assert.equal(index.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(index.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);

  const asset = await worker.fetch(
    new Request('https://www.blochdex.com/preview/assets/app-123.js'),
    assets,
    {},
  );
  assert.equal(asset.headers.get('Cache-Control'), 'public,max-age=31536000,immutable');
  assert.equal(asset.headers.get('Content-Security-Policy'), null);

  const missing = await worker.fetch(
    new Request('https://blochdex.com/preview/missing.js'),
    assets,
    {},
  );
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('Cache-Control'), 'no-store');
});

test('rewrites only successful root HTML and invalidates transformed metadata', async () => {
  const insertions = [];
  globalThis.HTMLRewriter = class {
    on(selector, handler) {
      assert.equal(selector, 'body');
      this.handler = handler;
      return this;
    }

    transform(response) {
      this.handler.element({
        prepend(html, options) {
          insertions.push({ html, options });
        },
      });
      return response;
    }
  };
  let upstream;
  globalThis.__posternPreviousFetch = () => upstream;
  const assets = assetEnvironment(() => assert.fail('Unexpected asset request'));
  upstream = new Response('<html><body>existing</body></html>', {
    headers: {
      'Content-Type': 'text/html',
      'Content-Length': '34',
      'Content-Encoding': 'identity',
      ETag: 'old',
      'Last-Modified': 'yesterday',
    },
  });
  const rewritten = await worker.fetch(new Request('https://blochdex.com/'), assets, {});
  assert.equal(insertions.length, 1);
  assert.match(insertions[0].html, /href="\/preview\/\?connect=qr"/);
  assert.deepEqual(insertions[0].options, { html: true });
  assert.equal(rewritten.headers.get('Cache-Control'), 'no-store');
  for (const header of ['Content-Length', 'Content-Encoding', 'ETag', 'Last-Modified']) {
    assert.equal(rewritten.headers.get(header), null);
  }

  upstream = new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  assert.equal(await worker.fetch(new Request('https://blochdex.com/'), assets, {}), upstream);
  assert.equal(insertions.length, 1);
});
