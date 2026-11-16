// Security headers of the multichain site (dist-multichain/_headers, written by scripts/multichain-finish.mjs): the
// Bloch L2 site's headers (mainnet/headers.ts) with connect-src naming every reviewed endpoint of every bundled
// chain instead of the L2 RPC. Hosts without _headers support must send the same values.
// No value import here: the build script loads this file and mainnet/headers.ts with Node's type stripping.
import type { MainnetNetwork } from '../mainnet/config';

export const MULTICHAIN_HEADERS_NOTE =
  '# Generated from frontend/src/multichain/headers.ts by scripts/multichain-finish.mjs; src/test/multichain.test.tsx checks it.';

/**
 * `render` is mainnet/headers.ts `renderHeadersFile`. It takes the origins of `rpcUrl` and of the bridge status
 * RPCs: one stand-in network whose first origin is `rpcUrl` and whose others ride as bridge status entries
 * carries the whole list, so the policy text stays in one place.
 */
export function multichainHeadersFile(
  rpcUrls: string[],
  render: (network: MainnetNetwork) => string,
): string {
  const origins = [...new Set(rpcUrls.map((u) => new URL(u).origin))];
  if (origins.length === 0) throw new Error('no RPC endpoint for the Content-Security-Policy');
  const [first, ...others] = origins;
  const carrier = {
    rpcUrl: first,
    bridges: others.map((ethRpcUrl) => ({ status: { ethRpcUrl } })),
  } as unknown as MainnetNetwork;
  const text = render(carrier);
  const [note, ...rest] = text.split('\n');
  if (!note.startsWith('# Generated from')) throw new Error('unexpected headers template');
  return [MULTICHAIN_HEADERS_NOTE, ...rest].join('\n');
}
