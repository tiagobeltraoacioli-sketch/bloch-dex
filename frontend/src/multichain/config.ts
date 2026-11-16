// The multichain site: the same DEX contracts on public EVM chains other than the Bloch L2
// (docs/MULTICHAIN-DEPLOY.md). One reviewed network file and one deployment record per chain, both written by
// scripts/multichain/frontend-files.mjs (the record from the post gate's report) and bundled at build time.
//
// A chain is "not yet live" (no RPC traffic, no wallet request) until its record says "deployed". The record is
// not signed: the page re-verifies chain id, genesis, and the runtime code of every contract and token against
// the chain at its finalized block before it shows anything (devnet4/chain.ts readSnapshot), exactly as the
// Bloch L2 route does. Every Bloch-L2-only rule is off here, by the network file: no new-slot fee, no credit
// rule, no idle-chain rule, no bridge hold, no Safe pin.
import type { Address, Hex } from 'viem';
import bundle from '@postern/multichain-bundle';
import type { DevnetDeployment } from '../devnet4/record';
import type { MainnetNetwork, MainnetState, PlannedCap } from '../mainnet/config';
import { NEW_SLOT_FEE_OFF } from '../mainnet/newslotfee';
import type { Wording } from '../mainnet/wording';

export const NETWORK_DOMAIN = 'postern.dex.multichain-frontend-network.v1';
export const RECORD_DOMAIN = 'postern.dex.multichain-frontend-record.v1';
/** Chains this site never serves: the Bloch L2 has its own site and its own rules. */
const BLOCH_L2_CHAIN_IDS = [700770, 700771];

export class MultichainConfigError extends Error {}
function refuse(condition: unknown, message: string): asserts condition {
  if (!condition) throw new MultichainConfigError(`multichain configuration: ${message}`);
}
const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d{2,5}\/?$/;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON, checked field by field
type AnyRecord = Record<string, any>;

export type ChainToken = { address: Address; symbol: string; decimals: number; codeHash: Hex };
export type Chain = {
  key: string;
  network: MainnetNetwork;
  rpcUrls: string[];
  wrapped: ChainToken;
  tokens: ChainToken[];
  multicall3: { address: Address; codeHash: Hex };
  feeTo: Address;
  wording: Wording;
  planned: { caps: PlannedCap[]; pairs: [string, string][] };
  load: () => Promise<MainnetState>;
};

function token(value: AnyRecord, field: string): ChainToken {
  refuse(value && ADDRESS.test(value.address ?? ''), `${field}.address`);
  refuse(
    typeof value.symbol === 'string' && /^[A-Za-z0-9.]{2,12}$/.test(value.symbol),
    `${field}.symbol`,
  );
  refuse(HASH.test(value.codeHash ?? ''), `${field}.codeHash`);
  const decimals = value.decimals ?? 18;
  refuse(Number.isInteger(decimals) && decimals >= 0 && decimals <= 36, `${field}.decimals`);
  return { address: value.address, symbol: value.symbol, decimals, codeHash: value.codeHash };
}

function url(value: unknown, field: string, rehearsal: boolean): string {
  refuse(typeof value === 'string' && value.length <= 200, `${field} is not a URL`);
  if (rehearsal) {
    // A rehearsal file names loopback forks; only a local render build accepts it.
    refuse(
      __POSTERN_LOCAL_RENDER__ && LOOPBACK.test(value),
      `${field} must be a loopback URL in a rehearsal file`,
    );
    return value;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new MultichainConfigError(`multichain configuration: ${field} is not a URL`);
  }
  refuse(
    parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hash &&
      !parsed.search,
    `${field} must be https without credentials, query or fragment`,
  );
  return value;
}

export function parseChain(networkInput: unknown, recordInput: unknown): Chain {
  const n = networkInput as AnyRecord;
  refuse(n && n.domain === NETWORK_DOMAIN && n.schemaVersion === 1, 'unsupported network file');
  refuse(typeof n.key === 'string' && /^[a-z0-9-]{2,24}$/.test(n.key), 'key');
  refuse(Number.isSafeInteger(n.chainId) && n.chainId > 0, 'chainId');
  refuse(!BLOCH_L2_CHAIN_IDS.includes(n.chainId), 'the Bloch L2 is not a chain of this site');
  refuse(
    typeof n.chainName === 'string' && n.chainName.length > 0 && n.chainName.length <= 40,
    'chainName',
  );
  const c = n.nativeCurrency as AnyRecord;
  refuse(
    c && typeof c.name === 'string' && /^[A-Z]{2,6}$/.test(c.symbol ?? '') && c.decimals === 18,
    'nativeCurrency',
  );
  refuse(HASH.test(n.genesisHash ?? ''), 'genesisHash');
  const rehearsal = n.rpc?.rehearsal === true;
  refuse(
    Array.isArray(n.rpc?.urls) && n.rpc.urls.length >= (rehearsal ? 1 : 2),
    'rpc.urls: at least two endpoints',
  );
  const rpcUrls = (n.rpc.urls as unknown[]).map((u, i) => url(u, `rpc.urls[${i}]`, rehearsal));
  refuse(new Set(rpcUrls).size === rpcUrls.length, 'rpc.urls lists an endpoint twice');
  const explorerUrl = n.explorer?.url === null ? null : url(n.explorer?.url, 'explorer.url', false);
  const off = n.l2Only as AnyRecord;
  refuse(
    off &&
      ['bridgeTokenPin', 'safePin', 'newSlotFee', 'creditRule', 'idleChainRule'].every(
        (k) => off[k] === false,
      ),
    'l2Only: every Bloch-L2-only rule must be stated off',
  );
  const wrapped = token(n.wrappedNative, 'wrappedNative');
  refuse(Array.isArray(n.tokens) && n.tokens.length >= 1 && n.tokens.length <= 8, 'tokens');
  const tokens = (n.tokens as AnyRecord[]).map((t, i) => token(t, `tokens[${i}]`));
  refuse(
    new Set([wrapped, ...tokens].map((t) => t.address)).size === tokens.length + 1 &&
      new Set([wrapped, ...tokens].map((t) => t.symbol)).size === tokens.length + 1,
    'a token is listed twice',
  );
  refuse(
    ADDRESS.test(n.multicall3?.address ?? '') && HASH.test(n.multicall3?.codeHash ?? ''),
    'multicall3',
  );
  refuse(ADDRESS.test(n.feeTo ?? ''), 'feeTo');

  const network: MainnetNetwork = {
    chainId: n.chainId,
    chainHex: `0x${(n.chainId as number).toString(16)}`,
    chainName: n.chainName,
    nativeCurrency: { name: c.name, symbol: c.symbol, decimals: 18 },
    genesisHash: n.genesisHash,
    rpcUrl: rpcUrls[0],
    rpcUrls,
    rpcLive: true,
    explorerUrl,
    bridges: [],
    // Off by the network file's `l2Only`: these chains have no new-slot price and make blocks without waiting
    // for work, so no heartbeat applies (a block is expected at least every 10 minutes).
    newSlotFee: NEW_SLOT_FEE_OFF,
    idle: { skipIdleBlocks: false, heartbeatSeconds: 600, blockIntervalSeconds: 600 },
    noIdleHeartbeat: true,
  };
  const wording: Wording = {
    network: n.chainName,
    title: `PosternDEX on ${n.chainName}`,
    where: n.chainName,
    block: 'block',
    finality: 'Finality',
    genesis: 'Genesis',
    native: c.symbol,
    launch: 'The protocol fee of each pool goes to the address shown below.',
    feeSuggestion: 'Your wallet sets the fee.',
    chain: n.chainName,
    quiet: 'stale-rpc',
  };
  const multicall3 = {
    address: n.multicall3.address as Address,
    codeHash: n.multicall3.codeHash as Hex,
  };
  const chain: Omit<Chain, 'load'> = {
    key: n.key,
    network,
    rpcUrls,
    wrapped,
    tokens,
    multicall3,
    feeTo: n.feeTo,
    wording,
    planned: { caps: [], pairs: tokens.map((t) => [wrapped.symbol, t.symbol]) },
  };
  const state = parseRecord(recordInput, chain, rehearsal);
  return { ...chain, load: () => Promise.resolve(state) };
}

/** The route state of one chain from its bundled record. */
export function parseRecord(
  recordInput: unknown,
  chain: Omit<Chain, 'load'>,
  rehearsal = false,
): MainnetState {
  const r = recordInput as AnyRecord;
  refuse(r && r.domain === RECORD_DOMAIN && r.schemaVersion === 1, 'unsupported record file');
  refuse(
    r.key === chain.key && r.chainId === chain.network.chainId,
    'the record is for another chain',
  );
  refuse(r.status === 'not-deployed' || r.status === 'deployed', 'record status');
  if (r.status === 'not-deployed')
    return {
      status: 'not-live',
      reasons: [
        `No verified deployment record for ${chain.network.chainName} has been published with this site.`,
      ],
    };
  refuse(
    r.rehearsal === rehearsal,
    rehearsal
      ? 'a rehearsal network file needs a rehearsal record'
      : 'the record is a rehearsal record',
  );
  refuse(r.genesisHash === chain.network.genesisHash, 'the record is for another genesis');
  refuse(r.feeTo === chain.feeTo, 'the record has another fee address than the network file');
  refuse(r.wrappedNative === chain.wrapped.address, 'the record has another wrapped native token');
  const contract = (value: AnyRecord, field: string) => {
    refuse(value && ADDRESS.test(value.address ?? '') && HASH.test(value.codeHash ?? ''), field);
    return value as { address: Address; codeHash: Hex };
  };
  const factory = contract(r.factory, 'factory');
  const router = contract(r.router, 'router');
  const lens = contract(r.lens, 'lens');
  refuse(HASH.test(r.pairCodeHash ?? ''), 'pairCodeHash');
  refuse(
    r.finalized &&
      Number.isSafeInteger(r.finalized.number) &&
      r.finalized.number >= 0 &&
      HASH.test(r.finalized.hash ?? ''),
    'finalized',
  );
  const listed = new Map([chain.wrapped, ...chain.tokens].map((t) => [t.address, t]));
  refuse(Array.isArray(r.reserveCaps), 'reserveCaps');
  const caps = new Map<string, bigint>();
  for (const cap of r.reserveCaps as AnyRecord[]) {
    refuse(
      listed.has(cap.token) && typeof cap.cap === 'string' && /^[1-9][0-9]*$/.test(cap.cap),
      'reserveCaps entry',
    );
    caps.set(cap.token, BigInt(cap.cap));
  }
  refuse(Array.isArray(r.pairs) && r.pairs.length >= 1 && r.pairs.length <= 8, 'pairs');
  const pairs = (r.pairs as AnyRecord[]).map((p, i) => {
    refuse(
      ADDRESS.test(p.address ?? '') &&
        listed.has(p.token0) &&
        listed.has(p.token1) &&
        p.token0 < p.token1,
      `pairs[${i}] names a token that is not listed, or is not sorted`,
    );
    return {
      address: p.address as Address,
      token0: p.token0 as Address,
      token1: p.token1 as Address,
    };
  });
  const codeHashes: Record<Address, Hex> = {
    [factory.address]: factory.codeHash,
    [router.address]: router.codeHash,
    [lens.address]: lens.codeHash,
    [chain.multicall3.address]: chain.multicall3.codeHash,
  };
  for (const t of listed.values()) codeHashes[t.address] = t.codeHash;
  for (const p of pairs) codeHashes[p.address] = r.pairCodeHash;
  refuse(
    Object.keys(codeHashes).length === 4 + listed.size + pairs.length,
    'two contracts share an address',
  );
  const deployment: DevnetDeployment = {
    name: `PosternDEX on ${chain.network.chainName}`,
    path: `deployments/${chain.key}/frontend.record.json`,
    revision: 'multichain',
    chainId: chain.network.chainId,
    genesisHash: chain.network.genesisHash as Hex,
    factory: factory.address,
    router: router.address,
    lens: lens.address,
    wrapped: chain.wrapped.address,
    feeTo: chain.feeTo,
    codeHashes,
    tokens: [...listed.values()].map((t) => ({
      address: t.address,
      symbol: t.symbol,
      cap: caps.get(t.address) ?? 0n,
      wrapped: t.address === chain.wrapped.address,
    })),
    pairs,
    gate: {
      decision: 'liquidity-enabled',
      finalizedNumber: BigInt(r.finalized.number),
      finalizedHash: r.finalized.hash,
    },
  };
  return { status: 'live', deployment, multicall3: chain.multicall3.address };
}

/** Every bundled chain, in the order the selector shows them. */
export function bundledChains(input: unknown = bundle): Chain[] {
  refuse(
    Array.isArray(input) && input.length >= 1 && input.length <= 16,
    'the bundle is not a list of chains',
  );
  const chains = (input as AnyRecord[]).map((entry) => parseChain(entry.network, entry.record));
  refuse(new Set(chains.map((c) => c.key)).size === chains.length, 'a chain key is bundled twice');
  refuse(
    new Set(chains.map((c) => c.network.chainId)).size === chains.length,
    'a chain id is bundled twice',
  );
  return chains;
}
