// Round 20 (agent 411): why a deposit or removal reverted, inferred from the state at the start and at the end of
// its block (no endpoint of these chains gives a trace). A read that fails makes the cause unknown, never wrong.
import { describe, expect, it } from 'vitest';
import {
  decodeFunctionData,
  encodeFunctionResult,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import type { LivePool, Rpc } from '../devnet4/chain';
import type { DevnetDeployment } from '../devnet4/record';
import { explainLiquidityRevert } from '../mainnet/liquidity';
import { addLiquidityTransaction, removeLiquidityTransaction } from '../mainnet/liquidity-tx';

const address = (digit: string) => `0x${digit.repeat(40)}` as Address;
const hash = (digit: string) => `0x${digit.repeat(64)}` as Hex;
const FROM = address('1'),
  TOKEN = address('2'),
  WRAPPED = address('3'),
  PAIR = address('8'),
  ROUTER = address('6'),
  FACTORY = address('5'),
  FEE_TO = address('7');
const pair = { address: PAIR, token0: TOKEN, token1: WRAPPED };
const d = {
  chainId: 1,
  factory: FACTORY,
  router: ROUTER,
  wrapped: WRAPPED,
  feeTo: FEE_TO,
  pairs: [pair],
} as unknown as DevnetDeployment;
const token = (a: Address, symbol: string, decimals: number, wrapped = false) => ({
  address: a,
  symbol,
  decimals,
  cap: 0n,
  wrapped,
});
const pool: LivePool = {
  address: PAIR,
  token0: token(TOKEN, 'USDC', 6),
  token1: token(WRAPPED, 'WETH', 18, true),
  reserve0: 0n,
  reserve1: 0n,
  cap0: 0n,
  cap1: 0n,
};
const ABI = parseAbi([
  'function getReserves() view returns (uint112, uint112, uint32)',
  'function totalSupply() view returns (uint256)',
  'function kLast() view returns (uint256)',
  'function feeTo() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address, address) view returns (uint256)',
]);
const ONE = 10n ** 18n;
const DEADLINE = 5000n;
const BLOCK = { hash: hash('b'), parentHash: hash('a'), timestamp: '0x1000' };
type State = {
  reserves: [bigint, bigint];
  supply: bigint;
  /** Wallet figures. */
  tokenBalance: bigint;
  tokenAllowance: bigint;
  shares: bigint;
  sharesAllowance: bigint;
  /** The token contract cannot be read at this block (an endpoint that no longer serves its state). */
  tokenUnreadable?: boolean;
};
const START: State = {
  reserves: [30_000_000_000n, 10n * ONE],
  supply: 547_722_557_505_166n,
  tokenBalance: 10n ** 12n,
  tokenAllowance: 10n ** 12n,
  shares: 10n ** 12n,
  sharesAllowance: 10n ** 12n,
};
function chain(start: State, end: State, block = BLOCK): Rpc {
  return async (method, params) => {
    if (method === 'eth_getBlockByNumber') return block;
    if (method === 'eth_getBalance') return `0x${(50n * ONE).toString(16)}`;
    if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
    const [{ to, data }, at] = params as [{ to: Address; data: Hex }, { blockHash: Hex }];
    const s = at.blockHash === block.parentHash ? start : end;
    const call = decodeFunctionData({ abi: ABI, data });
    const reply = (result: unknown) =>
      encodeFunctionResult({ abi: ABI as Abi, functionName: call.functionName, result } as never);
    if (to === TOKEN && s.tokenUnreadable) throw new Error('chain: eth_call failed: missing state');
    switch (call.functionName) {
      case 'getReserves':
        return reply([...s.reserves, 1]);
      case 'totalSupply':
        return reply(s.supply);
      case 'kLast':
        return reply(0n);
      case 'feeTo':
        return reply(FEE_TO);
      case 'balanceOf':
        return reply(
          to === PAIR
            ? s.shares
            : (call.args as [Address])[0] === PAIR
              ? to === TOKEN
                ? s.reserves[0]
                : s.reserves[1]
              : s.tokenBalance,
        );
      case 'allowance':
        return reply(to === PAIR ? s.sharesAllowance : s.tokenAllowance);
    }
  };
}
// 1 of the native coin with the 3000 USDC of the ratio, 0.5% minimums.
const ADD = addLiquidityTransaction(
  d,
  pair,
  { desired0: 3_000_000_000n, desired1: ONE, min0: 2_985_000_000n, min1: 995n * 10n ** 15n },
  FROM,
  DEADLINE,
);
const REMOVE = removeLiquidityTransaction(
  d,
  pair,
  { liquidity: 10n ** 12n, min0: 54_000_000n, min1: 18n * 10n ** 15n },
  FROM,
  DEADLINE,
);
const explain = (rpc: Rpc, tx = ADD) =>
  explainLiquidityRevert(rpc, d, [pool], { data: tx.data, value: tx.value, from: FROM }, 17n);

describe('why a liquidity transaction reverted', () => {
  it('names the deadline when the block is past it', async () => {
    const late = { ...BLOCK, timestamp: `0x${(DEADLINE + 1n).toString(16)}` };
    expect(await explain(chain(START, START, late))).toMatchObject({ cause: 'expired' });
    // Exactly at the deadline the router still accepts it.
    const at = { ...BLOCK, timestamp: `0x${DEADLINE.toString(16)}` };
    expect(await explain(chain(START, START, at))).toMatchObject({ cause: 'unknown' });
  });

  it('names the minimum when the ratio moved inside the block, in front of the transaction', async () => {
    // The native coin became 20% cheaper by the end of the block: the token side falls below its minimum.
    const moved: State = { ...START, reserves: [27_000_000_000n, 11_111_111_111_111_111_111n] };
    expect(await explain(chain(START, moved))).toMatchObject({
      cause: 'refused',
      refusal: { code: 'INSUFFICIENT_A_AMOUNT', side: 0 },
    });
    // The other way: the native side falls below its minimum.
    const dearer: State = { ...START, reserves: [33_000_000_000n, 9_090_909_090_909_090_909n] };
    expect(await explain(chain(START, dearer))).toMatchObject({
      cause: 'refused',
      refusal: { code: 'INSUFFICIENT_B_AMOUNT', side: 1 },
    });
  });

  it('still names the minimum when a token contract cannot be read at that block (reserves alone decide it)', async () => {
    const moved: State = { ...START, reserves: [27_000_000_000n, 11_111_111_111_111_111_111n] };
    const rpc = chain({ ...START, tokenUnreadable: true }, { ...moved, tokenUnreadable: true });
    expect(await explain(rpc)).toMatchObject({
      cause: 'refused',
      refusal: { code: 'INSUFFICIENT_A_AMOUNT', side: 0 },
    });
    // With nothing wrong in the reserves and the token unreadable, the page does not guess.
    const blind = chain({ ...START, tokenUnreadable: true }, { ...START, tokenUnreadable: true });
    expect(await explain(blind)).toMatchObject({ cause: 'unknown' });
  });

  it('names a short balance or approval of the token, and of the pool shares for a removal', async () => {
    expect(await explain(chain({ ...START, tokenAllowance: 1n }, START))).toMatchObject({
      cause: 'transfer',
      side: 0,
    });
    expect(await explain(chain({ ...START, tokenBalance: 1n }, START))).toMatchObject({
      cause: 'transfer',
      side: 0,
    });
    expect(await explain(chain({ ...START, sharesAllowance: 1n }, START), REMOVE)).toMatchObject({
      cause: 'shares',
    });
  });

  it('names the minimum of a removal the router checks first, and leaves the rest unknown', async () => {
    // 10^12 of 547,722,557,505,166 shares pay 54.77 USDC and 0.01825 of the native coin at the start.
    expect(await explain(chain(START, START), REMOVE)).toMatchObject({ cause: 'unknown' });
    const moved: State = { ...START, reserves: [27_000_000_000n, 11_111_111_111_111_111_111n] };
    expect(await explain(chain(START, moved), REMOVE)).toMatchObject({
      cause: 'refused',
      refusal: { code: 'INSUFFICIENT_A_AMOUNT', side: 0 },
    });
    // A call that is not a liquidity call of this record is never explained.
    expect(
      await explainLiquidityRevert(
        chain(START, START),
        d,
        [pool],
        { data: '0xdeadbeef', value: 0n, from: FROM },
        17n,
      ),
    ).toEqual({ cause: 'unknown', call: null });
  });
});
