// Temporary delivery adapter for the exact, independently published Pages shell.
// Keep the existing Pages application, API handlers and asset bytes unchanged.
export const EXPECTED_SHELL_SHA256 =
  '9c0774cff12d1546d7e851bec85efb11f7a7bcb3b61c9328441e93181704f7a2';
export const PREVIOUS_GENESIS = '0xd696c34e864365fffdfe5c758c271e50666e5023d44f036143f20d5f1c8147bb';
export const RECOVERY_PINS = {
  '/assets/index-DGP4G7Mx.js': 'ce833898fd57cf2c1ed688a6c2b1da078df1afbc432f13c309979766ada3efc9',
  '/deployment.json': 'e8958ff621416929766f2924319fe13e4a1194d2feed3e1c3492e0b996b09b33',
};

export function validateRecovery(recovery) {
  if (recovery === null) return null;
  if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery) ||
      Object.keys(recovery).sort().join(',') !== 'chainId,genesisHash,previousGenesisHash,version' ||
      recovery.version !== 1 || recovery.chainId !== 84001 ||
      recovery.previousGenesisHash !== PREVIOUS_GENESIS ||
      typeof recovery.genesisHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(recovery.genesisHash) ||
      recovery.genesisHash === PREVIOUS_GENESIS || /^0x0+$/.test(recovery.genesisHash)) {
    throw new Error('Invalid explicit testnet recovery artifact');
  }
  return Object.freeze({ ...recovery });
}

async function sha256(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createMobileWalletWorker(browserScript, scriptPath, upstream = fetch, recovery = null, nativeAssets = null) {
  recovery = validateRecovery(recovery);
  if (!/^\/__postern\/mobile-wallet-[a-f0-9]{16}\.js$/.test(scriptPath)) {
    throw new Error('Invalid versioned mobile script path');
  }
  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (!['blochdex.com', 'www.blochdex.com'].includes(url.hostname)) {
        return new Response('Not found', { status: 404 });
      }
      if (nativeAssets && (url.pathname === '/l1' || url.pathname.startsWith('/l1/') || url.pathname.startsWith('/__postern/native/'))) {
        if (!['GET', 'HEAD'].includes(request.method)) {
          return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
        }
        if (url.pathname === '/l1') return new Response(null, { status: 308, headers: { Location: '/l1/', 'Cache-Control': 'no-store' } });
        const asset = Object.hasOwn(nativeAssets, url.pathname) ? nativeAssets[url.pathname] : null;
        if (!asset) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
        const headers = {
          'Content-Type': asset.type,
          'Cache-Control': url.pathname === '/l1/' ? 'no-store' : 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          'X-Postern-Native-Page': '1',
        };
        if (url.pathname === '/l1/') headers['Content-Security-Policy'] = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
        const body = request.method === 'HEAD' ? null : Uint8Array.from(atob(asset.base64), c => c.charCodeAt(0));
        return new Response(body, { headers });
      }
      if (recovery && Object.hasOwn(RECOVERY_PINS, url.pathname)) {
        if (!['GET', 'HEAD'].includes(request.method)) {
          return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
        }
        const originRequest = new Request(request, { method: 'GET' });
        for (const name of ['If-None-Match', 'If-Modified-Since', 'Range', 'If-Range']) {
          originRequest.headers.delete(name);
        }
        const unavailable = () => new Response('Reviewed recovery asset unavailable', {
          status: 503, headers: { 'Cache-Control': 'no-store' },
        });
        let response;
        try { response = await upstream(originRequest); } catch { return unavailable(); }
        if (response.status !== 200) return unavailable();
        const bytes = await response.arrayBuffer();
        if (await sha256(bytes) !== RECOVERY_PINS[url.pathname]) return unavailable();
        const original = new TextDecoder().decode(bytes);
        if (original.split(PREVIOUS_GENESIS).length !== 2) return unavailable();
        const updated = original.replace(PREVIOUS_GENESIS, recovery.genesisHash);
        const headers = new Headers(response.headers);
        for (const name of ['Content-Length', 'Content-Encoding', 'ETag', 'Last-Modified']) headers.delete(name);
        headers.set('Cache-Control', 'no-store');
        headers.set('X-Postern-Testnet-Recovery', '1');
        headers.set('X-Content-Type-Options', 'nosniff');
        headers.set('Content-Type', url.pathname.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/javascript; charset=utf-8');
        return new Response(request.method === 'HEAD' ? null : updated, { headers });
      }
      if (url.pathname === scriptPath) {
        if (!['GET', 'HEAD'].includes(request.method)) {
          return new Response('Method not allowed', {
            status: 405,
            headers: { Allow: 'GET, HEAD' },
          });
        }
        return new Response(request.method === 'HEAD' ? null : browserScript, {
          headers: {
            'Content-Type': 'text/javascript; charset=utf-8',
            'Cache-Control': 'public, max-age=31536000, immutable',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }
      const isShell = request.method === 'GET' && ['/', '/index.html'].includes(url.pathname);
      if (!isShell) return upstream(request);

      // An origin 304 would reuse an unpatched browser-cached shell.
      const originRequest = new Request(request);
      originRequest.headers.delete('If-None-Match');
      originRequest.headers.delete('If-Modified-Since');
      const response = await upstream(originRequest);
      if (response.status !== 200 || !response.headers.get('Content-Type')?.includes('text/html')) {
        return response;
      }
      const bytes = await response.clone().arrayBuffer();
      const digest = await sha256(bytes);
      // A future Pages release must be reviewed, never patched by a stale adapter.
      if (digest !== EXPECTED_SHELL_SHA256) return response;
      let html = new TextDecoder()
        .decode(bytes)
        .replace(
          '</body>',
          `  <script type="module" src="${scriptPath}" data-postern-mobile-hotfix="1"></script>\n  </body>`,
        );
      // A previously immutable browser-cached bundle still contains the old
      // genesis. A new URL forces the reviewed recovered bytes to be fetched.
      if (recovery) html = html.replace(
        'src="./assets/index-DGP4G7Mx.js"',
        `src="./assets/index-DGP4G7Mx.js?recovery=${recovery.genesisHash.slice(2)}"`,
      );
      if (nativeAssets) html = html.replace('</head>', '<meta name="postern-native-page" content="/l1/">\n</head>');
      const headers = new Headers(response.headers);
      for (const name of ['Content-Length', 'Content-Encoding', 'ETag', 'Last-Modified']) {
        headers.delete(name);
      }
      headers.set('Cache-Control', 'no-store');
      headers.set('X-Postern-Mobile-Hotfix', '1');
      return new Response(html, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
}
