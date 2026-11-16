/**
 * Output per one whole input token of a quote, in output base units, rounded
 * down. Presentation of two figures the quote already carries; null when the
 * input is zero.
 */
export function quoteRate(amountIn: bigint, decimalsIn: number, amountOut: bigint): bigint | null {
  if (amountIn <= 0n || amountOut < 0n) return null;
  return (amountOut * 10n ** BigInt(decimalsIn)) / amountIn;
}
