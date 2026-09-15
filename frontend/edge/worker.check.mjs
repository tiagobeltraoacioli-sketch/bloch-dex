import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createMobileWalletWorker, EXPECTED_SHELL_SHA256, PREVIOUS_GENESIS, validateRecovery } from './worker.mjs';

const scriptPath = '/__postern/mobile-wallet-0123456789abcdef.js';
const script = '/* test handoff script */';
const recovery = { version: 1, chainId: 84001, previousGenesisHash: PREVIOUS_GENESIS, genesisHash: '0x' + 'ab'.repeat(32) };

test('recovery is opt-in, immutable and restricted to one explicit genesis transition', async () => {
  assert.equal(validateRecovery(null), null);
  const frozen = validateRecovery(recovery);
  assert.ok(Object.isFrozen(frozen));
  for (const invalid of [{}, [], { ...recovery, chainId: 8400 },
    { ...recovery, genesisHash: PREVIOUS_GENESIS }, { ...recovery, genesisHash: '0x' + '00'.repeat(32) },
    { ...recovery, rpc: 'https://attacker.test' }, { ...recovery, previousGenesisHash: recovery.genesisHash }]) {
    assert.throws(() => validateRecovery(invalid));
  }
  const untouched = new Response('old deployment');
  const worker = createMobileWalletWorker(script, scriptPath, () => untouched);
  assert.equal(await worker.fetch(new Request('https://blochdex.com/deployment.json?genesis=attacker')), untouched);
});

test('recovery fails closed for unknown assets, partial responses or unavailable origin', async () => {
  for (const response of [new Response('unreviewed'), new Response('partial', { status: 206 }), new Response('', { status: 502 })]) {
    const worker = createMobileWalletWorker(script, scriptPath, () => response, recovery);
    assert.equal((await worker.fetch(new Request('https://blochdex.com/assets/index-DGP4G7Mx.js'))).status, 503);
  }
  const worker = createMobileWalletWorker(script, scriptPath, () => { throw new Error('secret'); }, recovery);
  assert.equal((await worker.fetch(new Request('https://blochdex.com/deployment.json'))).status, 503);
  assert.equal((await worker.fetch(new Request('https://blochdex.com/deployment.json', { method: 'POST' }))).status, 405);
});

test('pinned recovery changes only genesis and busts the browser bundle cache', { skip: !process.env.POSTERN_RELEASE_DIR }, async () => {
  for (const path of ['/assets/index-DGP4G7Mx.js', '/deployment.json']) {
    const original = await readFile(process.env.POSTERN_RELEASE_DIR + path, 'utf8');
    const worker = createMobileWalletWorker(script, scriptPath, (request) => {
      assert.equal(request.method, 'GET');
      for (const name of ['Range', 'If-None-Match', 'If-Modified-Since', 'If-Range']) assert.equal(request.headers.get(name), null);
      return new Response(original, { headers: { ETag: 'old', 'Content-Length': '12', 'Content-Type': 'text/plain' } });
    }, recovery);
    const response = await worker.fetch(new Request('https://blochdex.com' + path + '?recovery=untrusted', { headers: { Range: 'bytes=0-5', 'If-None-Match': 'old' } }));
    const changed = await response.text();
    assert.equal(response.status, 200);
    assert.equal(changed.replace(recovery.genesisHash, PREVIOUS_GENESIS), original);
    assert.equal(changed.includes(PREVIOUS_GENESIS), false);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('ETag'), null);
    assert.equal(await (await worker.fetch(new Request('https://blochdex.com' + path, { method: 'HEAD' }))).text(), '');
  }
  const shell = await readFile(process.env.POSTERN_RELEASE_DIR + '/index.html', 'utf8');
  const worker = createMobileWalletWorker(script, scriptPath, () => new Response(shell, { headers: { 'Content-Type': 'text/html' } }), recovery);
  const html = await (await worker.fetch(new Request('https://blochdex.com/'))).text();
  assert.ok(html.includes(`index-DGP4G7Mx.js?recovery=${recovery.genesisHash.slice(2)}`));
  assert.ok(html.includes('data-postern-mobile-hotfix="1"'));
});

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

const nativeAssets = {
  '/l1/': { type: 'text/html; charset=utf-8', base64: btoa('<html>Native account only</html>') },
  '/__postern/native/assets/app-abc.js': { type: 'text/javascript; charset=utf-8', base64: btoa('/* native */') },
};
test('native delivery is opt-in and strictly confined to packaged read-only routes', async () => {
  const original = new Response('origin');
  const disabled = createMobileWalletWorker(script, scriptPath, () => original);
  assert.equal(await disabled.fetch(new Request('https://blochdex.com/l1/')), original);
  const worker = createMobileWalletWorker(script, scriptPath, () => assert.fail('Unexpected upstream'), null, nativeAssets);
  for (const host of ['blochdex.com', 'www.blochdex.com']) {
    const response = await worker.fetch(new Request(`https://${host}/l1/?asset=https://attacker.test`));
    assert.equal(await response.text(), '<html>Native account only</html>');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.ok(response.headers.get('Content-Security-Policy').includes("connect-src 'none'"));
    assert.ok(response.headers.get('Content-Security-Policy').includes("frame-ancestors 'none'"));
  }
  for (const path of Object.keys(nativeAssets)) {
    assert.equal(await (await worker.fetch(new Request('https://blochdex.com'+path, {method:'HEAD'}))).text(), '');
    const denied = await worker.fetch(new Request('https://blochdex.com'+path, {method:'POST', body:'ignored'}));
    assert.equal(denied.status,405);
    assert.equal(denied.headers.get('Allow'),'GET, HEAD');
  }
  for (const path of ['/l1/constructor','/l1/__proto__','/__postern/native/missing.js']) {
    assert.equal((await worker.fetch(new Request('https://blochdex.com'+path))).status,404);
  }
  const redirect = await worker.fetch(new Request('https://blochdex.com/l1?next=https://attacker.test'));
  assert.equal(redirect.status,308);
  assert.equal(redirect.headers.get('Location'),'/l1/');
  assert.equal((await worker.fetch(new Request('https://attacker.test/l1/'))).status,404);
  const asset = await worker.fetch(new Request('https://blochdex.com/__postern/native/assets/app-abc.js'));
  assert.equal(await asset.text(),'/* native */');
  assert.ok(asset.headers.get('Cache-Control').includes('immutable'));
});
test('native menu marker is limited to the pinned shell', {skip: !process.env.POSTERN_RELEASE_SHELL}, async () => {
  const shell = await readFile(process.env.POSTERN_RELEASE_SHELL,'utf8');
  for (const [html, expected] of [[shell,true],['<html><head></head><body>new release</body></html>',false]]) {
    const worker = createMobileWalletWorker(script,scriptPath,()=>new Response(html,{headers:{'Content-Type':'text/html'}}),recovery,nativeAssets);
    const result = await (await worker.fetch(new Request('https://blochdex.com/'))).text();
    assert.equal(result.includes('name="postern-native-page" content="/l1/"'),expected);
    if (!expected) assert.equal(result,html);
  }
});
