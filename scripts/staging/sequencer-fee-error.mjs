// Decode the optional settled-RPC admission refusal. This is a quote for one
// transaction at one head, never authorization to sign, retry or raise limits.
import { JsonRpcResponseError } from "./rpc-transport.mjs";

const HASH = /^0x[0-9a-f]{64}$/;
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/;
const FIELDS = Object.freeze([
  "headNumber", "baseFeePerGas", "requiredPriorityFeePerGas", "requiredMaxFeePerGas",
  "effectivePriorityFeePerGas", "gasUsed", "freshSlots", "chargedFreshSlots", "freshSlotPriceWei",
]);

export function sequencerFeeRequirement(error, expectedHash) {
  const response = error instanceof JsonRpcResponseError ? error : error?.cause;
  if (!(response instanceof JsonRpcResponseError) || response.rpcError.code !== -32000) return null;
  const data = response.rpcError.data;
  if (!data || typeof data !== "object" || Array.isArray(data) ||
    data.kind !== "sequencer-fee-underpriced" || data.scope !== "latest-state-next-block" ||
    typeof expectedHash !== "string" || !HASH.test(expectedHash) || /^0x0+$/.test(expectedHash) ||
    data.transactionHash !== expectedHash || typeof data.headHash !== "string" ||
    !HASH.test(data.headHash) || /^0x0+$/.test(data.headHash)) return null;
  const values = {};
  for (const field of FIELDS) {
    if (typeof data[field] !== "string" || !QUANTITY.test(data[field])) return null;
    values[field] = BigInt(data[field]);
  }
  const { gasUsed, chargedFreshSlots, freshSlots, freshSlotPriceWei,
    baseFeePerGas, requiredPriorityFeePerGas, requiredMaxFeePerGas, effectivePriorityFeePerGas } = values;
  if (gasUsed === 0n || chargedFreshSlots > freshSlots ||
    requiredPriorityFeePerGas <= effectivePriorityFeePerGas ||
    requiredMaxFeePerGas !== baseFeePerGas + requiredPriorityFeePerGas ||
    requiredPriorityFeePerGas * gasUsed < chargedFreshSlots * freshSlotPriceWei) return null;
  // Decimal integer strings match the operator's explicit wei flags and remain
  // JSON-safe even when a quote exceeds JavaScript's safe integer range.
  return {
    kind: data.kind, transactionHash: expectedHash, headHash: data.headHash, scope: data.scope,
    ...Object.fromEntries(FIELDS.map((field) => [field, values[field].toString()])),
    guidance: "Review this transaction's fee requirements and limits before signing again. Set maxPriorityFeePerGas at least to requiredPriorityFeePerGas and maxFeePerGas at least to requiredMaxFeePerGas (wei). This quote depends on the indicated head and policy; inclusion is not guaranteed. No automatic retry or fee increase was performed.",
  };
}
