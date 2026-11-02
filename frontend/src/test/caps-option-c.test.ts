import { describe, expect, it } from 'vitest';
import { atKCeiling, closedByExcess, explainBlock } from '../mainnet/caps';
import type { LivePool } from '../devnet4/chain';

const caps = { cap0: 1_000_000_000n, cap1: 10n ** 19n };

describe('option C in the pool view', () => {
  it('reports the k ceiling at exactly 64% of cap0 * cap1, and not below it', () => {
    expect(atKCeiling({ ...caps, reserve0: 800_000_000n, reserve1: 8n * 10n ** 18n })).toBe(true);
    expect(atKCeiling({ ...caps, reserve0: 799_000_000n, reserve1: 8n * 10n ** 18n })).toBe(false);
  });
  it('still reports it when a swap rounded the recorded reserve down', () => {
    const reserve1 = 7_500_000_000_000_000_123n;
    const ceiling = (caps.cap0 * caps.cap1 * 6_400n) / 10_000n;
    expect(atKCeiling({ ...caps, reserve0: ceiling / reserve1, reserve1 })).toBe(true);
  });
  it('has no ceiling on a pool with an uncapped side', () => {
    expect(atKCeiling({ cap0: 0n, cap1: 10n, reserve0: 10n ** 30n, reserve1: 10n })).toBe(false);
    expect(atKCeiling({ cap0: 10n, cap1: 0n, reserve0: 10n, reserve1: 10n ** 30n })).toBe(false);
  });
  it('names the first depositor on an empty pool', () => {
    const pool = { token0: { symbol: 'A' }, token1: { symbol: 'B' } } as unknown as LivePool;
    expect(explainBlock({ kind: 'no-liquidity', pool })).toMatch(/first depositor/);
  });
  describe('closedByExcess', () => {
    const W = 10n ** 19n;
    const Q = 10n ** 9n;
    const pool = (r0: bigint, x0: bigint, r1: bigint, x1: bigint) =>
      ({
        cap0: Q,
        cap1: W,
        reserve0: r0,
        reserve1: r1,
        excess: { excess0: x0, excess1: x1, blocksInflow0: false, blocksInflow1: false },
      }) as unknown as LivePool;
    it('is true for the real closure with one side above its cap, which the lens flags as one side', () => {
      const reserve1 = 8_618_052_029_873_667_082n;
      expect(closedByExcess(pool(742_000_000n, 200_000_000n, reserve1, 2n * 10n ** 18n))).toBe(true);
    });
    it('is true with both balances exactly at the caps, which the lens does not flag', () => {
      expect(closedByExcess(pool(800_000_000n, 200_000_000n, 8n * 10n ** 18n, 2n * 10n ** 18n))).toBe(
        true,
      );
    });
    it('is false with no excess, or with room for a small swap one way', () => {
      expect(closedByExcess(pool(Q, 0n, (W * 64n) / 100n, 0n))).toBe(false);
      expect(closedByExcess(pool(Q / 2n, 5n, W / 2n, 0n))).toBe(false);
      expect(closedByExcess(pool(Q / 2n, Q / 2n + 1n, W / 2n, 0n))).toBe(false);
    });
  });
});
