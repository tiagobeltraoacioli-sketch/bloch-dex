// Review r18, fourth pass (agent 364, continues 328): attacks on postern-dex 9e4b5d1 (multichain/rpc.ts and
// submission-outcome.ts). Goal: get ONE endpoint's value into anything the user signs or into a hold decision.
// Model nodes share one honest chain (block n: hash h(n), timestamp 1,000,000 + 2n).
import { describe, expect, it, vi } from 'vitest';
import type { Rpc } from '../../devnet4/chain';
import { BEHIND, DISAGREEMENT, UNCONFIRMED, chainRpc } from '../../multichain/rpc';

const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const q = (n: number) => `0x${n.toString(16)}`;
type Lie = { head?: number; time?: number; nonce?: number; pending?: number; call?: number };
function node(head: number, lie: Lie = {}) {
  return vi.fn<Rpc>(async (method, params) => {
    const p = params as unknown[];
    if (method === 'eth_getBlockByNumber' || method === 'eth_getBlockByHash') {
      const tag = p[0] as string;
      const top = lie.head ?? head;
      const n =
        method === 'eth_getBlockByHash'
          ? Number(BigInt(tag))
          : tag === 'latest'
            ? top
            : tag === 'finalized'
              ? head - 600
              : tag === 'safe'
                ? head - 300
                : Number(BigInt(tag));
      if (n > top) return null;
      const time = 1_000_000 + 2 * n + (n > head ? (lie.time ?? 0) : 0);
      return { number: q(n), hash: h(n), timestamp: q(time) };
    }
    if (method === 'eth_getTransactionCount') {
      if (p[1] === 'pending') return q(lie.pending ?? 5);
      return q(lie.nonce ?? 5);
    }
    if (method === 'eth_call') {
      const at = p[1] as { blockHash?: string } | string;
      if (typeof at !== 'object') return q(1 + (lie.call ?? 0)); // only reached if a tag were ever sent
      return q(Number(BigInt(at.blockHash!)) + (lie.call ?? 0));
    }
    throw new Error(`unexpected ${method}`);
  });
}
const RULES = { settle: { depth: 5 }, strict: { tag: 'finalized' as const }, reverted: { tag: 'safe' as const } };
const head = async (rpc: Rpc) =>
  (await rpc('eth_getBlockByNumber', ['latest', false])) as { number: string; timestamp: string };
const A = '0x' + '11'.repeat(20);

describe('fourth pass: signed values', () => {
  it('deadline clock: an endpoint that reports a newer head with a far-future time cannot move the head time used', async () => {
    // The liar claims block 1,001 exists with a timestamp an hour ahead. Two blocks of gap or less is never
    // "apart", so the older head (1,000, honest, confirmed by the liar at that height) is used.
    const rpc = chainRpc([node(1_000, { head: 1_001, time: 3_600 }), node(1_000)], RULES);
    const b = await head(rpc);
    expect(b.number).toBe(q(1_000));
    expect(b.timestamp).toBe(q(1_000_000 + 2_000));
  });

  it('account nonce (the one the wallet is asked to use): a pinned read is agreed; a lie is a disagreement', async () => {
    const rpc = chainRpc([node(1_000, { nonce: 9 }), node(1_000)], RULES);
    const b = (await rpc('eth_getBlockByNumber', ['latest', false])) as { hash: string };
    await expect(
      rpc('eth_getTransactionCount', [A, { blockHash: b.hash, requireCanonical: true }]),
    ).rejects.toThrow(DISAGREEMENT);
  });

  it('pending nonce: the HIGHER of two answers; a lower lie (hiding a queued transaction) is not used', async () => {
    expect(await chainRpc([node(1_000, { pending: 4 }), node(1_000)], RULES)('eth_getTransactionCount', [A, 'pending'])).toBe(q(5));
    // A higher lie only makes the page refuse ("pending activity"); it never becomes the signed nonce, which is the
    // agreed pinned nonce (submissionBoundary asserts pinned === pending).
    expect(await chainRpc([node(1_000, { pending: 9 }), node(1_000)], RULES)('eth_getTransactionCount', [A, 'pending'])).toBe(q(9));
  });

  it('state by NUMBER (a read the route could add later) is resolved and agreed, never sent by number', async () => {
    const liar = node(1_000, { call: 7 });
    const rpc = chainRpc([liar, node(1_000)], RULES);
    await expect(rpc('eth_call', [{ to: A, data: '0x' }, q(990)])).rejects.toThrow(DISAGREEMENT);
    expect(liar.mock.calls.every(([m, p]) => m !== 'eth_call' || typeof (p as unknown[])[1] === 'object')).toBe(true);
  });

  it('a read with no block is refused or resolved, never one endpoint\'s: pending/earliest state is refused', async () => {
    const rpc = chainRpc([node(1_000), node(1_000)], RULES);
    await expect(rpc('eth_call', [{ to: A, data: '0x' }, 'pending'])).rejects.toThrow(/names no block/);
    await expect(rpc('eth_getBalance', [A, 'earliest'])).rejects.toThrow(/names no block/);
  });
});

describe('fourth pass: hold decisions', () => {
  it('the reverted rule (safe): one endpoint claiming a newer safe block cannot make it newer (older of two)', async () => {
    const rpc = chainRpc([node(1_000), node(1_200)], RULES);
    // node(1,200) is 200 blocks / 400 s ahead: for `latest` that is BEHIND; for `safe` the older answer is used.
    const safe = (await rpc.reverted('eth_getBlockByNumber', ['finalized', false])) as { number: string };
    expect(safe.number).toBe(q(700));
  });
});

describe('fourth pass: availability (R364-1)', () => {
  it('ONE endpoint that reports a far-ahead head stops the page although two others agree (newest two are compared)', async () => {
    const rpc = chainRpc([node(1_000, { head: 1_500 }), node(1_000), node(1_000)], RULES);
    await expect(head(rpc)).rejects.toThrow(BEHIND);
  });
  it('the same liar placed third is never asked when the first two agree', async () => {
    const third = node(1_000, { head: 1_500 });
    const rpc = chainRpc([node(1_000), node(1_000), third], RULES);
    expect((await head(rpc)).number).toBe(q(1_000));
    expect(third).not.toHaveBeenCalled();
  });
  it('fails closed, never open: an unreachable second endpoint and no third -> UNCONFIRMED', async () => {
    const down: Rpc = async () => {
      throw new Error('fetch failed');
    };
    await expect(head(chainRpc([node(1_000), down], RULES))).rejects.toThrow(UNCONFIRMED);
  });
});
