// One retry at 1% after a swap reverts on its minimum received (owner decision
// DEX-5, round 10).
//
// The settled RPC has no transaction trace, so the page cannot read the revert
// reason. It infers it from the chain instead:
// - BDEX: EXPIRED when the block's timestamp is past the swap's deadline;
// - BDEX: INSUFFICIENT_OUTPUT_AMOUNT when the router's own getAmountsOut, for
//   the same amount and path, returns less than the signed minimum at the start
//   or at the end of the block the swap was mined in. The router checks the
//   minimum before any transfer or cap check, so that is the check that failed.
// Anything else is "unknown", and no retry is offered.
//
// A sandwich whose back-run restores the price inside the same block leaves no
// trace at either end of the block; it is reported as unknown. That is the
// conservative side: no retry is offered on a guess.
import { parseAbi, type Address, type Hex } from 'viem';
import { readCall, type Rpc } from '../devnet4/chain';
import { MAX_SLIPPAGE_BPS, RETRY_SLIPPAGE_BPS } from '../slippage';

/** What the page needs to explain a revert and to refill the form for a retry. */
export type SwapRetryInfo = {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  path: Address[];
  minimumOut: bigint;
  slippageBps: number;
  /** 1 for a swap the user set up, 2 for the one retry the page offered. */
  attempt: 1 | 2;
};

export type RevertCause = 'minimum' | 'expired' | 'unknown';

const ROUTER_READ_ABI = parseAbi([
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
]);

type Block = { hash?: Hex; parentHash?: Hex; timestamp?: string } | null;

/** Never throws: a failed read makes the cause unknown. */
export async function explainSwapRevert(
  rpc: Rpc,
  router: Address,
  info: SwapRetryInfo,
  blockNumber: bigint,
  deadline: bigint,
): Promise<RevertCause> {
  let block: Block;
  try {
    block = (await rpc('eth_getBlockByNumber', [`0x${blockNumber.toString(16)}`, false])) as Block;
  } catch {
    return 'unknown';
  }
  if (!block?.hash || !block.parentHash || !block.timestamp) return 'unknown';
  if (BigInt(block.timestamp) > deadline) return 'expired';
  for (const blockHash of [block.parentHash, block.hash]) {
    try {
      const amounts = await readCall<readonly bigint[]>(
        rpc,
        ROUTER_READ_ABI,
        router,
        'getAmountsOut',
        [info.amountIn, info.path],
        { blockHash },
      );
      const out = amounts.at(-1);
      if (out !== undefined && out < info.minimumOut) return 'minimum';
    } catch {
      // A pool that cannot quote says nothing about the minimum.
    }
  }
  return 'unknown';
}

export type RetryOffer =
  /** Offer one retry at this tolerance. */
  | { kind: 'retry'; slippageBps: number }
  /** Reverted on its minimum, but the page offers nothing wider. */
  | { kind: 'none'; reason: 'already-retried' | 'tolerance-not-below-retry' };

/** The retry rule. Only a revert on the minimum gets an answer. */
export function retryOffer(info: SwapRetryInfo, cause: RevertCause): RetryOffer | null {
  if (cause !== 'minimum') return null;
  if (info.attempt !== 1) return { kind: 'none', reason: 'already-retried' };
  const slippageBps = Math.min(RETRY_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS);
  if (info.slippageBps >= slippageBps) return { kind: 'none', reason: 'tolerance-not-below-retry' };
  return { kind: 'retry', slippageBps };
}

export const percentText = (bps: number) => `${(bps / 100).toFixed(2)}%`;

/** The words shown under a reverted swap. */
export function revertText(info: SwapRetryInfo, cause: RevertCause): string {
  if (cause === 'expired')
    return 'It reverted because its deadline had passed when its block was made (BDEX: EXPIRED). Only the gas was spent. Get a new quote to swap again.';
  if (cause === 'unknown')
    return 'The page could not tell why from the chain. Only the gas was spent. Check the transaction in the explorer before you swap again.';
  const set = percentText(info.slippageBps);
  const head = `It reverted on its minimum received (BDEX: INSUFFICIENT_OUTPUT_AMOUNT): the price moved more than your ${set} tolerance before it ran, most likely because someone traded the same way in the same block. Only the gas was spent; your tokens did not move.`;
  const offer = retryOffer(info, cause)!;
  if (offer.kind === 'retry')
    return `${head} You can retry once at ${percentText(offer.slippageBps)}. A wider tolerance lets the swap fill after a larger move, and someone who trades just before you can keep up to that share of your output.`;
  if (offer.reason === 'already-retried')
    return `${head} This was the one retry the page offers. The price is still moving: wait for the next block and get a new quote.`;
  return `${head} The page offers a retry only below ${percentText(RETRY_SLIPPAGE_BPS)}. A wider tolerance lets someone who trades just before you keep up to that share of your output; get a new quote when the price settles.`;
}
