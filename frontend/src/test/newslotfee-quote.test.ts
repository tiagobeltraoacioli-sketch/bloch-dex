// The node's admission quote (bloch_admissionQuote, bloch-l2-evm 24a116e; ABI in
// agents/R15-CROSS-AREA.md, 2026-11-11 01:15 UTC) never wins alone (review R309-2P-2, 2P-6): the
// page always computes its own access-list figure, suggests the larger of the two inside the
// 15 gwei bound, and sends nothing when they disagree by more than a factor of two. The node's
// figures of the first case are its own for a first approve of the real bridge token, measured on
// the user-transaction candidate (round 15). The reviewer's demonstrations (bfeb942) are the
// regression tests marked R309-2P.
import { describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import type { Rpc } from '../devnet4/chain';
import {
  ADMISSION_QUOTE_METHOD,
  NEW_SLOT_FEE_OFF,
  MAX_PUBLISHED_TIP_WEI,
  NewSlotFeeError,
  QUOTE_DISAGREEMENT_FACTOR,
  parseNewSlotFeePolicy,
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

const ACCESS_LIST_TIP = 4_995_798_988n; // ceil(1 x 200e12 x 1.1 / (48,337 - 2,400 - 1,900))

describe('the node quote and the page computation together', () => {
  it('suggests the larger of the two: here the page figure, 15% above the node requirement', async () => {
    const { rpc, calls } = rpcWith(() => quote());
    const fee = (await priceNewSlots(rpc, CALL, ON))!;
    // The node requires 4,334,915,578 (x 1.1 = 4,768,407,136); the page's own bound is higher and stands.
    expect(fee.source).toBe('access-list');
    expect(fee.maxPriorityFeePerGas).toBe(ACCESS_LIST_TIP);
    expect(fee.possibleNewSlots).toBe(1n);
    expect(calls[0]).toBe(ADMISSION_QUOTE_METHOD);
    expect(calls).toContain('eth_createAccessList');
    expect(newSlotFeeNote(fee)).toContain('1 new storage slot');
  });

  it('follows the node when it asks more than the page computes, up to twice as much', async () => {
    // An operator price above the network file's: 300 µBLCH per slot.
    const required = 6_502_373_367n; // ceil(300e12 / 46,137)
    const dearer = quote({
      requiredPriorityFeePerGas: q(required),
      requiredMaxFeePerGas: q(required + BASE),
      freshSlotPriceWei: q(300_000_000_000_000n),
    });
    const fee = (await priceNewSlots(rpcWith(() => dearer).rpc, CALL, ON))!;
    expect(fee.source).toBe('quote');
    expect(fee.maxPriorityFeePerGas).toBe((required * 11_000n + 9_999n) / 10_000n);
    expect(fee.maxPriorityFeePerGas).toBeGreaterThan(ACCESS_LIST_TIP);
    expect(fee.maxFeePerGas).toBe(2n * BASE + fee.maxPriorityFeePerGas);
  });

  it('R309-2P-2: sends nothing when the node asks more than twice the page figure (a lying RPC cannot move 4.8 gwei to 15)', async () => {
    expect(QUOTE_DISAGREEMENT_FACTOR).toBe(2n);
    const required = 13_636_363_636n;
    const lying = quote({
      requiredPriorityFeePerGas: q(required),
      requiredMaxFeePerGas: q(required + BASE),
      freshSlotPriceWei: '0x1',
    });
    await expect(priceNewSlots(rpcWith(() => lying).rpc, CALL, ON)).rejects.toThrow(
      /more than 2 times the 4\.995798988 gwei the page computes/,
    );
    // Just inside the factor it is followed; one wei per gas above it is not.
    const edge = (tip: bigint) => {
      // required such that ceil(required x 1.1) == tip
      const r = (tip * 10_000n) / 11_000n;
      return quote({
        requiredPriorityFeePerGas: q(r),
        requiredMaxFeePerGas: q(r + BASE),
        freshSlotPriceWei: q(r * 46_137n),
      });
    };
    const inside = await priceNewSlots(rpcWith(() => edge(2n * ACCESS_LIST_TIP)).rpc, CALL, ON);
    expect(inside!.maxPriorityFeePerGas).toBeLessThanOrEqual(2n * ACCESS_LIST_TIP);
    expect(inside!.source).toBe('quote');
    await expect(
      priceNewSlots(rpcWith(() => edge(2n * ACCESS_LIST_TIP + 2_000n)).rpc, CALL, ON),
    ).rejects.toBeInstanceOf(NewSlotFeeError);
  });

  it('R309-2P-2: a quote that charges no slot does not lower the page figure, and the access list is read', async () => {
    const zero = quote({
      chargedFreshSlots: '0x0',
      freshSlots: '0x1',
      headHash: `0x${'0'.repeat(64)}`,
      headNumber: '0x1',
      nonce: '0x63',
      requiredPriorityFeePerGas: q(100_000_000n),
      requiredMaxFeePerGas: q(100_000_000n + BASE),
    });
    const { rpc, calls } = rpcWith(() => zero);
    const fee = (await priceNewSlots(rpc, CALL, ON))!;
    expect(fee.source).toBe('access-list');
    expect(fee.maxPriorityFeePerGas).toBe(ACCESS_LIST_TIP);
    expect(calls).toContain('eth_createAccessList');
  });

  it('sends nothing when the node charges a slot the page cannot find', async () => {
    const calls: string[] = [];
    const rpc: Rpc = async (method) => {
      calls.push(method);
      if (method === ADMISSION_QUOTE_METHOD) return quote();
      if (method === 'eth_createAccessList') return { accessList: [], gasUsed: '0xb411' };
      throw new Error(`unexpected ${method}`);
    };
    await expect(priceNewSlots(rpc, CALL, ON)).rejects.toThrow(
      /charges 1 new storage slot\(s\) for this transaction, but the page finds none/,
    );
  });

  it('asks for no fee when neither the node nor the page finds a new slot', async () => {
    const zero = quote({
      chargedFreshSlots: '0x0',
      freshSlots: '0x0',
      requiredPriorityFeePerGas: q(100_000_000n),
      requiredMaxFeePerGas: q(100_000_000n + BASE),
    });
    const rpc: Rpc = async (method) => {
      if (method === ADMISSION_QUOTE_METHOD) return zero;
      if (method === 'eth_createAccessList') return { accessList: [], gasUsed: '0xb411' };
      throw new Error(`unexpected ${method}`);
    };
    expect(await priceNewSlots(rpc, CALL, ON)).toBeNull();
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
  ] as [string, () => unknown][])('the page figure stands alone when %s', async (_name, answer) => {
    const { rpc } = rpcWith(answer);
    const fee = (await priceNewSlots(rpc, CALL, ON))!;
    expect(fee.source).toBe('access-list');
    expect(fee.maxPriorityFeePerGas).toBe(ACCESS_LIST_TIP);
    expect(await quoteNewSlots(rpc, CALL, ON)).toBeUndefined();
  });

  it('sends nothing when the node requires more than the absolute bound', async () => {
    const dear = quote({
      requiredPriorityFeePerGas: q(14_000_000_000n),
      requiredMaxFeePerGas: q(14_000_000_000n + BASE),
      freshSlotPriceWei: q(600_000_000_000_000n),
    });
    await expect(priceNewSlots(rpcWith(() => dear).rpc, CALL, ON)).rejects.toThrow(
      /above the 15 gwei this page will suggest/,
    );
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

  it('R309-2P-6: the access-list figure itself never exceeds 15 gwei, whatever margin the network file carries', async () => {
    const policy = parseNewSlotFeePolicy({
      enabled: true,
      freshSlotPriceWei: '200000000000000',
      marginBps: 5000,
    });
    const keys = Array.from(
      { length: 100 },
      (_, i) => `0x${(i + 1).toString(16).padStart(64, '0')}`,
    );
    const used = 21_000n + 16_000n * 100n;
    const rpc: Rpc = async (method) => {
      switch (method) {
        case ADMISSION_QUOTE_METHOD:
          throw new Error('method not found');
        case 'eth_createAccessList':
          return {
            accessList: [{ address: TOKEN, storageKeys: keys }],
            gasUsed: q(used + 2_400n + 1_900n * 100n),
          };
        case 'eth_maxPriorityFeePerGas':
          return q(1_000_000_000n);
        case 'eth_getBlockByNumber':
          return { baseFeePerGas: q(BASE) };
        default:
          throw new Error(`unexpected ${method}`);
      }
    };
    // 18.5 gwei would be needed: nothing is suggested or sent.
    await expect(
      priceNewSlots(
        rpc,
        { from: FROM, to: TOKEN, data: '0x095ea7b3' as Hex, value: 0n, gas: 2_000_000n },
        policy,
      ),
    ).rejects.toThrow(/18\.507094387 gwei for its new storage slots, above the 15 gwei/);
    expect(MAX_PUBLISHED_TIP_WEI).toBe(15_000_000_000n);
  });

  it('is not asked at all while the policy is off', async () => {
    const { rpc, calls } = rpcWith(() => quote());
    expect(await priceNewSlots(rpc, CALL, NEW_SLOT_FEE_OFF)).toBeNull();
    expect(calls).toEqual([]);
  });
});
