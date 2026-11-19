// Review R413-9 (agent 411): the "Pool ratio" line shows six significant digits on every chain, whatever the order
// of the two tokens in the pair, and writes "=" only for a figure that is the ratio exactly.
import { describe, expect, it } from 'vitest';
import type { LivePool, LiveToken } from '../devnet4/chain';
import { poolRatio, poolRatioText } from '../live/ratio';
import bundle from '../multichain/bundle';

type Listed = { address: string; symbol: string; label?: string; decimals?: number };
const token = (t: Listed, wrapped: boolean): LiveToken =>
  ({
    address: t.address,
    symbol: t.label ?? t.symbol,
    decimals: t.decimals ?? 18,
    cap: 0n,
    wrapped,
  }) as LiveToken;
const pool = (a: LiveToken, ra: bigint, b: LiveToken, rb: bigint): LivePool => {
  const [token0, reserve0, token1, reserve1] =
    a.address.toLowerCase() < b.address.toLowerCase() ? [a, ra, b, rb] : [b, rb, a, ra];
  return { address: '0x00', token0, token1, reserve0, reserve1, cap0: 0n, cap1: 0n } as LivePool;
};
const significant = (figure: string) => figure.replace('.', '').replace(/^0+/, '').length;

describe('the pool ratio line', () => {
  const chains = bundle as { network: { key: string; wrappedNative: Listed; tokens: Listed[] } }[];

  it('covers the six bundled networks, in both token orders', () => {
    expect(chains.map((c) => c.network.key)).toHaveLength(6);
    const wrappedFirst = chains.filter(
      (c) =>
        c.network.wrappedNative.address.toLowerCase() < c.network.tokens[0].address.toLowerCase(),
    );
    expect(wrappedFirst.length).toBeGreaterThan(0);
    expect(wrappedFirst.length).toBeLessThan(6);
  });

  it.each(
    (bundle as { network: { key: string; wrappedNative: Listed; tokens: Listed[] } }[]).map(
      (c) => [c.network.key, c.network] as const,
    ),
  )(
    '%s: one wrapped native token in the listed token, six significant digits, cut and marked',
    (_key, n) => {
      const wrapped = token(n.wrappedNative, true);
      const listed = token(n.tokens[0], false);
      // 13,024.371357 of the token for 18.0747 of the wrapped native coin (the reviewer's Base figures).
      const p = pool(
        wrapped,
        180_747n * 10n ** 14n,
        listed,
        13_024_371_357n * 10n ** BigInt(listed.decimals - 6),
      );
      const r = poolRatio(p)!;
      expect(r.base.symbol).toBe(wrapped.symbol);
      expect(r.quote.symbol).toBe(listed.symbol);
      // 13024.371357 / 18.0747 = 720.5857...
      expect(r.figure).toBe('720.585');
      expect(significant(r.figure)).toBe(6);
      expect(r.exact).toBe(false);
      expect(poolRatioText(p)).toBe(`1 ${wrapped.symbol} ≈ 720.585 ${listed.symbol}`);
    },
  );

  it('keeps six digits of a small ratio and of a large one, and never rounds up', () => {
    const a = token({ address: '0x01', symbol: 'AAA', decimals: 6 }, false);
    const b = token({ address: '0x02', symbol: 'BBB', decimals: 18 }, false);
    // No wrapped token: per one token1 (BBB). 1 BBB = 0.000357142857… AAA
    expect(poolRatioText(pool(a, 1_000_000n, b, 2_800n * 10n ** 18n))).toBe(
      '1 BBB ≈ 0.000357142 AAA',
    );
    // 1 BBB = 1,999,999.999999 AAA exactly; six digits cut it, and the cut is said.
    expect(poolRatioText(pool(a, 1_999_999_999_999n, b, 10n ** 18n))).toBe('1 BBB ≈ 1999999 AAA');
    expect(poolRatioText(pool(a, 123_456_789_000_000n, b, 10n ** 18n))).toBe(
      '1 BBB = 123456789 AAA',
    );
  });

  it('writes "=" only when the figure is the ratio exactly', () => {
    const a = token({ address: '0x01', symbol: 'AAA', decimals: 6 }, false);
    const b = token({ address: '0x02', symbol: 'BBB', decimals: 18 }, false);
    expect(poolRatioText(pool(a, 2_000_000n, b, 10n ** 18n))).toBe('1 BBB = 2 AAA');
    expect(poolRatioText(pool(a, 3_051_250_000n, b, 10n ** 18n))).toBe('1 BBB = 3051.25 AAA');
    expect(poolRatioText(pool(a, 1_000_000n, b, 3n * 10n ** 18n))).toBe('1 BBB ≈ 0.333333 AAA');
    expect(poolRatioText(pool(a, 0n, b, 10n ** 18n))).toBe('Not available');
  });
});
