// Temporary delivery adapter for the exact, independently published Pages shell.
// Keep the existing Pages application, API handlers and asset bytes unchanged.
export const EXPECTED_SHELL_SHA256 =
  '9c0774cff12d1546d7e851bec85efb11f7a7bcb3b61c9328441e93181704f7a2';
const MAX_SHELL_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_LENGTH_DIGITS = String(MAX_SHELL_BYTES).length;
const MAX_SHELL_CHUNKS = 4096;

async function boundedClone(response, timeoutMs) {
  const declared = response.headers.get('Content-Length');
  if (
    declared !== null &&
    (declared.length > MAX_CONTENT_LENGTH_DIGITS ||
      !/^(0|[1-9][0-9]*)$/.test(declared) ||
      Number(declared) > MAX_SHELL_BYTES)
  )
    return null;
  const reader = response.clone().body?.getReader();
  if (!reader) return null;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('Shell scan timed out')), timeoutMs);
  });
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      length += value.byteLength;
      if (length > MAX_SHELL_BYTES || chunks.length >= MAX_SHELL_CHUNKS)
        throw Error('Shell scan exceeds bound');
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch {
    // Cancelling a tee can wait for the untouched branch. Do not delay fallback.
    reader.cancel().catch(() => {});
    return null;
  } finally {
    clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {}
  }
}

export function createMobileWalletWorker(
  browserScript,
  scriptPath,
  upstream = fetch,
  { scanTimeoutMs = 2000 } = {},
) {
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
      const encoding = response.headers.get('Content-Encoding');
      if (encoding && encoding.trim().toLowerCase() !== 'identity') return response;
      const bytes = await boundedClone(response, scanTimeoutMs);
      if (bytes === null) return response;
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
