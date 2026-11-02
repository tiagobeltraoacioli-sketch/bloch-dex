// Security headers for static hosting of the built site (dist/). The committed
// public/_headers file (Cloudflare Pages / Netlify format, copied into dist/)
// must equal renderHeadersFile(bundledNetwork()); src/test/hosting.test.ts
// keeps them in sync, so changing the L2 RPC URL forces a CSP update.
// Hosts without _headers support (nginx, a worker) must send the same values.
import type { MainnetNetwork } from './config';

// WalletConnect relay/verify and the Reown (WalletConnect) asset APIs used by
// the QR wallet flow, as in qr-release/worker.mjs.
const WALLETCONNECT_CONNECT = [
  'wss://relay.walletconnect.com',
  'wss://relay.walletconnect.org',
  'https://relay.walletconnect.com',
  'https://relay.walletconnect.org',
  'https://verify.walletconnect.com',
  'https://verify.walletconnect.org',
  'https://pulse.walletconnect.org',
  'https://rpc.walletconnect.org',
  'https://api.web3modal.org',
  'https://api.reown.com',
];
const WALLETCONNECT_FRAMES = [
  'https://verify.walletconnect.com',
  'https://verify.walletconnect.org',
];
const WALLETCONNECT_IMAGES = ['https://api.web3modal.org', 'https://api.reown.com'];

export function contentSecurityPolicy(network: MainnetNetwork): string {
  const origins = [network.rpcUrl, ...network.bridges.map((b) => b.status?.ethRpcUrl)]
    .filter((u): u is string => !!u)
    .map((u) => new URL(u).origin);
  const rpcOrigin = [...new Set(origins)].join(' ');
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    `img-src 'self' data: ${WALLETCONNECT_IMAGES.join(' ')}`,
    `connect-src 'self' ${rpcOrigin} ${WALLETCONNECT_CONNECT.join(' ')}`,
    `frame-src ${WALLETCONNECT_FRAMES.join(' ')}`,
    "manifest-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

export function securityHeaders(network: MainnetNetwork): [string, string][] {
  return [
    ['Content-Security-Policy', contentSecurityPolicy(network)],
    ['Strict-Transport-Security', 'max-age=63072000; includeSubDomains'],
    ['X-Content-Type-Options', 'nosniff'],
    ['X-Frame-Options', 'DENY'],
    ['Referrer-Policy', 'no-referrer'],
    [
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), browsing-topics=()',
    ],
    ['Cross-Origin-Opener-Policy', 'same-origin-allow-popups'],
    ['Cross-Origin-Resource-Policy', 'same-origin'],
  ];
}

export function renderHeadersFile(network: MainnetNetwork): string {
  const lines = [
    '# Generated from frontend/src/mainnet/headers.ts; src/test/hosting.test.ts checks it.',
    '/*',
    ...securityHeaders(network).map(([k, v]) => `  ${k}: ${v}`),
    '/',
    '  Cache-Control: no-cache',
    '/index.html',
    '  Cache-Control: no-cache',
    '/assets/*',
    '  Cache-Control: public, max-age=31536000, immutable',
  ];
  return `${lines.join('\n')}\n`;
}
