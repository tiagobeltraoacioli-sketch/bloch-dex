// Liquidity transactions of a live route: the router's add and remove calls for a pool of the verified record.
//
// The router's function names are the Bloch L2's: its native-coin entry points end in "BLCH" on every chain
// (contracts/periphery/BDexRouter.sol; the wrapped native token is a constructor argument). Those names are
// calldata, never page text.
//
// Every call is built from integer base units with explicit minimums and an explicit deadline, for a pair that
// the bundled record lists (the record lists a pair only when the post gate proved its opening:
// scripts/multichain/frontend-files.mjs). Nothing here can build a first deposit: the amounts come from
// mainnet/liquidity.ts, which refuses a pool without shares, and `addLiquidityTransaction` refuses a pair the
// record does not list.
import { decodeFunctionData, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import type { DevnetDeployment, DevnetPair } from '../devnet4/record';
import type { TransactionRequest } from '../devnet4/swap';

export const LIQUIDITY_ABI = parseAbi([
  'function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity)',
  'function addLiquidityBLCH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountBLCHMin, address to, uint256 deadline) payable returns (uint256 amountToken, uint256 amountBLCH, uint256 liquidity)',
  'function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB)',
  'function removeLiquidityBLCH(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountBLCHMin, address to, uint256 deadline) returns (uint256 amountToken, uint256 amountBLCH)',
]);

/**
 * Explicit gas limits, as for every transaction of the route (the page does not depend on an estimate).
 * Measured on forks of Ethereum and BNB Smart Chain on 2026-11-18 (agent 411's report): a deposit with the native
 * coin used up to about 190,000 gas, a removal up to about 215,000 (both include the protocol-fee mint and, for
 * USDC on Ethereum, the token's proxy). The limits leave about half as much again.
 */
export const ADD_LIQUIDITY_GAS = 350_000n;
export const REMOVE_LIQUIDITY_GAS = 350_000n;

export class LiquidityTxError extends Error {}
function refuse(condition: unknown, message: string): asserts condition {
  if (!condition) throw new LiquidityTxError(message);
}

const recorded = (d: DevnetDeployment, pair: DevnetPair) =>
  d.pairs.some(
    (p) => p.address === pair.address && p.token0 === pair.token0 && p.token1 === pair.token1,
  );

export type AddAmounts = { desired0: bigint; desired1: bigint; min0: bigint; min1: bigint };

/**
 * Deposit into an open pool of the record. A side that is the wrapped native token is paid in the native coin
 * through the router's native entry point (the value sent is that side's desired amount; the router returns
 * what the ratio did not need).
 */
export function addLiquidityTransaction(
  d: DevnetDeployment,
  pair: DevnetPair,
  a: AddAmounts,
  from: Address,
  deadline: bigint,
): TransactionRequest {
  refuse(recorded(d, pair), 'This pool is not a pool of the verified deployment record.');
  refuse(a.desired0 > 0n && a.desired1 > 0n, 'Both amounts must be positive.');
  refuse(
    a.min0 > 0n && a.min1 > 0n && a.min0 <= a.desired0 && a.min1 <= a.desired1,
    'The deposit has no valid minimums.',
  );
  refuse(deadline > 0n, 'The deposit has no deadline.');
  const native = pair.token0 === d.wrapped ? 0 : pair.token1 === d.wrapped ? 1 : null;
  if (native === null)
    return {
      from,
      to: d.router,
      data: encodeFunctionData({
        abi: LIQUIDITY_ABI,
        functionName: 'addLiquidity',
        args: [pair.token0, pair.token1, a.desired0, a.desired1, a.min0, a.min1, from, deadline],
      }),
      value: 0n,
      gas: ADD_LIQUIDITY_GAS,
    };
  const [token, tokenDesired, tokenMin, nativeDesired, nativeMin] =
    native === 0
      ? [pair.token1, a.desired1, a.min1, a.desired0, a.min0]
      : [pair.token0, a.desired0, a.min0, a.desired1, a.min1];
  return {
    from,
    to: d.router,
    data: encodeFunctionData({
      abi: LIQUIDITY_ABI,
      functionName: 'addLiquidityBLCH',
      args: [token, tokenDesired, tokenMin, nativeMin, from, deadline],
    }),
    value: nativeDesired,
    gas: ADD_LIQUIDITY_GAS,
  };
}

export type RemoveAmounts = { liquidity: bigint; min0: bigint; min1: bigint };

/** Withdraw pool shares; a wrapped-native side is paid out in the native coin. */
export function removeLiquidityTransaction(
  d: DevnetDeployment,
  pair: DevnetPair,
  r: RemoveAmounts,
  from: Address,
  deadline: bigint,
): TransactionRequest {
  refuse(recorded(d, pair), 'This pool is not a pool of the verified deployment record.');
  refuse(r.liquidity > 0n, 'Nothing to remove.');
  refuse(r.min0 > 0n && r.min1 > 0n, 'The removal has no valid minimums.');
  refuse(deadline > 0n, 'The removal has no deadline.');
  const native = pair.token0 === d.wrapped ? 0 : pair.token1 === d.wrapped ? 1 : null;
  if (native === null)
    return {
      from,
      to: d.router,
      data: encodeFunctionData({
        abi: LIQUIDITY_ABI,
        functionName: 'removeLiquidity',
        args: [pair.token0, pair.token1, r.liquidity, r.min0, r.min1, from, deadline],
      }),
      value: 0n,
      gas: REMOVE_LIQUIDITY_GAS,
    };
  const [token, tokenMin, nativeMin] =
    native === 0 ? [pair.token1, r.min1, r.min0] : [pair.token0, r.min0, r.min1];
  return {
    from,
    to: d.router,
    data: encodeFunctionData({
      abi: LIQUIDITY_ABI,
      functionName: 'removeLiquidityBLCH',
      args: [token, r.liquidity, tokenMin, nativeMin, from, deadline],
    }),
    value: 0n,
    gas: REMOVE_LIQUIDITY_GAS,
  };
}

export type LiquidityCall =
  | ({ action: 'add'; pair: DevnetPair; recipient: Address; deadline: bigint } & AddAmounts)
  | ({ action: 'remove'; pair: DevnetPair; recipient: Address; deadline: bigint } & RemoveAmounts);

/**
 * Read a saved liquidity call back into the pool's own token order. Null when the bytes are not one of the four
 * calls above for a pair of this record (a stored record is data, not authority).
 */
export function decodeLiquidityCall(
  d: DevnetDeployment,
  data: Hex,
  value: bigint,
): LiquidityCall | null {
  let call;
  try {
    call = decodeFunctionData({ abi: LIQUIDITY_ABI, data });
  } catch {
    return null;
  }
  const lower = (a: Address) => a.toLowerCase() as Address;
  const pairOf = (a: Address, b: Address) =>
    d.pairs.find((p) => (p.token0 === a && p.token1 === b) || (p.token0 === b && p.token1 === a)) ??
    null;
  if (call.functionName === 'addLiquidity') {
    const [a, b, desiredA, desiredB, minA, minB, to, deadline] = call.args;
    const pair = pairOf(lower(a), lower(b));
    if (!pair || value !== 0n) return null;
    const straight = pair.token0 === lower(a);
    return {
      action: 'add',
      pair,
      recipient: lower(to),
      deadline,
      desired0: straight ? desiredA : desiredB,
      desired1: straight ? desiredB : desiredA,
      min0: straight ? minA : minB,
      min1: straight ? minB : minA,
    };
  }
  if (call.functionName === 'addLiquidityBLCH') {
    const [token, tokenDesired, tokenMin, nativeMin, to, deadline] = call.args;
    const pair = pairOf(lower(token), d.wrapped);
    if (!pair) return null;
    const tokenFirst = pair.token0 === lower(token);
    return {
      action: 'add',
      pair,
      recipient: lower(to),
      deadline,
      desired0: tokenFirst ? tokenDesired : value,
      desired1: tokenFirst ? value : tokenDesired,
      min0: tokenFirst ? tokenMin : nativeMin,
      min1: tokenFirst ? nativeMin : tokenMin,
    };
  }
  if (call.functionName === 'removeLiquidity') {
    const [a, b, liquidity, minA, minB, to, deadline] = call.args;
    const pair = pairOf(lower(a), lower(b));
    if (!pair || value !== 0n) return null;
    const straight = pair.token0 === lower(a);
    return {
      action: 'remove',
      pair,
      recipient: lower(to),
      deadline,
      liquidity,
      min0: straight ? minA : minB,
      min1: straight ? minB : minA,
    };
  }
  const [token, liquidity, tokenMin, nativeMin, to, deadline] = call.args;
  const pair = pairOf(lower(token), d.wrapped);
  if (!pair || value !== 0n) return null;
  const tokenFirst = pair.token0 === lower(token);
  return {
    action: 'remove',
    pair,
    recipient: lower(to),
    deadline,
    liquidity,
    min0: tokenFirst ? tokenMin : nativeMin,
    min1: tokenFirst ? nativeMin : tokenMin,
  };
}

/** The deadline inside a saved liquidity call (its last argument), or null when the bytes are not one. */
export function savedLiquidityDeadline(data: Hex): bigint | null {
  try {
    const call = decodeFunctionData({ abi: LIQUIDITY_ABI, data });
    const deadline = call.args[call.args.length - 1];
    return typeof deadline === 'bigint' ? deadline : null;
  } catch {
    return null;
  }
}
