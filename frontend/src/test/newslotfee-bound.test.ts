// Review R309-A3 (round 15), the reviewer's demonstration (commit 665fb6b on codex/dex-review-r15-20261110)
// turned into a regression test: the bound of the suggested tip holds for the whole suggestion.
import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import type { Rpc } from '../devnet4/chain';
import {
  MAX_PUBLISHED_TIP_WEI,
  NEW_SLOT_FEE_OFF,
  NewSlotFeeError,
  priceNewSlots,
  type NewSlotFeePolicy,
} from '../mainnet/newslotfee';

const TOKEN = '0x1b7c0fb59f34683cd9214566636e63a0f7e092f6' as Address;
const FROM = '0x72dc623d4c03c996a3d20ed2674f24570e8acf44' as Address;
const ON: NewSlotFeePolicy = { ...NEW_SLOT_FEE_OFF, enabled: true };
const key = `0x${'1'.padStart(64, '0')}`;
const GWEI = 10n ** 9n;
const rpcWith =
  (publishedTip: bigint): Rpc =>
  async (method) => {
    switch (method) {
      case 'eth_createAccessList':
        return { accessList: [{ address: TOKEN, storageKeys: [key] }], gasUsed: '0x7a120' };
      case 'eth_getStorageAt':
        return '0x0';
      case 'eth_maxPriorityFeePerGas':
        return `0x${publishedTip.toString(16)}`;
      case 'eth_getBlockByNumber':
        return { baseFeePerGas: `0x${(1000n * GWEI).toString(16)}` };
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
const call = { from: FROM, to: TOKEN, data: '0x095ea7b3' as Hex, value: 0n, gas: 500_000n };

describe('R309-A3: the suggested tip is bounded whatever the RPC answers', () => {
  it('refuses to price with an RPC that publishes a 100 gwei priority fee: nothing is suggested or sent', async () => {
    await expect(priceNewSlots(rpcWith(100n * GWEI), call, ON)).rejects.toBeInstanceOf(
      NewSlotFeeError,
    );
    await expect(priceNewSlots(rpcWith(MAX_PUBLISHED_TIP_WEI + 1n), call, ON)).rejects.toThrow(
      /priority fee, above 15 gwei/,
    );
  });

  it('never suggests more than 15 gwei of tip: 0.0075 BLCH on a 500,000-gas swap', async () => {
    expect(MAX_PUBLISHED_TIP_WEI).toBe(15n * GWEI);
    const fee = await priceNewSlots(rpcWith(MAX_PUBLISHED_TIP_WEI), call, ON);
    expect(fee!.maxPriorityFeePerGas).toBe(15n * GWEI);
    expect(fee!.maxPriorityFeePerGas * 500_000n).toBe(75n * 10n ** 14n);
    // With an honest tip the slot term decides, and it is below its own 13.75 gwei bound.
    const honest = await priceNewSlots(rpcWith(GWEI), call, ON);
    expect(honest!.maxPriorityFeePerGas).toBeLessThanOrEqual(13_750_000_000n);
    expect(honest!.maxPriorityFeePerGas).toBeGreaterThanOrEqual(GWEI);
  });
});
