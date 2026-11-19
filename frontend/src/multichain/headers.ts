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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON, read field by field
type AnyRecord = Record<string, any>;

/**
 * The Bloch L2 as the seventh network (agent 415, round 20): the endpoints its route contacts, for `connect-src`,
 * from the L2 site's own two files (deployments/mainnet/frontend.network.json and dex-mainnet.record.json).
 *
 * An origin is named only if the built site can contact it. The route reads the chain only in the state
 * mainnet/config.ts `loadMainnetState` calls live, which takes all three of: a record that is not the
 * `not-deployed` placeholder, `rpc.status: "live"`, and a pinned genesis hash. Until then this returns nothing and
 * the published policy is the one of the six public chains, byte for byte. (A record that claims a deployment and
 * then fails verification is an error page that reads nothing; the origin is named for it all the same, because
 * verifying a record needs the route's code, which this file must not import.)
 *
 * When the route is live, two kinds of origin, each one the route itself reads and no other:
 *  - `rpc.url`: the L2's public RPC. Every read of the route (the finalized block, pools, caps, balances, quotes,
 *    receipts) goes to this one endpoint; the L2 has no second public endpoint to compare it with.
 *  - `bridges[].status.ethRpcUrl`, where a bridge entry carries a status block: the Ethereum RPC the route reads
 *    the bridge vault at, to tell whether exits of the bridged token are held (mainnet/bridgehold.ts).
 * Nothing is added to script-src, frame-src, img-src or any other directive.
 *
 * src/test/multichain-bloch-l2.test.tsx walks the eight states against `loadMainnetState`.
 */
export function blochL2PolicyUrls(network: unknown, record: unknown): string[] {
  const n = network as AnyRecord;
  const r = record as AnyRecord;
  if (!n || typeof n !== 'object' || Array.isArray(n))
    throw new Error('the Bloch L2 network file is not an object');
  if (!r || typeof r !== 'object' || Array.isArray(r))
    throw new Error('the Bloch L2 record is not an object');
  if (typeof n.rpc?.url !== 'string') throw new Error('the Bloch L2 network file has no rpc.url');
  const live = r.status !== 'not-deployed' && n.rpc.status === 'live' && Boolean(n.genesisHash);
  if (!live) return [];
  const holds = (Array.isArray(n.bridges) ? n.bridges : [])
    .map((b: AnyRecord) => b?.status?.ethRpcUrl)
    .filter((u: unknown): u is string => typeof u === 'string');
  return [n.rpc.url, ...holds];
}
