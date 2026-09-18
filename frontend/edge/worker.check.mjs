import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createMobileWalletWorker, EXPECTED_SHELL_SHA256 } from './worker.mjs';

const scriptPath = '/__postern/mobile-wallet-0123456789abcdef.js';
const script = '/* test handoff script */';

test('serves only the versioned script and respects HEAD and method restrictions', async () => {
  const worker = createMobileWalletWorker(script, scriptPath, () =>
    assert.fail('Unexpected origin request'),
  );
  const response = await worker.fetch(new Request('https://blochdex.com' + scriptPath));
  assert.equal(await response.text(), script);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('Content-Type'), 'text/javascript; charset=utf-8');
  assert.equal(
    (await worker.fetch(new Request('https://blochdex.com' + scriptPath, { method: 'POST' })))
      .status,
    405,
  );
  assert.equal(
    await (
      await worker.fetch(new Request('https://blochdex.com' + scriptPath, { method: 'HEAD' }))
    ).text(),
    '',
  );
  assert.equal(
    (await worker.fetch(new Request('https://unrelated.example' + scriptPath))).status,
    404,
  );
  assert.throws(() => createMobileWalletWorker(script, '/untrusted"path.js'));
});

test('preserves existing API requests, credentials, bodies, responses and assets', async () => {
  for (const [path, method] of [
    ['/api/rpc', 'POST'],
    ['/assets/index-DGP4G7Mx.js', 'GET'],
    ['/', 'HEAD'],
  ]) {
    const request = new Request('https://blochdex.com' + path, {
      method,
      headers: { Cookie: 'session=fixture' },
      ...(method === 'POST' ? { body: 'rpc-fixture' } : {}),
    });
    const original = new Response('untouched', {
      status: 202,
      headers: { 'X-Origin': 'preserved' },
    });
    const worker = createMobileWalletWorker(script, scriptPath, (received) => {
      assert.equal(received, request);
      return original;
    });
    assert.equal(await worker.fetch(request), original);
    assert.equal(request.headers.get('Cookie'), 'session=fixture');
    if (method === 'POST') assert.equal(await request.text(), 'rpc-fixture');
  }
});

test('fails open to the unchanged origin on an unknown release, redirect or non-HTML response', async () => {
  for (const response of [
    new Response('<html>new app</html>', { headers: { 'Content-Type': 'text/html' } }),
    new Response(null, { status: 301, headers: { Location: 'https://blochdex.com/' } }),
    new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
  ]) {
    const worker = createMobileWalletWorker(script, scriptPath, () => response);
    assert.equal(await worker.fetch(new Request('https://blochdex.com/')), response);
  }
});

test('bounded shell inspection preserves oversized, stalled and encoded origin responses', async () => {
  const largeBody = 'x'.repeat(2 * 1024 * 1024 + 1),
    large = new Response(largeBody, { headers: { 'Content-Type': 'text/html' } });
  let worker = createMobileWalletWorker(script, scriptPath, () => large);
  assert.equal(await worker.fetch(new Request('https://blochdex.com/')), large);
  assert.equal((await large.text()).length, largeBody.length);

  let controller;
  const stalled = new Response(
    new ReadableStream({
      start(value) {
        controller = value;
        value.enqueue(new TextEncoder().encode('original'));
      },
    }),
    { headers: { 'Content-Type': 'text/html' } },
  );
  worker = createMobileWalletWorker(script, scriptPath, () => stalled, { scanTimeoutMs: 10 });
  assert.equal(await worker.fetch(new Request('https://blochdex.com/')), stalled);
  controller.close();
  assert.equal(await stalled.text(), 'original');

  const encoded = new Response('encoded', {
    headers: { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' },
  });
  worker = createMobileWalletWorker(script, scriptPath, () => encoded);
  assert.equal(await worker.fetch(new Request('https://blochdex.com/')), encoded);
  assert.equal(await encoded.text(), 'encoded');
});

// This optional integration check runs against the independently captured release.
// The generated Pages shell is kept outside version control, per AGENTS.md.
test(
  'injects into the verified Pages shell while preserving headers and content',
  {
    skip: !process.env.POSTERN_RELEASE_SHELL,
  },
  async () => {
    const shell = await readFile(process.env.POSTERN_RELEASE_SHELL, 'utf8');
    assert.equal(createHash('sha256').update(shell).digest('hex'), EXPECTED_SHELL_SHA256);
    const worker = createMobileWalletWorker(script, scriptPath, (request) => {
      assert.equal(request.headers.get('If-None-Match'), null);
      assert.equal(request.headers.get('If-Modified-Since'), null);
      assert.equal(new URL(request.url).search, '?connect=metamask');
      return new Response(shell, {
        headers: {
          'Content-Type': 'text/html',
          ETag: 'old-shell',
          'Content-Length': String(shell.length),
          'Referrer-Policy': 'strict-origin-when-cross-origin',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "script-src 'self'",
        },
      });
    });
    const response = await worker.fetch(
      new Request('https://blochdex.com/?connect=metamask', {
        headers: {
          'If-None-Match': 'old-shell',
          'If-Modified-Since': 'Mon, 14 Sep 2026 00:00:00 GMT',
        },
      }),
    );
    const html = await response.text();
    assert.equal(
      html.replace(
        `  <script type="module" src="${scriptPath}" data-postern-mobile-hotfix="1"></script>\n  </body>`,
        '</body>',
      ),
      shell,
    );
    assert.equal(response.headers.get('Content-Security-Policy'), "script-src 'self'");
    assert.equal(response.headers.get('Referrer-Policy'), 'strict-origin-when-cross-origin');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('ETag'), null);
    assert.equal(response.headers.get('Content-Length'), null);
  },
);
