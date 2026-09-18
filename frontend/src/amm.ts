import type { Pool, Quote, Symbol } from './model';

export const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_RESERVE = (1n << 112n) - 1n;

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
  if (input <= 0n || path.length < 2 || path.length > 5 || new Set(path).size !== path.length)
    return null;
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 500) return null;
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

export function findQuotes(
  input: bigint,
  from: Symbol,
  to: Symbol,
  pools: Pool[],
  slippageBps: number,
): Quote[] {
  if (from === to) return [];
  const symbols = [...new Set(pools.flatMap((p) => [p.token0, p.token1]))];
  const paths: Symbol[][] = [
    [from, to],
    ...symbols.filter((s) => s !== from && s !== to).map((s) => [from, s, to]),
  ];
  return paths
    .slice(0, 8)
    .map((path) => quoteRoute(input, path, pools, slippageBps))
    .filter((q): q is Quote => q !== null)
    .sort((a, b) => (a.output > b.output ? -1 : a.output < b.output ? 1 : 0));
}
