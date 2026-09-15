/** Launch scope only. These entries are not deployed assets or funded pools. */
export const NATIVE_LAUNCH_MARKETS = Object.freeze([
  Object.freeze({
    symbol: 'bETH',
    sourceAsset: 'ETH',
    sourceNetwork: 'Ethereum',
    quote: 'BLCH',
    enabled: false,
  }),
  Object.freeze({
    symbol: 'bBTC',
    sourceAsset: 'BTC',
    sourceNetwork: 'Bitcoin',
    quote: 'BLCH',
    enabled: false,
  }),
  Object.freeze({
    symbol: 'bSOL',
    sourceAsset: 'SOL',
    sourceNetwork: 'Solana',
    quote: 'BLCH',
    enabled: false,
  }),
] as const);
