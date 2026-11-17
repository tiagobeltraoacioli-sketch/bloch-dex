// The confirmation rule of a public chain and the agreement of its two endpoints (src/multichain/rpc.ts,
// src/multichain/config.ts): review R309-MC-2, MC-3 and MC-6.
import { describe, expect, it, vi } from 'vitest';
import { ChainError, type Rpc } from '../devnet4/chain';
import bundle from '../multichain/bundle';
import { bundledChains, parseChain, parseConfirmation } from '../multichain/config';
import {
  BEHIND,
  DISAGREEMENT,
  FINALIZED_ONLY,
  UNCONFIRMED,
  agreeingRpc,
  chainRpc,
  fallbackRpc,
  settledRpc,
} from '../multichain/rpc';

const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const q = (n: number) => `0x${n.toString(16)}`;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const entry = (key: string) =>
  clone(
    (bundle as { network: { key: string }; record: unknown }[]).find((e) => e.network.key === key)!,
  ) as { network: Record<string, any>; record: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A node whose head the test moves; block n has hash h(n). `finalized` is `lag` blocks behind. */
function node(head: number, lag = 64) {
  const state = { head, lag };
  const rpc = vi.fn<Rpc>(async (method, params) => {
    if (method !== 'eth_getBlockByNumber') return `${method}:${JSON.stringify(params)}`;
    const [tag] = params as [string];
    const n =
      tag === 'latest'
        ? state.head
        : tag === 'finalized'
          ? state.head - state.lag
          : tag === 'safe'
            ? state.head - 32
            : Number(BigInt(tag));
    return n > state.head ? null : { number: q(n), hash: h(n), timestamp: q(1_000 + n) };
  });
  return { rpc, state };
}

describe('confirmation rule: the settled block', () => {
  it('a depth rule answers the request for `finalized` with the block that many blocks behind the head', async () => {
    const n = node(1_000);
    const rpc = settledRpc(n.rpc, { depth: 5 });
    expect(await rpc('eth_getBlockByNumber', ['finalized', false])).toMatchObject({
      number: q(995),
      hash: h(995),
    });
    // Nothing else is touched: the head, a block by number, any other method.
    expect(await rpc('eth_getBlockByNumber', ['latest', false])).toMatchObject({
      number: q(1_000),
    });
    expect(await rpc('eth_getBlockByNumber', [q(7), false])).toMatchObject({ number: q(7) });
    expect(await rpc('eth_chainId', [])).toBe('eth_chainId:[]');
    // The chain's own `finalized` tag was never asked.
    expect(n.rpc.mock.calls.some(([, p]) => (p as unknown[])[0] === 'finalized')).toBe(false);
  });
  it('a depth answer never goes backwards when a lagging endpoint answers the head', async () => {
    const n = node(1_000);
    const rpc = settledRpc(n.rpc, { depth: 5 });
    await rpc('eth_getBlockByNumber', ['finalized', false]);
    n.state.head = 997;
    expect(await rpc('eth_getBlockByNumber', ['finalized', false])).toMatchObject({
      number: q(995),
    });
    n.state.head = 1_010;
    expect(await rpc('eth_getBlockByNumber', ['finalized', false])).toMatchObject({
      number: q(1_005),
    });
  });
  it('a tag rule asks the chain for that tag; `finalized` is the RPC itself; a missing block is refused', async () => {
    const n = node(1_000);
    expect(
      await settledRpc(n.rpc, { tag: 'safe' })('eth_getBlockByNumber', ['finalized', false]),
    ).toMatchObject({ number: q(968) });
    expect(settledRpc(n.rpc, { tag: 'finalized' })).toBe(n.rpc);
    const broken: Rpc = async (_, params) =>
      (params as unknown[])[0] === 'latest' ? { number: q(50) } : null;
    await expect(
      settledRpc(broken, { depth: 2 })('eth_getBlockByNumber', ['finalized', false]),
    ).rejects.toThrow(/did not return the confirmed block/);
  });
  it('the strict reader of a chain RPC uses the strict rule, the RPC itself the settle rule', async () => {
    const n = node(1_000);
    const rpc = chainRpc([n.rpc], { settle: { depth: 2 }, strict: { tag: 'finalized' } });
    expect(await rpc('eth_getBlockByNumber', ['finalized', false])).toMatchObject({
      number: q(998),
    });
    expect(await rpc.strict('eth_getBlockByNumber', ['finalized', false])).toMatchObject({
      number: q(936),
    });
    // Without a rule both are the chain's own finalized block, on separate function objects.
    const plain = chainRpc([n.rpc]);
    expect(plain).not.toBe(n.rpc);
    expect(await plain('eth_getBlockByNumber', ['finalized', false])).toMatchObject({
      number: q(936),
    });
    expect(FINALIZED_ONLY.settle).toEqual({ tag: 'finalized' });
  });
});

describe('two endpoints must agree on every read pinned to a block hash', () => {
  const pinned = [{ to: h(1).slice(0, 42), data: '0x' }, { blockHash: h(9) }];
  const answers = (value: unknown) => vi.fn<Rpc>(async () => value);
  const failing = () =>
    vi.fn<Rpc>(async () => {
      throw new Error('network');
    });
  it('a pinned read is asked of both and returned when both give the same answer', async () => {
    const [a, b] = [answers('0x2a'), answers('0x2a')];
    expect(await agreeingRpc([a, b], 0)('eth_call', pinned)).toBe('0x2a');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
  it('R309-MC-3: a first endpoint that shows another state than the second is refused', async () => {
    await expect(
      agreeingRpc([answers('0x2a'), answers('0x2b')], 0)('eth_call', pinned),
    ).rejects.toThrow(DISAGREEMENT);
    // Also when one says the call reverts and the other gives a value.
    const reverting = vi.fn<Rpc>(async () => {
      const error = new ChainError('chain: eth_call failed: execution reverted: BDEX: K');
      error.code = 3;
      throw error;
    });
    await expect(agreeingRpc([answers('0x2a'), reverting], 0)('eth_call', pinned)).rejects.toThrow(
      DISAGREEMENT,
    );
    // Two endpoints that both say it reverts: the revert is the chain's answer.
    await expect(agreeingRpc([reverting, reverting], 0)('eth_call', pinned)).rejects.toThrow(
      /BDEX: K/,
    );
  });
  it('a second endpoint that cannot answer is asked three times, then the read is refused, not used', async () => {
    const down = failing();
    await expect(agreeingRpc([answers('0x2a'), down], 0)('eth_call', pinned)).rejects.toThrow(
      UNCONFIRMED,
    );
    expect(down).toHaveBeenCalledTimes(3);
    // It answers on the second try (the block had not reached it yet).
    let tries = 0;
    const late = vi.fn<Rpc>(async () => {
      if (++tries < 2) throw new Error('header not found');
      return '0x2a';
    });
    expect(await agreeingRpc([answers('0x2a'), late], 0)('eth_call', pinned)).toBe('0x2a');
    // A third endpoint stands in for one that keeps failing.
    expect(
      await agreeingRpc([answers('0x2a'), failing(), answers('0x2a')], 0)('eth_call', pinned),
    ).toBe('0x2a');
  });
  it('reads that are not pinned to a hash go to the first endpoint that answers; one endpoint alone is used as it is', async () => {
    const [a, b] = [answers('0x1'), answers('0x2')];
    const rpc = agreeingRpc([a, b], 0);
    expect(await rpc('eth_call', [{ to: h(1).slice(0, 42) }, 'latest'])).toBe('0x1');
    expect(await rpc('eth_gasPrice', [])).toBe('0x1');
    expect(b).not.toHaveBeenCalled();
    expect(await agreeingRpc([a], 0)('eth_call', pinned)).toBe('0x1');
  });
});

describe('the block a tag names is taken from two endpoints', () => {
  it('`latest` is a block both endpoints have: the older of two heads that are close; an endpoint far behind stops the page', async () => {
    // A few blocks apart (measured on the real endpoints: up to 5): the older head, whichever endpoint has it.
    const [a, b] = [node(997), node(1_000)];
    for (const order of [
      [a.rpc, b.rpc],
      [b.rpc, a.rpc],
    ])
      expect(await agreeingRpc(order, 0)('eth_getBlockByNumber', ['latest', false])).toMatchObject({
        number: q(997),
        hash: h(997),
      });
    // The settled block of a depth rule is counted from that head.
    const rpc = chainRpc([a.rpc, b.rpc], { settle: { depth: 5 }, strict: { depth: 30 } });
    expect(await rpc('eth_getBlockByNumber', ['finalized', false])).toMatchObject({
      number: q(992),
      hash: h(992),
    });
    expect(await rpc.strict('eth_getBlockByNumber', ['finalized', false])).toMatchObject({
      number: q(967),
    });
    // R328-6: one endpoint withholds 200 blocks (a true, old state; block n has time 1,000 + n here). The page
    // is not held on that state: it stops, whichever of the two lags.
    const stale = node(800);
    await expect(
      agreeingRpc([stale.rpc, b.rpc], 0)('eth_getBlockByNumber', ['latest', false]),
    ).rejects.toThrow(BEHIND);
    await expect(
      chainRpc([b.rpc, stale.rpc], { settle: { depth: 5 }, strict: { depth: 30 } })(
        'eth_getBlockByNumber',
        ['finalized', false],
      ),
    ).rejects.toThrow(BEHIND);
    // Exactly at the limit is accepted.
    expect(
      await agreeingRpc([node(910).rpc, b.rpc], 0)('eth_getBlockByNumber', ['latest', false]),
    ).toMatchObject({ number: q(910) });
  });
  it('a head only one endpoint answers is used (the pinned reads then need the other)', async () => {
    const down = vi.fn<Rpc>(async () => {
      throw new Error('network');
    });
    const up = node(1_000);
    expect(
      await agreeingRpc([down, up.rpc], 0)('eth_getBlockByNumber', ['latest', false]),
    ).toMatchObject({ number: q(1_000) });
    expect(down).toHaveBeenCalledTimes(1);
    await expect(
      agreeingRpc([down, down], 0)('eth_getBlockByNumber', ['latest', false]),
    ).rejects.toThrow('network');
  });
  it('`finalized` and `safe` are the older of the two answers, and both endpoints must answer', async () => {
    // One endpoint claims a newer block is final (Linea's public endpoints did exactly this for `finalized`).
    const [honest, eager] = [node(1_000, 64), node(1_000, 0)];
    for (const order of [
      [honest.rpc, eager.rpc],
      [eager.rpc, honest.rpc],
    ])
      expect(
        await agreeingRpc(order, 0)('eth_getBlockByNumber', ['finalized', false]),
      ).toMatchObject({ number: q(936) });
    expect(
      await agreeingRpc([honest.rpc, eager.rpc], 0)('eth_getBlockByNumber', ['safe', false]),
    ).toMatchObject({ number: q(968) });
    const down = vi.fn<Rpc>(async () => {
      throw new Error('network');
    });
    await expect(
      agreeingRpc([honest.rpc, down], 0)('eth_getBlockByNumber', ['finalized', false]),
    ).rejects.toThrow(UNCONFIRMED);
    expect(down).toHaveBeenCalledTimes(3);
    // An endpoint without the tag (null) does not count as an answer; a third endpoint stands in.
    const without = vi.fn<Rpc>(async () => null);
    await expect(
      agreeingRpc([honest.rpc, without], 0)('eth_getBlockByNumber', ['finalized', false]),
    ).rejects.toThrow(UNCONFIRMED);
    expect(
      await agreeingRpc([honest.rpc, without, eager.rpc], 0)('eth_getBlockByNumber', [
        'finalized',
        false,
      ]),
    ).toMatchObject({ number: q(936) });
    // The strict reader of a tag chain: the older `finalized` of the two.
    const rpc = chainRpc([eager.rpc, honest.rpc], {
      settle: { depth: 2 },
      strict: { tag: 'finalized' },
    });
    expect(await rpc.strict('eth_getBlockByNumber', ['finalized', false])).toMatchObject({
      number: q(936),
    });
  });
  it('a block by number or hash that the first endpoint does not have yet is asked of the next', async () => {
    const [behind, ahead] = [node(990), node(1_000)];
    const rpc = fallbackRpc([behind.rpc, ahead.rpc]);
    expect(await rpc('eth_getBlockByNumber', [q(1_000), false])).toMatchObject({ hash: h(1_000) });
    // A block nobody has is `null`, as from one endpoint; a missing block 0 stays an error.
    expect(await rpc('eth_getBlockByNumber', [q(2_000), false])).toBeNull();
    const none = vi.fn<Rpc>(async () => null);
    expect(await fallbackRpc([none, none])('eth_getBlockByHash', [h(5), false])).toBeNull();
    await expect(fallbackRpc([none, none])('eth_getBlockByNumber', ['0x0', false])).rejects.toThrow(
      /does not serve block 0/,
    );
    // Anything else that is `null` (an unknown receipt) is the first endpoint's answer.
    expect(await fallbackRpc([none, ahead.rpc])('eth_getTransactionReceipt', [h(3)])).toBeNull();
  });
});

describe('a transaction and its receipt count only when two endpoints report the same inclusion', () => {
  const receipt = (status: string, block = 9) => ({
    transactionHash: h(3),
    blockHash: h(block),
    blockNumber: q(block),
    status,
    gasUsed: '0x5208',
  });
  const says = (value: unknown) => vi.fn<Rpc>(async () => value);
  it('R328-6: one endpoint alone cannot report a receipt, and a false "reverted" is a disagreement', async () => {
    // Known to the first endpoint only (or invented by it): not known yet. A hold is never ended by `null`.
    expect(
      await agreeingRpc([says(receipt('0x0')), says(null)], 0)('eth_getTransactionReceipt', [h(3)]),
    ).toBeNull();
    // The transaction really succeeded; the first endpoint says it reverted.
    await expect(
      agreeingRpc([says(receipt('0x0')), says(receipt('0x1'))], 0)('eth_getTransactionReceipt', [
        h(3),
      ]),
    ).rejects.toThrow(DISAGREEMENT);
    // Another block for the same transaction (one endpoint is on another branch).
    await expect(
      agreeingRpc([says(receipt('0x1', 9)), says(receipt('0x1', 10))], 0)(
        'eth_getTransactionReceipt',
        [h(3)],
      ),
    ).rejects.toThrow(DISAGREEMENT);
    // Both report the same inclusion and status: the first endpoint's receipt is returned.
    const [a, b] = [says(receipt('0x1')), says({ ...receipt('0x1'), extra: 'field' })];
    expect(await agreeingRpc([a, b], 0)('eth_getTransactionReceipt', [h(3)])).toEqual(
      receipt('0x1'),
    );
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
  it('the transaction body follows the same rule; an endpoint that fails does not count; a third stands in', async () => {
    const body = { hash: h(3), blockHash: h(9), blockNumber: q(9), nonce: '0x4' };
    const down = vi.fn<Rpc>(async () => {
      throw new Error('network');
    });
    expect(await agreeingRpc([says(body), down], 0)('eth_getTransactionByHash', [h(3)])).toBeNull();
    expect(
      await agreeingRpc([says(body), down, says(body)], 0)('eth_getTransactionByHash', [h(3)]),
    ).toEqual(body);
    // Pending on both (no block yet): the same answer, returned as it is.
    const pending = { hash: h(3), blockHash: null, blockNumber: null, nonce: '0x4' };
    expect(
      await agreeingRpc([says(pending), says(pending)], 0)('eth_getTransactionByHash', [h(3)]),
    ).toEqual(pending);
    // One endpoint alone (a rehearsal file) is used as it is.
    expect(await agreeingRpc([says(body)], 0)('eth_getTransactionReceipt', [h(3)])).toEqual(body);
  });
});

describe('the network file states the rule, the deadline, and the page says both', () => {
  it('every bundled chain has a rule; five settle on a depth and decide lost requests more strictly', () => {
    const rules = Object.fromEntries(bundledChains().map((c) => [c.key, c.confirmation]));
    expect(rules).toEqual({
      ethereum: { settle: { depth: 2 }, strict: { tag: 'finalized' } },
      base: { settle: { depth: 50 }, strict: { tag: 'finalized' } },
      'arbitrum-one': { settle: { depth: 32 }, strict: { tag: 'finalized' } },
      'op-mainnet': { settle: { depth: 5 }, strict: { tag: 'finalized' } },
      // Linea's endpoints disagree on `finalized`: the tag is used for neither rule.
      linea: { settle: { depth: 1 }, strict: { depth: 300 } },
      'bnb-smart-chain': { settle: { tag: 'finalized' }, strict: { tag: 'finalized' } },
    });
    for (const chain of bundledChains()) expect(chain.network.defaultDeadlineMinutes).toBe(20);
  });
  it('says in words what "confirmed" (or, on a finalized rule, "finalized") means on the chain', () => {
    const notes = Object.fromEntries(bundledChains().map((c) => [c.key, c.confirmationNote]));
    expect(notes.ethereum).toBe(
      "On Ethereum this page treats a block as settled once 2 blocks are on top of it (about 24 seconds), not at the chain's own finality. Where this page says \"confirmed\" on this network, it means that. Prices and balances are read at that block and your swap is bound by its minimum and its deadline. A hold that ends without your transaction's own receipt (its deadline passed, or another transaction used its nonce) waits for the chain's own finalized block.",
    );
    expect(notes.linea).toMatch(
      /once 1 block is on top of it \(about 12 seconds\).*waits for 300 blocks on top \(about 58 minutes; this is not the chain's own finality\)\.$/,
    );
    expect(notes['bnb-smart-chain']).toBe(
      "On BNB Smart Chain this page reads and settles at the chain's own finalized block.",
    );
  });
  it('a network file without the two optional blocks keeps `finalized` and the route default', () => {
    const { network, record } = entry('base');
    delete network.confirmation;
    delete network.swap;
    const chain = parseChain(network, record);
    expect(chain.confirmation).toEqual(FINALIZED_ONLY);
    expect(chain.network.defaultDeadlineMinutes).toBeUndefined();
  });
  it('refuses a malformed rule, a strict rule weaker than the settle rule, and a deadline out of range', () => {
    const bad = (change: (n: Record<string, any>) => void) => {
      // eslint-disable-line @typescript-eslint/no-explicit-any
      const { network, record } = entry('base');
      change(network);
      return () => parseChain(network, record);
    };
    expect(bad((n) => (n.confirmation.settle = { depth: 0 }))).toThrow(
      /confirmation\.settle\.depth/,
    );
    expect(bad((n) => (n.confirmation.settle = { tag: 'latest' }))).toThrow(
      /confirmation\.settle\.tag/,
    );
    expect(bad((n) => (n.confirmation.settle = { depth: 5, tag: 'safe' }))).toThrow(
      /confirmation\.settle/,
    );
    expect(bad((n) => (n.confirmation.strict = { depth: 10 }))).toThrow(/weaker/);
    expect(bad((n) => (n.confirmation.extra = 1))).toThrow(/unknown field/);
    expect(bad((n) => delete n.confirmation.blockSeconds)).toThrow(/blockSeconds/);
    expect(bad((n) => (n.swap.deadlineMinutes = 9))).toThrow(/swap\.deadlineMinutes/);
    expect(bad((n) => (n.swap.deadlineMinutes = 61))).toThrow(/swap\.deadlineMinutes/);
    expect(() =>
      parseConfirmation({ settle: { tag: 'safe' }, strict: { depth: 9 }, blockSeconds: 1 }, 'X'),
    ).toThrow(/weaker/);
  });
});
