// Review R309-A1 (round 15): a swap is never requested from the wallet a second time, and a swap
// hold ends without any wallet request once its deadline has passed at a canonical finalized block.
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Address, type Hex } from 'viem';
import type { Rpc } from '../devnet4/chain';
import type { DevnetDeployment } from '../devnet4/record';
import { approveTransaction, swapTransaction, type TransactionRequest } from '../devnet4/swap';
import {
  parsePendingSwap,
  pendingSwapKey,
  REVIEW_NOT_FOR_SWAPS,
  usePendingSwap,
  type PendingSwap,
} from '../mainnet/pendingswap';
import {
  expiredSwap,
  submissionContext,
  type SubmissionIntent,
} from '../mainnet/submission-outcome';
import type { Provider } from '../wallet';
import { browserLocksForTest } from './browser-locks';

const address = (digit: string) => `0x${digit.repeat(40)}` as Address;
const hash = (digit: string) => `0x${digit.repeat(64)}` as Hex;
const FROM = address('1'),
  TOKEN = address('2'),
  WRAPPED = address('3');
const BOUNDARY = { number: '0xf', hash: hash('b'), timestamp: '0xff' };
const DEADLINE = 4096n;
const ONE = hash('1');
const deployment: DevnetDeployment = {
  name: 'swap expiry fixture',
  path: 'fixture',
  revision: 'fixture',
  chainId: 700770,
  genesisHash: hash('d'),
  factory: address('5'),
  router: address('6'),
  lens: address('7'),
  wrapped: WRAPPED,
  feeTo: address('0'),
  codeHashes: {},
  tokens: [TOKEN, WRAPPED].map((a) => ({
    address: a,
    symbol: 'TEST',
    cap: 1000000n,
    wrapped: a === WRAPPED,
  })),
  pairs: [{ address: address('8'), token0: TOKEN, token1: WRAPPED }],
  gate: { decision: 'liquidity-enabled', finalizedNumber: 15n, finalizedHash: BOUNDARY.hash },
};
const context = submissionContext(deployment);
const key = pendingSwapKey(deployment.chainId, FROM);
const SWAP: TransactionRequest = swapTransaction(
  deployment,
  {
    amountIn: 10n ** 18n,
    minimumOut: 100n,
    amountOut: 110n,
    path: [WRAPPED, TOKEN],
    amounts: [],
    executionLossBps: [],
    blockNumber: 16n,
  },
  { token: WRAPPED, native: true },
  { token: TOKEN, native: false },
  FROM,
  DEADLINE,
);
const APPROVE: TransactionRequest = approveTransaction(deployment, TOKEN, FROM, 5n);
const intentOf = (tx: TransactionRequest, kind: SubmissionIntent['kind']): SubmissionIntent => ({
  ...context,
  id: '12345678-1234-1234-1234-123456789abc',
  kind,
  from: tx.from,
  to: tx.to,
  data: tx.data,
  value: tx.value.toString(),
  gas: tx.gas.toString(),
  nonce: '4',
  afterBlockNumber: '15',
  afterBlockHash: BOUNDARY.hash,
});
const swapIntent = intentOf(SWAP, 'swap');
function hold(
  state: 'awaiting-wallet' | 'unknown',
  hashes: Hex[] = [],
  intent = swapIntent,
): PendingSwap {
  return {
    label: 'Swap 1 BLCH for TEST',
    deadline: intent.kind === 'swap' ? DEADLINE : 0n,
    sentAtMs: 0,
    intent,
    ...(hashes.length ? { hash: hashes.at(-1), candidateHashes: hashes } : {}),
    walletAttempt: {
      id: '87654321-1234-1234-1234-123456789abc',
      mode: 'initial',
      state,
      startedAtMs: 0,
    },
  };
}
const store = (value: PendingSwap) =>
  localStorage.setItem(
    key,
    JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  );
const stored = () => parsePendingSwap(localStorage.getItem(key));
const q = (n: bigint) => `0x${n.toString(16)}`;

/** A chain whose finalized and latest blocks, account nonce and transaction bodies the test sets. */
function chain() {
  const state = {
    finalized: { number: 16n, hash: hash('a'), timestamp: 256n },
    latest: { number: 16n, hash: hash('a'), timestamp: 256n },
    nonce: 4n,
    bodies: new Map<Hex, Record<string, unknown>>(),
    receipts: new Map<Hex, Record<string, unknown>>(),
    flipFinalizedHashAfter: -1,
    reads: 0,
  };
  const view = (b: { number: bigint; hash: Hex; timestamp: bigint }) => ({
    number: q(b.number),
    hash: b.hash,
    timestamp: q(b.timestamp),
  });
  const rpc = vi.fn<Rpc>(async (method, params) => {
    if (method === 'eth_chainId') return '0xab162';
    if (method === 'eth_getBlockByNumber') {
      const [tag] = params as [string];
      if (tag === '0x0') return { number: '0x0', hash: deployment.genesisHash };
      if (tag === BOUNDARY.number) return BOUNDARY;
      if (tag === 'finalized') {
        state.reads += 1;
        if (state.flipFinalizedHashAfter >= 0 && state.reads > state.flipFinalizedHashAfter)
          return { ...view(state.finalized), hash: hash('e') };
        return view(state.finalized);
      }
      if (tag === 'latest') return view(state.latest);
      if (tag === q(state.finalized.number)) return view(state.finalized);
      if (tag === q(state.latest.number)) return view(state.latest);
      if (tag === '0x11') return { number: '0x11', hash: hash('c'), timestamp: '0x101' };
      return null;
    }
    if (method === 'eth_getTransactionCount') return q(state.nonce);
    if (method === 'eth_getTransactionByHash') return state.bodies.get(params[0] as Hex) ?? null;
    if (method === 'eth_getTransactionReceipt') return state.receipts.get(params[0] as Hex) ?? null;
    throw new Error(`Unexpected RPC ${method}`);
  });
  return { rpc, state };
}
const body = (h: Hex, included: boolean) => ({
  hash: h,
  from: FROM,
  to: SWAP.to,
  input: SWAP.data,
  value: q(SWAP.value),
  chainId: '0xab162',
  nonce: '0x4',
  blockNumber: included ? '0x11' : null,
  blockHash: included ? hash('c') : null,
});
function walletThatMustNotBeAsked() {
  const request = vi.fn(({ method }: { method: string }) => {
    if (method === 'eth_chainId') return Promise.resolve('0xab162');
    throw new Error(`the wallet was asked for ${method}`);
  });
  return { provider: { request } as unknown as Provider, request };
}
const mount = (c: ReturnType<typeof chain>, provider: Provider, nowMs: () => number) => {
  const onMined = vi.fn();
  const hook = renderHook(() =>
    usePendingSwap({
      rpc: c.rpc,
      provider,
      account: FROM,
      chainId: 700770,
      deployment,
      enabled: true,
      now: nowMs,
      onMined,
      intervalMs: 5,
    }),
  );
  return { hook, onMined };
};
const AFTER = () => Number(DEADLINE + 100n) * 1000;
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 60))));

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: browserLocksForTest() });
});

describe('R309-A1: a swap is never requested from the wallet a second time', () => {
  it('offers no review and refuses one for a swap whose first request may still be open in the wallet', async () => {
    const c = chain();
    const wallet = walletThatMustNotBeAsked();
    store(hold('awaiting-wallet'));
    const { hook } = mount(c, wallet.provider, () => 300_000);
    await waitFor(() => expect(hook.result.current.open).toBe(true));
    expect(hook.result.current.review).toBeUndefined();
    await act(async () => {
      await expect(hook.result.current.reviewInWallet()).rejects.toThrow(REVIEW_NOT_FOR_SWAPS);
    });
    expect(wallet.request.mock.calls.some(([a]) => a.method === 'eth_sendTransaction')).toBe(false);
    expect(stored()?.walletAttempt).toMatchObject({ mode: 'initial', state: 'awaiting-wallet' });
    expect(hook.result.current.tracked?.detail).toMatch(/ends by itself once the swap deadline/);
  });

  it('still offers the review for an approval, where a second copy is harmless', async () => {
    const c = chain();
    store(hold('unknown', [], intentOf(APPROVE, 'approval')));
    const { hook } = mount(c, walletThatMustNotBeAsked().provider, () => 300_000);
    await waitFor(() => expect(hook.result.current.open).toBe(true));
    expect(hook.result.current.review?.details).toBeDefined();
  });
});

describe('a swap hold ends by its deadline at a canonical finalized block, with no wallet request', () => {
  it('releases the hold as expired when the nonce is unused: the swap did not execute', async () => {
    const c = chain();
    c.state.finalized = c.state.latest = { number: 20n, hash: hash('9'), timestamp: DEADLINE + 1n };
    const wallet = walletThatMustNotBeAsked();
    store(hold('awaiting-wallet'));
    const { hook, onMined } = mount(c, wallet.provider, AFTER);
    await waitFor(() => expect(hook.result.current.tracked?.state).toBe('expired'));
    expect(hook.result.current.open).toBe(false);
    expect(stored()).toBeNull();
    expect(hook.result.current.tracked?.detail).toMatch(
      /did not execute and can no longer execute/,
    );
    expect(onMined).toHaveBeenCalledTimes(1);
    expect(wallet.request).not.toHaveBeenCalled();
  });

  it('keeps the expiry notice across the refresh that follows, and drops it for another account', async () => {
    const c = chain();
    c.state.finalized = c.state.latest = { number: 20n, hash: hash('9'), timestamp: DEADLINE + 1n };
    store(hold('unknown'));
    const props = {
      rpc: c.rpc,
      provider: walletThatMustNotBeAsked().provider,
      account: FROM as Address | undefined,
      chainId: 700770,
      deployment,
      enabled: true,
      now: AFTER,
      onMined: vi.fn(),
      intervalMs: 5,
    };
    const hook = renderHook((p) => usePendingSwap(p), { initialProps: props });
    await waitFor(() => expect(hook.result.current.tracked?.state).toBe('expired'));
    // The page reloads its finalized view: the hook is disabled and enabled again.
    hook.rerender({ ...props, enabled: false });
    hook.rerender({ ...props, enabled: true });
    await settle();
    expect(hook.result.current.tracked?.state).toBe('expired');
    expect(hook.result.current.open).toBe(false);
    hook.rerender({ ...props, account: address('4') });
    await settle();
    expect(hook.result.current.tracked).toBeNull();
  });

  it('says the swap may have executed when the account nonce was used before the deadline block', async () => {
    const c = chain();
    c.state.finalized = c.state.latest = { number: 20n, hash: hash('9'), timestamp: DEADLINE + 1n };
    c.state.nonce = 5n;
    store(hold('unknown'));
    const { hook } = mount(c, walletThatMustNotBeAsked().provider, AFTER);
    await waitFor(() => expect(hook.result.current.tracked?.state).toBe('expired'));
    expect(hook.result.current.tracked?.detail).toMatch(/may have been this swap/);
  });

  it.each([
    ['the finalized timestamp equals the deadline (the router still accepts it)', DEADLINE, AFTER],
    ['only the latest block is past the deadline', DEADLINE - 5n, AFTER],
  ] as const)('keeps the hold while %s', async (_name, finalizedTimestamp, nowMs) => {
    const c = chain();
    c.state.finalized = { number: 20n, hash: hash('9'), timestamp: finalizedTimestamp };
    c.state.latest = { number: 21n, hash: hash('8'), timestamp: DEADLINE + 50n };
    store(hold('unknown'));
    const { hook } = mount(c, walletThatMustNotBeAsked().provider, nowMs);
    await waitFor(() => expect(hook.result.current.open).toBe(true));
    await settle();
    expect(hook.result.current.tracked?.state).toBe('unknown');
    expect(stored()?.intent?.id).toBe(swapIntent.id);
  });

  it('is decided by the finalized block alone: a device clock far ahead or far behind changes nothing', async () => {
    const c = chain();
    c.state.finalized = c.state.latest = { number: 20n, hash: hash('9'), timestamp: DEADLINE - 1n };
    store(hold('unknown'));
    const ahead = mount(c, walletThatMustNotBeAsked().provider, () => Number(DEADLINE) * 1000 * 10);
    await waitFor(() => expect(ahead.hook.result.current.open).toBe(true));
    await settle();
    expect(stored()?.intent?.id).toBe(swapIntent.id);
    ahead.hook.unmount();
    c.state.finalized = c.state.latest = { number: 21n, hash: hash('8'), timestamp: DEADLINE + 1n };
    const behind = mount(c, walletThatMustNotBeAsked().provider, () => 1_000);
    await waitFor(() => expect(behind.hook.result.current.tracked?.state).toBe('expired'));
    expect(stored()).toBeNull();
  });

  it('never ends an approval hold by time', async () => {
    const c = chain();
    c.state.finalized = c.state.latest = {
      number: 20n,
      hash: hash('9'),
      timestamp: DEADLINE * 10n,
    };
    const intent = intentOf(APPROVE, 'approval');
    store(hold('unknown', [], intent));
    const { hook } = mount(
      c,
      walletThatMustNotBeAsked().provider,
      () => Number(DEADLINE) * 1000 * 20,
    );
    await waitFor(() => expect(hook.result.current.open).toBe(true));
    await settle();
    expect(stored()?.intent?.id).toBe(intent.id);
  });

  it('a known hash that is already included waits for its finalized receipt; one that is nowhere expires', async () => {
    const c = chain();
    c.state.finalized = c.state.latest = { number: 20n, hash: hash('9'), timestamp: DEADLINE + 1n };
    c.state.bodies.set(ONE, body(ONE, true));
    expect(await expiredSwap(c.rpc, swapIntent, context, DEADLINE, [ONE])).toBeNull();
    c.state.bodies.set(ONE, body(ONE, false));
    expect(await expiredSwap(c.rpc, swapIntent, context, DEADLINE, [ONE])).toMatchObject({
      blockNumber: '20',
      nonceUsed: false,
    });
    c.state.bodies.clear();
    expect(await expiredSwap(c.rpc, swapIntent, context, DEADLINE, [ONE])).not.toBeNull();
    // A hash whose body is another call is contradictory evidence, not expiry.
    c.state.bodies.set(ONE, { ...body(ONE, false), input: '0x1234' });
    await expect(expiredSwap(c.rpc, swapIntent, context, DEADLINE, [ONE])).rejects.toThrow();
  });

  it('refuses evidence that changes while it is read, and non-swaps', async () => {
    const c = chain();
    c.state.finalized = c.state.latest = { number: 20n, hash: hash('9'), timestamp: DEADLINE + 1n };
    c.state.flipFinalizedHashAfter = 1;
    await expect(expiredSwap(c.rpc, swapIntent, context, DEADLINE)).rejects.toThrow();
    c.state.flipFinalizedHashAfter = -1;
    expect(await expiredSwap(c.rpc, intentOf(APPROVE, 'approval'), context, DEADLINE)).toBeNull();
    expect(await expiredSwap(c.rpc, swapIntent, context, 0n)).toBeNull();
    await expect(
      expiredSwap(c.rpc, swapIntent, { ...context, genesisHash: hash('f') }, DEADLINE),
    ).rejects.toThrow();
  });

  // Review R309-A2, the reviewer's demonstration (commit 665fb6b) turned into a regression test.
  it('R309-A2: a swap hold with a candidate the RPC cannot show is not closed as replaced before the deadline', async () => {
    const TWO = hash('2');
    const c = chain();
    c.state.finalized = c.state.latest = { number: 17n, hash: hash('c'), timestamp: 300n };
    store(hold('unknown', [TWO])); // the wallet returned TWO; it signed it at its own nonce 5 and holds it
    // A different transaction (a plain transfer) used nonce 4 and is finalized.
    c.state.bodies.set(ONE, {
      hash: ONE,
      from: FROM,
      to: FROM,
      input: '0x',
      value: '0x0',
      chainId: '0xab162',
      nonce: '0x4',
      blockNumber: '0x11',
      blockHash: hash('c'),
    });
    c.state.receipts.set(ONE, {
      transactionHash: ONE,
      from: FROM,
      to: FROM,
      blockNumber: '0x11',
      blockHash: hash('c'),
      status: '0x1',
      gasUsed: '0x5208',
    });
    c.state.nonce = 5n;
    const { hook } = mount(c, walletThatMustNotBeAsked().provider, () => 300_000);
    await waitFor(() => expect(hook.result.current.open).toBe(true));
    await act(async () => {
      await expect(hook.result.current.checkReplacement(ONE)).rejects.toThrow(
        /cannot show the transaction 0x2{64} .* may still be published and execute/,
      );
    });
    expect(stored()?.intent?.id).toBe(swapIntent.id);
    expect(hook.result.current.open).toBe(true);
    // Once the RPC shows the candidate at the saved nonce, the replacement is accepted as before.
    c.state.bodies.set(TWO, body(TWO, false));
    await act(async () => {
      const proof = await hook.result.current.checkReplacement(ONE);
      expect(proof.transactionHash).toBe(ONE);
    });
    // The page remembers that it read the candidate at the saved nonce: when the node drops it afterwards
    // (a cancellation replaced it), the replacement is still accepted, also after a reload.
    await waitFor(() => expect(stored()?.nonceSeen).toEqual([TWO]));
    c.state.bodies.delete(TWO);
    await act(async () => {
      expect((await hook.result.current.checkReplacement(ONE)).transactionHash).toBe(ONE);
    });
    hook.unmount();
    const again = mount(c, walletThatMustNotBeAsked().provider, () => 300_000);
    await waitFor(() => expect(again.hook.result.current.open).toBe(true));
    await act(async () => {
      expect((await again.hook.result.current.checkReplacement(ONE)).transactionHash).toBe(ONE);
    });
  });

  it('R309-A2: a candidate the RPC shows at another nonce is never recorded as seen', async () => {
    const TWO = hash('2');
    const c = chain();
    c.state.finalized = c.state.latest = { number: 17n, hash: hash('c'), timestamp: 300n };
    store(hold('unknown', [TWO]));
    c.state.bodies.set(TWO, { ...body(TWO, false), nonce: '0x5' });
    const { hook } = mount(c, walletThatMustNotBeAsked().provider, () => 300_000);
    await waitFor(() => expect(hook.result.current.open).toBe(true));
    await settle();
    expect(stored()?.nonceSeen).toBeUndefined();
  });

  it('a stored record whose nonceSeen names a hash that is not a candidate is unreadable', () => {
    const TWO = hash('2');
    store({ ...hold('unknown', [TWO]), nonceSeen: [ONE] });
    expect(stored()).toBeNull();
    store({ ...hold('unknown', [TWO]), nonceSeen: [TWO] });
    expect(stored()?.nonceSeen).toEqual([TWO]);
  });
});
