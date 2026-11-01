import { describe, expect, it } from 'vitest';
import { atKCeiling, explainBlock } from '../mainnet/caps';
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
});
