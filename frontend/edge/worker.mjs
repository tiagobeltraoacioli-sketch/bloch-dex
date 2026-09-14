// Temporary delivery adapter for the exact, independently published Pages shell.
// Keep the existing Pages application, API handlers and asset bytes unchanged.
export const EXPECTED_SHELL_SHA256 =
  '9c0774cff12d1546d7e851bec85efb11f7a7bcb3b61c9328441e93181704f7a2';

export function createMobileWalletWorker(browserScript, scriptPath, upstream = fetch) {
  if (!/^\/__postern\/mobile-wallet-[a-f0-9]{16}\.js$/.test(scriptPath)) {
    throw new Error('Invalid versioned mobile script path');
  }
  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (!['blochdex.com', 'www.blochdex.com'].includes(url.hostname)) {
        return new Response('Not found', { status: 404 });
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
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      // A future Pages release must be reviewed, never patched by a stale adapter.
      if (digest !== EXPECTED_SHELL_SHA256) return response;
      const html = new TextDecoder()
        .decode(bytes)
        .replace(
          '</body>',
          `  <script type="module" src="${scriptPath}" data-postern-mobile-hotfix="1"></script>\n  </body>`,
        );
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
