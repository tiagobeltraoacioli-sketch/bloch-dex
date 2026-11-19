// The "Pool ratio" line of the Market block (review R413-9). One rule on every chain, whatever the token order:
//   - the ratio is stated per ONE wrapped native token when the pool has one ("1 WETH … USDC"), else per one
//     token1;
//   - six significant digits, cut (never rounded up);
//   - "=" only when the figure shown is the ratio exactly; "≈" whenever a digit was cut or the division left a
//     remainder. The pool's ratio is its reserves; a swap's rate is in its quote, fee and price impact included.
import type { LivePool, LiveToken } from '../devnet4/chain';

export const RATIO_DIGITS = 6;
/** Digits carried below the quote token's own decimals before the cut, so that a small ratio keeps its digits. */
const EXTRA = 24;

export type PoolRatio = { base: LiveToken; quote: LiveToken; figure: string; exact: boolean };

export function poolRatio(pool: LivePool): PoolRatio | null {
  const baseIsZero = pool.token0.wrapped && !pool.token1.wrapped;
  const [base, quote, reserveBase, reserveQuote] = baseIsZero
    ? [pool.token0, pool.token1, pool.reserve0, pool.reserve1]
    : [pool.token1, pool.token0, pool.reserve1, pool.reserve0];
  if (reserveBase <= 0n || reserveQuote <= 0n) return null;
  // Quote base units per one whole base token, with EXTRA more decimal places.
  const numerator = reserveQuote * 10n ** BigInt(base.decimals) * 10n ** BigInt(EXTRA);
  const scaled = numerator / reserveBase;
  let exact = numerator % reserveBase === 0n;
  const places = quote.decimals + EXTRA;
  const digits = scaled.toString().padStart(places + 1, '0');
  const whole = digits.slice(0, digits.length - places);
  const fraction = digits.slice(digits.length - places);
  // Keep RATIO_DIGITS significant digits, counted from the first non-zero one.
  const all = whole + fraction;
  const first = all.search(/[1-9]/);
  if (first < 0) return { base, quote, figure: '0', exact: false };
  const keep = Math.max(first + RATIO_DIGITS, whole.length);
  if (/[1-9]/.test(all.slice(keep))) exact = false;
  const kept = all.slice(0, keep).padEnd(whole.length, '0');
  const keptFraction = kept.slice(whole.length).replace(/0+$/, '');
  return {
    base,
    quote,
    figure: `${BigInt(whole)}${keptFraction ? `.${keptFraction}` : ''}`,
    exact,
  };
}

/** "1 WETH ≈ 3051.35 USDC" */
export const poolRatioText = (pool: LivePool): string => {
  const r = poolRatio(pool);
  return r
    ? `1 ${r.base.symbol} ${r.exact ? '=' : '≈'} ${r.figure} ${r.quote.symbol}`
    : 'Not available';
};
