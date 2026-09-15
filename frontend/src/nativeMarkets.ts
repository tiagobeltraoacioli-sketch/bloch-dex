/** Bloch representations always use b + the registered source asset symbol.
 * Symbols are display labels, never asset or custody-route identities.
 */
function bridgedMarket<const Asset extends string>(sourceAsset: Asset, sourceNetwork: string) {
  return Object.freeze({
    symbol: `b${sourceAsset}` as `b${Asset}`,
    sourceAsset,
    sourceNetwork,
    quote: 'BLCH' as const,
    enabled: false as const,
  });
}

/** Launch scope only. These entries are not deployed assets or funded pools. */
export const NATIVE_LAUNCH_MARKETS = Object.freeze([
  bridgedMarket('ETH', 'Ethereum'),
  bridgedMarket('BTC', 'Bitcoin'),
  bridgedMarket('SOL', 'Solana'),
  bridgedMarket('USDT', 'Ethereum'),
  bridgedMarket('USDC', 'Ethereum'),
] as const);
