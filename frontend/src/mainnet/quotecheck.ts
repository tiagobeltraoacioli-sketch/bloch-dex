// Stale-quote cross-check for the mainnet route. Balances, allowances, caps and
// the binding quote are read at the finalized block, but L2 finality can lag
// the head, so a swap priced there may revert on the slippage check. The latest
// block is consulted only for this comparison: it never moves a balance or a
// cap on screen, and a worse price is applied only after the user reconfirms.
import type { LensQuote } from '../devnet4/chain';

export type QuoteCheck =
  /** The latest-block quote still clears the minimum output of the active quote. */
  | { status: 'ok'; latest: LensQuote }
  /** The price moved beyond the slippage tolerance; the user must reconfirm. */
  | { status: 'worse'; latest: LensQuote; worseBps: bigint }
  /** At the latest block no route fills the amount (for example a cap was reached). */
  | { status: 'unavailable' }
  /** The latest block could not be read; the finalized quote and the on-chain minimum still apply. */
  | { status: 'unknown' };

/** Compare the active quote with one taken at the latest block. */
export function compareQuotes(active: LensQuote, latest: LensQuote | null): QuoteCheck {
  if (!latest) return { status: 'unavailable' };
  if (latest.amountOut >= active.minimumOut) return { status: 'ok', latest };
  const worseBps = ((active.amountOut - latest.amountOut) * 10_000n) / active.amountOut;
  return { status: 'worse', latest, worseBps };
}

/** Swaps stay disabled until a worse quote is reconfirmed or an unfillable one is replaced. */
export const blocksSwap = (check: QuoteCheck | null) =>
  check?.status === 'worse' || check?.status === 'unavailable';
