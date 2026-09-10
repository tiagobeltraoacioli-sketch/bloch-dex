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
};
export type Period = '1H' | '24H' | '1W' | '1M';
export type Page = 'trade' | 'pools' | 'portfolio' | 'develop';
export type Quote = {
  path: Symbol[];
  amounts: bigint[];
  output: bigint;
  minimum: bigint;
  executionLossBps: number;
};
export type LiquidityAction = { mode: 'add' | 'remove'; pool: Pool };
