import type { Pool, Quote, Symbol } from './model';
import { isAllowedSlippageBps } from './slippage';

export const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_RESERVE = (1n << 112n) - 1n;
const MAX_PATH_LENGTH = 5;
const MAX_ROUTES = 8;

function reusesPool(path: Symbol[], next: Symbol): boolean {
  const current = path.at(-1)!;
  if (current === next) return true;
  for (let i = 0; i < path.length - 1; i++) {
    if (
      (path[i] === current && path[i + 1] === next) ||
      (path[i] === next && path[i + 1] === current)
    )
      return true;
  }
  return false;
}

function hasRepeatedPool(path: Symbol[]): boolean {
  return path.slice(1).some((next, index) => reusesPool(path.slice(0, index + 1), next));
}

/** Parse a user amount without floating point rounding, exponent syntax or truncation. */
export function parseAmount(input: string, decimals: number): bigint | null {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const value = input.trim();
  if (value.length > 80 || !/^\d+(?:\.\d*)?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) return null;
  const amount =
    BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  return amount <= MAX_UINT256 ? amount : null;
}

/** Format exact units, always rounding down; this output can safely be parsed again. */
export function formatAmount(amount: bigint, decimals: number, places = decimals): string {
  const scale = 10n ** BigInt(decimals);
  const fraction = (amount % scale)
    .toString()
    .padStart(decimals, '0')
    .slice(0, places)
    .replace(/0+$/, '');
  return `${amount / scale}${fraction ? `.${fraction}` : ''}`;
}

export function amountOut(input: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (input <= 0n || reserveIn <= 0n || reserveOut <= 0n || input > MAX_UINT256) return 0n;
  // Pair._update stores uint112 balances; mirror BDexLens's execution bound.
  if (reserveOut > MAX_RESERVE || reserveIn + input > MAX_RESERVE) return 0n;
  // Matches BDexLibrary.getAmountOut; intermediate overflow would revert on-chain.
  const withFee = input * 997n;
  const numerator = withFee * reserveOut;
  const denominator = reserveIn * 1000n + withFee;
  if (numerator > MAX_UINT256 || denominator > MAX_UINT256) return 0n;
  return numerator / denominator;
}

export function quoteRoute(
  input: bigint,
  path: Symbol[],
  pools: Pool[],
  slippageBps: number,
): Quote | null {
  if (input <= 0n || path.length < 2 || path.length > MAX_PATH_LENGTH || hasRepeatedPool(path))
    return null;
  if (slippageBps !== 0 && !isAllowedSlippageBps(slippageBps)) return null;
  const amounts = [input];
  let marginal = input;
  for (let i = 1; i < path.length; i++) {
    const pool = pools.find(
      (p) =>
        (p.token0 === path[i - 1] && p.token1 === path[i]) ||
        (p.token1 === path[i - 1] && p.token0 === path[i]),
    );
    if (!pool) return null;
    const [reserveIn, reserveOut] =
      pool.token0 === path[i - 1] ? [pool.reserve0, pool.reserve1] : [pool.reserve1, pool.reserve0];
    const next = amountOut(amounts[i - 1], reserveIn, reserveOut);
    if (!next) return null;
    amounts.push(next);
    marginal = (marginal * reserveOut) / reserveIn;
  }
  const output = amounts.at(-1)!;
  const minimum = (output * BigInt(10_000 - slippageBps)) / 10_000n;
  if (!minimum) return null;
  const loss = marginal > output ? ((marginal - output) * 10_000n) / marginal : 0n;
  return { path, amounts, output, minimum, executionLossBps: Number(loss) };
}

function discoverPaths(from: Symbol, to: Symbol, pools: Pool[]): Symbol[][] {
  const adjacent = new Map<Symbol, Set<Symbol>>();
  for (const pool of pools) {
    if (pool.token0 === pool.token1) continue;
    if (!adjacent.has(pool.token0)) adjacent.set(pool.token0, new Set());
    if (!adjacent.has(pool.token1)) adjacent.set(pool.token1, new Set());
    adjacent.get(pool.token0)!.add(pool.token1);
    adjacent.get(pool.token1)!.add(pool.token0);
  }

  const paths: Symbol[][] = [];
  const visit = (path: Symbol[]) => {
    const current = path.at(-1)!;
    if (current === to) {
      paths.push(path);
      return;
    }
    if (path.length === MAX_PATH_LENGTH) return;
    for (const next of adjacent.get(current) ?? []) {
      if (!reusesPool(path, next)) visit([...path, next]);
    }
  };
  visit([from]);
  return paths;
}

export function findQuotes(
  input: bigint,
  from: Symbol,
  to: Symbol,
  pools: Pool[],
  slippageBps: number,
): Quote[] {
  if (from === to) return [];
  return discoverPaths(from, to, pools)
    .map((path) => quoteRoute(input, path, pools, slippageBps))
    .filter((q): q is Quote => q !== null)
    .sort((a, b) => {
      if (a.output !== b.output) return a.output > b.output ? -1 : 1;
      if (a.path.length !== b.path.length) return a.path.length - b.path.length;
      const aPath = a.path.join('\0');
      const bPath = b.path.join('\0');
      return aPath < bPath ? -1 : aPath > bPath ? 1 : 0;
    })
    .slice(0, MAX_ROUTES);
}
