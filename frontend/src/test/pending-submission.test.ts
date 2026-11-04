import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import type { Rpc } from '../devnet4/chain';
import { submissionBoundary, verifySubmissionHash } from '../mainnet/submission-outcome';
import { pollPendingSwap, type PendingSwap } from '../mainnet/pendingswap';

const hash = (digit: string) => `0x${digit.repeat(64)}` as Hex;
const HASH = hash('1');
const BLOCK = { number: '0x10', hash: hash('2'), timestamp: '0x1000' };
const BOUNDARY = { number: '0xf', hash: hash('7') };
const GENESIS = hash('3');
const FROM = `0x${'4'.repeat(40)}` as const;
const TO = `0x${'5'.repeat(40)}` as const;
const swap: PendingSwap = {
  hash: HASH,
  label: 'Swap',
  deadline: 1000n,
  sentAtMs: 0,
  intent: {
    id: '12345678-1234-1234-1234-123456789abc',
    kind: 'swap',
    chainId: 700770,
    from: FROM,
    to: TO,
    data: '0x1234',
    value: '7',
    gas: '100000',
    nonce: '4',
    afterBlockNumber: '15',
    afterBlockHash: BOUNDARY.hash,
    ...{ genesisHash: GENESIS, deploymentId: hash('6') },
  },
};
const receipt = {
  transactionHash: HASH,
  from: FROM,
  to: TO,
  status: '0x1',
  blockNumber: BLOCK.number,
  blockHash: BLOCK.hash,
  gasUsed: '0x100',
};
const tx = {
  hash: HASH,
  from: FROM,
  to: TO,
  input: '0x1234',
  value: '0x7',
  chainId: '0xab162',
  nonce: '0x4',
  blockNumber: BLOCK.number,
  blockHash: BLOCK.hash,
};
function rpcWith(
  overrides: Partial<Record<string, unknown | ((params: unknown[]) => unknown)>> = {},
): Rpc {
  return async (method, params) => {
    if (method === 'eth_getBlockByNumber' && params[0] === BOUNDARY.number) return BOUNDARY;
    if (method in overrides) {
      const value = overrides[method];
      return typeof value === 'function' ? value(params) : value;
    }
    if (method === 'eth_chainId') return '0xab162';
    if (method === 'eth_getTransactionCount') return '0x4';
    if (method === 'eth_getBlockByNumber')
      return params[0] === '0x0' ? { number: '0x0', hash: GENESIS } : BLOCK;
    if (method === 'eth_getTransactionReceipt') return receipt;
    if (method === 'eth_getTransactionByHash') return tx;
    throw new Error(`Unexpected ${method}`);
  };
}

describe('wallet submission settlement', () => {
  it.each(['0x1', '0x0'])(
    'settles a matching canonical finalized receipt with status %s',
    async (status) => {
      expect(
        await pollPendingSwap(
          rpcWith({ eth_getTransactionReceipt: { ...receipt, status } }),
          swap,
          0,
        ),
      ).toMatchObject({
        kind: 'receipt',
        receipt: {
          status: status === '0x1' ? 'success' : 'reverted',
          blockNumber: 16n,
          gasUsed: 256n,
        },
      });
    },
  );
  it('retains the hold when the receipt is above finality', async () => {
    const rpc = rpcWith({
      eth_getBlockByNumber: (p: unknown[]) =>
        p[0] === '0x0'
          ? { number: '0x0', hash: GENESIS }
          : p[0] === 'finalized'
            ? { ...BLOCK, number: '0xf' }
            : BLOCK,
    });
    expect((await pollPendingSwap(rpc, swap, 0)).kind).not.toBe('receipt');
  });
  it('retains the hold for a receipt belonging to another hash', async () => {
    expect(
      (
        await pollPendingSwap(
          rpcWith({ eth_getTransactionReceipt: { ...receipt, transactionHash: hash('9') } }),
          swap,
          0,
        )
      ).kind,
    ).not.toBe('receipt');
  });
  it('retains the hold for a receipt from a noncanonical block', async () => {
    const rpc = rpcWith({
      eth_getBlockByNumber: (p: unknown[]) =>
        p[0] === '0x0' ? { number: '0x0', hash: GENESIS } : { ...BLOCK, hash: hash('8') },
    });
    expect((await pollPendingSwap(rpc, swap, 0)).kind).not.toBe('receipt');
  });
  it('retains the hold for a different call to the same destination', async () => {
    expect(
      (
        await pollPendingSwap(
          rpcWith({ eth_getTransactionByHash: { ...tx, input: '0x9876' } }),
          swap,
          0,
        )
      ).kind,
    ).not.toBe('receipt');
  });
  it('never releases an absent receipt just because the deadline has passed', async () => {
    expect(
      (await pollPendingSwap(rpcWith({ eth_getTransactionReceipt: null }), swap, 2_000_000)).kind,
    ).toBe('waiting');
  });
  it.each([
    ['from', TO],
    ['to', FROM],
    ['input', '0x123456'],
    ['value', '0x8'],
    ['chainId', '0x1'],
    ['hash', hash('9')],
    ['chainId', undefined],
  ])('retains the hold when transaction %s differs', async (field, value) => {
    expect(
      (
        await pollPendingSwap(
          rpcWith({ eth_getTransactionByHash: { ...tx, [field]: value } }),
          swap,
          0,
        )
      ).kind,
    ).toBe('unreachable');
  });
  it.each([
    ['status', '0x2'],
    ['status', undefined],
    ['blockHash', hash('0')],
    ['blockNumber', '0x010'],
    ['gasUsed', '-1'],
    ['gasUsed', undefined],
    ['from', TO],
    ['to', FROM],
    ['from', undefined],
    ['to', undefined],
  ])('retains the hold for malformed receipt %s', async (field, value) => {
    expect(
      (
        await pollPendingSwap(
          rpcWith({ eth_getTransactionReceipt: { ...receipt, [field]: value } }),
          swap,
          0,
        )
      ).kind,
    ).toBe('unreachable');
  });
  it('retains the hold when the transaction body is unavailable', async () => {
    expect((await pollPendingSwap(rpcWith({ eth_getTransactionByHash: null }), swap, 0)).kind).toBe(
      'waiting',
    );
  });
  it('retains the hold when transaction inclusion disagrees with its receipt', async () => {
    expect(
      (
        await pollPendingSwap(
          rpcWith({ eth_getTransactionByHash: { ...tx, blockHash: hash('8') } }),
          swap,
          0,
        )
      ).kind,
    ).toBe('unreachable');
  });
  it.each([
    null,
    { ...receipt, status: '0x0' },
    { ...receipt, blockHash: hash('8') },
    { ...receipt, gasUsed: '0x101' },
  ])('retains the hold when the receipt changes during verification (%j)', async (changed) => {
    let reads = 0;
    expect(
      (
        await pollPendingSwap(
          rpcWith({ eth_getTransactionReceipt: () => (++reads === 1 ? receipt : changed) }),
          swap,
          0,
        )
      ).kind,
    ).toBe('unreachable');
  });
  it('retains the hold when the transaction changes during verification', async () => {
    let reads = 0;
    expect(
      (
        await pollPendingSwap(
          rpcWith({
            eth_getTransactionByHash: () => (++reads === 1 ? tx : { ...tx, input: '0xabcd' }),
          }),
          swap,
          0,
        )
      ).kind,
    ).toBe('unreachable');
  });
  it('retains the hold when finality regresses during verification', async () => {
    let reads = 0;
    const rpc = rpcWith({
      eth_getBlockByNumber: (p: unknown[]) =>
        p[0] === '0x0'
          ? { number: '0x0', hash: GENESIS }
          : p[0] === 'finalized' && ++reads > 1
            ? { ...BLOCK, number: '0xf' }
            : BLOCK,
    });
    expect((await pollPendingSwap(rpc, swap, 0)).kind).toBe('unreachable');
  });
  it('retains the hold when the canonical checkpoint changes after the first read', async () => {
    let reads = 0;
    const rpc = rpcWith({
      eth_getBlockByNumber: (p: unknown[]) =>
        p[0] === '0x0'
          ? { number: '0x0', hash: GENESIS }
          : p[0] === BLOCK.number && ++reads > 2
            ? { ...BLOCK, hash: hash('8') }
            : BLOCK,
    });
    expect((await pollPendingSwap(rpc, swap, 0)).kind).toBe('unreachable');
  });
  it('retains the hold on an RPC chain switch', async () => {
    expect((await pollPendingSwap(rpcWith({ eth_chainId: '0x1' }), swap, 0)).kind).toBe(
      'unreachable',
    );
  });
  it('retains the hold on an RPC genesis switch during verification', async () => {
    let reads = 0;
    const rpc = rpcWith({
      eth_getBlockByNumber: (p: unknown[]) =>
        p[0] === '0x0' ? { number: '0x0', hash: ++reads === 1 ? GENESIS : hash('8') } : BLOCK,
    });
    expect((await pollPendingSwap(rpc, swap, 0)).kind).toBe('unreachable');
  });
  it('refuses to reconcile an intent under another deployment context', async () => {
    const context = { ...swap.intent!, deploymentId: hash('8') };
    expect((await pollPendingSwap(rpcWith(), swap, 0, context)).kind).toBe('unreachable');
  });
  it('can recover tracking for a matching pending transaction body', async () => {
    await expect(
      verifySubmissionHash(
        rpcWith({ eth_getTransactionByHash: { ...tx, blockNumber: null, blockHash: null } }),
        HASH,
        swap.intent!,
        swap.intent!,
      ),
    ).resolves.toBeUndefined();
  });
  it('refuses recovery when the same destination received another call', async () => {
    await expect(
      verifySubmissionHash(
        rpcWith({ eth_getTransactionByHash: { ...tx, input: '0xabcd' } }),
        HASH,
        swap.intent!,
        swap.intent!,
      ),
    ).rejects.toThrow(/does not match/);
  });
  it('refuses recovery when no transaction body is available', async () => {
    await expect(
      verifySubmissionHash(
        rpcWith({ eth_getTransactionByHash: null }),
        HASH,
        swap.intent!,
        swap.intent!,
      ),
    ).rejects.toThrow(/no transaction body/);
  });
  it('refuses a historically identical call mined before the saved wallet request', async () => {
    const historical = {
      ...swap,
      intent: { ...swap.intent!, afterBlockNumber: '16', afterBlockHash: BLOCK.hash },
    };
    expect((await pollPendingSwap(rpcWith(), historical, 0)).kind).toBe('unreachable');
    await expect(
      verifySubmissionHash(rpcWith(), HASH, historical.intent, historical.intent),
    ).rejects.toThrow(/historical hash/);
  });
  it('retains the hold when the saved pre-wallet checkpoint is no longer canonical', async () => {
    const orphaned = { ...swap, intent: { ...swap.intent!, afterBlockHash: hash('8') } };
    expect((await pollPendingSwap(rpcWith(), orphaned, 0)).kind).toBe('unreachable');
    await expect(
      verifySubmissionHash(rpcWith(), HASH, orphaned.intent, orphaned.intent),
    ).rejects.toThrow(/no longer canonical/);
  });
  it('does not settle an identical call with a different nonce', async () => {
    const bound = { ...swap, intent: { ...swap.intent!, nonce: '4' } };
    const rpc = rpcWith({ eth_getTransactionByHash: { ...tx, nonce: '0x5' } });
    expect((await pollPendingSwap(rpc, bound, 0)).kind).toBe('unreachable');
  });
  it('does not recover an identical call with a different nonce', async () => {
    const bound = { ...swap.intent!, nonce: '4' };
    await expect(
      verifySubmissionHash(
        rpcWith({ eth_getTransactionByHash: { ...tx, nonce: '0x5' } }),
        HASH,
        bound,
        bound,
      ),
    ).rejects.toThrow(/nonce/);
  });

  it('pins an unused nonce and canonical head before requesting the wallet', async () => {
    expect(await submissionBoundary(rpcWith(), swap.intent!, FROM)).toEqual({
      afterBlockNumber: '16',
      afterBlockHash: BLOCK.hash,
      nonce: '4',
    });
  });
  it('refuses to choose a nonce when pending activity already exists', async () => {
    const rpc = rpcWith({
      eth_getTransactionCount: (p: unknown[]) => (p[1] === 'pending' ? '0x5' : '0x4'),
    });
    await expect(submissionBoundary(rpc, swap.intent!, FROM)).rejects.toThrow(/pending activity/);
  });
  it.each(['0x04', '-1', null, '0xffffffffffffffff'])(
    'refuses an invalid or exhausted account nonce (%j)',
    async (nonce) => {
      await expect(
        submissionBoundary(rpcWith({ eth_getTransactionCount: nonce }), swap.intent!, FROM),
      ).rejects.toThrow();
    },
  );
  it('refuses a nonce prepared while the latest head moves', async () => {
    let reads = 0;
    const rpc = rpcWith({
      eth_getBlockByNumber: (p: unknown[]) =>
        p[0] === '0x0'
          ? { number: '0x0', hash: GENESIS }
          : p[0] === 'latest' && ++reads > 1
            ? { ...BLOCK, number: '0x11' }
            : BLOCK,
    });
    await expect(submissionBoundary(rpc, swap.intent!, FROM)).rejects.toThrow(/head changed/);
  });
  it('pins the nonce read to the canonical block hash without a number fallback', async () => {
    const calls: unknown[][] = [];
    const rpc = rpcWith({
      eth_getTransactionCount: (p: unknown[]) => {
        calls.push(p);
        return '0x4';
      },
    });
    await submissionBoundary(rpc, swap.intent!, FROM);
    expect(calls).toEqual([
      [FROM, { blockHash: BLOCK.hash, requireCanonical: true }],
      [FROM, 'pending'],
    ]);
  });
  it('fails before the wallet when a canonical hash-pinned nonce read is unsupported', async () => {
    let calls = 0;
    const rpc = rpcWith({
      eth_getTransactionCount: () => {
        calls++;
        throw new Error('unsupported block identifier');
      },
    });
    await expect(submissionBoundary(rpc, swap.intent!, FROM)).rejects.toThrow(
      /canonical hash-pinned nonce read is required/,
    );
    expect(calls).toBe(1);
  });
});
