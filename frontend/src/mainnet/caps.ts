// Cap-aware route checks. They mirror BDexLens._quote and UniswapV2Pair._update
// on a finalized snapshot, so the UI can say which pool and which reserve cap
// would make a swap revert, and how much input still fits.
//
// Pair rule (UniswapV2Pair._update): a reserve may grow only while it stays at
// or below its constructor-fixed cap (0 = uncapped); outflows are never
// blocked. A swap that would lift the input reserve above the cap reverts with
// "BDEX: RESERVE_CAP", and the lens reports such a route as unavailable.
//
// K ceiling (UniswapV2Pair._applyCeiling): on a pair capped on both sides,
// reserve0 * reserve1 stays at or below 64% of cap0 * cap1. Mint and sync revert
// with "BDEX: K_CEILING"; a swap or burn still runs and records less, so its fee
// stays outside the reserves as excess. It changes neither output nor cap checks.
import type { Address } from 'viem';
import { amountOut, formatAmount } from '../amm';
import type { LivePool, LiveToken } from '../devnet4/chain';

export type HopBlock =
  | { kind: 'no-pool'; tokenIn: LiveToken | Address; tokenOut: LiveToken | Address }
  | { kind: 'no-liquidity'; pool: LivePool }
  | {
      kind: 'reserve-cap';
      pool: LivePool;
      token: LiveToken;
      reserve: bigint;
      cap: bigint;
      amountIn: bigint;
      /** Input this hop can still take: cap − reserve (0 when inflow is paused). */
      maxInput: bigint;
    }
  | { kind: 'zero-output'; pool: LivePool }
  | {
      /** A standing donation would leave the balance above the cap (finding DEX-02). */
      kind: 'pending-excess';
      pool: LivePool;
      token: LiveToken;
      excess: bigint;
      cap: bigint;
    };

export type RouteCheck = { path: Address[]; amounts: bigint[]; block: HopBlock | null };

export function findPool(pools: LivePool[], a: Address, b: Address): LivePool | undefined {
  return pools.find(
    (p) =>
      (p.token0.address === a && p.token1.address === b) ||
      (p.token0.address === b && p.token1.address === a),
  );
}

/** Remaining inflow before a reserve reaches its cap; null when uncapped. */
export function headroom(reserve: bigint, cap: bigint): bigint | null {
  if (cap === 0n) return null;
  return cap > reserve ? cap - reserve : 0n;
}

/** UniswapV2Pair.K_CEILING_BPS. */
const K_CEILING_BPS = 6_400n;

/** True when the pool's reserves are at its k ceiling: deposits revert, swaps still run. */
export function atKCeiling(
  pool: Pick<LivePool, 'reserve0' | 'reserve1' | 'cap0' | 'cap1'>,
): boolean {
  if (pool.cap0 === 0n || pool.cap1 === 0n) return false;
  const ceiling = (pool.cap0 * pool.cap1 * K_CEILING_BPS) / 10_000n;
  // A swap records floor(ceiling / other reserve), so k lands up to one reserve below it.
  const margin = pool.reserve0 > pool.reserve1 ? pool.reserve0 : pool.reserve1;
  return pool.reserve0 * pool.reserve1 + margin > ceiling;
}

/**
 * True when a swap of 0.1% of the input side's cap reverts in both directions because
 * of unrecorded balance. The lens's blocksInflow flags cannot say this: one side above
 * its cap is enough, and a balance exactly at its cap is not flagged.
 */
export function closedByExcess(pool: LivePool): boolean {
  const e = pool.excess;
  if (!e || (e.excess0 === 0n && e.excess1 === 0n)) return false;
  const b0 = pool.reserve0 + e.excess0;
  const b1 = pool.reserve1 + e.excess1;
  const within = (balance: bigint, reserve: bigint, cap: bigint) =>
    cap === 0n || balance <= (cap > reserve ? cap : reserve);
  const fits = (
    balIn: bigint,
    rIn: bigint,
    capIn: bigint,
    balOut: bigint,
    rOut: bigint,
    capOut: bigint,
  ) => {
    if (capIn === 0n) return true;
    const input = capIn / 1000n || 1n;
    return (
      within(balIn + input, rIn, capIn) &&
      within(balOut - amountOut(input, rIn, rOut), rOut, capOut)
    );
  };
  return (
    !fits(b0, pool.reserve0, pool.cap0, b1, pool.reserve1, pool.cap1) &&
    !fits(b1, pool.reserve1, pool.cap1, b0, pool.reserve0, pool.cap0)
  );
}

/** Walk a route hop by hop on finalized reserves, stopping at the first hop that would revert. */
export function checkRoute(pools: LivePool[], path: Address[], amountIn: bigint): RouteCheck {
  const amounts = [amountIn];
  for (let i = 0; i < path.length - 1; i++) {
    const pool = findPool(pools, path[i], path[i + 1]);
    if (!pool)
      return { path, amounts, block: { kind: 'no-pool', tokenIn: path[i], tokenOut: path[i + 1] } };
    const inputIs0 = pool.token0.address === path[i];
    const [rIn, rOut, capIn, token] = inputIs0
      ? [pool.reserve0, pool.reserve1, pool.cap0, pool.token0]
      : [pool.reserve1, pool.reserve0, pool.cap1, pool.token1];
    if (rIn === 0n || rOut === 0n) return { path, amounts, block: { kind: 'no-liquidity', pool } };
    const amount = amounts[i];
    if (capIn !== 0n && rIn + amount > capIn) {
      return {
        path,
        amounts,
        block: {
          kind: 'reserve-cap',
          pool,
          token,
          reserve: rIn,
          cap: capIn,
          amountIn: amount,
          maxInput: headroom(rIn, capIn)!,
        },
      };
    }
    const out = amountOut(amount, rIn, rOut);
    if (out === 0n) return { path, amounts, block: { kind: 'zero-output', pool } };
    const excess0 = pool.excess?.excess0 ?? 0n;
    const excess1 = pool.excess?.excess1 ?? 0n;
    const [excessIn, excessOut, capOut, tokenOut] = inputIs0
      ? [excess0, excess1, pool.cap1, pool.token1]
      : [excess1, excess0, pool.cap0, pool.token0];
    if (capIn !== 0n && excessIn > 0n && rIn + excessIn + amount > capIn) {
      const block = { kind: 'pending-excess', pool, token, excess: excessIn, cap: capIn } as const;
      return { path, amounts, block };
    }
    const leftOut = rOut + excessOut - out;
    if (capOut !== 0n && excessOut > 0n && leftOut > capOut && leftOut > rOut) {
      const block = {
        kind: 'pending-excess',
        pool,
        token: tokenOut,
        excess: excessOut,
        cap: capOut,
      } as const;
      return { path, amounts, block };
    }
    amounts.push(out);
  }
  return { path, amounts, block: null };
}

const pairName = (p: LivePool) => `${p.token0.symbol}/${p.token1.symbol}`;

/** One sentence explaining why a hop would revert or be refused by the lens. */
export function explainBlock(block: HopBlock): string {
  switch (block.kind) {
    case 'no-pool':
      return 'No pool exists for one hop of this route.';
    case 'no-liquidity':
      return `The ${pairName(block.pool)} pool has no liquidity yet. Only the deployment's first depositor can make its first deposit.`;
    case 'zero-output':
      return `The amount is too small: the ${pairName(block.pool)} pool would return nothing.`;
    case 'pending-excess': {
      const d = block.token.decimals;
      const s = block.token.symbol;
      return (
        `The ${pairName(block.pool)} pool holds ${formatAmount(block.excess, d)} ${s} above its ` +
        `reserves, so its ${s} balance would pass the fixed cap of ${formatAmount(block.cap, d)} ${s} ` +
        `and the swap would revert with BDEX: RESERVE_CAP. Anyone can clear this by calling skim on the pool.`
      );
    }
    case 'reserve-cap': {
      const d = block.token.decimals;
      const s = block.token.symbol;
      const after = formatAmount(block.reserve + block.amountIn, d);
      const head =
        block.maxInput === 0n
          ? `${s} inflow into this pool is paused until its reserve falls below the cap.`
          : `At most ${formatAmount(block.maxInput, d)} ${s} more fits into this pool.`;
      return (
        `The ${pairName(block.pool)} pool would revert with BDEX: RESERVE_CAP: its ${s} reserve ` +
        `would reach ${after} ${s}, above the fixed cap of ${formatAmount(block.cap, d)} ${s}. ${head}`
      );
    }
  }
}

/**
 * Share of each hop's remaining cap headroom this swap would use. Others can
 * fill the pool between the finalized block and your transaction, so a swap
 * close to 100% may still revert with RESERVE_CAP.
 */
export function headroomUse(pools: LivePool[], path: Address[], amounts: bigint[]) {
  const uses: { pool: LivePool; token: LiveToken; bps: bigint }[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const pool = findPool(pools, path[i], path[i + 1]);
    if (!pool) continue;
    const inputIs0 = pool.token0.address === path[i];
    const [rIn, capIn, token] = inputIs0
      ? [pool.reserve0, pool.cap0, pool.token0]
      : [pool.reserve1, pool.cap1, pool.token1];
    const room = headroom(rIn, capIn);
    if (room === null) continue;
    uses.push({ pool, token, bps: room === 0n ? 10_000n : (amounts[i] * 10_000n) / room });
  }
  return uses;
}
