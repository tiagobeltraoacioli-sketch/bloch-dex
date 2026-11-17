// TRON route (bUSDT.trx): the two deposit transactions as unsigned requests for the user's own wallet
// (TronLink and the TRON HTTP API take exactly these fields: `triggersmartcontract`), never signed here.
import { encodeAbiParameters, type Address, type Hex } from 'viem';
import type { LiveRoute } from './config';
import { tronAddress20, tronAddressText } from './codec';

export type TronCall = {
  step: string;
  contract: string;
  functionSelector: string;
  /** ABI-encoded arguments, hex without 0x, as `triggersmartcontract` takes them in `parameter`. */
  parameter: string;
  ownerAddress: string;
  callValue: 0;
};
const bare = (hex: Hex) => hex.slice(2);

/** approve(vault, amount) on the token, then deposit(amount, l2Recipient) on the vault. */
export function tronDepositCalls(route: LiveRoute, from: string, amount: bigint, l2Recipient: Address): TronCall[] {
  const owner = tronAddress20(from);
  if (!owner.ok) throw new Error(owner.reason);
  const vault = tronAddress20(route.custody.address);
  if (!vault.ok) throw new Error(`the vault address is not a TRON address: ${vault.reason}`);
  const token = tronAddress20(route.asset.id);
  if (!token.ok) throw new Error(`the asset address is not a TRON address: ${token.reason}`);
  if (amount < route.limits.minDeposit || amount > route.limits.maxDeposit) throw new Error('The amount is outside the deposit limits.');
  if (!/^0x[0-9a-fA-F]{40}$/.test(l2Recipient) || /^0x0{40}$/.test(l2Recipient)) throw new Error('The L2 recipient must be a non-zero 20-byte address.');
  return [
    {
      step: `Approve the vault for ${route.asset.symbol} (TRC-20 approve)`,
      contract: tronAddressText(token.address20),
      functionSelector: 'approve(address,uint256)',
      parameter: bare(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [vault.address20, amount])),
      ownerAddress: from,
      callValue: 0,
    },
    {
      step: 'Deposit into the vault, naming your L2 address',
      contract: tronAddressText(vault.address20),
      functionSelector: 'deposit(uint64,bytes32)',
      parameter: bare(encodeAbiParameters([{ type: 'uint64' }, { type: 'bytes32' }], [amount, `0x${l2Recipient.slice(2).toLowerCase().padStart(64, '0')}` as Hex])),
      ownerAddress: from,
      callValue: 0,
    },
  ];
}
