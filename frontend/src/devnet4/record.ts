// The committed, reviewed devnet4 deployment record the devnet4 live route is
// allowed to use (the same verifier checks the mainnet record against a
// mainnet target, see ../mainnet/config.ts): the deployment plan, the configuration it was derived from
// and the schema-2 finality-gate report that enabled liquidity. Nothing here
// talks to an RPC; chain checks live in chain.ts.
import { sha256, stringToBytes, type Address, type Hex } from 'viem';
import plan from '../../../deployments/devnet4/mainnet-procedure-2pairs-20261016/plan.json';
import config from '../../../deployments/devnet4/mainnet-procedure-2pairs-20261016/config.json';
import gateReport from '../../../deployments/devnet4/mainnet-procedure-2pairs-20261016/gate-report.json';
import { DEX_STAGING_CHAIN_ID } from '../network-identity';

export const RECORD_NAME = 'devnet4 mainnet-procedure rehearsal, two pilot pairs (2026-10-16)';
export const RECORD_PATH = 'deployments/devnet4/mainnet-procedure-2pairs-20261016';
const PLAN_DOMAIN = 'postern.dex.mainnet-plan.v1';
const GATE_DOMAIN = 'postern.dex.finality-gate.v1';
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;

export type DevnetToken = {
  address: Address;
  /** On-chain symbol; the wrapper is shown as native BLCH in the swap form. */
  symbol: string;
  cap: bigint;
  wrapped: boolean;
};
export type DevnetPair = { address: Address; token0: Address; token1: Address };
export type DevnetDeployment = {
  name: string;
  path: string;
  revision: string;
  chainId: number;
  genesisHash: Hex;
  factory: Address;
  router: Address;
  lens: Address;
  wrapped: Address;
  feeTo: Address;
  /** Runtime code hash of every contract the route reads or calls. */
  codeHashes: Record<Address, Hex>;
  tokens: DevnetToken[];
  pairs: DevnetPair[];
  gate: { decision: 'liquidity-enabled'; finalizedNumber: bigint; finalizedHash: Hex };
};

export type RecordInput = { plan: unknown; config: unknown; gateReport: unknown };

/** Which chain a record must target: devnet4 in rehearsal mode, or the mainnet. */
export type RecordTarget = {
  chainId: number;
  rehearsal: boolean;
  name: string;
  path: string;
  /** When set, the record's genesis must equal it (the reviewed L2 genesis). */
  genesisHash?: Hex | null;
};
export const DEVNET4_TARGET: RecordTarget = {
  chainId: DEX_STAGING_CHAIN_ID,
  rehearsal: true,
  name: RECORD_NAME,
  path: RECORD_PATH,
};

export class RecordError extends Error {}

function refuse(condition: unknown, message: string): asserts condition {
  if (!condition) throw new RecordError(`deployment record: ${message}`);
}

/** Canonical JSON (sorted keys, no whitespace), as dex-deploy-config.mjs hashes it. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256Hex = (text: string): string => sha256(stringToBytes(text));

const address = (value: unknown, field: string): Address => {
  refuse(typeof value === 'string' && ADDRESS.test(value), `${field} is not a lowercase address`);
  return value as Address;
};
const hash = (value: unknown, field: string): Hex => {
  refuse(typeof value === 'string' && HASH.test(value), `${field} is not a 32-byte hash`);
  return value as Hex;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON, checked field by field
type AnyRecord = Record<string, any>;

/**
 * Verify the record's internal consistency: the plan is derived from this
 * configuration (SHA-256 of its canonical JSON), targets the devnet4 chain
 * in rehearsal mode, and the gate report enabled liquidity for exactly the
 * planned chain, fee recipient, pairs and transactions.
 */
export async function verifyDeploymentRecord(
  input: RecordInput = { plan, config, gateReport },
  target: RecordTarget = DEVNET4_TARGET,
): Promise<DevnetDeployment> {
  const p = input.plan as AnyRecord;
  const c = input.config as AnyRecord;
  const g = input.gateReport as AnyRecord;
  refuse(p && p.domain === PLAN_DOMAIN && p.schemaVersion === 1, 'unsupported plan');
  refuse(
    p.chain?.id === target.chainId && p.chain?.rehearsal === target.rehearsal,
    target.rehearsal
      ? 'the plan is not a devnet4 rehearsal'
      : `the plan is not a chain ${target.chainId} deployment`,
  );
  refuse(
    sha256Hex(stableJson(c)) === p.configSha256,
    'the plan was not derived from this configuration',
  );
  refuse(
    c.network?.chainId === p.chain.id && c.network?.genesisHash === p.chain.genesisHash,
    'configuration and plan disagree',
  );
  const genesisHash = hash(p.chain.genesisHash, 'chain.genesisHash');
  refuse(
    !target.genesisHash || genesisHash === target.genesisHash,
    'the plan genesis differs from the reviewed network genesis',
  );

  refuse(g && g.domain === GATE_DOMAIN && g.schemaVersion === 2, 'unsupported gate report');
  refuse(g.decision === 'liquidity-enabled', 'the finality gate did not enable liquidity');
  refuse(
    g.chainId === p.chain.id && g.genesisHash === genesisHash,
    'the gate report is for another chain',
  );
  refuse(g.feeTo === p.feeTo, 'the gate report fee recipient differs from the plan');
  refuse(
    Array.isArray(g.pairs) &&
      g.pairs.length === p.pairs.length &&
      g.pairs.every((pair: AnyRecord, i: number) => pair.address === p.pairs[i].address),
    'the gate report pairs differ from the plan',
  );
  refuse(
    Array.isArray(g.transactions) && g.transactions.length === p.steps.length,
    'the gate report transactions differ from the plan',
  );
  const finalizedNumber = BigInt(g.finalized?.number ?? -1);
  refuse(finalizedNumber > 0n, 'the gate report has no finalized block');

  const contracts = p.contracts as Record<string, { address: string; codeHash: string }>;
  const codeHashes: Record<Address, Hex> = {};
  for (const key of ['wrappedNative', 'factory', 'router', 'lens']) {
    codeHashes[address(contracts[key]?.address, key)] = hash(
      contracts[key]?.codeHash,
      `${key}.codeHash`,
    );
  }
  const pairs: DevnetPair[] = (p.pairs as AnyRecord[]).map((pair, i) => {
    codeHashes[address(pair.address, `pairs[${i}]`)] = hash(pair.codeHash, `pairs[${i}].codeHash`);
    return {
      address: pair.address,
      token0: address(pair.token0, `pairs[${i}].token0`),
      token1: address(pair.token1, `pairs[${i}].token1`),
    };
  });
  const wrapped = contracts.wrappedNative.address as Address;
  const symbols = new Map<string, string>(
    (p.externalTokens as AnyRecord[]).map((t) => {
      codeHashes[address(t.token, 'externalTokens.token')] = hash(
        t.codeHash,
        'externalTokens.codeHash',
      );
      return [t.token, t.symbol];
    }),
  );
  const tokens: DevnetToken[] = (p.reserveCaps as AnyRecord[]).map((entry, i) => {
    const token = address(entry.token, `reserveCaps[${i}].token`);
    const isWrapped = token === wrapped;
    refuse(isWrapped || symbols.has(token), `reserveCaps[${i}] has no reviewed token entry`);
    return {
      address: token,
      symbol: isWrapped ? 'WBLCH' : symbols.get(token)!,
      cap: BigInt(entry.cap),
      wrapped: isWrapped,
    };
  });
  for (const pair of pairs) {
    refuse(
      tokens.some((t) => t.address === pair.token0) &&
        tokens.some((t) => t.address === pair.token1),
      'a planned pair holds an uncapped token',
    );
  }
  return {
    name: target.name,
    path: target.path,
    revision: String(p.source?.revision ?? ''),
    chainId: p.chain.id,
    genesisHash,
    factory: contracts.factory.address as Address,
    router: contracts.router.address as Address,
    lens: contracts.lens.address as Address,
    wrapped,
    feeTo: address(p.feeTo, 'feeTo'),
    codeHashes,
    tokens,
    pairs,
    gate: {
      decision: 'liquidity-enabled',
      finalizedNumber,
      finalizedHash: hash(g.finalized.hash, 'gate finalized hash'),
    },
  };
}

export const committedRecord: RecordInput = { plan, config, gateReport };
