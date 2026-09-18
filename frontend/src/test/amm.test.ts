import { describe, expect, it } from 'vitest';
import { MAX_UINT256, amountOut, findQuotes, formatAmount, parseAmount, quoteRoute } from '../amm';
import { POOLS } from '../data';
import type { Pool } from '../model';

describe('exact token arithmetic', () => {
  it('preserves amounts beyond Number safe integer precision', () => {
    const amount = parseAmount('9007199254740993.123456789012345678', 18)!;
    expect(formatAmount(amount, 18)).toBe('9007199254740993.123456789012345678');
    expect(formatAmount(1234567n, 6, 2)).toBe('1.23');
    expect(parseAmount('0.000001', 6)).toBe(1n);
    expect(parseAmount('1.', 6)).toBe(1_000_000n);
  });
  it.each(['', '-1', '1e8', 'NaN', 'Infinity', '1,000', '1.0000001', '.1', '0x10', '1\n2'])(
    'rejects malformed or overprecision USDC input %s',
    (value) => {
      expect(parseAmount(value, 6)).toBeNull();
    },
  );
  it('bounds decimals, string size and uint256 values', () => {
    expect(parseAmount('1', -1)).toBeNull();
    expect(parseAmount('1', 37)).toBeNull();
    expect(parseAmount('1'.repeat(81), 0)).toBeNull();
    expect(parseAmount(MAX_UINT256.toString(), 0)).toBe(MAX_UINT256);
    expect(parseAmount((MAX_UINT256 + 1n).toString(), 0)).toBeNull();
  });
  it('matches the known 997/1000 V2 quote and maintains the reserve product', () => {
    expect(amountOut(1000n, 10000n, 20000n)).toBe(1813n);
    for (let i = 1n; i <= 256n; i++) {
      const reserveIn = 100000n + i * 157n;
      const reserveOut = 200000n + i * 251n;
      const input = i * i + 31n;
      const output = amountOut(input, reserveIn, reserveOut);
      expect(output).toBeLessThan(reserveOut);
      expect((reserveIn + input) * (reserveOut - output)).toBeGreaterThanOrEqual(
        reserveIn * reserveOut,
      );
      expect(input * 997n * reserveOut - output * (reserveIn * 1000n + input * 997n)).toBeLessThan(
        reserveIn * 1000n + input * 997n,
      );
    }
  });
  it('rejects dust, missing routes, cycles, bad slippage and overflow', () => {
    expect(amountOut(MAX_UINT256, 10000n, 20000n)).toBe(0n);
    expect(amountOut(1n, 0n, 100n)).toBe(0n);
    expect(quoteRoute(1n, ['BLCH', 'USDC'], POOLS, 50)).toBeNull();
    expect(quoteRoute(100n, ['WETH', 'USTAV'], POOLS, 50)).toBeNull();
    expect(quoteRoute(100n, ['BLCH', 'USDC', 'BLCH'], POOLS, 50)).toBeNull();
    expect(quoteRoute(100n, ['BLCH', 'USDC'], POOLS, -1)).toBeNull();
    expect(quoteRoute(100n, ['BLCH', 'USDC'], POOLS, 50.5)).toBeNull();
    expect(quoteRoute(100n, ['BLCH', 'USDC'], POOLS, 501)).toBeNull();
  });
  it('rejects swaps that would exceed the pair reserve capacity', () => {
    const maximum = (1n << 112n) - 1n;
    expect(amountOut(1000n, maximum - 1000n, maximum)).toBeGreaterThan(0n);
    expect(amountOut(1001n, maximum - 1000n, maximum)).toBe(0n);
    expect(amountOut(1000n, 10000n, maximum + 1n)).toBe(0n);
    expect(findQuotes(maximum, 'BLCH', 'USDC', POOLS, 50)).toEqual([]);
  });
  it('compares direct and multi-hop routes with conservative minimum output', () => {
    const quotes = findQuotes(parseAmount('1000', 18)!, 'BLCH', 'USDC', POOLS, 50);
    expect(quotes).toHaveLength(2);
    expect(quotes[0].path).toEqual(['BLCH', 'USDC']);
    expect(quotes[1].path).toEqual(['BLCH', 'USTAV', 'USDC']);
    expect(quotes[0].output).toBeGreaterThan(quotes[1].output);
    for (const quote of quotes) {
      expect(quote.minimum).toBe((quote.output * 9950n) / 10000n);
      expect(quote.minimum).toBeGreaterThan(0n);
      expect(quote.executionLossBps).toBeGreaterThanOrEqual(29);
    }
    expect(findQuotes(100n, 'BLCH', 'BLCH', POOLS, 50)).toEqual([]);
  });
  it('discovers executable routes with up to four hops before selecting the best eight', () => {
    const pool = (
      id: string,
      token0: Pool['token0'],
      token1: Pool['token1'],
      reserve0: bigint,
      reserve1: bigint,
    ): Pool => ({
      id,
      token0,
      token1,
      reserve0,
      reserve1,
      liquidity: 0,
      volume: 0,
      fees: 0,
    });
    const pools = [
      pool('poor-direct', 'BLCH', 'USDC', 1_000_000n, 1_000n),
      pool('first-hop', 'BLCH', 'WETH', 1_000_000n, 1_000_000n),
      pool('second-hop', 'WETH', 'USTAV', 1_000_000n, 1_000_000n),
      pool('third-hop', 'USTAV', 'USDC', 1_000_000n, 1_000_000n),
    ];

    const quotes = findQuotes(10_000n, 'BLCH', 'USDC', pools, 50);
    expect(quotes.map((quote) => quote.path)).toContainEqual([
      'BLCH',
      'WETH',
      'USTAV',
      'USDC',
    ]);
    expect(quotes[0].path).toEqual(['BLCH', 'WETH', 'USTAV', 'USDC']);
    expect(quotes).toHaveLength(2);

    const reversed = findQuotes(10_000n, 'BLCH', 'USDC', [...pools].reverse(), 50);
    expect(reversed).toEqual(quotes);
  });
});
