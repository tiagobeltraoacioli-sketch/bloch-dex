// Liquidity of a live route: what a deposit or a removal will do, computed in integer base units from state read
// at one block, with the pair's and the router's own arithmetic and every refusal they can raise.
//
// Sources (contracts are frozen; nothing here changes what they do):
//   contracts/periphery/BDexRouter.sol   _addLiquidity (the pool's ratio, INSUFFICIENT_A_AMOUNT / B_AMOUNT),
//                                        _removeLiquidity, `ensure` (EXPIRED)
//   contracts/periphery/BDexLibrary.sol  quote (floor division)
//   contracts/UniswapV2Pair.sol          mint, burn, _mintFee, _update (OVERFLOW, RESERVE_CAP), _applyCeiling
//                                        (K_CEILING), MINIMUM_LIQUIDITY, the first-depositor rule
//
// What differs from a plain Uniswap V2 estimate, and is included here:
//   - the protocol fee is settled lazily: mint and burn first mint the fee recipient's shares (`_mintFee`), so
//     the supply a deposit or removal is measured against is the supply AFTER that dilution;
//   - mint counts every token at the pair's address above the reserves, so tokens someone sent there (a gift to
//     the pool, docs/MULTICHAIN-DEPLOY.md sections 8 and 12) join the next deposit's shares calculation, and
//     burn pays pro rata of the pair's BALANCES, not its reserves;
//   - reserve caps and the k ceiling (6400 bps of cap0 x cap1) where the factory fixed caps.
// A pool without shares is never quoted: only the factory's first depositor can open a pool, and this page builds
// no first deposit for anyone.
import { parseAbi, type Address, type Hex } from 'viem';
import { ERC20_ABI, readCall, type BlockTag, type LivePool, type Rpc } from '../devnet4/chain';
import type { DevnetDeployment } from '../devnet4/record';
import { decodeLiquidityCall, type LiquidityCall } from './liquidity-tx';
import { readBalances } from './reads';

export const MINIMUM_LIQUIDITY = 1_000n;
export const K_CEILING_BPS = 6_400n;
export const UINT112_MAX = 2n ** 112n - 1n;
/** The pair's swap fee and the protocol's part of it, as the pair computes them (0.30%; 1/6 of fee growth). */
export const POOL_FEE_TEXT = '0.30%';

export const PAIR_SHARES_ABI = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function kLast() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);
const FACTORY_ABI = parseAbi(['function feeTo() view returns (address)']);
const PAIR_RESERVES_ABI = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 timestamp)',
]);

/** libraries/Math.sol `sqrt` (Babylonian, floor). */
export function sqrt(y: bigint): bigint {
  if (y > 3n) {
    let z = y;
    let x = y / 2n + 1n;
    while (x < z) {
      z = x;
      x = (y / x + x) / 2n;
    }
    return z;
  }
  return y !== 0n ? 1n : 0n;
}

/** The pool as the pair sees it at one block. `excess` is what the pair holds above its reserves. */
export type PoolState = {
  /**
   * The pool side the router calls "A": the token it is given first. In the native entry points that is the
   * token that is NOT the wrapped native one. It decides which side keeps its full desired amount when both
   * could (rounding), and which side a refusal names (INSUFFICIENT_A_AMOUNT / INSUFFICIENT_B_AMOUNT).
   */
  aSide: 0 | 1;
  reserve0: bigint;
  reserve1: bigint;
  cap0: bigint;
  cap1: bigint;
  excess0: bigint;
  excess1: bigint;
};
/** The share token's state at the same block. `feeOn`: the factory has a fee recipient. */
export type PoolShares = { totalSupply: bigint; kLast: bigint; feeOn: boolean };

export const routerASide = (pool: Pick<LivePool, 'token0'>, wrapped: Address): 0 | 1 =>
  pool.token0.address === wrapped ? 1 : 0;

export const poolState = (pool: LivePool, wrapped: Address): PoolState => ({
  aSide: routerASide(pool, wrapped),
  reserve0: pool.reserve0,
  reserve1: pool.reserve1,
  cap0: pool.cap0,
  cap1: pool.cap1,
  excess0: pool.excess?.excess0 ?? 0n,
  excess1: pool.excess?.excess1 ?? 0n,
});

/** Shares `_mintFee` mints to the fee recipient before the next mint or burn. */
export function feeLiquidity(p: PoolState, s: PoolShares): bigint {
  if (!s.feeOn || s.kLast === 0n) return 0n;
  const rootK = sqrt(p.reserve0 * p.reserve1);
  const rootKLast = sqrt(s.kLast);
  if (rootK <= rootKLast) return 0n;
  return (s.totalSupply * (rootK - rootKLast)) / (rootK * 5n + rootKLast);
}

/** The supply a deposit or a removal is measured against: after the pending protocol-fee shares. */
export const supplyAfterFee = (p: PoolState, s: PoolShares): bigint =>
  s.totalSupply + feeLiquidity(p, s);

/** A pool this page may offer: it has shares and both reserves. */
export const isOpen = (p: PoolState, s: PoolShares): boolean =>
  s.totalSupply > 0n && p.reserve0 > 0n && p.reserve1 > 0n;

/** BDexLibrary.quote: the other side's amount at the pool's own ratio, rounded down. */
export const quoteOther = (amount: bigint, reserveThis: bigint, reserveOther: bigint): bigint =>
  (amount * reserveOther) / reserveThis;

/** Every refusal of the deposit and removal paths, by the name the contracts revert with. */
export type RefusalCode =
  | 'NOT_OPEN'
  | 'INSUFFICIENT_AMOUNT'
  | 'INSUFFICIENT_A_AMOUNT'
  | 'INSUFFICIENT_B_AMOUNT'
  | 'INSUFFICIENT_LIQUIDITY_MINTED'
  | 'INSUFFICIENT_LIQUIDITY_BURNED'
  | 'RESERVE_CAP'
  | 'K_CEILING'
  | 'OVERFLOW'
  | 'MINIMUM_ZERO'
  | 'EXCEEDS_SHARES';
/** `side`: the pool side (0 or 1) the refusal is about, where it is about one. */
export type Refusal = { code: RefusalCode; side?: 0 | 1 };

export type AddOutcome =
  | {
      ok: true;
      /** What the router takes (the side the ratio did not need in full is returned or never pulled). */
      amount0: bigint;
      amount1: bigint;
      /** Shares minted to the depositor. */
      liquidity: bigint;
      /** Shares in existence after the deposit (protocol-fee shares included). */
      supplyAfter: bigint;
    }
  | { ok: false; refusal: Refusal };

/**
 * What `addLiquidity` does with these desired amounts and minimums on this state: the router's `_addLiquidity`,
 * then the pair's `mint` and `_update`. Used for the quote (state at the page's pinned block), for the comparison
 * with the latest block before the wallet is asked, and to explain a revert (state around its block).
 */
export function evaluateAdd(
  p: PoolState,
  s: PoolShares,
  desired0: bigint,
  desired1: bigint,
  min0: bigint,
  min1: bigint,
): AddOutcome {
  if (!isOpen(p, s)) return { ok: false, refusal: { code: 'NOT_OPEN' } };
  if (desired0 <= 0n || desired1 <= 0n)
    return { ok: false, refusal: { code: 'INSUFFICIENT_AMOUNT' } };
  // Router._addLiquidity in its own order: A keeps its desired amount when B's optimal amount fits.
  const a = p.aSide;
  const b = a === 0 ? 1 : 0;
  const pick = <T>(side: 0 | 1, v0: T, v1: T): T => (side === 0 ? v0 : v1);
  const [desiredA, desiredB] = [pick(a, desired0, desired1), pick(b, desired0, desired1)];
  const [minA, minB] = [pick(a, min0, min1), pick(b, min0, min1)];
  const [reserveA, reserveB] = [pick(a, p.reserve0, p.reserve1), pick(b, p.reserve0, p.reserve1)];
  const refuseA: AddOutcome = { ok: false, refusal: { code: 'INSUFFICIENT_A_AMOUNT', side: a } };
  const refuseB: AddOutcome = { ok: false, refusal: { code: 'INSUFFICIENT_B_AMOUNT', side: b } };
  let amountA: bigint;
  let amountB: bigint;
  const optimalB = quoteOther(desiredA, reserveA, reserveB);
  if (optimalB <= desiredB) {
    if (optimalB < minB) return refuseB;
    [amountA, amountB] = [desiredA, optimalB];
  } else {
    const optimalA = quoteOther(desiredB, reserveB, reserveA);
    if (optimalA < minA) return refuseA;
    [amountA, amountB] = [optimalA, desiredB];
  }
  if (amountA < minA) return refuseA;
  if (amountB < minB) return refuseB;
  if (amountA <= 0n || amountB <= 0n)
    return { ok: false, refusal: { code: 'INSUFFICIENT_AMOUNT' } };
  const [amount0, amount1] = a === 0 ? [amountA, amountB] : [amountB, amountA];
  // Pair.mint: everything above the reserves counts, the depositor's tokens and anything already there.
  const in0 = amount0 + p.excess0;
  const in1 = amount1 + p.excess1;
  const supply = supplyAfterFee(p, s);
  const share0 = (in0 * supply) / p.reserve0;
  const share1 = (in1 * supply) / p.reserve1;
  const liquidity = share0 < share1 ? share0 : share1;
  if (liquidity <= 0n) return { ok: false, refusal: { code: 'INSUFFICIENT_LIQUIDITY_MINTED' } };
  // Pair._update(strict): the balances become the reserves.
  const balance0 = p.reserve0 + in0;
  const balance1 = p.reserve1 + in1;
  if (balance0 > UINT112_MAX) return { ok: false, refusal: { code: 'OVERFLOW', side: 0 } };
  if (balance1 > UINT112_MAX) return { ok: false, refusal: { code: 'OVERFLOW', side: 1 } };
  if (p.cap0 !== 0n && balance0 > p.cap0 && balance0 > p.reserve0)
    return { ok: false, refusal: { code: 'RESERVE_CAP', side: 0 } };
  if (p.cap1 !== 0n && balance1 > p.cap1 && balance1 > p.reserve1)
    return { ok: false, refusal: { code: 'RESERVE_CAP', side: 1 } };
  if (p.cap0 !== 0n && p.cap1 !== 0n) {
    let ceiling = (p.cap0 * p.cap1 * K_CEILING_BPS) / 10_000n;
    const k = p.reserve0 * p.reserve1;
    if (k > ceiling) ceiling = k;
    if (balance0 * balance1 > ceiling) return { ok: false, refusal: { code: 'K_CEILING' } };
  }
  return { ok: true, amount0, amount1, liquidity, supplyAfter: supply + liquidity };
}

const floorBps = (amount: bigint, slippageBps: number): bigint =>
  (amount * BigInt(10_000 - slippageBps)) / 10_000n;

export type AddQuote = {
  desired0: bigint;
  desired1: bigint;
  min0: bigint;
  min1: bigint;
  outcome: AddOutcome;
};

/**
 * The deposit for one typed amount: the other side from the pool's own ratio, both minimums `slippageBps` below
 * the amounts (as scripts/multichain/first-deposit.mjs `add` sets them), and what the contracts do with it on
 * this state. A minimum that rounds to zero is refused: it would protect nothing.
 */
export function quoteAdd(
  p: PoolState,
  s: PoolShares,
  typed: { side: 0 | 1; amount: bigint },
  slippageBps: number,
): AddQuote {
  const none = (refusal: Refusal): AddQuote => ({
    desired0: 0n,
    desired1: 0n,
    min0: 0n,
    min1: 0n,
    outcome: { ok: false, refusal },
  });
  if (!isOpen(p, s)) return none({ code: 'NOT_OPEN' });
  if (typed.amount <= 0n) return none({ code: 'INSUFFICIENT_AMOUNT' });
  const other =
    typed.side === 0
      ? quoteOther(typed.amount, p.reserve0, p.reserve1)
      : quoteOther(typed.amount, p.reserve1, p.reserve0);
  const [desired0, desired1] = typed.side === 0 ? [typed.amount, other] : [other, typed.amount];
  const min0 = floorBps(desired0, slippageBps);
  const min1 = floorBps(desired1, slippageBps);
  const quote = { desired0, desired1, min0, min1 };
  if (other <= 0n)
    return { ...quote, outcome: { ok: false, refusal: { code: 'INSUFFICIENT_AMOUNT' } } };
  if (min0 <= 0n || min1 <= 0n)
    return {
      ...quote,
      outcome: { ok: false, refusal: { code: 'MINIMUM_ZERO', side: min0 <= 0n ? 0 : 1 } },
    };
  return { ...quote, outcome: evaluateAdd(p, s, desired0, desired1, min0, min1) };
}

export type RemoveOutcome =
  | { ok: true; amount0: bigint; amount1: bigint; supplyAfter: bigint }
  | { ok: false; refusal: Refusal };

/** What `burn` pays for `liquidity` shares on this state: pro rata of the pair's balances, after `_mintFee`. */
export function evaluateRemove(p: PoolState, s: PoolShares, liquidity: bigint): RemoveOutcome {
  if (!isOpen(p, s)) return { ok: false, refusal: { code: 'NOT_OPEN' } };
  const supply = supplyAfterFee(p, s);
  if (liquidity <= 0n || liquidity > supply)
    return { ok: false, refusal: { code: 'INSUFFICIENT_LIQUIDITY_BURNED' } };
  const balance0 = p.reserve0 + p.excess0;
  const balance1 = p.reserve1 + p.excess1;
  const amount0 = (liquidity * balance0) / supply;
  const amount1 = (liquidity * balance1) / supply;
  if (amount0 <= 0n || amount1 <= 0n)
    return { ok: false, refusal: { code: 'INSUFFICIENT_LIQUIDITY_BURNED' } };
  // Pair._update after a burn refuses only a balance above uint112 on an uncapped side (a capped side records
  // at most max(cap, reserve): `_exitBound`).
  if (p.cap0 === 0n && balance0 - amount0 > UINT112_MAX)
    return { ok: false, refusal: { code: 'OVERFLOW', side: 0 } };
  if (p.cap1 === 0n && balance1 - amount1 > UINT112_MAX)
    return { ok: false, refusal: { code: 'OVERFLOW', side: 1 } };
  return { ok: true, amount0, amount1, supplyAfter: supply - liquidity };
}

/** The router's check of a removal's two minimums, in its own order (A first), or null when both hold. */
export function belowMinimum(
  p: PoolState,
  paid: { amount0: bigint; amount1: bigint },
  min0: bigint,
  min1: bigint,
): Refusal | null {
  const a = p.aSide;
  const b = a === 0 ? 1 : 0;
  const under = (side: 0 | 1) => (side === 0 ? paid.amount0 < min0 : paid.amount1 < min1);
  if (under(a)) return { code: 'INSUFFICIENT_A_AMOUNT', side: a };
  if (under(b)) return { code: 'INSUFFICIENT_B_AMOUNT', side: b };
  return null;
}

export type RemoveQuote = { liquidity: bigint; min0: bigint; min1: bigint; outcome: RemoveOutcome };

/** A removal of `liquidity` of the account's `held` shares, with minimums `slippageBps` below the amounts. */
export function quoteRemove(
  p: PoolState,
  s: PoolShares,
  liquidity: bigint,
  held: bigint,
  slippageBps: number,
): RemoveQuote {
  const none = (refusal: Refusal): RemoveQuote => ({
    liquidity,
    min0: 0n,
    min1: 0n,
    outcome: { ok: false, refusal },
  });
  if (!isOpen(p, s)) return none({ code: 'NOT_OPEN' });
  if (liquidity <= 0n) return none({ code: 'INSUFFICIENT_LIQUIDITY_BURNED' });
  if (liquidity > held) return none({ code: 'EXCEEDS_SHARES' });
  const outcome = evaluateRemove(p, s, liquidity);
  if (!outcome.ok) return { liquidity, min0: 0n, min1: 0n, outcome };
  const min0 = floorBps(outcome.amount0, slippageBps);
  const min1 = floorBps(outcome.amount1, slippageBps);
  if (min0 <= 0n || min1 <= 0n) return none({ code: 'MINIMUM_ZERO', side: min0 <= 0n ? 0 : 1 });
  return { liquidity, min0, min1, outcome };
}

/** The shares a percentage of a position is, rounded down; 100 is every share the account holds. */
export const sharesForPercent = (held: bigint, percent: number): bigint =>
  percent >= 100 ? held : percent <= 0 ? 0n : (held * BigInt(Math.floor(percent))) / 100n;

export type Position = {
  shares: bigint;
  /** Parts per million of the supply after the pending protocol-fee shares. */
  sharePpm: bigint;
  amount0: bigint;
  amount1: bigint;
};

/** What `shares` are worth at this block: the amounts a removal of all of them would pay there. */
export function positionOf(p: PoolState, s: PoolShares, shares: bigint): Position {
  const supply = supplyAfterFee(p, s);
  if (supply === 0n || shares <= 0n) return { shares: 0n, sharePpm: 0n, amount0: 0n, amount1: 0n };
  return {
    shares,
    sharePpm: (shares * 1_000_000n) / supply,
    amount0: (shares * (p.reserve0 + p.excess0)) / supply,
    amount1: (shares * (p.reserve1 + p.excess1)) / supply,
  };
}

/** "12.3456%" from parts per million; a positive share below the last digit is "<0.0001%". */
export function sharePercentText(ppm: bigint, positive = ppm > 0n): string {
  if (ppm === 0n) return positive ? '<0.0001%' : '0%';
  const whole = ppm / 10_000n;
  const fraction = (ppm % 10_000n).toString().padStart(4, '0');
  return `${whole}.${fraction}%`;
}

/** One sentence per refusal, said before anything is sent. `symbols`: the pool's two names as the page shows them. */
export function refusalText(
  refusal: Refusal,
  symbols: readonly [string, string],
  action: 'add' | 'remove',
): string {
  const side = refusal.side === undefined ? '' : symbols[refusal.side];
  switch (refusal.code) {
    case 'NOT_OPEN':
      return 'This pool is not open. Only the first depositor fixed in the factory can open a pool, so this page builds no first deposit for anyone.';
    case 'INSUFFICIENT_AMOUNT':
      return action === 'add'
        ? 'Enter an amount large enough for the pool to ask a non-zero amount of the other token (BDEX: INSUFFICIENT_AMOUNT).'
        : 'Enter an amount of pool shares.';
    case 'INSUFFICIENT_A_AMOUNT':
    case 'INSUFFICIENT_B_AMOUNT':
      return `The pool's ratio has moved by more than your tolerance: the ${side} side would be below its minimum and the deposit would revert (BDEX: ${refusal.code}).`;
    case 'INSUFFICIENT_LIQUIDITY_MINTED':
      return 'This deposit is too small to receive a single pool share and would revert (BDEX: INSUFFICIENT_LIQUIDITY_MINTED).';
    case 'INSUFFICIENT_LIQUIDITY_BURNED':
      return 'These shares are too few to pay a non-zero amount of both tokens; the removal would revert (BDEX: INSUFFICIENT_LIQUIDITY_BURNED).';
    case 'RESERVE_CAP':
      return `This deposit would lift the ${side} reserve above its fixed cap and would revert (BDEX: RESERVE_CAP). Tokens held by the pair above its reserves count toward the cap until someone calls skim.`;
    case 'K_CEILING':
      return 'This deposit would lift the pool above its k ceiling (both reserves at 80% of their caps) and would revert (BDEX: K_CEILING).';
    case 'OVERFLOW':
      return action === 'add'
        ? `This deposit would lift the ${side} balance above what a pool can record and would revert (BDEX: OVERFLOW).`
        : `The pair holds more ${side} than a pool can record; a removal reverts until someone calls skim (BDEX: OVERFLOW).`;
    case 'MINIMUM_ZERO':
      return `This amount is so small that the minimum of ${side} rounds to zero, so nothing would protect it. Enter a larger amount.`;
    case 'EXCEEDS_SHARES':
      return 'That is more than the pool shares this account holds.';
  }
}

/** The share token's state of one pool at `at`. Refuses a factory whose fee recipient is not the record's. */
export async function readPoolShares(
  rpc: Rpc,
  at: BlockTag,
  d: DevnetDeployment,
  pair: Address,
): Promise<PoolShares> {
  const totalSupply = await readCall<bigint>(rpc, PAIR_SHARES_ABI, pair, 'totalSupply', [], at);
  const kLast = await readCall<bigint>(rpc, PAIR_SHARES_ABI, pair, 'kLast', [], at);
  const feeTo = (
    await readCall<Address>(rpc, FACTORY_ABI, d.factory, 'feeTo', [], at)
  ).toLowerCase();
  if (feeTo !== d.feeTo.toLowerCase())
    throw new Error("chain: the factory's fee recipient differs from the record");
  return { totalSupply, kLast, feeOn: BigInt(feeTo) !== 0n };
}

/** The pool as the pair sees it at `at`, read from the pair and the two tokens (used around a reverted block). */
export async function readPoolState(
  rpc: Rpc,
  at: BlockTag,
  pool: LivePool,
  wrapped: Address,
): Promise<PoolState> {
  const [reserve0, reserve1] = await readCall<readonly [bigint, bigint, number]>(
    rpc,
    PAIR_RESERVES_ABI,
    pool.address,
    'getReserves',
    [],
    at,
  );
  const balance = (token: Address) =>
    readCall<bigint>(rpc, ERC20_ABI, token, 'balanceOf', [pool.address], at);
  const balance0 = await balance(pool.token0.address);
  const balance1 = await balance(pool.token1.address);
  return {
    aSide: routerASide(pool, wrapped),
    reserve0,
    reserve1,
    cap0: pool.cap0,
    cap1: pool.cap1,
    excess0: balance0 > reserve0 ? balance0 - reserve0 : 0n,
    excess1: balance1 > reserve1 ? balance1 - reserve1 : 0n,
  };
}

/** The pool from the pair's own storage alone: reserves, nothing above them. */
export async function readPoolReserves(
  rpc: Rpc,
  at: BlockTag,
  pool: LivePool,
  wrapped: Address,
): Promise<PoolState> {
  const [reserve0, reserve1] = await readCall<readonly [bigint, bigint, number]>(
    rpc,
    PAIR_RESERVES_ABI,
    pool.address,
    'getReserves',
    [],
    at,
  );
  return {
    aSide: routerASide(pool, wrapped),
    reserve0,
    reserve1,
    cap0: pool.cap0,
    cap1: pool.cap1,
    excess0: 0n,
    excess1: 0n,
  };
}

/** What one account holds and has approved, for one pool, at the page's pinned block. */
export type LiquidityAccount = {
  shares: bigint;
  sharesAllowance: bigint;
  /** Wallet balance per pool side; the native coin's balance for a side that is the wrapped native token. */
  balance0: bigint;
  balance1: bigint;
  /** The router's allowance per side; null for a side paid in the native coin (nothing to approve). */
  allowance0: bigint | null;
  allowance1: bigint | null;
};

export async function readLiquidityAccount(
  rpc: Rpc,
  blockHash: Hex,
  d: DevnetDeployment,
  pool: LivePool,
  account: Address,
  multicall3?: Address,
): Promise<LiquidityAccount> {
  const at = { blockHash };
  const shares = await readCall<bigint>(
    rpc,
    PAIR_SHARES_ABI,
    pool.address,
    'balanceOf',
    [account],
    at,
  );
  const sharesAllowance = await readCall<bigint>(
    rpc,
    PAIR_SHARES_ABI,
    pool.address,
    'allowance',
    [account, d.router],
    at,
  );
  const balances = await readBalances(
    rpc,
    blockHash,
    account,
    [pool.token0, pool.token1],
    multicall3,
  );
  const side = async (token: Address): Promise<[bigint, bigint | null]> =>
    token === d.wrapped
      ? [balances.native, null]
      : [
          balances.tokens.get(token) ?? 0n,
          await readCall<bigint>(rpc, ERC20_ABI, token, 'allowance', [account, d.router], at),
        ];
  const [balance0, allowance0] = await side(pool.token0.address);
  const [balance1, allowance1] = await side(pool.token1.address);
  return { shares, sharesAllowance, balance0, balance1, allowance0, allowance1 };
}

/** Why a liquidity transaction reverted, as far as the chain shows it. */
export type LiquidityRevert =
  | { cause: 'expired' }
  | { cause: 'refused'; refusal: Refusal }
  | { cause: 'transfer'; side?: 0 | 1 }
  | { cause: 'shares' }
  | { cause: 'unknown' };

type Block = { hash?: Hex; parentHash?: Hex; timestamp?: string } | null;

/**
 * The chains' public endpoints give no trace, so the reason is inferred, as mainnet/retry.ts does for a swap:
 * the saved call is evaluated again on the state at the start and at the end of the block it was mined in. Never
 * throws; a failed read makes the cause unknown.
 */
export async function explainLiquidityRevert(
  rpc: Rpc,
  d: DevnetDeployment,
  pools: LivePool[],
  call: { data: Hex; value: bigint; from: Address },
  blockNumber: bigint,
): Promise<LiquidityRevert & { call: LiquidityCall | null }> {
  const decoded = decodeLiquidityCall(d, call.data, call.value);
  const pool = decoded ? pools.find((p) => p.address === decoded.pair.address) : undefined;
  if (!decoded || !pool) return { cause: 'unknown', call: decoded };
  let block: Block;
  try {
    block = (await rpc('eth_getBlockByNumber', [`0x${blockNumber.toString(16)}`, false])) as Block;
  } catch {
    return { cause: 'unknown', call: decoded };
  }
  if (!block?.hash || !block.parentHash || !block.timestamp)
    return { cause: 'unknown', call: decoded };
  if (BigInt(block.timestamp) > decoded.deadline) return { cause: 'expired', call: decoded };
  for (const blockHash of [block.parentHash, block.hash]) {
    try {
      const at = { blockHash };
      // A token contract may be unreadable at an older block where the pair itself still is (an endpoint that no
      // longer serves that state). The reserves alone decide the ratio and the minimums; what only the token
      // balances could show (a gift at the pair, the wallet's balance and approval) then stays unknown.
      const state = await readPoolState(rpc, at, pool, d.wrapped).catch(() =>
        readPoolReserves(rpc, at, pool, d.wrapped),
      );
      const shares = await readPoolShares(rpc, at, d, pool.address);
      if (decoded.action === 'add') {
        const outcome = evaluateAdd(
          state,
          shares,
          decoded.desired0,
          decoded.desired1,
          decoded.min0,
          decoded.min1,
        );
        if (!outcome.ok) return { cause: 'refused', refusal: outcome.refusal, call: decoded };
        const account = await readLiquidityAccount(rpc, blockHash, d, pool, call.from);
        if (
          account.balance0 < outcome.amount0 ||
          (account.allowance0 ?? outcome.amount0) < outcome.amount0
        )
          return { cause: 'transfer', side: 0, call: decoded };
        if (
          account.balance1 < outcome.amount1 ||
          (account.allowance1 ?? outcome.amount1) < outcome.amount1
        )
          return { cause: 'transfer', side: 1, call: decoded };
      } else {
        const held = await readCall<bigint>(
          rpc,
          PAIR_SHARES_ABI,
          pool.address,
          'balanceOf',
          [call.from],
          at,
        );
        const approved = await readCall<bigint>(
          rpc,
          PAIR_SHARES_ABI,
          pool.address,
          'allowance',
          [call.from, d.router],
          at,
        );
        if (held < decoded.liquidity || approved < decoded.liquidity)
          return { cause: 'shares', call: decoded };
        const outcome = evaluateRemove(state, shares, decoded.liquidity);
        if (!outcome.ok) return { cause: 'refused', refusal: outcome.refusal, call: decoded };
        const short = belowMinimum(state, outcome, decoded.min0, decoded.min1);
        if (short) return { cause: 'refused', refusal: short, call: decoded };
      }
    } catch {
      // A state that cannot be read says nothing about the cause.
    }
  }
  return { cause: 'unknown', call: decoded };
}

/** The words shown under a reverted deposit or removal. Only the gas was spent in every case. */
export function liquidityRevertText(
  revert: LiquidityRevert,
  symbols: readonly [string, string],
  action: 'add' | 'remove',
): string {
  const what = action === 'add' ? 'deposit' : 'removal';
  const tail = `Only the gas was spent; your tokens and pool shares did not move.`;
  switch (revert.cause) {
    case 'expired':
      return `It reverted because its deadline had passed when its block was made (BDEX: EXPIRED). ${tail} Start the ${what} again for a new deadline.`;
    case 'refused':
      if (
        action === 'remove' &&
        (revert.refusal.code === 'INSUFFICIENT_A_AMOUNT' ||
          revert.refusal.code === 'INSUFFICIENT_B_AMOUNT')
      )
        return `It reverted on its minimum of ${symbols[revert.refusal.side ?? 0]} (BDEX: ${revert.refusal.code}): the pool's balances moved by more than your tolerance before it ran. ${tail}`;
      return `${refusalText(revert.refusal, symbols, action)
        .replace(/would revert/g, 'reverted')
        .replace(/would be below/g, 'was below')} ${tail}`;
    case 'transfer':
      return `It reverted when the router pulled ${revert.side === undefined ? 'a token' : symbols[revert.side]} from this account (BDEX: TRANSFER_FROM_FAILED, or the token's own refusal): the balance or the approval was short when it ran, or the token's issuer has paused or blocked the transfer. ${tail}`;
    case 'shares':
      return `It reverted when the router pulled the pool shares: this account's shares or its approval of them were short when it ran. ${tail}`;
    case 'unknown':
      return `The page could not tell why from the chain. ${tail} The pool's figures around its block would have let it through, so a token may have refused the transfer (an issuer can pause its token or block an address), or the pool changed inside that block. Check the transaction in the explorer before you try again.`;
  }
}
