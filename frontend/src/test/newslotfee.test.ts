import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import type { Rpc } from '../devnet4/chain';
import { sendTransaction } from '../devnet4/swap';
import {
  DEFAULT_FRESH_SLOT_PRICE_WEI,
  MAX_STORAGE_READS,
  NEW_SLOT_FEE_OFF,
  newSlotFeeNote,
  parseNewSlotFeePolicy,
  priceNewSlots,
  slotTipFor,
  type NewSlotFeePolicy,
} from '../mainnet/newslotfee';
// The L2 settled RPC's own refusal of an underpriced first approve (local admission rehearsal).
import refusal from './fixtures/sequencer-fee-error.json';

const TOKEN = '0x1b7c0fb59f34683cd9214566636e63a0f7e092f6' as Address;
const FROM = '0x72dc623d4c03c996a3d20ed2674f24570e8acf44' as Address;
const ON: NewSlotFeePolicy = { ...NEW_SLOT_FEE_OFF, enabled: true };
const CALL = { from: FROM, to: TOKEN, data: '0x095ea7b3' as Hex, value: 0n, gas: 100_000n };
const key = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

type Node = {
  keys?: string[];
  zero?: string[];
  gasUsed?: string;
  tip?: string;
  baseFee?: string;
  error?: string;
  calls: { method: string; params: unknown[] }[];
};
function node(change: Partial<Node> = {}): { rpc: Rpc; n: Node } {
  const n: Node = { keys: [key(1)], zero: [key(1)], calls: [], ...change };
  const rpc: Rpc = async (method, params) => {
    n.calls.push({ method, params });
    switch (method) {
      case 'eth_createAccessList':
        return {
          accessList: n.keys!.length ? [{ address: TOKEN, storageKeys: n.keys }] : [],
          gasUsed: n.gasUsed ?? '0xb3b0',
          ...(n.error ? { error: n.error } : {}),
        };
      case 'eth_getStorageAt':
        return n.zero!.includes(String(params[1])) ? '0x0' : `0x${'00'.repeat(31)}01`;
      case 'eth_maxPriorityFeePerGas':
        return n.tip ?? '0x5f5e100';
      case 'eth_getBlockByNumber':
        return { baseFeePerGas: n.baseFee ?? '0x3b9aca00' };
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
  return { rpc, n };
}

describe('new-slot priority fee', () => {
  it('prices a first approve: one zero slot at 200 µBLCH plus 10%, over the simulated gas, rounded up', async () => {
    const { rpc, n } = node();
    const fee = (await priceNewSlots(rpc, CALL, ON))!;
    // Simulated 46,000 gas with a one-address, one-key access list: 46,000 - 2,400 - 1,900 = 41,700
    // without it. ceil(1 x 200e12 x 1.1 / 41700).
    expect(fee.gasUsed).toBe(41_700n);
    expect(fee.maxPriorityFeePerGas).toBe(5_275_779_377n);
    expect(fee.maxFeePerGas).toBe(2n * 1_000_000_000n + 5_275_779_377n);
    expect(fee.possibleNewSlots).toBe(1n);
    expect(fee.slotCostWei).toBe(DEFAULT_FRESH_SLOT_PRICE_WEI);
    // What the RPC checks: gasUsed x tip >= slots x price.
    expect(fee.gasUsed * fee.maxPriorityFeePerGas).toBeGreaterThanOrEqual(fee.slotCostWei);
    expect(n.calls.map((c) => c.method)).toEqual([
      'eth_createAccessList',
      'eth_getStorageAt',
      'eth_maxPriorityFeePerGas',
      'eth_getBlockByNumber',
    ]);
    expect(n.calls[0].params).toEqual([
      { from: FROM, to: TOKEN, data: '0x095ea7b3', value: '0x0', gas: '0x186a0' },
      'latest',
    ]);
    expect(newSlotFeeNote(fee)).toContain('1 new storage slot');
    expect(newSlotFeeNote(fee)).toContain('5.275779377 gwei');
  });

  it("satisfies the RPC's own refusal fixture: its gas and slot count priced here pass its rule", async () => {
    const d = refusal.error.data;
    // The RPC measured 46,095 gas for the approve as the wallet sends it (no access list);
    // eth_createAccessList reports the run WITH the list, 4,300 intrinsic gas dearer at most.
    const withList = `0x${(BigInt(d.gasUsed) + 4_300n).toString(16)}`;
    const { rpc } = node({ gasUsed: withList, baseFee: d.baseFeePerGas });
    const policy = { ...ON, freshSlotPriceWei: BigInt(d.freshSlotPriceWei), marginBps: 0 };
    const fee = (await priceNewSlots(rpc, { ...CALL, gas: 200_000n }, policy))!;
    expect(fee.possibleNewSlots).toBe(BigInt(d.chargedFreshSlots));
    // With no margin the page's figure is exactly the RPC's requiredPriorityFeePerGas.
    expect(fee.maxPriorityFeePerGas).toBe(BigInt(d.requiredPriorityFeePerGas));
    expect(fee.maxFeePerGas).toBeGreaterThanOrEqual(BigInt(d.requiredMaxFeePerGas));
  });

  it('leaves the wallet request alone when the policy is off or no touched key reads zero', async () => {
    const off = node();
    expect(await priceNewSlots(off.rpc, CALL, NEW_SLOT_FEE_OFF)).toBeNull();
    expect(off.n.calls).toEqual([]);
    const repeat = node({ zero: [] });
    expect(await priceNewSlots(repeat.rpc, CALL, ON)).toBeNull();
    const none = node({ keys: [] });
    expect(await priceNewSlots(none.rpc, CALL, ON)).toBeNull();
    expect(none.n.calls.map((c) => c.method)).toEqual(['eth_createAccessList']);
    expect(newSlotFeeNote(null)).toBe('');
  });

  it('keeps the published tip when it is higher, and counts only zero keys', async () => {
    const { rpc } = node({
      keys: [key(1), key(2), key(3)],
      zero: [key(1), key(3)],
      tip: '0x4a817c800',
    });
    const fee = (await priceNewSlots(rpc, CALL, ON))!;
    expect(fee.possibleNewSlots).toBe(2n);
    // 2 slots need ceil(2 x 200e12 x 1.1 / 37900) = 11,609,498,681 < the published 20 gwei.
    expect(fee.maxPriorityFeePerGas).toBe(20_000_000_000n);
    expect(newSlotFeeNote(fee)).toBe('');
  });

  it('counts every key without reading when the call touches too many', async () => {
    const keys = Array.from({ length: MAX_STORAGE_READS + 1 }, (_, i) => key(i + 1));
    const { rpc, n } = node({ keys, zero: [] });
    const fee = (await priceNewSlots(rpc, CALL, ON))!;
    expect(fee.possibleNewSlots).toBe(BigInt(keys.length));
    expect(n.calls.some((c) => c.method === 'eth_getStorageAt')).toBe(false);
  });

  it('refuses instead of guessing: a reverting call, malformed replies, absurd figures', async () => {
    const cases: [Partial<Node>, RegExp][] = [
      [{ error: 'execution reverted' }, /would fail if sent now/],
      [{ gasUsed: '0x1' }, /simulated gas/],
      [{ gasUsed: '0x30d40' }, /simulated gas/],
      [{ gasUsed: 'nope' }, /no simulated gas/],
      [{ tip: '0x174876e801' }, /priority fee/],
      [{ baseFee: undefined as unknown as string, tip: '0x' }, /no priority fee/],
      [{ keys: Array.from({ length: 200 }, (_, i) => key(i + 1)) }, /at most 128/],
      [{ keys: ['0x12'] }, /malformed access list/],
    ];
    for (const [change, message] of cases)
      await expect(priceNewSlots(node(change).rpc, CALL, ON)).rejects.toThrow(message);
    const down: Rpc = async () => {
      throw new Error('RPC down');
    };
    await expect(priceNewSlots(down, CALL, ON)).rejects.toThrow('RPC down');
    const noList: Rpc = async () => null;
    await expect(priceNewSlots(noList, CALL, ON)).rejects.toThrow(/no access list/);
  });

  it('rounds the tip up and never divides by zero gas', () => {
    expect(slotTipFor(1n, 3n, 10n, 0)).toBe(4n);
    expect(slotTipFor(1n, 3n, 9n, 0)).toBe(3n);
    expect(slotTipFor(0n, 0n, 9n, 0)).toBe(0n);
    expect(() => slotTipFor(1n, 0n, 9n, 0)).toThrow(/gas used/);
  });

  it('reads the network file block strictly; absent means off', () => {
    expect(parseNewSlotFeePolicy(undefined)).toEqual(NEW_SLOT_FEE_OFF);
    expect(parseNewSlotFeePolicy({ enabled: true })).toEqual(ON);
    expect(
      parseNewSlotFeePolicy({ enabled: true, freshSlotPriceWei: '300000000000000', marginBps: 0 }),
    ).toEqual({ enabled: true, freshSlotPriceWei: 300_000_000_000_000n, marginBps: 0 });
    for (const bad of [
      [],
      { enabled: 'yes' },
      { enabled: true, method: 'bloch_newSlotTip' },
      { enabled: true, freshSlotPriceWei: 200 },
      { enabled: true, freshSlotPriceWei: '0' },
      { enabled: true, freshSlotPriceWei: '0x10' },
      { enabled: true, freshSlotPriceWei: '10000000000000001' },
      { enabled: true, marginBps: 5001 },
      { enabled: true, marginBps: -1 },
      { enabled: true, marginBps: 1.5 },
    ])
      expect(() => parseNewSlotFeePolicy(bad)).toThrow(/newSlotFee/);
  });

  it('the wallet request carries both fee fields or neither', async () => {
    const seen: unknown[] = [];
    const provider = {
      async request({ params }: { method: string; params?: unknown[] }) {
        seen.push(params![0]);
        return `0x${'1'.repeat(64)}`;
      },
    };
    const tx = { ...CALL, chainId: 700770, nonce: 3n };
    await sendTransaction(provider, { ...tx, maxPriorityFeePerGas: 5n, maxFeePerGas: 9n });
    await sendTransaction(provider, { ...tx, maxPriorityFeePerGas: 5n });
    await sendTransaction(provider, tx);
    expect(seen[0]).toMatchObject({
      maxPriorityFeePerGas: '0x5',
      maxFeePerGas: '0x9',
      nonce: '0x3',
    });
    expect(seen[1]).not.toHaveProperty('maxPriorityFeePerGas');
    expect(seen[2]).not.toHaveProperty('maxFeePerGas');
  });
});
