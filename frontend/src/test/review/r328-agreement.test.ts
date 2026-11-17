// Review r17 (agent 328): what the two-endpoint agreement of multichain/rpc.ts binds at 0566af3, and what it
// does not. Two model nodes share one honest chain (block n has hash h(n); the pool's reserve at block n is n);
// the first endpoint of the page is the one that may lie.
import { describe, expect, it } from 'vitest';
import type { Rpc } from '../../devnet4/chain';
import { BEHIND, DISAGREEMENT, UNCONFIRMED, chainRpc } from '../../multichain/rpc';

const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const q = (n: number) => `0x${n.toString(16)}`;
const numberOf = (hash: string) => Number(BigInt(hash));

/** An honest node at `head`. A pinned eth_call answers the reserve at that block; receipts are unknown. */
function honest(head: number, oldestState = 0): Rpc {
  return async (method, params) => {
    if (method === 'eth_getBlockByNumber') {
      const tag = (params as [string])[0];
      const n = tag === 'latest' ? head : tag === 'finalized' ? head - 600 : Number(BigInt(tag));
      return n > head ? null : { number: q(n), hash: h(n), timestamp: q(1_000_000 + 2 * n) };
    }
    if (method === 'eth_call') {
      const at = (params as [unknown, { blockHash: string }])[1];
      const n = numberOf(at.blockHash);
      if (n > head) throw new Error('header not found');
      if (n < oldestState) throw new Error('Archive requests require a personal token');
      return q(n);
    }
    if (method === 'eth_getTransactionReceipt') return null;
    throw new Error(`unexpected ${method}`);
  };
}
const RULES = { settle: { depth: 5 }, strict: { tag: 'finalized' as const } };
const settleBlock = async (rpc: Rpc) =>
  (await rpc('eth_getBlockByNumber', ['finalized', false])) as { number: string; hash: string };
const reserveAt = (rpc: Rpc, hash: string) => rpc('eth_call', [{ to: '0x00', data: '0x' }, { blockHash: hash }]);

describe('R309-MC-3 at 0566af3: one lying endpoint', () => {
  it('FIXED for state: a first endpoint that answers a pinned read falsely is refused, nothing is used', async () => {
    const lying: Rpc = async (method, params) =>
      method === 'eth_call' ? q(999_999) : honest(1_000)(method, params);
    const rpc = chainRpc([lying, honest(1_000)], RULES);
    const block = await settleBlock(rpc);
    expect(block.number).toBe(q(995));
    await expect(reserveAt(rpc, block.hash)).rejects.toThrow(DISAGREEMENT);
  });

  it('R328-6: WHICH block is "settled" is the first endpoint alone: a real block from 9 minutes ago is accepted, and the second endpoint confirms its (stale) state', async () => {
    // The chain is at block 1,000 (2 s blocks). The first endpoint presents block 730 as the head.
    const stale = honest(730);
    const rpc = chainRpc([stale, honest(1_000)], RULES);
    // Restated in the fourth pass (agent 364): the defect shown here at 0566af3 (the stale block 725 was accepted
    // and its state quoted) is closed since c462735 and still at 9e4b5d1: two heads 270 blocks / 540 s apart stop
    // the page. The old assertion, which demonstrated the defect, is at commit 709350b.
    await expect(settleBlock(rpc)).rejects.toThrow(BEHIND);
  });

  it('R328-6: a receipt comes from the first endpoint alone: a false "reverted" receipt reaches the route unchallenged', async () => {
    const falseReceipt = { status: '0x0', blockNumber: q(990), blockHash: h(990), transactionHash: h(7) };
    const lying: Rpc = async (method, params) =>
      method === 'eth_getTransactionReceipt' ? falseReceipt : honest(1_000)(method, params);
    const rpc = chainRpc([lying, honest(1_000)], RULES);
    // Restated in the fourth pass (agent 364): closed since c462735 (R328-6 b). The honest endpoint knows no such
    // receipt, so the answer is null ("not seen yet"), which never ends a hold. Old assertion: commit 709350b.
    expect(await rpc('eth_getTransactionReceipt', [h(7)])).toBeNull();
  });
});

describe('R328-4 and R328-5 at 0566af3: a second endpoint that keeps only recent state', () => {
  it('the strict read (state at the finalized block, 600 blocks old) can never be confirmed', async () => {
    // The second endpoint serves state for the newest 30 blocks only (Arbitrum One: about a minute).
    const rpc = chainRpc([honest(1_000), honest(1_000, 970)], RULES);
    const strict = (await rpc.strict('eth_getBlockByNumber', ['finalized', false])) as { hash: string };
    await expect(reserveAt(rpc.strict, strict.hash)).rejects.toThrow(UNCONFIRMED);
  });

  it('a snapshot block that the user keeps for a few minutes can no longer be read: no quote until Refresh', async () => {
    let head = 1_000;
    const first: Rpc = (m, p) => honest(head)(m, p);
    const second: Rpc = (m, p) => honest(head, head - 30)(m, p);
    const rpc = chainRpc([first, second], RULES);
    const snapshot = await settleBlock(rpc);
    expect(await reserveAt(rpc, snapshot.hash)).toBe(q(995)); // at once: fine
    head += 60; // two minutes later the user asks for a quote at the snapshot's block
    await expect(reserveAt(rpc, snapshot.hash)).rejects.toThrow(UNCONFIRMED);
  });
});
