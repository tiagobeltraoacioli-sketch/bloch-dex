// Stellar route (bUSDC.xlm): the commitment an exit names, and the deposit invocation. Mirrors
// contracts/stellar/StellarBurnRouter.sol and tools/signatario-stellar/stellar_net.py.
import { keccak256, stringToHex, type Address } from 'viem';
import type { LiveRoute } from './config';
import { concat, fromHex, stellarAddress, utf8 } from './codec';

/** Low 20 bytes of keccak256(bytes32("BLOCH-XLM-RECIPIENT-v1") || the 56-character address). */
export function stellarCommitment(address: string): Address {
  const checked = stellarAddress(address);
  if (!checked.ok) throw new Error(checked.reason);
  const tag = fromHex(stringToHex('BLOCH-XLM-RECIPIENT-v1', { size: 32 }));
  return `0x${keccak256(concat(tag, utf8(address))).slice(-40)}` as Address;
}

export type StellarDeposit = {
  contract: string;
  function: 'deposit';
  args: { name: string; type: string; value: string }[];
  /** The same call as one line for the Stellar CLI; signed by the user's own key, never by this page. */
  cli: string;
};
/** The deposit call, unsigned: deposit(from, amount in stroops (a multiple of 10), l2_recipient: 20 bytes). No memo. */
export function stellarDeposit(route: LiveRoute, from: string, custodyUnits: bigint, l2Recipient: Address): StellarDeposit {
  const source = stellarAddress(from);
  if (!source.ok) throw new Error(source.reason);
  if (custodyUnits < route.limits.minDeposit || custodyUnits > route.limits.maxDeposit) throw new Error('The amount is outside the deposit limits.');
  if (!/^0x[0-9a-fA-F]{40}$/.test(l2Recipient) || /^0x0{40}$/.test(l2Recipient)) throw new Error('The L2 recipient must be a non-zero 20-byte address.');
  const stroops = custodyUnits * route.asset.unitsPerCustodyUnit;
  const recipient = l2Recipient.slice(2).toLowerCase();
  return {
    contract: route.custody.address,
    function: 'deposit',
    args: [
      { name: 'from', type: 'Address', value: from },
      { name: 'amount', type: 'i128 (stroops)', value: stroops.toString() },
      { name: 'l2_recipient', type: 'BytesN<20>', value: recipient },
    ],
    cli: `stellar contract invoke --network mainnet --source-account ${from} --id ${route.custody.address} -- deposit --from ${from} --amount ${stroops} --l2_recipient ${recipient}`,
  };
}

/** Horizon's account record: does this G… account exist and hold a trustline to the asset? */
export function trustlineState(account: unknown, code: string, issuer: string): 'trusted' | 'no-trustline' | 'unauthorized' {
  const balances = (account as { balances?: unknown })?.balances;
  if (!Array.isArray(balances)) throw new Error('not a Horizon account record');
  const line = balances.find((b) => b && typeof b === 'object' && (b as Record<string, unknown>).asset_code === code && (b as Record<string, unknown>).asset_issuer === issuer) as Record<string, unknown> | undefined;
  if (!line) return 'no-trustline';
  return line.is_authorized === false ? 'unauthorized' : 'trusted';
}
