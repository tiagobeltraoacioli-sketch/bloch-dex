// Round 20 (agent 411): what a deposit or a removal will do, against figures computed independently (Python
// integers, `math.isqrt`) from the contracts' formulas: BDexLibrary.quote, BDexRouter._addLiquidity, and
// UniswapV2Pair mint / burn / _mintFee / _update / _applyCeiling. The same functions are compared with the chain,
// number by number, in the fork rehearsal of the report.
import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import type { DevnetDeployment } from '../devnet4/record';
import { approvalPlan } from '../mainnet/approval';
import { APPROVE_GAS } from '../devnet4/swap';
import {
  belowMinimum,
  evaluateAdd,
  evaluateRemove,
  feeLiquidity,
  isOpen,
  liquidityRevertText,
  positionOf,
  quoteAdd,
  quoteOther,
  quoteRemove,
  refusalText,
  sharePercentText,
  sharesForPercent,
  sqrt,
  supplyAfterFee,
  UINT112_MAX,
  type PoolShares,
  type PoolState,
} from '../mainnet/liquidity';

// A pool opened with 30,000 USDC (6 decimals, side 0) and 10 of the wrapped native token (side 1), after swaps
// that grew k: the protocol fee is pending. The router's "A" is USDC (the native entry point names the token first).
const POOL: PoolState = {
  aSide: 0,
  reserve0: 30_300_000_000n,
  reserve1: 9_930_000_000_000_000_000n,
  cap0: 0n,
  cap1: 0n,
  excess0: 0n,
  excess1: 0n,
};
const SHARES: PoolShares = {
  totalSupply: 547_722_557_505_166n,
  kLast: 30_000_000_000n * 10n * 10n ** 18n,
  feeOn: true,
};
const ONE = 10n ** 18n;

describe('the pair and router arithmetic', () => {
  it('sqrt is the floor square root of libraries/Math.sol', () => {
    expect([0n, 1n, 2n, 3n, 4n, 8n, 9n, 15n, 16n].map(sqrt)).toEqual([
      0n,
      1n,
      1n,
      1n,
      2n,
      2n,
      3n,
      3n,
      4n,
    ]);
    expect(sqrt(2n ** 200n + 12345n)).toBe(1267650600228229401496703205376n);
    expect(sqrt(SHARES.kLast)).toBe(547_722_557_505_166n);
  });

  it('quote rounds down at the pool ratio', () => {
    expect(quoteOther(ONE, POOL.reserve1, POOL.reserve0)).toBe(3_051_359_516n);
    expect(quoteOther(3_051_359_516n, POOL.reserve0, POOL.reserve1)).toBe(999_999_999_798_019_801n);
    expect(quoteOther(1n, POOL.reserve1, POOL.reserve0)).toBe(0n);
  });

  it('the pending protocol fee dilutes the supply a deposit is measured against', () => {
    expect(feeLiquidity(POOL, SHARES)).toBe(133_474_941_583n);
    expect(supplyAfterFee(POOL, SHARES)).toBe(547_856_032_446_749n);
    // No fee recipient, no baseline, or no growth: nothing is minted.
    expect(feeLiquidity(POOL, { ...SHARES, feeOn: false })).toBe(0n);
    expect(feeLiquidity(POOL, { ...SHARES, kLast: 0n })).toBe(0n);
    expect(feeLiquidity({ ...POOL, reserve0: 29_000_000_000n }, SHARES)).toBe(0n);
  });
});

describe('a deposit', () => {
  it('computes the other side from the pool ratio, minimums from the tolerance, and the shares after the fee', () => {
    const q = quoteAdd(POOL, SHARES, { side: 1, amount: ONE }, 50);
    expect(q).toMatchObject({
      desired0: 3_051_359_516n,
      desired1: ONE,
      min0: 3_036_102_718n,
      min1: 995_000_000_000_000_000n,
    });
    // The router keeps the token's desired amount and takes the native amount the ratio asks for it: a little
    // less than was typed; the rest of the value sent is returned in the same transaction.
    expect(q.outcome).toEqual({
      ok: true,
      amount0: 3_051_359_516n,
      amount1: 999_999_999_798_019_801n,
      liquidity: 55_171_805_874_732n,
      supplyAfter: 603_027_838_321_481n,
    });
    // An estimate that ignored the pending fee would promise fewer shares than the pair mints.
    const naive = evaluateAdd(
      POOL,
      { ...SHARES, feeOn: false },
      q.desired0,
      q.desired1,
      q.min0,
      q.min1,
    );
    expect(naive.ok && naive.liquidity).toBe(55_158_364_289_480n);
  });

  it('follows the router order: the side it calls "A" keeps its desired amount when both could', () => {
    // The wrapped token as side 0 makes side 1 the router's "A".
    const flipped: PoolState = {
      ...POOL,
      aSide: 1,
      reserve0: POOL.reserve1,
      reserve1: POOL.reserve0,
    };
    const q = quoteAdd(flipped, SHARES, { side: 0, amount: ONE }, 50);
    expect(q.outcome).toMatchObject({
      ok: true,
      amount0: 999_999_999_798_019_801n,
      amount1: 3_051_359_516n,
      liquidity: 55_171_805_874_732n,
    });
    // With side 0 as "A" (a pair of two plain tokens) the typed amount is kept whole instead.
    const plain = quoteAdd({ ...flipped, aSide: 0 }, SHARES, { side: 0, amount: ONE }, 50);
    expect(plain.outcome).toMatchObject({ ok: true, amount0: ONE, amount1: 3_051_359_516n });
  });

  it('typing the token side gives the native amount of the ratio', () => {
    const q = quoteAdd(POOL, SHARES, { side: 0, amount: 3_000_000_000n }, 50);
    expect(q.desired1).toBe(983_168_316_831_683_168n);
    expect(q.outcome).toMatchObject({
      ok: true,
      amount0: 3_000_000_000n,
      amount1: 983_168_316_831_683_168n,
    });
  });

  it('counts tokens already at the pair above its reserves: a gift joins the next deposit', () => {
    const q = quoteAdd(POOL, SHARES, { side: 1, amount: ONE }, 50);
    // A gift on one side changes nothing for the depositor (the smaller ratio decides)...
    const one = evaluateAdd(
      { ...POOL, excess0: 5_000_000n },
      SHARES,
      q.desired0,
      q.desired1,
      q.min0,
      q.min1,
    );
    expect(one.ok && one.liquidity).toBe(55_171_805_874_732n);
    // ...a gift on both sides is counted in the depositor's shares.
    const both = evaluateAdd(
      { ...POOL, excess0: 5_000_000n, excess1: 10n ** 16n },
      SHARES,
      q.desired0,
      q.desired1,
      q.min0,
      q.min1,
    );
    expect(both.ok && both.liquidity).toBe(55_262_211_160_614n);
  });

  it('is never quoted for a pool without shares: no first deposit is built for anyone', () => {
    const empty: PoolShares = { totalSupply: 0n, kLast: 0n, feeOn: true };
    expect(isOpen(POOL, empty)).toBe(false);
    expect(quoteAdd(POOL, empty, { side: 1, amount: ONE }, 50).outcome).toEqual({
      ok: false,
      refusal: { code: 'NOT_OPEN' },
    });
    expect(evaluateAdd(POOL, empty, 1n, 1n, 1n, 1n)).toEqual({
      ok: false,
      refusal: { code: 'NOT_OPEN' },
    });
    // A pair that exists with donated balances but no reserves is not open either.
    expect(
      quoteAdd(
        { ...POOL, reserve0: 0n, reserve1: 0n, excess0: 5n },
        SHARES,
        { side: 0, amount: 5n },
        50,
      ).outcome,
    ).toEqual({ ok: false, refusal: { code: 'NOT_OPEN' } });
    expect(refusalText({ code: 'NOT_OPEN' }, ['USDC', 'ETH'], 'add')).toBe(
      'This pool is not open. Only the first depositor fixed in the factory can open a pool, so this page builds no first deposit for anyone.',
    );
  });

  it('refuses amounts too small to mean anything', () => {
    expect(quoteAdd(POOL, SHARES, { side: 1, amount: 0n }, 50).outcome).toEqual({
      ok: false,
      refusal: { code: 'INSUFFICIENT_AMOUNT' },
    });
    // 1 wei of the native side asks zero USDC: BDEX: INSUFFICIENT_AMOUNT in the router.
    expect(quoteAdd(POOL, SHARES, { side: 1, amount: 1n }, 50).outcome).toEqual({
      ok: false,
      refusal: { code: 'INSUFFICIENT_AMOUNT' },
    });
    // 100 base units of USDC: its minimum at 0.5% is 99, but the other side... both non-zero; one base unit is not.
    expect(quoteAdd(POOL, SHARES, { side: 0, amount: 1n }, 50).outcome).toEqual({
      ok: false,
      refusal: { code: 'MINIMUM_ZERO', side: 0 },
    });
    // A deposit that would mint no share (a huge supply against tiny amounts is not reachable here; shown on a
    // pool with a small supply).
    const thin: PoolShares = { totalSupply: 1_000n, kLast: 0n, feeOn: false };
    expect(evaluateAdd(POOL, thin, 1_000n, 327_722_772_277n, 1n, 1n)).toEqual({
      ok: false,
      refusal: { code: 'INSUFFICIENT_LIQUIDITY_MINTED' },
    });
  });

  it('reverts on a minimum when the ratio has moved beyond the tolerance, on the side the router names', () => {
    const q = quoteAdd(POOL, SHARES, { side: 1, amount: ONE }, 50);
    // The native coin became 1% dearer in the pool: the same USDC asks less native than its minimum.
    const dearer = { ...POOL, reserve0: 30_603_000_000n };
    expect(evaluateAdd(dearer, SHARES, q.desired0, q.desired1, q.min0, q.min1)).toEqual({
      ok: false,
      refusal: { code: 'INSUFFICIENT_B_AMOUNT', side: 1 },
    });
    // 1% cheaper: the native amount asks less USDC than its minimum.
    const cheaper = { ...POOL, reserve0: 29_997_000_000n };
    expect(evaluateAdd(cheaper, SHARES, q.desired0, q.desired1, q.min0, q.min1)).toEqual({
      ok: false,
      refusal: { code: 'INSUFFICIENT_A_AMOUNT', side: 0 },
    });
    // Within the tolerance it goes through at the pool's new ratio.
    const near = { ...POOL, reserve0: 30_390_900_000n };
    expect(evaluateAdd(near, SHARES, q.desired0, q.desired1, q.min0, q.min1)).toMatchObject({
      ok: true,
      amount0: 3_051_359_516n,
    });
    expect(refusalText({ code: 'INSUFFICIENT_B_AMOUNT', side: 1 }, ['USDC', 'ETH'], 'add')).toBe(
      "The pool's ratio has moved by more than your tolerance: the ETH side would be below its minimum and the deposit would revert (BDEX: INSUFFICIENT_B_AMOUNT).",
    );
  });

  it('predicts the reserve cap, the k ceiling and the uint112 bound of _update', () => {
    const q = quoteAdd(POOL, SHARES, { side: 1, amount: ONE }, 50);
    const args = [q.desired0, q.desired1, q.min0, q.min1] as const;
    // A cap on side 0 below the balance after the deposit.
    expect(evaluateAdd({ ...POOL, cap0: 33_000_000_000n }, SHARES, ...args)).toEqual({
      ok: false,
      refusal: { code: 'RESERVE_CAP', side: 0 },
    });
    expect(evaluateAdd({ ...POOL, cap1: 10n * ONE }, SHARES, ...args)).toEqual({
      ok: false,
      refusal: { code: 'RESERVE_CAP', side: 1 },
    });
    // Exactly at the cap is allowed (the pair requires balance <= cap).
    expect(evaluateAdd({ ...POOL, cap0: 33_351_359_516n }, SHARES, ...args).ok).toBe(true);
    // A gift already at the pair counts toward the cap.
    expect(evaluateAdd({ ...POOL, cap0: 33_351_359_516n, excess0: 1n }, SHARES, ...args)).toEqual({
      ok: false,
      refusal: { code: 'RESERVE_CAP', side: 0 },
    });
    // Both sides capped: the product may not pass 64% of cap0 x cap1 (or the current k, if larger).
    const capped = { ...POOL, cap0: 40_000_000_000n, cap1: 13n * ONE };
    // 33.351 x 10.93 = 364.5 > 0.64 x 520 = 332.8
    expect(evaluateAdd(capped, SHARES, ...args)).toEqual({
      ok: false,
      refusal: { code: 'K_CEILING' },
    });
    expect(evaluateAdd({ ...capped, cap0: 45_000_000_000n }, SHARES, ...args).ok).toBe(true);
    // uint112.
    const full = { ...POOL, reserve0: UINT112_MAX - 10n, reserve1: UINT112_MAX - 200n };
    const plain: PoolShares = { totalSupply: UINT112_MAX, kLast: 0n, feeOn: false };
    expect(evaluateAdd(full, plain, 100n, 100n, 99n, 99n)).toEqual({
      ok: false,
      refusal: { code: 'OVERFLOW', side: 0 },
    });
    expect(
      evaluateAdd({ ...full, reserve0: UINT112_MAX - 200n }, plain, 100n, 100n, 99n, 99n).ok,
    ).toBe(true);
    expect(refusalText({ code: 'K_CEILING' }, ['USDC', 'ETH'], 'add')).toContain('BDEX: K_CEILING');
    expect(refusalText({ code: 'RESERVE_CAP', side: 0 }, ['USDC', 'ETH'], 'add')).toContain(
      'the USDC reserve above its fixed cap',
    );
  });
});

describe('a removal and a position', () => {
  const HELD = 55_171_805_874_732n;
  const AFTER: PoolShares = { ...SHARES };

  it('pays pro rata of the pair balances after the pending fee, with minimums from the tolerance', () => {
    const quarter = sharesForPercent(HELD, 25);
    expect(quarter).toBe(13_792_951_468_683n);
    const q = quoteRemove(POOL, AFTER, quarter, HELD, 50);
    expect(q.outcome).toEqual({
      ok: true,
      amount0: 762_839_878n,
      amount1: 249_999_999_949_503_047n,
      supplyAfter: 547_856_032_446_749n - quarter,
    });
    expect(q.min0).toBe((762_839_878n * 9950n) / 10_000n);
    expect(q.min1).toBe((249_999_999_949_503_047n * 9950n) / 10_000n);
    // Tokens someone sent to the pair are paid out pro rata too (burn reads balances, not reserves).
    const gifted = evaluateRemove({ ...POOL, excess0: 5_000_000n }, AFTER, quarter);
    expect(gifted.ok && gifted.amount0).toBe(762_965_760n);
  });

  it('removes every share at 100 percent and never more than the account holds', () => {
    expect(sharesForPercent(HELD, 100)).toBe(HELD);
    expect(sharesForPercent(HELD, 0)).toBe(0n);
    expect(quoteRemove(POOL, AFTER, HELD + 1n, HELD, 50).outcome).toEqual({
      ok: false,
      refusal: { code: 'EXCEEDS_SHARES' },
    });
    expect(quoteRemove(POOL, AFTER, 0n, HELD, 50).outcome).toEqual({
      ok: false,
      refusal: { code: 'INSUFFICIENT_LIQUIDITY_BURNED' },
    });
    // One share of this pool pays zero USDC: the pair would revert.
    expect(quoteRemove(POOL, AFTER, 1n, HELD, 50).outcome).toEqual({
      ok: false,
      refusal: { code: 'INSUFFICIENT_LIQUIDITY_BURNED' },
    });
    expect(
      quoteRemove(POOL, { totalSupply: 0n, kLast: 0n, feeOn: true }, 1n, 1n, 50).outcome,
    ).toEqual({
      ok: false,
      refusal: { code: 'NOT_OPEN' },
    });
  });

  it('names the minimum the router checks first', () => {
    const paid = { amount0: 100n, amount1: 100n };
    expect(belowMinimum(POOL, paid, 100n, 100n)).toBeNull();
    expect(belowMinimum(POOL, paid, 101n, 101n)).toEqual({
      code: 'INSUFFICIENT_A_AMOUNT',
      side: 0,
    });
    expect(belowMinimum({ ...POOL, aSide: 1 }, paid, 101n, 101n)).toEqual({
      code: 'INSUFFICIENT_A_AMOUNT',
      side: 1,
    });
    expect(belowMinimum(POOL, paid, 100n, 101n)).toEqual({
      code: 'INSUFFICIENT_B_AMOUNT',
      side: 1,
    });
  });

  it('states a position as shares, share of the pool and the two amounts a full removal would pay', () => {
    const p = positionOf(POOL, AFTER, sharesForPercent(HELD, 25));
    expect(p).toEqual({
      shares: 13_792_951_468_683n,
      sharePpm: (13_792_951_468_683n * 1_000_000n) / 547_856_032_446_749n,
      amount0: 762_839_878n,
      amount1: 249_999_999_949_503_047n,
    });
    expect(sharePercentText(p.sharePpm)).toBe('2.5176%');
    expect(sharePercentText(0n, true)).toBe('<0.0001%');
    expect(sharePercentText(0n, false)).toBe('0%');
    expect(sharePercentText(1_000_000n)).toBe('100.0000%');
    expect(positionOf(POOL, AFTER, 0n)).toEqual({
      shares: 0n,
      sharePpm: 0n,
      amount0: 0n,
      amount1: 0n,
    });
  });

  it('says in words why a reverted deposit or removal reverted, and that only the gas was spent', () => {
    const names = ['USDC', 'ETH'] as const;
    expect(liquidityRevertText({ cause: 'expired' }, names, 'add')).toBe(
      'It reverted because its deadline had passed when its block was made (BDEX: EXPIRED). Only the gas was spent; your tokens and pool shares did not move. Start the deposit again for a new deadline.',
    );
    expect(
      liquidityRevertText(
        { cause: 'refused', refusal: { code: 'INSUFFICIENT_A_AMOUNT', side: 0 } },
        names,
        'add',
      ),
    ).toBe(
      "The pool's ratio has moved by more than your tolerance: the USDC side was below its minimum and the deposit reverted (BDEX: INSUFFICIENT_A_AMOUNT). Only the gas was spent; your tokens and pool shares did not move.",
    );
    expect(
      liquidityRevertText(
        { cause: 'refused', refusal: { code: 'INSUFFICIENT_B_AMOUNT', side: 1 } },
        names,
        'remove',
      ),
    ).toMatch(/^It reverted on its minimum of ETH \(BDEX: INSUFFICIENT_B_AMOUNT\)/);
    expect(liquidityRevertText({ cause: 'transfer', side: 0 }, names, 'add')).toMatch(
      /pulled USDC from this account \(BDEX: TRANSFER_FROM_FAILED.*paused or blocked the transfer/,
    );
    expect(liquidityRevertText({ cause: 'unknown' }, names, 'remove')).toMatch(
      /could not tell why from the chain\. Only the gas was spent/,
    );
  });
});

describe('the approve sequence of a token is decided in one place', () => {
  const d = { router: `0x${'6'.repeat(40)}` } as unknown as DevnetDeployment;
  const owner = `0x${'1'.repeat(40)}` as Address;
  const token = { address: `0x${'2'.repeat(40)}` as Address, label: 'USDC', decimals: 6 };

  it('asks for nothing when the allowance covers the amount, and for exactly the amount when it does not', () => {
    expect(approvalPlan(d, token, owner, 500n, 500n)).toEqual([]);
    expect(approvalPlan(d, token, owner, 0n, 0n)).toEqual([]);
    const [step, ...rest] = approvalPlan(d, token, owner, 499n, 500n);
    expect(rest).toEqual([]);
    expect(step).toMatchObject({ kind: 'approve', amount: 500n });
    const tx = step.build();
    expect(tx).toMatchObject({ from: owner, to: token.address, value: 0n, gas: APPROVE_GAS });
    // approve(router, 500): never an unlimited allowance.
    expect(tx.data).toBe(
      `0x095ea7b3${'6'.repeat(40).padStart(64, '0')}${500n.toString(16).padStart(64, '0')}`,
    );
  });

  it('puts a reset to zero first for a token whose approve refuses a change of a non-zero allowance', () => {
    const tether = { ...token, label: 'USDT', zeroFirst: true };
    expect(approvalPlan(d, tether, owner, 0n, 500n).map((s) => s.kind)).toEqual(['approve']);
    const plan = approvalPlan(d, tether, owner, 7n, 500n);
    expect(plan.map((s) => [s.kind, s.amount])).toEqual([
      ['reset', 0n],
      ['approve', 500n],
    ]);
    expect(plan[0].build().data).toBe(
      `0x095ea7b3${'6'.repeat(40).padStart(64, '0')}${'0'.repeat(64)}`,
    );
  });
});
