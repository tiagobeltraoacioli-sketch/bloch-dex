// The L2 candidate's per-sender credit rule (bloch-l2-evm 1b55ce1, ABI in agents/R15-CROSS-AREA.md of
// 2026-11-12 00:18 UTC): bloch_admissionQuote reports `executable` and `not_executable_reason`, and
// eth_sendRawTransaction refuses with kind "sequencer-needs-credit" or "sequencer-gas-limit-above-cap".
// For both, a higher fee does not help, and the page must never say that it does.
import { describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import type { Rpc } from '../devnet4/chain';
import { SWAP_GAS_PER_HOP, APPROVE_GAS } from '../devnet4/swap';
import {
  ADMISSION_QUOTE_METHOD,
  NEW_SLOT_FEE_OFF,
  NewSlotFeeError,
  creditRefusalText,
  newSlotFeeNote,
  priceNewSlots,
  type NewSlotFeePolicy,
} from '../mainnet/newslotfee';
import { submissionFeeNote } from '../mainnet/submission-fees';

const TOKEN = '0x1b7c0fb59f34683cd9214566636e63a0f7e092f6' as Address;
const FROM = '0x72dc623d4c03c996a3d20ed2674f24570e8acf44' as Address;
const ON: NewSlotFeePolicy = { ...NEW_SLOT_FEE_OFF, enabled: true };
const q = (n: bigint) => `0x${n.toString(16)}`;
const BASE = 976_792_726n;
const quote = (over: Record<string, unknown> = {}) => ({
  kind: 'sequencer-admission-quote',
  scope: 'latest-state-next-block',
  baseFeePerGas: q(BASE),
  requiredPriorityFeePerGas: q(4_334_915_578n),
  requiredMaxFeePerGas: q(4_334_915_578n + BASE),
  minimumPriorityFeePerGas: q(100_000_000n),
  gasUsed: q(46_137n),
  freshSlots: '0x1',
  chargedFreshSlots: '0x1',
  freshSlotPriceWei: q(200_000_000_000_000n),
  executable: true,
  not_executable_reason: null,
  covered: false,
  gas_limit: 100_000,
  credit_wei: '0',
  credit_needed_wei: '0',
  uncovered_max_gas: 1_500_000,
  max_tx_gas: 5_000_000,
  ...over,
});
function node(answer: unknown) {
  const calls: string[] = [];
  const rpc = vi.fn<Rpc>(async (method) => {
    calls.push(method);
    switch (method) {
      case ADMISSION_QUOTE_METHOD:
        return answer;
      case 'eth_createAccessList':
        return {
          accessList: [{ address: TOKEN, storageKeys: [`0x${'1'.padStart(64, '0')}`] }],
          gasUsed: '0xbcd1',
        };
      case 'eth_getStorageAt':
        return '0x0';
      case 'eth_maxPriorityFeePerGas':
        return q(1_000_000_000n);
      case 'eth_getBlockByNumber':
        return { baseFeePerGas: q(BASE) };
      default:
        throw new Error(`unexpected ${method}`);
    }
  });
  return { rpc, calls };
}
const call = (gas: bigint) => ({
  from: FROM,
  to: TOKEN,
  data: '0x095ea7b3' as Hex,
  value: 0n,
  gas,
});
const NO_FEE_ADVICE =
  /raise|increase the (fee|tip)|higher (fee|tip) (will|would|helps)|try a higher/i;

describe('credit rule: what the page asks never needs credit', () => {
  it('an approval, a skim and the longest route the router takes (4 hops) are below the 1,500,000 limit of a wallet without credit', () => {
    expect(APPROVE_GAS).toBe(100_000n);
    expect(SWAP_GAS_PER_HOP * 4n).toBe(1_000_000n);
    expect(SWAP_GAS_PER_HOP * 4n).toBeLessThanOrEqual(1_500_000n);
    // The router refuses a fifth hop (test/RouteGas.t.sol), and amm.ts builds no path above 5 tokens.
  });

  it('prices as before when the node says the call is executable, with the new fields present', async () => {
    const { rpc } = node(quote());
    const fee = await priceNewSlots(rpc, call(100_000n), ON);
    expect(fee!.maxPriorityFeePerGas).toBe(4_995_798_988n);
  });

  it('prices as before against a node with an old policy file (new fields null) and against the launch RPC (no method)', async () => {
    const old = node(
      quote({
        executable: true,
        not_executable_reason: null,
        covered: null,
        gas_limit: null,
        credit_wei: null,
        credit_needed_wei: null,
        uncovered_max_gas: null,
        max_tx_gas: null,
      }),
    );
    expect((await priceNewSlots(old.rpc, call(100_000n), ON))!.source).toBe('access-list');
    const launch = vi.fn<Rpc>(async (method) => {
      if (method === ADMISSION_QUOTE_METHOD)
        throw Object.assign(new Error('Method not found'), { code: -32601 });
      return node(null).rpc(method, []);
    });
    expect((await priceNewSlots(launch, call(100_000n), ON))!.source).toBe('access-list');
  });
});

describe('credit rule: a wallet without credit is told about the plain transfer', () => {
  it('adds the first-transfer advice when the node gives the figure, with no fee-raising advice', async () => {
    const { rpc } = node(quote({ covered: false, first_transfer_priority_fee_wei: '20642455134' }));
    const fee = await priceNewSlots(rpc, call(100_000n), ON);
    // The call goes out at the page's tip (the node's plus the margin): ceil(100,000 x 4,995,798,988 / 21,000).
    expect(fee!.firstTransferTip).toBe(23_789_518_991n);
    expect(fee!.maxPriorityFeePerGas).toBe(4_995_798_988n);
    const note = newSlotFeeNote(fee);
    expect(note).toMatch(
      /This wallet has not paid for an L2 transaction yet\. If L2 blocks are full, its first call can wait whatever fee it offers; one plain transfer first \(to your own address is enough\) with a priority fee of at least 23\.789518991 gwei avoids that\.$/,
    );
    expect(note).not.toMatch(NO_FEE_ADVICE);
  });

  it('says nothing about it for a covered wallet, a node without the field, or the launch RPC', async () => {
    for (const over of [
      { covered: true, first_transfer_priority_fee_wei: null },
      { covered: false },
      { covered: null, first_transfer_priority_fee_wei: null },
    ]) {
      const fee = await priceNewSlots(node(quote(over)).rpc, call(100_000n), ON);
      expect(fee!.firstTransferTip).toBeUndefined();
      expect(newSlotFeeNote(fee)).not.toMatch(/has not paid/);
    }
  });

  it('the refusal text uses the node figure for the transfer when it is given', () => {
    expect(
      creditRefusalText('needs-credit', {
        gas_limit: 1_750_000,
        uncovered_max_gas: 1_500_000,
        credit_needed_wei: '21000000000000',
        first_transfer_priority_fee_wei: '1000000007',
      }),
    ).toMatch(/priority fee of 1000000007 wei per gas earns enough in one step/);
  });
});

describe('credit rule: credit that covers the node tip but not the page tip', () => {
  it('sends nothing when the call is above the limit and the credit is below gas limit x the tip the page would send', async () => {
    // The node judges at 4,334,915,578 wei: 1,750,000 x that = 7,586,102,261,500,000 wei of credit covers it.
    // The page would send at 4,995,798,988 wei and needs 8,742,648,229,000,000.
    const { rpc } = node(
      quote({
        covered: true,
        gas_limit: 1_750_000,
        credit_wei: '7586102261500000',
        credit_needed_wei: '0',
        first_transfer_priority_fee_wei: null,
      }),
    );
    const error = await priceNewSlots(rpc, call(1_750_000n), ON).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NewSlotFeeError);
    // ceil((8,742,648,229,000,000 - 7,586,102,261,500,000) / 21,000)
    expect((error as Error).message).toMatch(
      /its gas limit of 1750000 is above the 1500000 .* A higher fee does not help\. .*one plain transfer with a priority fee of 55073617500 wei per gas earns enough in one step\)\. Nothing was sent\.$/,
    );
  });

  it('prices as before when the credit covers the page tip, and below the limit whatever the credit', async () => {
    const rich = node(
      quote({ covered: true, gas_limit: 1_750_000, credit_wei: '8742648229000000' }),
    );
    expect((await priceNewSlots(rich.rpc, call(1_750_000n), ON))!.maxPriorityFeePerGas).toBe(
      4_995_798_988n,
    );
    const small = node(quote({ covered: false, credit_wei: '0' }));
    expect((await priceNewSlots(small.rpc, call(100_000n), ON))!.maxPriorityFeePerGas).toBe(
      4_995_798_988n,
    );
  });
});

describe('credit rule: needs-credit and gas-limit-above-cap', () => {
  it('sends nothing on needs-credit, says what helps, and never suggests a higher fee; no fallback to the access list', async () => {
    const { rpc, calls } = node(
      quote({
        executable: false,
        not_executable_reason: 'needs-credit',
        gas_limit: 1_750_000,
        credit_needed_wei: '7586102261500000',
        uncovered_max_gas: 1_500_000,
      }),
    );
    const error = await priceNewSlots(rpc, call(1_750_000n), ON).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NewSlotFeeError);
    const text = (error as Error).message;
    expect(text).toMatch(
      /its gas limit of 1750000 is above the 1500000 the L2 allows such a wallet for one call/,
    );
    expect(text).toMatch(
      /A higher fee does not help\. What helps: a smaller route \(fewer hops\), or one earlier transaction from this wallet/,
    );
    // The transfer is priced for the tip the page would send the call with (its own access-list figure,
    // 4,995,798,988 wei, above the node's plus the margin): ceil(1,750,000 x 4,995,798,988 / 21,000).
    expect(text).toMatch(
      /one plain transfer with a priority fee of 416316582334 wei per gas earns enough in one step/,
    );
    expect(text).toMatch(/Nothing was sent\.$/);
    expect(text.replace('A higher fee does not help', '')).not.toMatch(NO_FEE_ADVICE);
    // The access list may be read to name the transfer; no fee comes back and nothing is sent.
    expect(calls[0]).toBe(ADMISSION_QUOTE_METHOD);
  });

  it('sends nothing on gas-limit-above-cap, with the cap named', async () => {
    const { rpc, calls } = node(
      quote({
        executable: false,
        not_executable_reason: 'gas-limit-above-cap',
        gas_limit: 6_000_000,
        max_tx_gas: 5_000_000,
      }),
    );
    await expect(priceNewSlots(rpc, call(6_000_000n), ON)).rejects.toThrow(
      /its gas limit of 6000000 is above the L2's maximum of 5000000 for one transaction\. A higher fee does not help\. Use a smaller route \(fewer hops\)\. Nothing was sent\./,
    );
    // The access list may be read to name the transfer; no fee comes back and nothing is sent.
    expect(calls[0]).toBe(ADMISSION_QUOTE_METHOD);
  });

  it('sends nothing on a reason it does not know, and on a refusal whose fee figures are missing', async () => {
    await expect(
      priceNewSlots(
        node(quote({ executable: false, not_executable_reason: 'something-new' })).rpc,
        call(100_000n),
        ON,
      ),
    ).rejects.toThrow(/would not execute this transaction \(something-new\).*Nothing was sent/);
    await expect(
      priceNewSlots(
        node(
          quote({ executable: false, not_executable_reason: 'needs-credit', gasUsed: undefined }),
        ).rpc,
        call(100_000n),
        ON,
      ),
    ).rejects.toThrow(/A higher fee does not help/);
  });

  it('explains a refusal that reaches the page through the wallet, without fee advice and without the fee diagnostic', () => {
    const refusal = (kind: string, data: Record<string, unknown>) => ({
      code: -32000,
      message: 'sequencer policy',
      data: { kind, scope: 'latest-state-next-block', ...data },
    });
    const credit = submissionFeeNote(
      refusal('sequencer-needs-credit', {
        gas_limit: 1_750_000,
        uncovered_max_gas: 1_500_000,
        credit_wei: '0',
        credit_needed_wei: '21000000000000',
        max_tx_gas: 5_000_000,
      }),
    )!;
    expect(credit).toMatch(
      /^RPC diagnostic \(not bound to your wallet's signed transaction\): The L2 does not take this transaction from a wallet that has not paid/,
    );
    expect(credit).toMatch(/priority fee of 1000000000 wei per gas earns enough in one step/);
    expect(credit).toMatch(
      /Submission outcome remains unknown; no retry or fee increase was performed\.$/,
    );
    expect(credit).not.toMatch(/required priority fee/);
    const cap = submissionFeeNote({
      cause: refusal('sequencer-gas-limit-above-cap', {
        gas_limit: 6_000_000,
        max_tx_gas: 5_000_000,
      }),
    })!;
    expect(cap).toMatch(
      /above the L2's maximum of 5000000 for one transaction\. A higher fee does not help/,
    );
    // Unknown kinds and malformed figures stay silent or figure-free.
    expect(submissionFeeNote(refusal('sequencer-something', {}))).toBeUndefined();
    expect(creditRefusalText('needs-credit', { gas_limit: 'abc', credit_needed_wei: -1 })).toMatch(
      /its gas limit is above the limit the L2 allows/,
    );
    expect(creditRefusalText('sequencer-fee-underpriced', {})).toBeNull();
  });
});
