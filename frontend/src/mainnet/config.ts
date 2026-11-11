// Bloch L2 mainnet (chain 700770) configuration for the #/mainnet route.
//
// Two reviewed JSON files, both bundled at build time (never fetched at run
// time, so a static host cannot swap them):
// - deployments/mainnet/frontend.network.json: wallet network parameters, the
//   public RPC and explorer, the pinned L2 genesis and bridge links;
// - deployments/mainnet/dex-mainnet.record.json: the deployment record
//   (plan, config, schema-2 gate report) or a "not-deployed" placeholder.
// The vite aliases @postern/mainnet-network and @postern/mainnet-record point
// at them; POSTERN_MAINNET_NETWORK / POSTERN_MAINNET_RECORD replace them for a
// local render check against a throwaway anvil chain (see README).
//
// The route is "not yet live" (no RPC traffic, no wallet transactions) unless
// the record passed the finality gate, the public RPC is marked live and the
// L2 genesis is pinned here, and the record's genesis equals it.
import type { Address, Hex } from 'viem';
import networkJson from '@postern/mainnet-network';
import recordJson from '@postern/mainnet-record';
import plannedConfig from '../../../deployments/mainnet/dex-mainnet.config.json';
import mainnetPins from '../../../deployments/mainnet/700770/pins.json';
import { DEX_MAINNET_CHAIN_ID } from '../network-identity';
import { verifyDeploymentRecord, type DevnetDeployment } from '../devnet4/record';
import type { AddChainParameters } from '../devnet4/swap';
import type { BridgeStatusConfig } from './bridgehold';
import { parseNewSlotFeePolicy, type NewSlotFeePolicy } from './newslotfee';

export const NETWORK_DOMAIN = 'postern.dex.frontend-network.v1';
export const RECORD_DOMAIN = 'postern.dex.frontend-record.v1';
export const MAINNET_RECORD_PATH = 'deployments/mainnet/dex-mainnet.record.json';
export const MAINNET_RECORD_NAME = 'Bloch L2 mainnet DEX';
const INFRA_PLAN_DOMAIN = 'postern.dex.mainnet-infra-plan.v1';
/** Canonical Multicall3 runtime (scripts/staging/infra-deploy-config.mjs pins the same hash). */
export const MULTICALL3_CODE_HASH =
  '0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891';

/** Slippage: 0.50% by default, 0.01% to 3.00% (owner decision DEX-5); defined in src/slippage.ts. */
export { DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS, RETRY_SLIPPAGE_BPS } from '../slippage';
/**
 * Deadline: one L2 block per settlement proof (10–20 minutes observed on
 * devnet4), so 60 minutes leaves room for a missed block or two; 10–180.
 */
export const DEFAULT_DEADLINE_MINUTES = 60;
export const MIN_DEADLINE_MINUTES = 10;
/** The page warns at the same finalized age as scripts/ops/dex-monitor.mjs (finalizedAgeWarn). */
export const FINALIZED_AGE_WARN_SECONDS = 150 * 60;
/** The device clock may be this far behind the latest L2 block before a swap is refused. */
export const CLOCK_BEHIND_TOLERANCE_SECONDS = 120;

/**
 * A swap's deadline is built from the device clock, and since round 15 a swap hold lasts until
 * that deadline is final. A device clock far from the chain's would make the deadline (and the
 * hold) arbitrarily long, or already past (review R309-2P-5). The L2 only makes a block when it
 * has transactions, so its latest timestamp may honestly lag the clock; the page already treats
 * a chain older than FINALIZED_AGE_WARN_SECONDS as stale. Returns the reason to refuse, or null.
 */
export function swapClockProblem(nowMs: number, latestBlockTimestamp: bigint): string | null {
  const now = BigInt(Math.floor(nowMs / 1000));
  if (now + BigInt(CLOCK_BEHIND_TOLERANCE_SECONDS) < latestBlockTimestamp)
    return `This device's clock is ${latestBlockTimestamp - now} seconds behind the latest L2 block, so the swap deadline would be wrong. Correct the clock and get a new quote. Nothing was sent.`;
  if (now > latestBlockTimestamp + BigInt(FINALIZED_AGE_WARN_SECONDS))
    return `This device's clock is ${(now - latestBlockTimestamp) / 60n} minutes ahead of the latest L2 block. Either the clock is wrong or the L2 has not made a block for that long; a swap sent now would hold this account until a deadline that far away is final. Check the clock, or wait for the L2. Nothing was sent.`;
  return null;
}
export const MAX_DEADLINE_MINUTES = 180;

export type BridgeLink = {
  symbol: string;
  name: string;
  depositUrl: string | null;
  withdrawUrl: string | null;
  docsUrl: string | null;
  /** Where the page reads whether exits of this token are held (bUSDC on the V3 bridge). */
  status: BridgeStatusConfig | null;
};
export type MainnetNetwork = {
  chainId: number;
  chainHex: `0x${string}`;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  genesisHash: Hex | null;
  rpcUrl: string;
  rpcLive: boolean;
  explorerUrl: string | null;
  bridges: BridgeLink[];
  /** L2 new-slot priority fee (mainnet/newslotfee.ts); off when the network file has no block. */
  newSlotFee: NewSlotFeePolicy;
};
export type PlannedCap = { symbol: string; cap: bigint; decimals: number };
export type MainnetState =
  | { status: 'not-live'; reasons: string[] }
  | { status: 'live'; deployment: DevnetDeployment; multicall3?: Address };

export class MainnetConfigError extends Error {}
function refuse(condition: unknown, message: string): asserts condition {
  if (!condition) throw new MainnetConfigError(`mainnet configuration: ${message}`);
}

const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const LOOPBACK = __POSTERN_LOCAL_RENDER__
  ? /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?(\/.*)?$/
  : /^$/;

/** https only; plain http only for loopback (a local render check). */
export function safeUrl(value: unknown, field: string): string | null {
  if (value === null) return null;
  refuse(typeof value === 'string' && value.length <= 200, `${field} is not a URL`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MainnetConfigError(`mainnet configuration: ${field} is not a URL`);
  }
  refuse(
    (url.protocol === 'https:' || (__POSTERN_LOCAL_RENDER__ && LOOPBACK.test(value))) &&
      !url.username &&
      !url.password &&
      !url.hash,
    `${field} must be https without credentials or a fragment`,
  );
  return value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON, checked field by field
type AnyRecord = Record<string, any>;

export function parseNetwork(input: unknown): MainnetNetwork {
  const n = input as AnyRecord;
  refuse(n && n.domain === NETWORK_DOMAIN && n.schemaVersion === 1, 'unsupported network file');
  refuse(
    n.chainId === DEX_MAINNET_CHAIN_ID,
    `the network file is not chain ${DEX_MAINNET_CHAIN_ID}`,
  );
  refuse(
    typeof n.chainName === 'string' && n.chainName.length > 0 && n.chainName.length <= 40,
    'chainName',
  );
  const c = n.nativeCurrency as AnyRecord;
  refuse(
    c && c.symbol === 'BLCH' && c.decimals === 18 && typeof c.name === 'string',
    'the native currency must be BLCH with 18 decimals',
  );
  refuse(
    n.genesisHash === null || (typeof n.genesisHash === 'string' && HASH.test(n.genesisHash)),
    'genesisHash must be null or a lowercase 32-byte hash',
  );
  refuse(n.rpc?.status === 'placeholder' || n.rpc?.status === 'live', 'rpc.status');
  const rpcUrl = safeUrl(n.rpc.url, 'rpc.url');
  refuse(rpcUrl, 'rpc.url is required');
  refuse(Array.isArray(n.bridges), 'bridges');
  const bridges = (n.bridges as AnyRecord[]).map((b, i) => {
    refuse(typeof b.symbol === 'string' && typeof b.name === 'string', `bridges[${i}]`);
    return {
      symbol: b.symbol,
      name: b.name,
      depositUrl: safeUrl(b.depositUrl, `bridges[${i}].depositUrl`),
      withdrawUrl: safeUrl(b.withdrawUrl, `bridges[${i}].withdrawUrl`),
      docsUrl: safeUrl(b.docsUrl, `bridges[${i}].docsUrl`),
      status: parseBridgeStatus(b.status ?? null, `bridges[${i}].status`),
    };
  });
  return {
    chainId: n.chainId,
    chainHex: `0x${(n.chainId as number).toString(16)}`,
    chainName: n.chainName,
    nativeCurrency: { name: c.name, symbol: c.symbol, decimals: c.decimals },
    genesisHash: n.genesisHash,
    rpcUrl,
    rpcLive: n.rpc.status === 'live',
    explorerUrl: safeUrl(n.explorer?.url ?? null, 'explorer.url'),
    bridges,
    newSlotFee: parseNewSlotFeePolicy(n.newSlotFee),
  };
}

function parseBridgeStatus(value: unknown, field: string): BridgeStatusConfig | null {
  if (value === null) return null;
  const v = value as AnyRecord;
  const ethRpcUrl = safeUrl(v.ethRpcUrl, `${field}.ethRpcUrl`);
  refuse(ethRpcUrl, `${field}.ethRpcUrl is required`);
  refuse(typeof v.vault === 'string' && ADDRESS.test(v.vault), `${field}.vault`);
  refuse(typeof v.token === 'string' && ADDRESS.test(v.token), `${field}.token`);
  const hash = v.vaultCodeHash ?? null;
  // Required: without it any contract at the vault address could report "normal".
  refuse(typeof hash === 'string' && HASH.test(hash), `${field}.vaultCodeHash is required`);
  return {
    ethRpcUrl,
    vault: v.vault as Address,
    token: v.token as Address,
    vaultCodeHash: hash as Hex | null,
  };
}

/** EIP-3085 parameters; only meaningful once the RPC is live. */
export function addChainParameters(network: MainnetNetwork): AddChainParameters {
  return {
    chainId: network.chainId,
    chainName: network.chainName,
    nativeCurrency: network.nativeCurrency,
    rpcUrls: [network.rpcUrl],
    blockExplorerUrls: network.explorerUrl ? [network.explorerUrl] : undefined,
  };
}

/**
 * On the pinned mainnet genesis only a report of the mainnet gate is accepted (F-L2): the generic
 * gate checks neither the Bloch Inc Safe nor the bridge token against its deployment record, and
 * its report carries no `pinned` block. The report is not signed: this refuses a wrong record,
 * and the page still re-verifies the deployment against the RPC at the finalized block.
 */
export function requireMainnetGateReport(
  report: AnyRecord,
  deployment: { feeTo: string; tokens: { address: string; wrapped: boolean }[] },
  genesisHash: string | null | undefined,
  pinnedGenesis: string = mainnetPins.l2.genesisHash,
): void {
  if (genesisHash !== pinnedGenesis) return;
  const lower = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : v);
  const pinned = report?.pinned as AnyRecord | undefined;
  refuse(
    !!pinned &&
      pinned.chainId === mainnetPins.l2.chainId &&
      pinned.genesisHash === pinnedGenesis &&
      typeof pinned.safe === 'string' &&
      ADDRESS.test(pinned.safe.toLowerCase()) &&
      lower(pinned.safe) === lower(deployment.feeTo),
    'the gate report was not written by the mainnet gate for the pinned chain and Safe',
  );
  const bridged = deployment.tokens.filter((t) => !t.wrapped).map((t) => lower(t.address));
  const checked = Array.isArray(report.bridgeTokens)
    ? (report.bridgeTokens as AnyRecord[]).map((t) => lower(t?.address))
    : [];
  refuse(
    bridged.length > 0 &&
      checked.length === bridged.length &&
      bridged.every((token) => checked.includes(token)),
    'the gate report does not show every bridge token checked against its bridge deployment record',
  );
}

/**
 * The same rule as scripts/staging/frontend-record.mjs (review R309-2P-12): every guard of the
 * mainnet record keys on the pinned genesis. A record for another genesis is served only when it
 * says that it is a rehearsal chain (`rehearsalChain: true`, written by `--rehearsal-chain`), and
 * a record for the pinned genesis must not say so.
 */
export function requireChainKind(
  rehearsalChain: unknown,
  genesisHash: string | null | undefined,
  pinnedGenesis: string = mainnetPins.l2.genesisHash,
): void {
  if (genesisHash === pinnedGenesis)
    refuse(
      rehearsalChain === undefined,
      'the record is marked as a rehearsal chain on the pinned mainnet genesis',
    );
  else
    refuse(
      rehearsalChain === true,
      'the record is for a genesis that is not the pinned mainnet genesis and is not marked as a rehearsal chain',
    );
}

/**
 * Decide the route state from the bundled record. A placeholder record, a
 * placeholder RPC or an unpinned genesis keep the route "not yet live"; a
 * record that claims a deployment but fails verification is an error.
 */
export async function loadMainnetState(
  record: unknown,
  network: MainnetNetwork,
): Promise<MainnetState> {
  const r = record as AnyRecord;
  refuse(r && r.domain === RECORD_DOMAIN && r.schemaVersion === 1, 'unsupported record file');
  refuse(r.status === 'not-deployed' || r.status === 'liquidity-enabled', 'record status');
  const reasons: string[] = [];
  if (r.status === 'not-deployed')
    reasons.push('No verified mainnet deployment record has been published.');
  if (!network.rpcLive) reasons.push('The public L2 RPC is not published yet.');
  if (!network.genesisHash) reasons.push('The reviewed L2 genesis hash is not pinned yet.');
  if (reasons.length) return { status: 'not-live', reasons };
  const deployment = await verifyDeploymentRecord(
    { plan: r.plan, config: r.config, gateReport: r.gateReport },
    {
      chainId: network.chainId,
      rehearsal: false,
      name: MAINNET_RECORD_NAME,
      path: MAINNET_RECORD_PATH,
      genesisHash: network.genesisHash,
    },
  );
  requireMainnetGateReport(r.gateReport as AnyRecord, deployment, network.genesisHash);
  requireChainKind(r.rehearsalChain, network.genesisHash);
  const infra = r.infra as AnyRecord;
  refuse(infra && infra.domain === INFRA_PLAN_DOMAIN, 'the record has no infra plan');
  refuse(
    infra.chain?.id === network.chainId && infra.chain?.genesisHash === network.genesisHash,
    'the infra plan is for another chain',
  );
  const multicall = infra.contracts?.multicall3 as AnyRecord;
  refuse(
    multicall && typeof multicall.address === 'string' && ADDRESS.test(multicall.address),
    'the infra plan has no Multicall3 address',
  );
  refuse(multicall.codeHash === MULTICALL3_CODE_HASH, 'the Multicall3 code hash is not canonical');
  const multicall3 = multicall.address as Address;
  // readSnapshot checks every entry of codeHashes against the finalized block.
  return {
    status: 'live',
    deployment: {
      ...deployment,
      codeHashes: { ...deployment.codeHashes, [multicall3]: MULTICALL3_CODE_HASH },
    },
    multicall3,
  };
}

const DECIMALS: Record<string, number> = { WBLCH: 18, bUSDC: 6 };

/** The committed, reviewed caps of the planned launch (shown before deployment). */
export function plannedCaps(config: unknown = plannedConfig): PlannedCap[] {
  const c = config as AnyRecord;
  return (c.reserveCaps as AnyRecord[]).map((entry) => {
    const symbol = String(entry.symbol ?? entry.token);
    return { symbol, cap: BigInt(entry.cap), decimals: DECIMALS[symbol] ?? 18 };
  });
}
export function plannedPairs(config: unknown = plannedConfig): [string, string][] {
  return ((config as AnyRecord).initialPairs as AnyRecord[]).map((p) => [
    String(p.tokenA),
    String(p.tokenB),
  ]);
}

export const bundledNetwork = (): MainnetNetwork => parseNetwork(networkJson);
export const bundledState = (): Promise<MainnetState> =>
  loadMainnetState(recordJson, bundledNetwork());
export const bundledRecord: unknown = recordJson;
