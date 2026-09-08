import { parseAmount } from './amm';
import type { Period, Pool, Symbol, Token } from './model';

/** Symbolic demo assets, not a deployment registry or contract addresses. */
export const TOKENS: Record<Symbol, Token> = {
  BLCH: { symbol: 'BLCH', name: 'Bloch', decimals: 18, price: 0.1842, glyph: 'B' },
  USDC: { symbol: 'USDC', name: 'USD Coin', decimals: 6, price: 1, glyph: '$' },
  WETH: { symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, price: 2400, glyph: '◇' },
  USTAV: { symbol: 'USTAV', name: 'Ustav', decimals: 18, price: 0.42, glyph: 'U' },
};

function pool(id: string, token0: Symbol, token1: Symbol, liquidity: number, volume: number): Pool {
  const reserve = (symbol: Symbol) =>
    parseAmount(
      (liquidity / 2 / TOKENS[symbol].price).toFixed(TOKENS[symbol].decimals),
      TOKENS[symbol].decimals,
    )!;
  return {
    id,
    token0,
    token1,
    liquidity,
    volume,
    fees: volume * 0.003,
    reserve0: reserve(token0),
    reserve1: reserve(token1),
  };
}

export const POOLS: Pool[] = [
  pool('blch-usdc', 'BLCH', 'USDC', 2_840_000, 428_560),
  pool('weth-usdc', 'WETH', 'USDC', 3_100_000, 512_300),
  pool('ustav-usdc', 'USTAV', 'USDC', 1_420_000, 184_600),
  pool('blch-ustav', 'BLCH', 'USTAV', 1_060_000, 134_540),
];

export const DEMO_POSITION = {
  pool: POOLS[0],
  value: 12_480,
  token0: parseAmount('33876.221498371335', 18)!,
  token1: 6_240_000_000n,
};
export const usd = (value: number, digits = 2) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
export const compactUsd = (value: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(value);
export const number = (value: number, digits = 2) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value);

/** Deterministic illustrative history, independent of the wall clock and all wallet state. */
export function marketSeries(price: number, period: Period): number[] {
  const change = { '1H': 0.0041, '24H': 0.0342, '1W': -0.0217, '1M': 0.0824 }[period];
  const start = price / (1 + change);
  return Array.from({ length: 81 }, (_, i) => {
    const t = i / 80;
    return (
      start +
      (price - start) * t +
      Math.sin(t * Math.PI) * price * (Math.sin(i * 0.46) * 0.003 + Math.sin(i * 0.17) * 0.012)
    );
  });
}

export const POSITION_HISTORY = Array.from({ length: 61 }, (_, i) => {
  const t = i / 60;
  return (
    11_600 + 880 * t + Math.sin(Math.PI * t) * (Math.sin(t * 10) * 780 + Math.sin(t * 48) * 95)
  );
});

export const PERIOD_LABELS: Record<Period, string[]> = {
  '1H': ['09:00', '09:15', '09:30', '09:45', '10:00'],
  '24H': ['00:00', '06:00', '12:00', '18:00', '24:00'],
  '1W': ['Sep 02', 'Sep 03', 'Sep 05', 'Sep 07', 'Sep 08'],
  '1M': ['Aug 09', 'Aug 16', 'Aug 23', 'Aug 30', 'Sep 08'],
};
