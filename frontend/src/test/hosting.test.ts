import { describe, expect, it } from 'vitest';
import headersFile from '../../public/_headers?raw';
import { parseNetwork } from '../mainnet/config';
import { contentSecurityPolicy, renderHeadersFile } from '../mainnet/headers';
import network from '../../../deployments/mainnet/frontend.network.json';

describe('static hosting security headers', () => {
  const parsed = parseNetwork(network);

  it('public/_headers equals the generated file for the committed network', () => {
    expect(headersFile).toBe(renderHeadersFile(parsed));
  });

  it('locks the page down and allows only the L2 RPC and WalletConnect to be contacted', () => {
    const csp = contentSecurityPolicy(parsed);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toMatch(/connect-src 'self' https:\/\/l2rpc\.blochl1\.com /);
    expect(headersFile).toMatch(/Strict-Transport-Security: max-age=\d+/);
    expect(headersFile).toContain('X-Content-Type-Options: nosniff');
    expect(headersFile).toContain('Referrer-Policy: no-referrer');
    expect(headersFile).toContain('X-Frame-Options: DENY');
  });

  it('follows the RPC origin from the network file', () => {
    const other = { ...parsed, rpcUrl: 'https://rpc.example.invalid/l2' };
    expect(contentSecurityPolicy(other)).toContain(
      "connect-src 'self' https://rpc.example.invalid ",
    );
  });
});
