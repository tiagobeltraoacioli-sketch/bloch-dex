// Review r17, third pass (agent 328): the page's RPC stack at c462735 (multichain/rpc.ts) against endpoints that
// lie, lag, are stale alike, have a header without its state, or disagree at the head. Model nodes share one
// honest chain (block n has hash h(n), timestamp 1,000,000 + 2n; the pool's reserve at block n is n).
import { describe, expect, it, vi } from 'vitest';
import type { Rpc } from '../../devnet4/chain';
import { DISAGREEMENT, UNCONFIRMED, chainRpc } from '../../multichain/rpc';

const h = (n: number, fork = 0) => `0x${(n + fork * 2 ** 40).toString(16).padStart(64, '0')}`;
const q = (n: number) => `0x${n.toString(16)}`;
type Options = { stateFrom?: number; stateUpTo?: number; spacing?: number; fork?: number; lie?: number };
/** A node at `head`. `stateFrom`/`stateUpTo`: the blocks whose state it serves; `lie`: added to every state answer. */
function node(head: number, o: Options = {}) {
  const spacing = o.spacing ?? 2;
  const rpc = vi.fn<Rpc>(async (method, params) => {
    if (method === 'eth_getBlockByNumber') {
      const tag = (params as [string])[0];
      const n = tag === 'latest' ? head : tag === 'finalized' ? head - 600 : Number(BigInt(tag));
      return n > head ? null : { number: q(n), hash: h(n, n === head ? (o.fork ?? 0) : 0), timestamp: q(1_000_000 + spacing * n) };
    }
    if (method === 'eth_call') {
      const at = (params as [unknown, unknown])[1];
      if (at === 'latest') return q(head + (o.lie ?? 0));
      const hash = (at as { blockHash: string }).blockHash;
      const n = Number(BigInt(hash) % BigInt(2 ** 40));
      if (hash !== h(n, n === head ? (o.fork ?? 0) : 0) || n > head) throw new Error('header not found');
      if (n < (o.stateFrom ?? 0) || n > (o.stateUpTo ?? head)) throw new Error('missing trie node');
      return q(n + (o.lie ?? 0));
    }
    throw new Error(`unexpected ${method}`);
  });
  return rpc;
}
const down: Rpc = async () => {
  throw new Error('fetch failed');
};
const RULES = { settle: { depth: 5 }, strict: { tag: 'finalized' as const } };
const settle = async (rpc: Rpc) => (await rpc('eth_getBlockByNumber', ['finalized', false])) as { number: string; hash: string };
const head = async (rpc: Rpc) => (await rpc('eth_getBlockByNumber', ['latest', false])) as { number: string; hash: string };
const at = (rpc: Rpc, hash: string) => rpc('eth_call', [{ to: '0x00', data: '0x' }, { blockHash: hash }]);

describe('the safety property: a pinned read is used only when two endpoints give the same answer at one block hash', () => {
  it('holds: one of three lies about state -> refused; the third is not used to outvote', async () => {
    const third = node(1_000);
    const rpc = chainRpc([node(1_000, { lie: 7 }), node(1_000), third], RULES);
    await expect(at(rpc, (await settle(rpc)).hash)).rejects.toThrow(DISAGREEMENT);
    expect(third.mock.calls.filter(([m]) => m === 'eth_call')).toHaveLength(0);
  });
  it('holds: an endpoint with the head header but not yet its state -> the third stands in; without a third nothing is used', async () => {
    const noState = node(1_000, { stateUpTo: 990 });
    const three = chainRpc([node(1_000), noState, node(1_000)], RULES);
    expect(await at(three, (await head(three)).hash)).toBe(q(1_000));
    const two = chainRpc([node(1_000), noState], RULES);
    await expect(at(two, (await head(two)).hash)).rejects.toThrow(UNCONFIRMED);
  });
  it('holds: the two endpoints have different blocks at the head (a one-block reorganisation seen by one) -> nothing is used', async () => {
    const rpc = chainRpc([node(1_000), node(1_000, { fork: 1 })], RULES);
    // Restated in the fourth pass (agent 364): at 9e4b5d1 the head HEADER must itself be the same block on both
    // endpoints, so the page stops one step earlier (DISAGREEMENT at the head, before any state read); at
    // c462735 the head was taken and the pinned read was UNCONFIRMED (commit 709350b). Stronger, same property.
    await expect(head(rpc)).rejects.toThrow(DISAGREEMENT);
  });
  it('limit: with the first endpoint unreachable, the other two decide; if they lie alike (one provider behind two names) the lie is used', async () => {
    const rpc = chainRpc([down, node(1_000, { lie: 7 }), node(1_000, { lie: 7 })], RULES);
    expect(await at(rpc, (await settle(rpc)).hash)).toBe(q(995 + 7));
  });
  it('limit: both endpoints stale by the same amount (9 minutes) are accepted; only the clock notice after 10 minutes remains', async () => {
    const rpc = chainRpc([node(730), node(730)], RULES);
    expect((await settle(rpc)).number).toBe(q(725));
    expect(await at(rpc, (await settle(rpc)).hash)).toBe(q(725));
  });
});

describe('R328-3P-4: the quote at the latest block is ONE endpoint\'s, pinned to nothing, and it can become the signed quote', () => {
  it('eth_call at the tag `latest` (MainnetLive.tsx crossCheck -> quoteExactInput(..., "latest")) goes to the first endpoint alone', async () => {
    const liar = node(1_000, { lie: -500 }); // half the output
    const honest = node(1_000);
    const rpc = chainRpc([liar, honest, node(1_000)], RULES);
    // Restated in the fourth pass (agent 364): CLOSED at 9e4b5d1. The tag is resolved to a head two endpoints
    // agree on and read at its hash from two endpoints; the liar's answer is refused, the honest one is asked.
    // At c462735 the liar's 0x1f4 came back and nobody else was asked (commit 709350b).
    await expect(rpc('eth_call', [{ to: '0x00', data: '0x' }, 'latest'])).rejects.toThrow(DISAGREEMENT);
    expect(honest.mock.calls.some(([m, p]) => m === 'eth_call' && typeof (p as unknown[])[1] === 'object')).toBe(true);
    expect(liar.mock.calls.every(([m, p]) => m !== 'eth_call' || typeof (p as unknown[])[1] === 'object')).toBe(true);
  });
});

describe('R328-3P-5: availability of the head rule', () => {
  it('a second endpoint that lags stops the page (BEHIND) although a healthy third is listed: the third is never asked for the head', async () => {
    const third = node(1_000);
    const rpc = chainRpc([node(1_000), node(900), third], RULES);
    // Restated in the fourth pass (agent 364): CLOSED at 9e4b5d1, the third is asked and the page goes on at
    // the older of the two close heads. At c462735: BEHIND, third never asked (commit 709350b).
    expect((await head(rpc)).number).toBe(q(1_000));
    expect(third.mock.calls.length).toBeGreaterThan(0);
  });
  it('a chain that makes blocks only when there is work (Linea: up to 82 s apart measured): ONE block of difference can be more than 90 s of chain time -> BEHIND', async () => {
    const rpc = chainRpc([node(1_000, { spacing: 100 }), node(999, { spacing: 100 })], RULES);
    // Restated in the fourth pass (agent 364): CLOSED at 9e4b5d1 ("apart" needs more than HEAD_GAP_BLOCKS blocks
    // AND more than HEAD_GAP_SECONDS); the older head 999 is used. At c462735: BEHIND (commit 709350b).
    expect((await head(rpc)).number).toBe(q(999));
  });
});

describe('R328-6 (b) at c462735: receipts need two endpoints', () => {
  const receipt = (status: string, block: number) => ({ status, blockNumber: q(block), blockHash: h(block), gasUsed: '0x5208' });
  const withReceipt = (value: unknown): Rpc => async (method, params) => (method === 'eth_getTransactionReceipt' ? value : node(1_000)(method, params));
  it('closed: one endpoint\'s false "reverted" is not a receipt; two different outcomes are a disagreement', async () => {
    const lonely = chainRpc([withReceipt(receipt('0x0', 990)), withReceipt(null), withReceipt(null)], RULES);
    expect(await lonely('eth_getTransactionReceipt', [h(7)])).toBeNull();
    const split = chainRpc([withReceipt(receipt('0x0', 990)), withReceipt(receipt('0x1', 990))], RULES);
    await expect(split('eth_getTransactionReceipt', [h(7)])).rejects.toThrow(DISAGREEMENT);
  });
});
