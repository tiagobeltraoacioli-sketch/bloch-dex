// Finalized-only reads for the mainnet route: native and token balances, router
// allowances and pending pool donations, all at the finalized block hash of the
// snapshot (EIP-1898), never `latest`. With a recorded Multicall3 (its runtime
// code is verified at that block by readSnapshot) a balance read is one eth_call.
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import {
  ERC20_ABI,
  LENS_ABI,
  readCall,
  type LivePool,
  type LiveToken,
  type Rpc,
} from '../devnet4/chain';

export const MULTICALL3_ABI = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
]);
const SKIM_ABI = parseAbi(['function skim(address to)']);

export type Balances = { native: bigint; tokens: Map<Address, bigint> };

export async function readBalances(
  rpc: Rpc,
  finalizedHash: Hex,
  account: Address,
  tokens: LiveToken[],
  multicall3?: Address,
): Promise<Balances> {
  const at = { blockHash: finalizedHash };
  if (multicall3) {
    const balanceCall = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [account],
    });
    const nativeCall = encodeFunctionData({
      abi: MULTICALL3_ABI,
      functionName: 'getEthBalance',
      args: [account],
    });
    const results = await readCall<readonly { success: boolean; returnData: Hex }[]>(
      rpc,
      MULTICALL3_ABI,
      multicall3,
      'aggregate3',
      [
        [
          { target: multicall3, allowFailure: false, callData: nativeCall },
          ...tokens.map((t) => ({
            target: t.address,
            allowFailure: false,
            callData: balanceCall,
          })),
        ],
      ],
      at,
    );
    if (results.length !== tokens.length + 1) throw new Error('chain: aggregate3 failed');
    const word = (data: Hex) =>
      decodeFunctionResult({ abi: ERC20_ABI, functionName: 'balanceOf', data });
    return {
      native: word(results[0].returnData),
      tokens: new Map(tokens.map((t, i) => [t.address, word(results[i + 1].returnData)])),
    };
  }
  const native = await rpc('eth_getBalance', [account, at]);
  if (typeof native !== 'string' || !native.startsWith('0x'))
    throw new Error('chain: eth_getBalance failed');
  const map = new Map<Address, bigint>();
  for (const token of tokens) {
    map.set(
      token.address,
      await readCall<bigint>(rpc, ERC20_ABI, token.address, 'balanceOf', [account], at),
    );
  }
  return { native: BigInt(native), tokens: map };
}

export async function readAllowance(
  rpc: Rpc,
  finalizedHash: Hex,
  token: Address,
  owner: Address,
  router: Address,
): Promise<bigint> {
  return readCall<bigint>(rpc, ERC20_ABI, token, 'allowance', [owner, router], {
    blockHash: finalizedHash,
  });
}

/** Pending donations of every pool at the finalized block (finding DEX-02). */
export async function readExcess(
  rpc: Rpc,
  finalizedHash: Hex,
  lens: Address,
  pools: LivePool[],
): Promise<LivePool[]> {
  const out: LivePool[] = [];
  for (const pool of pools) {
    const excess = await readCall<NonNullable<LivePool['excess']>>(
      rpc,
      LENS_ABI,
      lens,
      'pendingExcess',
      [pool.address],
      { blockHash: finalizedHash },
    );
    out.push({ ...pool, excess });
  }
  return out;
}

/** `pair.skim(to)`: anyone may call it; the caller's `to` receives the excess. */
export function skimTransaction(pair: Address, to: Address) {
  return {
    from: to,
    to: pair,
    data: encodeFunctionData({ abi: SKIM_ABI, functionName: 'skim', args: [to] }),
    value: 0n,
    gas: 200_000n,
  };
}
