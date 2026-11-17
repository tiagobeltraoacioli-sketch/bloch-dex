// Bitcoin route (bBTC): the deposit address of an L2 recipient, the vault's fee rules, the refund request.
// Mirrors tools/signatario-btc/btc_core.py and btc_policy.py of the bridge; tested against their answers.
import type { Address } from 'viem';
import type { BitcoinPolicy, BitcoinScript, LiveRoute, Route } from './config';
import { concat, fromHex, segwitV0Encode, sha256Bytes, toHex, type Bytes } from './codec';

const OP_DROP = 0x75;
const OP_CHECKMULTISIG = 0xae;

/** `<vault id || L2 recipient> OP_DROP <k-of-n multisig>`: the recipient is committed by the address itself. */
export function depositScript(script: BitcoinScript, l2Recipient: Address): Bytes {
  const recipient = fromHex(l2Recipient);
  if (recipient.length !== 20 || recipient.every((b) => b === 0)) throw new Error('The L2 recipient must be a non-zero 20-byte address.');
  const keys = script.publicKeys.map(fromHex);
  return concat(
    Uint8Array.of(0x20),
    fromHex(script.vaultId),
    recipient,
    Uint8Array.of(OP_DROP, 0x50 + script.threshold),
    ...keys.map((k) => concat(Uint8Array.of(0x21), k)),
    Uint8Array.of(0x50 + keys.length, OP_CHECKMULTISIG),
  );
}

/** The P2WSH deposit address of `l2Recipient` on this vault. Only for a live route. */
export function depositAddress(route: LiveRoute, l2Recipient: Address): { address: string; witnessScript: `0x${string}` } {
  const script = route.bitcoin?.script;
  if (!script) throw new Error('The Bitcoin vault keys are not published.');
  const witness = depositScript(script, l2Recipient);
  return { address: segwitV0Encode(script.hrp, sha256Bytes(witness)), witnessScript: toHex(witness) };
}

export type BitcoinDepositQuote =
  | { ok: true; units: bigint; bridgeFeeSats: bigint; minerChargeSats: bigint; restSats: bigint }
  | { ok: false; wait: boolean; reason: string };
/** What a swept deposit of `sats` credits at `feeRate` sat/vB (btc_policy.deposit_credit). */
export function bitcoinDepositQuote(route: Route, sats: bigint, feeRate: bigint): BitcoinDepositQuote {
  const policy = route.bitcoin!.policy;
  const unit = route.asset.unitsPerCustodyUnit;
  if (sats < route.limits.minDeposit * unit)
    return { ok: false, wait: false, reason: 'Below the minimum: it would not be credited. Its L2 recipient can have it refunded.' };
  if (sats > route.limits.maxDeposit * unit)
    return { ok: false, wait: false, reason: 'Above the maximum for one payment: it would not be credited. Its L2 recipient can have it refunded.' };
  const fee = (sats * BigInt(route.fee.depositBps)) / 10_000n;
  const charge = feeRate * BigInt(policy.depositVbytes);
  if (charge > (sats * BigInt(policy.depositMaxChargeBps)) / 10_000n)
    return { ok: false, wait: true, reason: `At ${feeRate} sat/vB the miner charge would be more than ${policy.depositMaxChargeBps / 100}% of this deposit, so the vault waits for lower fees before it collects it. It stays refundable meanwhile.` };
  const net = sats - fee - charge;
  const units = net / unit;
  if (units === 0n) return { ok: false, wait: false, reason: 'Nothing would be left to credit after the fees.' };
  return { ok: true, units, bridgeFeeSats: fee, minerChargeSats: charge, restSats: net % unit };
}

export type BitcoinExitQuote = { payoutSats: bigint; bridgeFeeSats: bigint; minerChargeSats: bigint; dust: boolean };
/** BitcoinBurnRouter.quote, and its dust refusal: the LEAST a burn of `units` pays when charged `feeRate` sat/vB. */
export function bitcoinExitQuote(route: Route, units: bigint, feeRate: bigint): BitcoinExitQuote {
  const policy: BitcoinPolicy = route.bitcoin!.policy;
  const gross = units * route.asset.unitsPerCustodyUnit;
  const bridgeFeeSats = (gross * BigInt(route.fee.releaseBps)) / 10_000n;
  const minerChargeSats = feeRate * BigInt(policy.releaseVbytes);
  const payoutSats = gross > bridgeFeeSats + minerChargeSats ? gross - bridgeFeeSats - minerChargeSats : 0n;
  return { payoutSats, bridgeFeeSats, minerChargeSats, dust: payoutSats < BigInt(policy.dustSats) };
}

/** What a refund of an unswept deposit returns (btc_policy.refund_amount); null when it would be dust. */
export function bitcoinRefundQuote(route: Route, sats: bigint, feeRate: bigint) {
  const policy = route.bitcoin!.policy;
  const fee = (sats * BigInt(route.fee.depositBps)) / 10_000n;
  const charge = feeRate * BigInt(policy.refundVbytes);
  const back = sats - fee - charge;
  return back < BigInt(policy.dustSats) ? null : { backSats: back, bridgeFeeSats: fee, minerChargeSats: charge };
}

/** The text the L2 recipient of an unswept deposit personal-signs to have it sent back (btc_core.refund_text). */
export function refundText(route: LiveRoute, txid: string, vout: number, bitcoinAddress: string): string {
  const script = route.bitcoin?.script;
  if (!script) throw new Error('The Bitcoin vault keys are not published.');
  if (!/^[0-9a-f]{64}$/.test(txid) || !Number.isInteger(vout) || vout < 0) throw new Error('Name the deposit as its transaction id and output number.');
  return `bloch.bbtc.refund.v1: refund the deposit ${txid}:${vout} of vault ${script.vaultId.slice(2)} to the Bitcoin address ${bitcoinAddress}`;
}

/** Valid fee-rate ceiling of an exit: whole sat/vB from 1 to the vault's ceiling. */
export function parseFeeRate(text: string, ceiling: number): bigint | null {
  if (!/^[1-9][0-9]{0,3}$/.test(text)) return null;
  const value = BigInt(text);
  return value >= 1n && value <= BigInt(ceiling) ? value : null;
}
