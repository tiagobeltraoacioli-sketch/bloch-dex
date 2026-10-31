// Stale-quote cross-check for the mainnet route. Balances, allowances, caps and
// the binding quote are read at the finalized block, but L2 finality can lag
// the head, so a swap priced there may revert on the slippage check. The latest
// block is consulted only for this comparison and for the signed minimum: it
// never moves a balance or a cap on screen, a worse price is applied only after
// the user reconfirms, and a better price tightens the minimum (signedQuote).
import type { LensQuote } from '../devnet4/chain';

export type QuoteCheck =
  /** The latest-block quote still clears the minimum output of the active quote. */
  | { status: 'ok'; latest: LensQuote }
  /** The price moved beyond the slippage tolerance; the user must reconfirm. */
  | { status: 'worse'; latest: LensQuote; worseBps: bigint }
  /** At the latest block no route fills the amount (for example a cap was reached). */
  | { status: 'unavailable' }
  /**
   * The latest block could not be read. The finalized quote and the on-chain
   * minimum still apply, and `last` keeps the latest quote seen for this quote.
   */
  | { status: 'unknown'; last?: LensQuote };

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

/**
 * The quote to sign. When the latest block returns more than the active quote,
 * the minimum follows it, so a favourable move during the finality lag does not
 * widen the slippage the user chose. It never drops below the active minimum.
 */
export function signedQuote(active: LensQuote, check: QuoteCheck | null): LensQuote {
  const latest =
    check?.status === 'ok' ? check.latest : check?.status === 'unknown' ? check.last : undefined;
  if (!latest || latest.amountIn !== active.amountIn || latest.minimumOut <= active.minimumOut)
    return active;
  // A minimum from one route cannot bound another, so a new best route comes with its legs.
  return latest.path.join() === active.path.join()
    ? { ...active, amountOut: latest.amountOut, minimumOut: latest.minimumOut }
    : { ...latest, blockNumber: active.blockNumber };
}
