// A wallet does not expose its signed hash before eth_sendTransaction returns.
// Structured admission data is therefore diagnostic only, never a reason to
// release the intent, attach the reported hash, resend or increase fees.
import { isSubmissionHash } from './submission-outcome';

const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/;
const FIELDS = [
  'headNumber',
  'baseFeePerGas',
  'requiredPriorityFeePerGas',
  'requiredMaxFeePerGas',
  'effectivePriorityFeePerGas',
  'gasUsed',
  'freshSlots',
  'chargedFreshSlots',
  'freshSlotPriceWei',
] as const;
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export function submissionFeeNote(error: unknown): string | undefined {
  try {
    let response = record(error);
    for (let depth = 0; response && depth < 3; depth++) {
      if (response.code === -32000) break;
      response = record(response.cause) ?? record(record(response.data)?.originalError);
    }
    if (response?.code !== -32000) return;
    const data = record(response.data);
    if (
      !data ||
      data.kind !== 'sequencer-fee-underpriced' ||
      data.scope !== 'latest-state-next-block' ||
      !isSubmissionHash(data.transactionHash) ||
      !isSubmissionHash(data.headHash)
    )
      return;
    const values = {} as Record<(typeof FIELDS)[number], bigint>;
    for (const field of FIELDS) {
      const value = data[field];
      if (typeof value !== 'string' || !QUANTITY.test(value)) return;
      values[field] = BigInt(value);
    }
    const {
      gasUsed,
      chargedFreshSlots,
      freshSlots,
      freshSlotPriceWei,
      baseFeePerGas,
      requiredPriorityFeePerGas,
      requiredMaxFeePerGas,
      effectivePriorityFeePerGas,
      headNumber,
    } = values;
    if (
      gasUsed === 0n ||
      chargedFreshSlots > freshSlots ||
      requiredPriorityFeePerGas <= effectivePriorityFeePerGas ||
      requiredMaxFeePerGas !== baseFeePerGas + requiredPriorityFeePerGas ||
      requiredPriorityFeePerGas * gasUsed < chargedFreshSlots * freshSlotPriceWei
    )
      return;
    return `RPC fee diagnostic (not bound to your wallet's signed transaction): at head ${headNumber}, required priority fee ${requiredPriorityFeePerGas} wei/gas and max fee ${requiredMaxFeePerGas} wei/gas. Submission outcome remains unknown; no retry or fee increase was performed.`;
  } catch {
    return;
  }
}
