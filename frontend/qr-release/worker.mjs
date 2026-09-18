import previous from './previous-worker.mjs';
// Preserve all existing RPC, recovery, native DEX and legacy wallet routes.
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!['blochdex.com', 'www.blochdex.com'].includes(url.hostname))
      return previous.fetch(request, env, ctx);
    if (url.pathname === '/preview' || url.pathname.startsWith('/preview/')) {
      if (!['GET', 'HEAD'].includes(request.method))
        return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
      if (url.pathname === '/preview') return Response.redirect(url.origin + '/preview/', 308);
      let path = url.pathname.slice('/preview/'.length) || 'index.html';
      if (path.includes('..') || !/^([a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+$/.test(path))
        return new Response('Not found', { status: 404 });
      url.pathname = '/' + path;
      url.search = '';
      const asset = await env.QR_ASSETS.fetch(new Request(url, { method: request.method }));
      const response = new Response(asset.body, asset);
      response.headers.set('X-Postern-QR-Release', '2026-09-16');
      response.headers.set('Referrer-Policy', 'no-referrer');
      response.headers.set('X-Content-Type-Options', 'nosniff');
      response.headers.set(
        'Cache-Control',
        path === 'index.html' || !asset.ok ? 'no-store' : 'public,max-age=31536000,immutable',
      );
      if (path === 'index.html')
        response.headers.set(
          'Content-Security-Policy',
          "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: https://api.web3modal.org https://api.reown.com; connect-src 'self' wss://relay.walletconnect.com wss://relay.walletconnect.org https://relay.walletconnect.com https://relay.walletconnect.org https://verify.walletconnect.com https://verify.walletconnect.org https://pulse.walletconnect.org https://rpc.walletconnect.org https://api.web3modal.org https://api.reown.com; frame-src https://verify.walletconnect.com https://verify.walletconnect.org; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        );
      return response;
    }
    const response = await previous.fetch(request, env, ctx);
    if (
      request.method !== 'GET' ||
      !['/', '/index.html'].includes(url.pathname) ||
      !response.headers.get('content-type')?.includes('text/html') ||
      response.status !== 200
    )
      return response;
    const output = new Response(response.body, response);
    for (const key of ['Content-Length', 'Content-Encoding', 'ETag', 'Last-Modified'])
      output.headers.delete(key);
    output.headers.set('Cache-Control', 'no-store');
    return new HTMLRewriter()
      .on('body', {
        element(element) {
          element.prepend(
            '<aside style="padding:12px 20px;text-align:center;background:#182216;color:#c6f779;font:14px system-ui"><a href="/preview/?connect=qr" style="color:inherit">Connect mobile wallet with QR · DEX preview ↗</a></aside>',
            { html: true },
          );
        },
      })
      .transform(output);
  },
};
