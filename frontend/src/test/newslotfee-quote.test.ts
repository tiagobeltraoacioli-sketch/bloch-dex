// The node's admission quote (bloch_admissionQuote, bloch-l2-evm 24a116e; ABI in
// agents/R15-CROSS-AREA.md, 2026-11-11 01:15 UTC) is used when the RPC serves it; the access-list
// computation is the fallback. The figures of the first case are the node's own for a first
// approve of the real bridge token, measured on the user-transaction candidate (round 15).
import { describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import type { Rpc } from '../devnet4/chain';
import {
  ADMISSION_QUOTE_METHOD,
  NEW_SLOT_FEE_OFF,
  NewSlotFeeError,
  newSlotFeeNote,
  priceNewSlots,
  quoteNewSlots,
  type NewSlotFeePolicy,
} from '../mainnet/newslotfee';

const TOKEN = '0x1b7c0fb59f34683cd9214566636e63a0f7e092f6' as Address;
const FROM = '0x72dc623d4c03c996a3d20ed2674f24570e8acf44' as Address;
const ON: NewSlotFeePolicy = { ...NEW_SLOT_FEE_OFF, enabled: true };
const CALL = { from: FROM, to: TOKEN, data: '0x095ea7b3' as Hex, value: 0n, gas: 100_000n };
const q = (n: bigint) => `0x${n.toString(16)}`;
const BASE = 976_792_726n;
const quote = (over: Record<string, unknown> = {}) => ({
  kind: 'sequencer-admission-quote',
  scope: 'latest-state-next-block',
  headHash: `0x${'a'.repeat(64)}`,
  headNumber: '0x10',
  nonce: '0x0',
  baseFeePerGas: q(BASE),
  requiredPriorityFeePerGas: q(4_334_915_578n),
  requiredMaxFeePerGas: q(4_334_915_578n + BASE),
  minimumPriorityFeePerGas: q(100_000_000n),
  gasUsed: q(46_137n),
  freshSlots: '0x1',
  chargedFreshSlots: '0x1',
  freshSlotPriceWei: q(200_000_000_000_000n),
  ...over,
});
/** An RPC that serves the quote (or fails it) and the access-list path (one zero slot, 48,337 gas). */
function rpcWith(answer: () => unknown) {
  const calls: string[] = [];
  const rpc = vi.fn<Rpc>(async (method) => {
    calls.push(method);
    switch (method) {
      case ADMISSION_QUOTE_METHOD:
        return answer();
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

describe('admission quote first, access list as the fallback', () => {
  it('uses the node figures: the slots it charges and its requirement plus the margin', async () => {
    const { rpc, calls } = rpcWith(() => quote());
    const fee = (await priceNewSlots(rpc, CALL, ON))!;
    expect(fee.source).toBe('quote');
    expect(fee.possibleNewSlots).toBe(1n);
    expect(fee.gasUsed).toBe(46_137n);
    // ceil(4,334,915,578 x 1.1): 10% above the node's requirement, against 15.2% with the access list.
    expect(fee.maxPriorityFeePerGas).toBe(4_768_407_136n);
    expect(fee.maxFeePerGas).toBe(2n * BASE + 4_768_407_136n);
    expect(fee.publishedTip).toBe(100_000_000n);
    expect(calls).toEqual([ADMISSION_QUOTE_METHOD]);
    expect(rpc.mock.calls[0][1]).toEqual([
      { from: FROM, to: TOKEN, data: '0x095ea7b3', value: '0x0', gas: '0x186a0' },
    ]);
    expect(newSlotFeeNote(fee)).toContain('1 new storage slot');
  });

  it('asks for no fee when the node charges no slot, where the access list would count one', async () => {
    const zero = quote({
      chargedFreshSlots: '0x0',
      freshSlots: '0x0',
      requiredPriorityFeePerGas: q(100_000_000n),
      requiredMaxFeePerGas: q(100_000_000n + BASE),
    });
    const { rpc, calls } = rpcWith(() => zero);
    expect(await priceNewSlots(rpc, CALL, ON)).toBeNull();
    expect(calls).toEqual([ADMISSION_QUOTE_METHOD]);
    // The same RPC without the method: the upper bound counts the zero slot.
    const without = rpcWith(() => {
      throw new Error('Method not found');
    });
    expect((await priceNewSlots(without.rpc, CALL, ON))!.possibleNewSlots).toBe(1n);
  });

  it.each([
    [
      'the method is unknown (launch release, gateway without the route)',
      () => {
        throw Object.assign(new Error('Method not found'), { code: -32601 });
      },
    ],
    [
      'the endpoint has no admission policy',
      () => {
        throw Object.assign(new Error('no sequencer admission policy'), { code: -32000 });
      },
    ],
    [
      'the sender balance is below gas x base fee + value',
      () => {
        throw Object.assign(new Error('insufficient balance for the quote'), { code: -32000 });
      },
    ],
    [
      'the EVM permits are busy',
      () => {
        throw Object.assign(new Error('busy'), { code: -32005 });
      },
    ],
    ['the answer is null', () => null],
    ['the answer is another kind', () => quote({ kind: 'something-else' })],
    ['a quantity is missing', () => quote({ gasUsed: undefined })],
    [
      'the max fee is not the requirement plus the base fee',
      () => quote({ requiredMaxFeePerGas: q(1n) }),
    ],
    [
      'the requirement does not pay for the slots it charges',
      () =>
        quote({
          requiredPriorityFeePerGas: q(1_000_000_000n),
          requiredMaxFeePerGas: q(1_000_000_000n + BASE),
        }),
    ],
    ['more slots are charged than exist', () => quote({ chargedFreshSlots: '0x2' })],
    [
      'the gas used is above the gas limit',
      () => quote({ gasUsed: q(100_001n), requiredPriorityFeePerGas: q(4_334_915_578n) }),
    ],
  ] as [string, () => unknown][])(
    'falls back to the access list when %s',
    async (_name, answer) => {
      const { rpc, calls } = rpcWith(answer);
      const fee = (await priceNewSlots(rpc, CALL, ON))!;
      expect(fee.source).toBe('access-list');
      expect(fee.possibleNewSlots).toBe(1n);
      expect(calls).toContain('eth_createAccessList');
      expect(await quoteNewSlots(rpc, CALL, ON)).toBeUndefined();
    },
  );

  it('sends nothing when the node requires more than the page will suggest: no fallback to a lower figure', async () => {
    const dear = quote({
      requiredPriorityFeePerGas: q(14_000_000_000n),
      requiredMaxFeePerGas: q(14_000_000_000n + BASE),
      freshSlotPriceWei: q(600_000_000_000_000n),
    });
    const { rpc, calls } = rpcWith(() => dear);
    await expect(priceNewSlots(rpc, CALL, ON)).rejects.toBeInstanceOf(NewSlotFeeError);
    await expect(priceNewSlots(rpc, CALL, ON)).rejects.toThrow(
      /above the 15 gwei this page will suggest/,
    );
    expect(calls).not.toContain('eth_createAccessList');
    // A published tip or a base fee outside the bounds is refused the same way.
    await expect(
      priceNewSlots(
        rpcWith(() =>
          quote({
            minimumPriorityFeePerGas: q(16_000_000_000n),
            requiredPriorityFeePerGas: q(16_000_000_000n),
            requiredMaxFeePerGas: q(16_000_000_000n + BASE),
          }),
        ).rpc,
        CALL,
        ON,
      ),
    ).rejects.toThrow(/priority fee, above 15 gwei/);
    const hugeBase = 2_000n * 10n ** 9n;
    await expect(
      priceNewSlots(
        rpcWith(() =>
          quote({ baseFeePerGas: q(hugeBase), requiredMaxFeePerGas: q(4_334_915_578n + hugeBase) }),
        ).rpc,
        CALL,
        ON,
      ),
    ).rejects.toThrow(/base fee/);
  });

  it('is not asked at all while the policy is off', async () => {
    const { rpc, calls } = rpcWith(() => quote());
    expect(await priceNewSlots(rpc, CALL, NEW_SLOT_FEE_OFF)).toBeNull();
    expect(calls).toEqual([]);
  });
});
