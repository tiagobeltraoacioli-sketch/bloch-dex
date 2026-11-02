// Slippage limits for every swap form and quote on this site. This module is the
// only place they are defined; src/mainnet/config.ts re-exports them.
//
// Owner decision DEX-5 (round 10, agent 177): someone who knows a swap's size and
// direction can take the whole tolerance. At 0.5% that is 0.4-0.9% of the swap
// gross; at 3% it is 2.6-5.2%; at 5% it was 4.3-8.6%. So the default stays at 0.5%
// and the maximum is 3%. The lens itself accepts up to 100%, so only this page
// enforces the limit.

/** Default tolerance: 0.50%. */
export const DEFAULT_SLIPPAGE_BPS = 50;
/** Largest tolerance any form or quote on this site accepts: 3.00%. */
export const MAX_SLIPPAGE_BPS = 300;
/**
 * After a swap reverts on its minimum received, the page offers one retry at
 * this tolerance (1.00%), never above MAX_SLIPPAGE_BPS.
 */
export const RETRY_SLIPPAGE_BPS = Math.min(100, MAX_SLIPPAGE_BPS);

/** Whole basis points from 1 (0.01%) to MAX_SLIPPAGE_BPS. */
export function isAllowedSlippageBps(bps: number | bigint): boolean {
  if (typeof bps === 'bigint') return bps >= 1n && bps <= BigInt(MAX_SLIPPAGE_BPS);
  return Number.isInteger(bps) && bps >= 1 && bps <= MAX_SLIPPAGE_BPS;
}

/** "0.01% to 3.00%", for form messages. */
export const SLIPPAGE_RANGE_TEXT = `0.01% to ${(MAX_SLIPPAGE_BPS / 100).toFixed(2)}%`;
