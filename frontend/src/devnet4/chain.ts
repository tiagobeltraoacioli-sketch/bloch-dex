// Devnet4 live reads. Pool state is read at the RPC's `finalized` block after
// re-checking the chain identity and every runtime code hash of the reviewed
// record there; quotes come from the deployed BDexLens (which refuses routes
// that would exceed a reserve cap) at `latest`, the state a swap executes on.
import {
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import type { DevnetDeployment, DevnetToken } from './record';
import { SLIPPAGE_RANGE_TEXT, isAllowedSlippageBps } from '../slippage';

export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

export const ERC20_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
export const PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 timestamp)',
  'function reserveCaps() view returns (uint112 cap0, uint112 cap1)',
]);
export const LENS_ABI = parseAbi([
  'struct RouteQuote { bool available; uint256 blockNumber; uint256 timestamp; uint256 amountOut; uint256 minimumOut; uint256[] amounts; uint256[] executionLossBps; }',
  'function bestExactInput(uint256 amountIn, address[][] routes, uint256 slippageBps) view returns (uint256 bestIndex, RouteQuote[] quotes)',
  'struct PendingExcess { uint256 excess0; uint256 excess1; bool blocksInflow0; bool blocksInflow1; }',
  'function pendingExcess(address pair) view returns (PendingExcess value)',
]);

export class ChainError extends Error {
  /** The JSON-RPC error code, when the error came from an RPC answer. */
  code?: number;
}
function refuseAs(condition: unknown, message: string, label: string): asserts condition {
  if (!condition) throw new ChainError(`${label}: ${message}`);
}
/** RPC, call and quote helpers are shared by the devnet4 and mainnet routes. */
const refuse: (condition: unknown, message: string) => asserts condition = (c, m) =>
  refuseAs(c, m, 'chain');

const RPC_TEXT_CONTROLS =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu;
const RPC_TEXT_LINKS =
  /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S*|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|xyz|app|me|gg|co|info|link|site|online|top|finance|exchange)\b\S*|@[a-z0-9_]{3,}|\bt\.me\S*/giu;
export const RPC_TEXT_MAX = 120;

/**
 * An RPC error text is untrusted: a lying or compromised RPC chooses it, and the
 * page shows it next to its own status text. Keep a bounded, single-line, link-free
 * excerpt, so it cannot carry a "support" URL, handle or long instructions.
 */
export function rpcErrorText(value: unknown): string {
  if (typeof value !== 'string') return 'error';
  const cleaned = value
    .slice(0, 1024)
    .normalize('NFKC')
    .replace(RPC_TEXT_CONTROLS, ' ')
    .replace(RPC_TEXT_LINKS, '[link removed]')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!cleaned) return 'error';
  const chars = Array.from(cleaned);
  return chars.length > RPC_TEXT_MAX ? `${chars.slice(0, RPC_TEXT_MAX).join('')}…` : cleaned;
}

/** JSON-RPC over HTTP POST (the settled RPC has no CORS; see README for the proxy). */
export function httpRpc(url: string, fetchImpl: typeof fetch = (...args) => fetch(...args)): Rpc {
  let id = 0;
  return async (method, params) => {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    refuse(response.ok, `${method} returned HTTP ${response.status}`);
    const body = (await response.json()) as {
      result?: unknown;
      error?: { message?: string; code?: number };
    };
    if (body.error) {
      const error = new ChainError(`chain: ${method} failed: ${rpcErrorText(body.error.message)}`);
      error.code = Number.isSafeInteger(body.error.code) ? body.error.code : undefined;
      throw error;
    }
    return body.result;
  };
}

export type BlockTag = 'latest' | { blockHash: Hex };

export async function readCall<T>(
  rpc: Rpc,
  abi: Abi,
  to: Address,
  functionName: string,
  args: unknown[],
  at: BlockTag,
): Promise<T> {
  const data = encodeFunctionData({ abi, functionName, args } as never);
  const result = await rpc('eth_call', [{ to, data }, at]);
  refuse(typeof result === 'string' && result.startsWith('0x'), `${functionName} call failed`);
  return decodeFunctionResult({ abi, functionName, data: result as Hex } as never) as T;
}

export type LiveToken = DevnetToken & { decimals: number };
export type LivePool = {
  address: Address;
  token0: LiveToken;
  token1: LiveToken;
  reserve0: bigint;
  reserve1: bigint;
  cap0: bigint;
  cap1: bigint;
  /** Mainnet route: tokens held above the reserves (`BDexLens.pendingExcess`). */
  excess?: { excess0: bigint; excess1: bigint; blocksInflow0: boolean; blocksInflow1: boolean };
};
export type Snapshot = {
  finalized: { number: bigint; hash: Hex; timestamp: bigint };
  tokens: LiveToken[];
  pools: LivePool[];
};

/**
 * Re-verify the record against the chain at its finalized block and read
 * every pool. Refuses a different chain or genesis, a finalized block older
 * than the gate's, or any runtime code that differs from the record.
 */
export async function readSnapshot(
  rpc: Rpc,
  d: DevnetDeployment,
  label = 'devnet4',
): Promise<Snapshot> {
  const refuse: (condition: unknown, message: string) => asserts condition = (c, m) =>
    refuseAs(c, m, label);
  refuse(
    BigInt(String(await rpc('eth_chainId', []))) === BigInt(d.chainId),
    'the RPC serves another chain',
  );
  const genesis = (await rpc('eth_getBlockByNumber', ['0x0', false])) as { hash?: string } | null;
  refuse(genesis?.hash === d.genesisHash, 'the RPC genesis differs from the record');
  const block = (await rpc('eth_getBlockByNumber', ['finalized', false])) as {
    number?: string;
    hash?: string;
    timestamp?: string;
  } | null;
  refuse(block?.hash && block.number && block.timestamp, 'the RPC has no finalized block');
  const finalized = {
    number: BigInt(block.number),
    hash: block.hash as Hex,
    timestamp: BigInt(block.timestamp),
  };
  refuse(
    finalized.number >= d.gate.finalizedNumber,
    'the finalized block is older than the gate decision',
  );
  const at: BlockTag = { blockHash: finalized.hash };
  for (const [contract, expected] of Object.entries(d.codeHashes)) {
    const code = await rpc('eth_getCode', [contract, at]);
    refuse(
      typeof code === 'string' && code !== '0x' && keccak256(code as Hex) === expected,
      `runtime code of ${contract} differs from the record`,
    );
  }
  const tokens: LiveToken[] = [];
  for (const token of d.tokens) {
    const decimals = Number(
      await readCall<number>(rpc, ERC20_ABI, token.address, 'decimals', [], at),
    );
    const symbol = await readCall<string>(rpc, ERC20_ABI, token.address, 'symbol', [], at);
    refuse(
      symbol === token.symbol,
      `token ${token.address} symbol ${symbol} differs from the record`,
    );
    refuse(
      Number.isInteger(decimals) && decimals >= 0 && decimals <= 36,
      'token decimals out of range',
    );
    tokens.push({ ...token, decimals });
  }
  const byAddress = new Map(tokens.map((t) => [t.address, t]));
  const pools: LivePool[] = [];
  for (const pair of d.pairs) {
    const [reserve0, reserve1] = await readCall<readonly [bigint, bigint, number]>(
      rpc,
      PAIR_ABI,
      pair.address,
      'getReserves',
      [],
      at,
    );
    const [cap0, cap1] = await readCall<readonly [bigint, bigint]>(
      rpc,
      PAIR_ABI,
      pair.address,
      'reserveCaps',
      [],
      at,
    );
    pools.push({
      address: pair.address,
      token0: byAddress.get(pair.token0)!,
      token1: byAddress.get(pair.token1)!,
      reserve0,
      reserve1,
      cap0,
      cap1,
    });
  }
  return { finalized, tokens, pools };
}

/** Candidate routes between two record tokens: direct when a pair exists, else through WBLCH. */
export function routesFor(d: DevnetDeployment, tokenIn: Address, tokenOut: Address): Address[][] {
  const direct = d.pairs.some(
    (p) =>
      (p.token0 === tokenIn && p.token1 === tokenOut) ||
      (p.token1 === tokenIn && p.token0 === tokenOut),
  );
  const routes: Address[][] = [];
  if (direct) routes.push([tokenIn, tokenOut]);
  if (tokenIn !== d.wrapped && tokenOut !== d.wrapped) routes.push([tokenIn, d.wrapped, tokenOut]);
  return routes;
}

export type LensQuote = {
  path: Address[];
  amountIn: bigint;
  amountOut: bigint;
  minimumOut: bigint;
  amounts: bigint[];
  executionLossBps: bigint[];
  blockNumber: bigint;
};

/**
 * Quote through the lens at `at` (devnet4: `latest`; the mainnet route passes
 * the finalized block hash); null when every route is unavailable (no pool, a
 * cap, or zero output).
 */
export async function quoteExactInput(
  rpc: Rpc,
  d: DevnetDeployment,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  slippageBps: number,
  at: BlockTag = 'latest',
): Promise<LensQuote | null> {
  refuse(tokenIn !== tokenOut, 'choose two different tokens');
  refuse(amountIn > 0n, 'the amount must be positive');
  refuse(isAllowedSlippageBps(slippageBps), `slippage must be ${SLIPPAGE_RANGE_TEXT}`);
  const routes = routesFor(d, tokenIn, tokenOut);
  refuse(routes.length > 0, 'no route between these tokens');
  type Quote = {
    available: boolean;
    blockNumber: bigint;
    amountOut: bigint;
    minimumOut: bigint;
    amounts: readonly bigint[];
    executionLossBps: readonly bigint[];
  };
  const [bestIndex, quotes] = await readCall<readonly [bigint, readonly Quote[]]>(
    rpc,
    LENS_ABI,
    d.lens,
    'bestExactInput',
    [amountIn, routes, BigInt(slippageBps)],
    at,
  );
  if (bestIndex >= BigInt(routes.length)) return null;
  const q = quotes[Number(bestIndex)];
  if (!q || !q.available || q.amountOut === 0n) return null;
  // The lens answer comes from the RPC. The signed minimum is recomputed here
  // (BDexLens: amountOut * (10000 - slippageBps) / 10000), so an RPC cannot hand
  // the wallet a minimum below the slippage the user chose, and the legs must
  // describe this amount on this path.
  const path = routes[Number(bestIndex)];
  refuse(
    q.minimumOut === (q.amountOut * BigInt(10_000 - slippageBps)) / 10_000n,
    'the quote minimum does not match the slippage tolerance',
  );
  refuse(
    q.amounts.length === path.length &&
      q.amounts[0] === amountIn &&
      q.amounts[q.amounts.length - 1] === q.amountOut,
    'the quote legs do not match the amount and the route',
  );
  return {
    path,
    amountIn,
    amountOut: q.amountOut,
    minimumOut: q.minimumOut,
    amounts: [...q.amounts],
    executionLossBps: [...q.executionLossBps],
    blockNumber: q.blockNumber,
  };
}
