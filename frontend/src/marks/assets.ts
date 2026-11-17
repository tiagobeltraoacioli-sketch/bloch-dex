/**
 * Which mark a token symbol gets. Presentation only: nothing here names a contract or decides what can be traded.
 * One base mark per underlying asset; a bridged or per-network token carries the badge of the network it comes
 * from, so bUSDC, bUSDT.trx and USDC on Arbitrum One are told apart at a glance. The marks are original drawings
 * (marks/TokenMark.tsx); no third-party logo is bundled.
 */
export type AssetKey =
  | 'blch'
  | 'usdc'
  | 'usdt'
  | 'btc'
  | 'eth'
  | 'bnb'
  | 'sol'
  | 'xlm'
  | 'trx'
  | 'generic';

export type MarkSpec = {
  asset: AssetKey;
  /** One or two letters set in the display face (the BLCH mark draws the gate instead). */
  glyph: string;
  /** Network key of the badge (a lamp key of styles/tokens.css), or null for an asset at home. */
  origin: string | null;
};

const ASSETS: Record<string, { asset: AssetKey; glyph: string }> = {
  BLCH: { asset: 'blch', glyph: 'B' },
  USDC: { asset: 'usdc', glyph: 'U' },
  USDT: { asset: 'usdt', glyph: 'T' },
  BTC: { asset: 'btc', glyph: 'B' },
  ETH: { asset: 'eth', glyph: 'E' },
  BNB: { asset: 'bnb', glyph: 'Bn' },
  SOL: { asset: 'sol', glyph: 'S' },
  XLM: { asset: 'xlm', glyph: 'X' },
  TRX: { asset: 'trx', glyph: 'Tx' },
};

/** Suffix of a per-network wrapped token (`bUSDT.trx`) to the network it comes from. */
const SUFFIX: Record<string, string> = {
  eth: 'ethereum',
  arb: 'arbitrum-one',
  base: 'base',
  op: 'op-mainnet',
  linea: 'linea',
  bnb: 'bnb-smart-chain',
  bsc: 'bnb-smart-chain',
  btc: 'bitcoin',
  sol: 'solana',
  trx: 'tron',
  xlm: 'stellar',
};

/** Where an asset lives when a bridged symbol names no network (`bUSDC` is USDC from Ethereum). */
const HOME: Partial<Record<AssetKey, string>> = {
  btc: 'bitcoin',
  sol: 'solana',
  xlm: 'stellar',
  trx: 'tron',
  bnb: 'bnb-smart-chain',
};

/**
 * @param symbol  the label the page shows (`BLCH`, `bUSDC`, `bUSDT.trx`, `WETH`, `USDC`)
 * @param network lamp key of the network the page is on; on a public network every token carries that
 *                network's badge, on the Bloch L2 only bridged tokens carry one (their origin)
 */
export function tokenMark(symbol: string, network = 'bloch-l2'): MarkSpec {
  const [head, suffix] = symbol.split('.', 2);
  const bridged = /^b[A-Z]/.test(head);
  const bare = (bridged ? head.slice(1) : head).replace(/^W(?=ETH$|BLCH$|BNB$|BTC$)/, '');
  const known = ASSETS[bare.toUpperCase()];
  const asset = known?.asset ?? 'generic';
  const glyph =
    known?.glyph ??
    (bare
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 1)
      .toUpperCase() ||
      '?');
  const home = network === 'bloch-l2' || network === 'devnet4' || network === 'preview';
  const origin = bridged
    ? ((suffix && SUFFIX[suffix.toLowerCase()]) ?? HOME[asset] ?? 'ethereum')
    : home
      ? null
      : network;
  return { asset, glyph, origin };
}
