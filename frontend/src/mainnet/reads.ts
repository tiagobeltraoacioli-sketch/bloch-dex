// Finalized-only account reads for the mainnet route: native and token
// balances and router allowances, all at the finalized block hash of the
// snapshot (EIP-1898), never `latest`.
import type { Address, Hex } from 'viem';
import { ERC20_ABI, readCall, type LiveToken, type Rpc } from '../devnet4/chain';

export type Balances = { native: bigint; tokens: Map<Address, bigint> };

export async function readBalances(
  rpc: Rpc,
  finalizedHash: Hex,
  account: Address,
  tokens: LiveToken[],
): Promise<Balances> {
  const at = { blockHash: finalizedHash };
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
