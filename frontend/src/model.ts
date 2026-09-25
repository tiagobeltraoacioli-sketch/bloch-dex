export type Symbol = 'BLCH' | 'USDC' | 'WETH' | 'USTAV';
export type Token = {
  symbol: Symbol;
  name: string;
  decimals: number;
  price: number;
  glyph: string;
};
export type Pool = {
  id: string;
  token0: Symbol;
  token1: Symbol;
  reserve0: bigint;
  reserve1: bigint;
  liquidity: number;
  volume: number;
  fees: number;
  /** Effective quote fee in basis points; omitted legacy preview pools use 30. */
  swapFeeBps?: number;
};
export type Period = '1H' | '24H' | '1W' | '1M';
export type Page = 'trade' | 'pools' | 'portfolio';
export type Quote = {
  path: Symbol[];
  amounts: bigint[];
  output: bigint;
  minimum: bigint;
  executionLossBps: number;
  poolFeeBps?: number[];
};
export type LiquidityAction = { mode: 'add' | 'remove'; pool: Pool };
