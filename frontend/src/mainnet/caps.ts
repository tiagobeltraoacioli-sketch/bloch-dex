// Cap-aware route checks. They mirror BDexLens._quote and UniswapV2Pair._update
// on a finalized snapshot, so the UI can say which pool and which reserve cap
// would make a swap revert, and how much input still fits.
//
// Pair rule (UniswapV2Pair._update): a reserve may grow only while it stays at
// or below its constructor-fixed cap (0 = uncapped); outflows are never
// blocked. A swap that would lift the input reserve above the cap reverts with
// "BDEX: RESERVE_CAP", and the lens reports such a route as unavailable.
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
  | { kind: 'zero-output'; pool: LivePool };

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
      return `The ${pairName(block.pool)} pool has no liquidity yet.`;
    case 'zero-output':
      return `The amount is too small: the ${pairName(block.pool)} pool would return nothing.`;
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
