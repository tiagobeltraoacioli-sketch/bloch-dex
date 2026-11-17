// The bridge routes the page offers, parsed field by field from the bundled files. Fail closed everywhere:
// a file the page cannot read in full makes its route "unreadable" (shown, never usable); a route with any
// address still `TBD-deploy`, or no read endpoint, is "not live" and no transaction or payload is ever built
// for it (every builder in this directory takes a `LiveRoute`, which only `liveRoute()` produces).
import type { Address, Hex } from 'viem';

export const L2_CHAIN_ID = 700770;
export const SCHEMA = 'bloch.bridge.network.v1';
export const TBD = /^TBD-(deploy|owner)$/;

export type NetworkKind = 'evm' | 'utxo' | 'svm' | 'tvm' | 'stellar';
export type LaunchState = 'shown' | 'not-available-yet' | 'not-offered';

export type ReadEndpoints = { urls: string[] } | null;

export type BitcoinScript = { threshold: number; publicKeys: Hex[]; vaultId: Hex; hrp: string };
export type BitcoinPolicy = {
  depositVbytes: number;
  releaseVbytes: number;
  refundVbytes: number;
  depositMaxChargeBps: number;
  feeRateCeiling: number;
  dustSats: number;
  sweepConfirmations: number;
  largeBurnThreshold: bigint;
  largeBurnDelaySeconds: number;
};
export type SolanaPolicy = {
  largeReleaseThreshold: bigint;
  releaseDelaySeconds: number;
  depositRentLamports: bigint;
  recordRetentionSeconds: number;
  proofMaxAgeSeconds: number;
};
/** How the destination proof of a Solana exit is made and where it goes: data, so the format can move with the router. */
export type SolanaProofFormat = {
  /** One line; `{wallet}`, `{l2Account}`, `{router}`, `{chainId}`, `{issued}` are filled by the page. */
  template: string;
  /** `page`: verified by the page only (router burnTo(uint64,string)). `router`: also passed to the router call. */
  carriedBy: 'page' | 'router';
  /** The router function when `carriedBy` is `router` (ABI signature text), else null. */
  routerFunction: string | null;
};
export type TronPolicy = {
  releaseFlat: bigint;
  depositTrxEstimate: string;
  issuerFeeMaxBps: number;
  issuerFeeMaxUnits: bigint;
};
export type StellarPolicy = { worstCaseGuardianDelaySeconds: number };

export type Route = {
  id: string;
  name: string;
  kind: NetworkKind;
  chainId: string;
  native: { symbol: string; decimals: number };
  asset: {
    symbol: string;
    name: string;
    /** Decimals of the asset on its own network (what the user types on the source side). */
    decimals: number;
    id: string;
    issuer: string;
    issuerNative: boolean;
    issuerPowers: string[];
    /** Asset units per custody unit (100 sat per bBTC unit, 10 stroops per bUSDC.xlm unit); 1 when equal. */
    unitsPerCustodyUnit: bigint;
  };
  custody: { type: string; address: string | null; contract: string };
  committee: { threshold: number; pauseSeconds: number; guardianPower: string };
  l2: { token: Address | null; name: string; symbol: string; decimals: number };
  /** All in custody units (= L2 token units). */
  limits: {
    cap: bigint;
    window: bigint;
    windowSeconds: number;
    minDeposit: bigint;
    maxDeposit: bigint;
    l2MinBurn: bigint;
    l2MaxBurn: bigint;
    mintDelaySeconds: number;
    largeItemThreshold: bigint;
    releaseDelaySeconds: number;
  };
  fee: { depositBps: number; releaseBps: number; recipient: string; collection: string; networkFee: string };
  finality: {
    rule: string;
    tag: string | null;
    confirmations: number;
    typicalSeconds: number;
    worstCaseSeconds: number;
    reorg: string;
  };
  deposit: {
    method: 'contract-call' | 'program-instruction' | 'tagged-address' | 'memo';
    recipientEncoding: string;
    function: string | null;
    steps: string[];
    refusals: string[];
  };
  release: {
    l2Function: string;
    recipientEncoding: string;
    typicalSeconds: number;
    paysAsset: string;
    notes: string[];
  };
  explorers: { tx: string | null; address: string | null; l2Tx: string | null; l2Address: string | null };
  notes: string[];
  /** The file's own statement about bridge v1, when it makes one. */
  fileLaunch: { v1: boolean; state: string; reason: string } | null;
  launch: { state: LaunchState; reason: string | null };
  /** Exits of this route go through a burn router (Bitcoin, Solana, Stellar); null: a burn on the token. */
  router: { address: Address | null; codeHash: Hex | null } | null;
  read: ReadEndpoints;
  bitcoin?: { script: BitcoinScript | null; policy: BitcoinPolicy };
  solana?: { policy: SolanaPolicy; proof: SolanaProofFormat; programId: string | null; vault: string | null };
  tron?: { policy: TronPolicy };
  stellar?: { policy: StellarPolicy };
  source: { commit: string; ref: string; derived: boolean } | null;
};

/** A route whose every address is deployed and whose reads are configured: the only thing a builder accepts. */
export type LiveRoute = Route & {
  readonly live: unique symbol;
  l2: Route['l2'] & { token: Address };
  custody: Route['custody'] & { address: string };
  read: { urls: string[] };
};

export type RouteStatus =
  | { state: 'live' }
  | { state: 'not-live'; reasons: string[] }
  | { state: 'not-available-yet'; reason: string }
  | { state: 'unreadable'; reason: string };

export type RouteEntry = { id: string; name: string; route: Route | null; status: RouteStatus };

type AnyRecord = Record<string, any>;
class Refusal extends Error {}
const refuse: (condition: unknown, what: string) => asserts condition = (condition, what) => {
  if (!condition) throw new Refusal(what);
};
const isObject = (v: unknown): v is AnyRecord => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, what: string, max = 4000): string => {
  refuse(typeof v === 'string' && v.length > 0 && v.length <= max, `${what} is not text`);
  return v;
};
const texts = (v: unknown, what: string): string[] => {
  refuse(Array.isArray(v) && v.length <= 40, `${what} is not a list`);
  return v.map((item, i) => text(item, `${what}[${i}]`));
};
const whole = (v: unknown, what: string, max = 2 ** 40): number => {
  refuse(Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max, `${what} is not a whole number`);
  return v as number;
};
const amount = (v: unknown, what: string): bigint => {
  refuse(typeof v === 'string' && /^(0|[1-9][0-9]{0,29})$/.test(v), `${what} is not an amount string`);
  return BigInt(v);
};
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const deployed = (v: unknown, what: string, pattern: RegExp): string | null => {
  refuse(typeof v === 'string', `${what} is not text`);
  if (TBD.test(v)) return null;
  refuse(pattern.test(v) && !/^0x0{40}$/.test(v), `${what} is neither an address nor TBD-deploy`);
  return v;
};
const pattern = (v: unknown, what: string): string | null => {
  refuse(typeof v === 'string', `${what} is not text`);
  if (TBD.test(v)) return null;
  refuse(/^https:\/\/[a-z0-9.-]+\/[^\s<>"']*$/i.test(v) && v.length < 200, `${what} is not an https URL pattern`);
  return v;
};
const KINDS: NetworkKind[] = ['evm', 'utxo', 'svm', 'tvm', 'stellar'];
const METHODS = ['contract-call', 'program-instruction', 'tagged-address', 'memo'] as const;
const TOP = ['schema', 'status', 'launch', 'network', 'asset', 'custody', 'committee', 'l2', 'limits', 'fee', 'finality', 'deposit', 'release', 'explorers', 'notes'];
/** Which routes exit through a router, by the decision of the round ("never a direct burn on the token"). */
export const ROUTER_KINDS: NetworkKind[] = ['utxo', 'svm', 'stellar'];

/** Where a loopback endpoint is acceptable: only a rehearsal bundle (a local render build). */
function endpoints(value: unknown, what: string, rehearsal: boolean): ReadEndpoints {
  if (typeof value === 'string') {
    refuse(TBD.test(value), `${what} is neither a list of endpoints nor TBD-owner`);
    return null;
  }
  refuse(isObject(value) && Array.isArray(value.urls) && value.urls.length >= 1 && value.urls.length <= 4, `${what}.urls`);
  const urls = (value.urls as unknown[]).map((u, i) => {
    refuse(typeof u === 'string' && u.length < 200, `${what}.urls[${i}]`);
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      throw new Refusal(`${what}.urls[${i}] is not a URL`);
    }
    const loopback = parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1';
    refuse(
      (parsed.protocol === 'https:' && !rehearsal) || (loopback && rehearsal),
      `${what}.urls[${i}] must be https (or 127.0.0.1 in a rehearsal bundle)`,
    );
    refuse(!parsed.username && !parsed.password && !parsed.search && !parsed.hash, `${what}.urls[${i}] carries credentials, a query or a fragment`);
    return u;
  });
  refuse(new Set(urls).size === urls.length, `${what}.urls repeats an endpoint`);
  return { urls };
}

function parseBitcoinScript(value: unknown, what: string, rehearsal: boolean): BitcoinScript | null {
  if (typeof value === 'string') {
    refuse(TBD.test(value), `${what} is neither a script description nor TBD-deploy`);
    return null;
  }
  refuse(isObject(value), what);
  const threshold = whole(value.threshold, `${what}.threshold`, 15);
  refuse(Array.isArray(value.publicKeys) && value.publicKeys.length >= 1 && value.publicKeys.length <= 15, `${what}.publicKeys`);
  const publicKeys = (value.publicKeys as unknown[]).map((k, i) => {
    refuse(typeof k === 'string' && /^0x0[23][0-9a-f]{64}$/.test(k), `${what}.publicKeys[${i}] is not a compressed key`);
    return k as Hex;
  });
  refuse([...publicKeys].sort().join() === publicKeys.join() && new Set(publicKeys).size === publicKeys.length, `${what}.publicKeys are not distinct and sorted`);
  refuse(threshold >= 1 && threshold <= publicKeys.length, `${what}.threshold`);
  refuse(typeof value.vaultId === 'string' && /^0x[0-9a-f]{24}$/.test(value.vaultId), `${what}.vaultId is not 12 bytes`);
  const hrp = value.hrp === undefined ? 'bc' : value.hrp;
  refuse(hrp === 'bc' || (rehearsal && hrp === 'bcrt'), `${what}.hrp`);
  return { threshold, publicKeys, vaultId: value.vaultId as Hex, hrp };
}

/** Router calls that carry the proof, as the page can build them (solana.ts `solanaExitCall`). */
export const SOLANA_ROUTER_SHAPES = [
  'burnTo(uint64 amount, string recipient, uint64 issued, bytes signature)',
  'burnTo(uint64 amount, string recipient, bytes signature)',
];
const DEFAULT_SOLANA_PROOF: SolanaProofFormat = {
  template:
    'Bloch bridge exit: pay bUSDC.sol exits to my Solana wallet {wallet}. L2 account {l2Account}. Router {router}. Chain {chainId}. Issued {issued}.',
  carriedBy: 'page',
  routerFunction: null,
};
function parseSolanaProof(value: unknown, what: string): SolanaProofFormat {
  if (value === undefined) return DEFAULT_SOLANA_PROOF;
  refuse(isObject(value), what);
  const template = text(value.template, `${what}.template`, 600);
  refuse(/^[\x20-\x7e]+$/.test(template), `${what}.template is not one line of printable ASCII`);
  for (const field of ['{wallet}', '{l2Account}', '{router}', '{chainId}', '{issued}'])
    refuse(template.split(field).length === 2, `${what}.template must name ${field} exactly once`);
  refuse(value.carriedBy === 'page' || value.carriedBy === 'router', `${what}.carriedBy`);
  const routerFunction = value.carriedBy === 'router' ? text(value.routerFunction, `${what}.routerFunction`, 200) : null;
  refuse(routerFunction === null || SOLANA_ROUTER_SHAPES.includes(routerFunction), `${what}.routerFunction is not a shape this page can call`);
  return { template, carriedBy: value.carriedBy, routerFunction };
}

function parseRoute(file: unknown, launch: AnyRecord, page: AnyRecord, source: Route['source'], rehearsal: boolean): Route {
  refuse(isObject(file), 'the file is not an object');
  refuse(file.schema === SCHEMA, `schema is not ${SCHEMA}`);
  refuse(Object.keys(file).every((key) => TOP.includes(key)), 'the file has a top-level key the page does not know');
  const { network: n, asset: a, custody: c, committee: m, l2, limits: l, fee: f, finality: fin, deposit: d, release: r, explorers: e } = file;
  for (const [name, block] of Object.entries({ network: n, asset: a, custody: c, committee: m, l2, limits: l, fee: f, finality: fin, deposit: d, release: r, explorers: e }))
    refuse(isObject(block), `${name} is missing`);
  const id = text(n.id, 'network.id', 24);
  refuse(/^[a-z0-9-]{2,24}$/.test(id), 'network.id');
  refuse(KINDS.includes(n.kind), 'network.kind');
  const kind = n.kind as NetworkKind;
  refuse(l2.chainId === L2_CHAIN_ID, 'l2.chainId is not 700770');
  refuse(typeof l2.symbol === 'string' && /^[A-Za-z0-9.]{1,11}$/.test(l2.symbol), 'l2.symbol');
  const l2Decimals = whole(l2.decimals, 'l2.decimals', 36);
  const assetDecimals = whole(a.decimals, 'asset.decimals', 36);
  let unitsPerCustodyUnit = 1n;
  if (a.unit !== undefined) {
    refuse(isObject(a.unit) && a.unit.decimals === l2Decimals, 'asset.unit.decimals must equal l2.decimals');
    unitsPerCustodyUnit = amount(a.unit.assetUnitsPerUnit, 'asset.unit.assetUnitsPerUnit');
    refuse(unitsPerCustodyUnit === 10n ** BigInt(assetDecimals - l2Decimals), 'asset.unit.assetUnitsPerUnit does not match the decimals');
  } else refuse(assetDecimals === l2Decimals, 'asset.decimals differs from l2.decimals and the file names no unit');
  refuse(f.paidOn === 'source', 'fee.paidOn');
  const depositBps = whole(f.depositBps, 'fee.depositBps', 30);
  const releaseBps = whole(f.releaseBps, 'fee.releaseBps', 30);
  refuse(METHODS.includes(d.method), 'deposit.method');
  const limits = {
    cap: amount(l.cap, 'limits.cap'),
    window: amount(l.window, 'limits.window'),
    windowSeconds: whole(l.windowSeconds, 'limits.windowSeconds'),
    minDeposit: amount(l.minDeposit, 'limits.minDeposit'),
    maxDeposit: amount(l.maxDeposit, 'limits.maxDeposit'),
    l2MinBurn: amount(l.l2MinBurn, 'limits.l2MinBurn'),
    l2MaxBurn: amount(l.l2MaxBurn, 'limits.l2MaxBurn'),
    mintDelaySeconds: whole(l.mintDelaySeconds, 'limits.mintDelaySeconds'),
    largeItemThreshold: amount(l.largeItemThreshold, 'limits.largeItemThreshold'),
    releaseDelaySeconds: l.releaseDelaySeconds === undefined ? 0 : whole(l.releaseDelaySeconds, 'limits.releaseDelaySeconds'),
  };
  refuse(limits.minDeposit > 0n && limits.minDeposit <= limits.maxDeposit && limits.l2MinBurn > 0n && limits.l2MinBurn <= limits.l2MaxBurn, 'limits are not ordered');
  let fileLaunch: Route['fileLaunch'] = null;
  if (file.launch !== undefined) {
    refuse(isObject(file.launch) && typeof file.launch.v1 === 'boolean', 'launch.v1');
    fileLaunch = { v1: file.launch.v1, state: text(file.launch.state, 'launch.state', 40), reason: text(file.launch.reason, 'launch.reason') };
  }
  const decided = launch.networks?.[id];
  refuse(isObject(decided) && ['shown', 'not-available-yet', 'not-offered'].includes(decided.state), `launch.json has no decision for ${id}`);
  // The file's own "not in v1" wins over the page's list, never the other way round.
  const launchState: LaunchState =
    decided.state === 'shown' && fileLaunch && !fileLaunch.v1 ? 'not-available-yet' : decided.state;
  const p = page.networks?.[id] ?? {};
  refuse(isObject(p), `page.json networks.${id}`);
  const needsRouter = ROUTER_KINDS.includes(kind);
  refuse(needsRouter === (p.router !== undefined), needsRouter ? 'page.json names no router for a route that exits through one' : 'page.json names a router for a route that burns on the token');
  const custodyAddress = text(c.address, 'custody.address', 200);
  const route: Route = {
    id,
    name: text(n.name, 'network.name', 40),
    kind,
    chainId: text(n.chainId, 'network.chainId', 100),
    native: { symbol: text(n.nativeCurrency?.symbol, 'network.nativeCurrency.symbol', 8), decimals: whole(n.nativeCurrency?.decimals, 'network.nativeCurrency.decimals', 36) },
    asset: {
      symbol: text(a.symbol, 'asset.symbol', 12),
      name: text(a.name, 'asset.name', 60),
      decimals: assetDecimals,
      id: text(a.id, 'asset.id', 300),
      issuer: text(a.issuer, 'asset.issuer', 300),
      issuerNative: a.issuerNative === true,
      issuerPowers: Array.isArray(a.issuerPowers) && a.issuerPowers.length === 0 ? [] : texts(a.issuerPowers, 'asset.issuerPowers'),
      unitsPerCustodyUnit,
    },
    custody: { type: text(c.type, 'custody.type', 40), address: TBD.test(custodyAddress) ? null : custodyAddress, contract: text(c.contract, 'custody.contract', 400) },
    committee: { threshold: whole(m.threshold, 'committee.threshold', 16), pauseSeconds: whole(m.pauseSeconds, 'committee.pauseSeconds'), guardianPower: text(m.guardianPower, 'committee.guardianPower', 40) },
    l2: { token: deployed(l2.token, 'l2.token', ADDRESS) as Address | null, name: text(l2.name, 'l2.name', 60), symbol: l2.symbol, decimals: l2Decimals },
    limits,
    fee: { depositBps, releaseBps, recipient: text(f.recipient, 'fee.recipient', 100), collection: text(f.collection, 'fee.collection'), networkFee: text(f.networkFee, 'fee.networkFee') },
    finality: {
      rule: text(fin.rule, 'finality.rule'),
      tag: fin.tag === undefined ? null : text(fin.tag, 'finality.tag', 40),
      confirmations: whole(fin.confirmations, 'finality.confirmations'),
      typicalSeconds: whole(fin.typicalSeconds, 'finality.typicalSeconds'),
      worstCaseSeconds: whole(fin.worstCaseSeconds, 'finality.worstCaseSeconds'),
      reorg: text(fin.reorg, 'finality.reorg'),
    },
    deposit: {
      method: d.method,
      recipientEncoding: text(d.recipientEncoding, 'deposit.recipientEncoding'),
      function: d.function === undefined ? null : text(d.function, 'deposit.function'),
      steps: texts(d.steps, 'deposit.steps'),
      refusals: texts(d.refusals, 'deposit.refusals'),
    },
    release: {
      l2Function: text(r.l2Function, 'release.l2Function'),
      recipientEncoding: text(r.recipientEncoding, 'release.recipientEncoding'),
      typicalSeconds: whole(r.typicalSeconds, 'release.typicalSeconds'),
      paysAsset: text(r.paysAsset, 'release.paysAsset'),
      notes: r.notes === undefined ? [] : texts(r.notes, 'release.notes'),
    },
    explorers: {
      tx: pattern(e.source?.tx, 'explorers.source.tx'),
      address: pattern(e.source?.address, 'explorers.source.address'),
      l2Tx: pattern(e.l2?.tx, 'explorers.l2.tx'),
      l2Address: pattern(e.l2?.address, 'explorers.l2.address'),
    },
    notes: file.notes === undefined ? [] : texts(file.notes, 'notes'),
    fileLaunch,
    launch: { state: launchState, reason: launchState === 'shown' ? null : (decided.reason ?? fileLaunch?.reason ?? null) },
    router: needsRouter
      ? { address: deployed(p.router, 'page.router', ADDRESS) as Address | null, codeHash: deployed(p.routerCodeHash, 'page.routerCodeHash', HASH) as Hex | null }
      : null,
    read: endpoints(p.read ?? 'TBD-owner', `page.json networks.${id}.read`, rehearsal),
    source,
  };
  // The burn entry point must be the one the file describes: a router where the file names one, the token otherwise.
  refuse(needsRouter === /Router\.burnTo|burnTo\(/.test(route.release.l2Function), 'release.l2Function and the exit entry point of this network kind disagree');
  if (kind === 'utxo') {
    const pol = p.policy;
    refuse(isObject(pol), 'page.json bitcoin.policy');
    route.bitcoin = {
      script: parseBitcoinScript(p.script ?? 'TBD-deploy', 'page.json bitcoin.script', rehearsal),
      policy: {
        depositVbytes: whole(pol.depositVbytes, 'depositVbytes', 100_000),
        releaseVbytes: whole(pol.releaseVbytes, 'releaseVbytes', 100_000),
        refundVbytes: whole(pol.refundVbytes, 'refundVbytes', 100_000),
        depositMaxChargeBps: whole(pol.depositMaxChargeBps, 'depositMaxChargeBps', 10_000),
        feeRateCeiling: whole(pol.feeRateCeiling, 'feeRateCeiling', 10_000),
        dustSats: whole(pol.dustSats, 'dustSats', 100_000),
        sweepConfirmations: whole(pol.sweepConfirmations, 'sweepConfirmations', 1000),
        largeBurnThreshold: amount(pol.largeBurnThreshold, 'largeBurnThreshold'),
        largeBurnDelaySeconds: whole(pol.largeBurnDelaySeconds, 'largeBurnDelaySeconds'),
      },
    };
  }
  if (kind === 'svm') {
    const pol = p.policy;
    refuse(isObject(pol), 'page.json solana.policy');
    let programId: string | null = null;
    let vault: string | null = null;
    if (route.custody.address) {
      const parts = route.custody.address.split('/');
      refuse(parts.length === 2 && parts.every((part) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(part)), 'custody.address is not <programId>/<vaultAddress>');
      [programId, vault] = parts;
    }
    route.solana = {
      policy: {
        largeReleaseThreshold: amount(pol.largeReleaseThreshold, 'largeReleaseThreshold'),
        releaseDelaySeconds: whole(pol.releaseDelaySeconds, 'releaseDelaySeconds'),
        depositRentLamports: amount(pol.depositRentLamports, 'depositRentLamports'),
        recordRetentionSeconds: whole(pol.recordRetentionSeconds, 'recordRetentionSeconds'),
        proofMaxAgeSeconds: whole(pol.proofMaxAgeSeconds, 'proofMaxAgeSeconds', 3600),
      },
      proof: parseSolanaProof(p.exitProof, 'page.json solana.exitProof'),
      programId,
      vault,
    };
  }
  if (kind === 'tvm') {
    const pol = p.policy;
    refuse(isObject(pol), 'page.json tron.policy');
    route.tron = {
      policy: {
        releaseFlat: amount(pol.releaseFlat, 'releaseFlat'),
        depositTrxEstimate: text(pol.depositTrxEstimate, 'depositTrxEstimate', 12),
        issuerFeeMaxBps: whole(pol.issuerFeeMaxBps, 'issuerFeeMaxBps', 10_000),
        issuerFeeMaxUnits: amount(pol.issuerFeeMaxUnits, 'issuerFeeMaxUnits'),
      },
    };
    refuse(route.tron.policy.releaseFlat < limits.l2MinBurn, 'the fixed release fee is not below the smallest exit');
  }
  if (kind === 'stellar') {
    const pol = p.policy;
    refuse(isObject(pol), 'page.json stellar.policy');
    route.stellar = { policy: { worstCaseGuardianDelaySeconds: whole(pol.worstCaseGuardianDelaySeconds, 'worstCaseGuardianDelaySeconds') } };
  }
  return route;
}

/** Why a shown route is not live, in the user's words; empty when it is live. */
export function notLiveReasons(route: Route, direction?: 'deposit' | 'exit'): string[] {
  const reasons: string[] = [];
  if (!route.l2.token) reasons.push(`The ${route.l2.symbol} token is not deployed on the Bloch L2.`);
  if (!route.custody.address) reasons.push(`The vault on ${route.name} is not deployed.`);
  if (route.router && !route.router.address) reasons.push(`The exit router for ${route.l2.symbol} is not deployed on the Bloch L2.`);
  if (route.router && route.router.address && !route.router.codeHash) reasons.push(`The code hash of the ${route.l2.symbol} exit router is not pinned.`);
  if (!route.read) reasons.push(`No reviewed endpoint is published for reading ${route.name}.`);
  if (route.kind === 'utxo' && !route.bitcoin?.script && direction !== 'exit')
    reasons.push('The Bitcoin vault keys are not published, so no deposit address can be computed.');
  return reasons;
}

export function routeStatus(route: Route): RouteStatus {
  if (route.launch.state !== 'shown')
    return { state: 'not-available-yet', reason: route.launch.reason ?? `The bridge from ${route.name} is not available yet.` };
  const reasons = notLiveReasons(route);
  return reasons.length ? { state: 'not-live', reasons } : { state: 'live' };
}

/** The only door to the builders: null unless the route is shown and every address and endpoint is there. */
export function liveRoute(route: Route | null | undefined): LiveRoute | null {
  return route && routeStatus(route).state === 'live' ? (route as LiveRoute) : null;
}

export type WrappedToken = {
  symbol: string;
  name: string;
  decimals: number;
  address: Address | null;
  status: 'deployed' | 'not-deployed';
  offered: 'shown' | 'not-available-yet';
  network: { id: string; name: string; kind: NetworkKind };
  asset: { symbol: string; name: string; issuer: string; issuerNative: boolean };
  exit: 'router' | 'token-burn';
  description: string;
};

export type BridgeConfig = {
  rehearsal: boolean;
  /** The networks the page lists, in the coordinator's order; a network that is not offered is absent. */
  entries: RouteEntry[];
  tokens: WrappedToken[];
  l2Explorer: string | null;
};

export function parseBridgeBundle(bundle: unknown, allowRehearsal: boolean): BridgeConfig {
  refuse(isObject(bundle) && Array.isArray(bundle.files) && isObject(bundle.launch) && isObject(bundle.page), 'the bridge bundle is malformed');
  const rehearsal = bundle.rehearsal === true;
  refuse(!rehearsal || allowRehearsal, 'a rehearsal bridge bundle in a build that is not a local render build');
  const { launch, page } = bundle as { launch: AnyRecord; page: AnyRecord };
  refuse(launch.l2ChainId === L2_CHAIN_ID && Array.isArray(launch.order), 'launch.json');
  const sources: AnyRecord[] = Array.isArray(bundle.sources?.sources) ? bundle.sources.sources : [];
  const byId = new Map<string, RouteEntry>();
  for (const file of bundle.files as unknown[]) {
    const id = isObject(file) && isObject(file.network) && typeof file.network.id === 'string' ? file.network.id : '';
    const name = isObject(file) && isObject(file.network) && typeof file.network.name === 'string' ? file.network.name.slice(0, 40) : id;
    if (!/^[a-z0-9-]{2,24}$/.test(id) || byId.has(id)) continue;
    const src = sources.find((s) => s.network === id);
    const source = src && typeof src.commit === 'string' ? { commit: src.commit, ref: String(src.ref), derived: src.derived === true } : null;
    try {
      const route = parseRoute(file, launch, page, source, rehearsal);
      byId.set(id, { id, name: route.name, route, status: routeStatus(route) });
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      byId.set(id, { id, name, route: null, status: { state: 'unreadable', reason: error.message } });
    }
  }
  const entries = (launch.order as unknown[])
    .filter((id): id is string => typeof id === 'string' && byId.has(id))
    .map((id) => byId.get(id)!)
    .filter((entry) => launch.networks?.[entry.id]?.state !== 'not-offered');
  const tokens: WrappedToken[] = [];
  const list: unknown[] = Array.isArray(bundle.tokens?.tokens) ? bundle.tokens.tokens : [];
  for (const t of list) {
    refuse(isObject(t) && typeof t.symbol === 'string' && /^[A-Za-z0-9.]{1,11}$/.test(t.symbol), 'wrapped-tokens.json symbol');
    refuse(t.address === null || (typeof t.address === 'string' && /^0x[0-9a-f]{40}$/.test(t.address)), 'wrapped-tokens.json address');
    const entry = byId.get(t.network?.id);
    // The generated list must say what the interface file says: a stale list is refused, not shown.
    if (!entry?.route) continue; // an unreadable route lists no token
    refuse(entry.route.l2.symbol === t.symbol && entry.route.l2.name === t.name && entry.route.l2.decimals === t.decimals && (entry.route.l2.token?.toLowerCase() ?? null) === t.address, `wrapped-tokens.json is stale for ${t.symbol}: rerun scripts/bridge/import-interfaces.mjs`);
    tokens.push(t as WrappedToken);
  }
  refuse(new Set(tokens.map((t) => t.symbol.toLowerCase())).size === tokens.length, 'two wrapped tokens share a symbol');
  const explorer = page.l2?.explorer;
  return { rehearsal, entries, tokens, l2Explorer: pattern(explorer ?? 'TBD-owner', 'page.json l2.explorer') };
}
