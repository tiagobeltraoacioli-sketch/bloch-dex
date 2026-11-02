// DEX-5 (round 10): default 0.5%, maximum 3%, one retry at 1% after a revert on
// the minimum received. One source of truth for the limits: src/slippage.ts.
import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import {
  DEFAULT_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
  RETRY_SLIPPAGE_BPS,
  SLIPPAGE_RANGE_TEXT,
  isAllowedSlippageBps,
} from '../slippage';
import * as config from '../mainnet/config';
import { quoteRoute } from '../amm';
import { explainSwapRevert, retryOffer, revertText, type SwapRetryInfo } from '../mainnet/retry';
import { parsePendingSwap } from '../mainnet/pendingswap';
import type { Pool } from '../model';

const info = (change: Partial<SwapRetryInfo> = {}): SwapRetryInfo => ({
  tokenIn: '0x1b7c0fb59f34683cd9214566636e63a0f7e092f6',
  tokenOut: '0x7f889d9cb335bbdb197b75c74a6409ac2bbbe6e6',
  amountIn: 1_000_000n,
  path: [
    '0x1b7c0fb59f34683cd9214566636e63a0f7e092f6',
    '0x7f889d9cb335bbdb197b75c74a6409ac2bbbe6e6',
  ],
  minimumOut: 995n,
  slippageBps: 50,
  attempt: 1,
  ...change,
});

describe('slippage limits', () => {
  it('defaults to 0.50% and stops at 3.00%', () => {
    expect(DEFAULT_SLIPPAGE_BPS).toBe(50);
    expect(MAX_SLIPPAGE_BPS).toBe(300);
    expect(RETRY_SLIPPAGE_BPS).toBe(100);
    expect(RETRY_SLIPPAGE_BPS).toBeLessThanOrEqual(MAX_SLIPPAGE_BPS);
    expect(SLIPPAGE_RANGE_TEXT).toBe('0.01% to 3.00%');
    expect(config.DEFAULT_SLIPPAGE_BPS).toBe(DEFAULT_SLIPPAGE_BPS);
    expect(config.MAX_SLIPPAGE_BPS).toBe(MAX_SLIPPAGE_BPS);
  });

  it('accepts 1 to 300 bps only, as numbers or bigints', () => {
    for (const ok of [1, 50, 100, 300]) expect(isAllowedSlippageBps(ok)).toBe(true);
    for (const bad of [0, -1, 301, 500, 1.5, Number.NaN])
      expect(isAllowedSlippageBps(bad)).toBe(false);
    expect(isAllowedSlippageBps(300n)).toBe(true);
    expect(isAllowedSlippageBps(301n)).toBe(false);
  });

  it('the sample route quote refuses more than 3%', () => {
    const pools: Pool[] = [
      {
        id: 'p',
        token0: 'BLCH',
        token1: 'USDC',
        reserve0: 10n ** 21n,
        reserve1: 10n ** 11n,
      } as unknown as Pool,
    ];
    expect(quoteRoute(10n ** 18n, ['BLCH', 'USDC'] as never, pools, 300)).not.toBeNull();
    expect(quoteRoute(10n ** 18n, ['BLCH', 'USDC'] as never, pools, 301)).toBeNull();
    expect(quoteRoute(10n ** 18n, ['BLCH', 'USDC'] as never, pools, 500)).toBeNull();
  });

  it('no source file outside src/slippage.ts hard-codes a slippage limit', () => {
    const sources = import.meta.glob(
      ['../**/*.ts', '../**/*.tsx', '!../test/**', '!../slippage.ts'],
      {
        query: '?raw',
        import: 'default',
        eager: true,
      },
    ) as Record<string, string>;
    expect(Object.keys(sources).length).toBeGreaterThan(20);
    const offenders = Object.entries(sources)
      .filter(([, text]) => /slippage[A-Za-z]*\s*(<=|>|<|>=)\s*(500|300)n?\b/i.test(text))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
    expect(Object.values(sources).join('\n')).not.toMatch(/0\.01% to 5\.00%/);
  });
});

describe('the one retry', () => {
  it('is offered at 1% only after a revert on the minimum of a first attempt below 1%', () => {
    expect(retryOffer(info(), 'minimum')).toEqual({ kind: 'retry', slippageBps: 100 });
    expect(retryOffer(info({ slippageBps: 10 }), 'minimum')).toEqual({
      kind: 'retry',
      slippageBps: 100,
    });
    expect(retryOffer(info(), 'expired')).toBeNull();
    expect(retryOffer(info(), 'unknown')).toBeNull();
    expect(retryOffer(info({ attempt: 2, slippageBps: 100 }), 'minimum')).toEqual({
      kind: 'none',
      reason: 'already-retried',
    });
    expect(retryOffer(info({ slippageBps: 100 }), 'minimum')).toEqual({
      kind: 'none',
      reason: 'tolerance-not-below-retry',
    });
    expect(retryOffer(info({ slippageBps: 300 }), 'minimum')).toEqual({
      kind: 'none',
      reason: 'tolerance-not-below-retry',
    });
  });

  it('never offers more than the 3% maximum', () => {
    for (let bps = 1; bps <= MAX_SLIPPAGE_BPS; bps++) {
      const offer = retryOffer(info({ slippageBps: bps }), 'minimum');
      if (offer?.kind === 'retry') expect(offer.slippageBps).toBeLessThanOrEqual(MAX_SLIPPAGE_BPS);
    }
  });

  it('explains each cause in plain words', () => {
    expect(revertText(info(), 'minimum')).toMatch(/retry once at 1\.00%/);
    expect(revertText(info(), 'expired')).toMatch(/BDEX: EXPIRED/);
    expect(revertText(info(), 'unknown')).toMatch(/could not tell why/);
  });
});

describe('explainSwapRevert', () => {
  const ROUTER = '0xb3a451af23df72f72916064c6d33d1fbe25e7106' as Address;
  it('never throws: a failed block read is unknown', async () => {
    const rpc = async () => {
      throw new Error('down');
    };
    expect(await explainSwapRevert(rpc, ROUTER, info(), 442n, 10n)).toBe('unknown');
  });
  it('is expired when the block is past the deadline, before any call', async () => {
    const calls: string[] = [];
    const rpc = async (m: string) => {
      calls.push(m);
      return { hash: `0x${'b'.repeat(64)}`, parentHash: `0x${'c'.repeat(64)}`, timestamp: '0x64' };
    };
    expect(await explainSwapRevert(rpc, ROUTER, info(), 442n, 99n)).toBe('expired');
    expect(calls).toEqual(['eth_getBlockByNumber']);
  });
  it('is unknown when the router cannot quote', async () => {
    const rpc = async (m: string) => {
      if (m === 'eth_call') throw new Error('execution reverted');
      return { hash: `0x${'b'.repeat(64)}`, parentHash: `0x${'c'.repeat(64)}`, timestamp: '0x1' };
    };
    expect(await explainSwapRevert(rpc, ROUTER, info(), 442n, 99n)).toBe('unknown');
  });
});

describe('stored pending swap', () => {
  const base = {
    hash: `0x${'a'.repeat(64)}`,
    label: 'Swap 1 bUSDC for BLCH',
    deadline: '1792203600',
    sentAtMs: 1,
  };
  it('reads records without retry fields (older pages) and with them', () => {
    expect(parsePendingSwap(JSON.stringify(base))?.retry).toBeUndefined();
    const retry = { ...info(), amountIn: '1000000', minimumOut: '995' };
    expect(parsePendingSwap(JSON.stringify({ ...base, retry }))?.retry).toEqual(info());
  });
  it('drops malformed retry fields but keeps the hold', () => {
    const bad = { ...info(), amountIn: '-1', minimumOut: '995' };
    const parsed = parsePendingSwap(JSON.stringify({ ...base, retry: bad }));
    expect(parsed?.hash).toBe(base.hash);
    expect(parsed?.retry).toBeUndefined();
    const third = { ...info(), amountIn: '1', minimumOut: '1', attempt: 3 };
    expect(parsePendingSwap(JSON.stringify({ ...base, retry: third }))?.retry).toBeUndefined();
  });
});
