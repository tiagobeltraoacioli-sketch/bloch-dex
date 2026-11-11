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
  REPLACEMENT_NOT_FOR_UNSEEN_SWAPS,
  REVIEW_NOT_FOR_SWAPS,
  UNREADABLE_RECORD,
  idleWaitNote,
  usePendingSwap,
  type PendingSwap,
} from '../mainnet/pendingswap';
import {
  DEFAULT_IDLE_POLICY,
  IDLE_MARGIN_SECONDS,
  idleDeadlineSeconds,
  longestQuiet,
  parseIdlePolicy,
  swapClock,
  type SwapClock,
} from '../mainnet/config';
import {
  expiredSwap,
  savedSwapDeadline,
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
      /no transaction of this account used nonce 4 before it: sent from an ordinary wallet account this swap did not execute, and it can no longer execute/,
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
    // R309-2P-3: a hash whose body is not the saved call (a wrapper transaction, appended calldata) says
    // nothing about the saved call and does not keep the hold for ever, even when it is included.
    c.state.bodies.set(ONE, { ...body(ONE, true), input: `${SWAP.data}00` });
    expect(await expiredSwap(c.rpc, swapIntent, context, DEADLINE, [ONE])).toMatchObject({
      blockNumber: '20',
    });
    // R309-2P-4: never on a deadline other than the one inside the saved call.
    expect(await expiredSwap(c.rpc, swapIntent, context, DEADLINE - 1n, [])).toBeNull();
    c.state.finalized = c.state.latest = { number: 21n, hash: hash('7'), timestamp: 10n };
    expect(await expiredSwap(c.rpc, swapIntent, context, 5n, [])).toBeNull();
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

  // Review R309-2P-1, the reviewer's demonstration (bfeb942) turned into a regression test.
  it('R309-2P-1: a swap hold WITHOUT any wallet hash is never closed through the replacement check', async () => {
    const c = chain();
    c.state.finalized = c.state.latest = { number: 17n, hash: hash('c'), timestamp: 300n };
    store(hold('awaiting-wallet')); // the first prompt may still be open in the wallet
    // The user sent another transaction at nonce 4, as the panel used to suggest; it is finalized.
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
    const wallet = walletThatMustNotBeAsked();
    const { hook } = mount(c, wallet.provider, () => 300_000);
    await waitFor(() => expect(hook.result.current.open).toBe(true));
    await act(async () => {
      await expect(hook.result.current.checkReplacement(ONE)).rejects.toThrow(
        REPLACEMENT_NOT_FOR_UNSEEN_SWAPS,
      );
    });
    // The hold stays: no new swap can be reserved, so the old prompt signed at nonce 5 stays the only swap.
    expect(stored()?.intent?.id).toBe(swapIntent.id);
    expect(hook.result.current.open).toBe(true);
    expect(wallet.request).not.toHaveBeenCalled();
    // It ends at the deadline in a finalized block, and only there.
    c.state.finalized = c.state.latest = { number: 30n, hash: hash('6'), timestamp: DEADLINE + 1n };
    await waitFor(() => expect(hook.result.current.tracked?.state).toBe('expired'));
    expect(hook.result.current.tracked?.detail).toMatch(/may have been this swap/);
  });

  it('R309-2P-1: an approval hold without a hash can still be closed by a finalized replacement', async () => {
    const c = chain();
    c.state.finalized = c.state.latest = { number: 17n, hash: hash('c'), timestamp: 300n };
    store(hold('unknown', [], intentOf(APPROVE, 'approval')));
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
      expect((await hook.result.current.checkReplacement(ONE)).transactionHash).toBe(ONE);
    });
  });

  // Review R309-2P-4 (bfeb942): the stored deadline must be the one inside the saved call.
  it('R309-2P-4: a record whose deadline field is not the saved call deadline is unreadable: nothing is sent, and only a deliberate discard removes it', async () => {
    const c = chain();
    // A finalized block past the LOWER stored deadline but before the deadline a wallet would sign.
    c.state.finalized = c.state.latest = { number: 20n, hash: hash('9'), timestamp: 2_000n };
    store({ ...hold('unknown'), deadline: 1_000n });
    expect(parsePendingSwap(localStorage.getItem(key))).toBeNull();
    expect(savedSwapDeadline(SWAP.data)).toBe(DEADLINE);
    const wallet = walletThatMustNotBeAsked();
    const { hook } = mount(c, wallet.provider, () => 3_000_000);
    await waitFor(() => expect(hook.result.current.storageProblem).toBe(UNREADABLE_RECORD));
    // Fail safe: the page counts as holding (Swap disabled), the record stays, the wallet is not asked.
    expect(hook.result.current.open).toBe(true);
    expect(hook.result.current.unreadable).toBe(true);
    await settle();
    expect(localStorage.getItem(key)).not.toBeNull();
    expect(wallet.request).not.toHaveBeenCalled();
    await act(async () => {
      await expect(hook.result.current.reviewInWallet()).rejects.toThrow();
    });
    // The manual clear removes exactly this unreadable record.
    await act(async () => {
      expect(await hook.result.current.discardUnreadable()).toBe(true);
    });
    expect(localStorage.getItem(key)).toBeNull();
    expect(hook.result.current.storageProblem).toBeNull();
    expect(hook.result.current.open).toBe(false);
  });

  it('never discards a readable hold, and a non-swap record with a deadline is unreadable too', async () => {
    const c = chain();
    store(hold('unknown'));
    const { hook } = mount(c, walletThatMustNotBeAsked().provider, () => 300_000);
    await waitFor(() => expect(hook.result.current.open).toBe(true));
    expect(hook.result.current.unreadable).toBe(false);
    await act(async () => {
      expect(await hook.result.current.discardUnreadable()).toBe(false);
    });
    expect(stored()?.intent?.id).toBe(swapIntent.id);
    store({ ...hold('unknown', [], intentOf(APPROVE, 'approval')), deadline: 5n });
    expect(parsePendingSwap(localStorage.getItem(key))).toBeNull();
  });
});

describe('the swap deadline: device clock, idle chain, settler policy (R309-2P-5, 3P-1, 4P-1 to 4P-4)', () => {
  const T = 1_792_200_000n;
  const at = (seconds: number) => (Number(T) + seconds) * 1000;
  const ok = (clock: SwapClock) => {
    if (!clock.ok) throw new Error(clock.problem);
    return clock;
  };
  it('counts the deadline from the device clock on a busy chain, and never from before the chain', () => {
    expect(swapClock(at(30), T, DEFAULT_IDLE_POLICY, 10)).toEqual({
      ok: true,
      base: T + 30n,
      deadline: T + 30n + 600n,
      deadlineMinutes: 10,
      idleSeconds: 30n,
      notice: null,
    });
    // Up to two minutes behind the chain: the chain's own time is the base.
    expect(ok(swapClock(at(-120), T, DEFAULT_IDLE_POLICY, 10)).deadline).toBe(T + 600n);
    expect(ok(swapClock(at(29 * 60), T)).notice).toBeNull();
  });

  // Third pass, the reviewer's demonstration (2cc1536) turned: a quiet chain does not close the page.
  it('R309-3P-1: a correct clock on a quiet L2 (151 minutes, 18 hours, 25 hours without a block) builds the swap and says the chain is idle', () => {
    for (const [age, words] of [
      [151 * 60, /no block for 2 hours: it is idle/],
      [18 * 3_600, /no block for 18 hours/],
      [25 * 3_600, /no block for 25 hours/],
      [45 * 60, /no block for 45 minutes/],
    ] as [number, RegExp][]) {
      const clock = ok(swapClock(at(age), T));
      expect(clock.base).toBe(T + BigInt(age));
      expect(clock.notice).toMatch(words);
    }
  });

  it('R309-4P-3: on an idle chain the deadline covers the block after the next, and the user is told the wait', () => {
    expect(idleDeadlineSeconds(DEFAULT_IDLE_POLICY)).toBe(4_500); // 2 x 1800 + 900
    // A 10 or 15 minute deadline would revert in the second block: it is raised to 75 minutes.
    for (const minutes of [10, 15, 60]) {
      const clock = ok(swapClock(at(5 * 3_600), T, DEFAULT_IDLE_POLICY, minutes));
      expect(clock.deadlineMinutes).toBe(75);
      expect(clock.deadline).toBe(T + BigInt(5 * 3_600 + 75 * 60));
      expect(clock.notice).toMatch(
        new RegExp(
          `the first block after a pause takes no transactions, so the swap is included in the block after it, in about 60 minutes.*The deadline was raised from ${minutes} to 75 minutes to cover that wait`,
        ),
      );
    }
    // A longer deadline of the user stands, and nothing is said about raising it.
    const long = ok(swapClock(at(5 * 3_600), T, DEFAULT_IDLE_POLICY, 120));
    expect(long.deadlineMinutes).toBe(120);
    expect(long.notice).not.toMatch(/was raised/);
    // The figures follow the network file's block interval.
    const fast = { ...DEFAULT_IDLE_POLICY, blockIntervalSeconds: 660 };
    expect(ok(swapClock(at(3_600), T, fast, 10)).deadlineMinutes).toBe(28); // ceil((1320 + 330) / 60)
    expect(ok(swapClock(at(3_600), T, fast, 10)).notice).toMatch(/in about 22 minutes/);
    // On a busy chain a short deadline is the user's choice.
    expect(ok(swapClock(at(300), T, DEFAULT_IDLE_POLICY, 10)).deadlineMinutes).toBe(10);
  });

  it('R309-4P-4: follows the settler policy of the network file, with idle blocks skipped or not', () => {
    // Idle blocks skipped (the launch setting): refused only beyond the heartbeat plus its margin.
    const limit = 86_400 + IDLE_MARGIN_SECONDS;
    expect(swapClock(at(limit), T).ok).toBe(true);
    const far = swapClock(at(limit + 1), T);
    expect(!far.ok && far.problem).toMatch(
      /26 hours ahead of the latest L2 block\. The L2 makes a block at least every 24 hours even when it is idle, so either this clock is wrong or this RPC is not showing the current chain\. Nothing was sent\./,
    );
    // An operator's own heartbeat (the kit's idle rehearsal used 8 h).
    const eight = { ...DEFAULT_IDLE_POLICY, heartbeatSeconds: 8 * 3_600 };
    expect(swapClock(at(10 * 3_600), T, eight).ok).toBe(true);
    expect(swapClock(at(10 * 3_600 + 1), T, eight).ok).toBe(false);
    // Idle blocks NOT skipped: every cycle makes a block, there is no heartbeat, and a head older than one
    // interval plus the margin is a wrong clock or a stale RPC, whatever heartbeat the file carries.
    const every = { ...DEFAULT_IDLE_POLICY, skipIdleBlocks: false };
    expect(longestQuiet(every)).toBe(1_800);
    expect(swapClock(at(1_800 + IDLE_MARGIN_SECONDS), T, every).ok).toBe(true);
    const stale = swapClock(at(1_800 + IDLE_MARGIN_SECONDS + 1), T, every);
    expect(!stale.ok && stale.problem).toMatch(
      /The L2 makes a block at least every 30 minutes, so either this clock is wrong/,
    );
    expect(longestQuiet(DEFAULT_IDLE_POLICY)).toBe(86_400);
  });

  it('refuses a clock behind the chain, and never sends a deadline that is not after the latest block (R309-4P-2)', () => {
    const behind = swapClock(at(-121), T);
    expect(!behind.ok && behind.problem).toMatch(/121 seconds behind the latest L2 block/);
    const past = swapClock(at(-60), T, DEFAULT_IDLE_POLICY, 0);
    expect(!past.ok && past.problem).toMatch(
      /would not be after the latest L2 block's time, so the swap could only revert/,
    );
    expect(swapClock(at(-60), T, DEFAULT_IDLE_POLICY, -5).ok).toBe(false);
    // Whatever the device clock inside the tolerance, an accepted deadline is after the chain's time by the full minutes.
    for (const lag of [-120, -1, 0, 1])
      expect(ok(swapClock(at(lag), T, DEFAULT_IDLE_POLICY, 10)).deadline >= T + 600n).toBe(true);
  });

  // Fourth pass, the reviewer's demonstrations (355683f): what the rule still lets through, and what it now covers.
  it('R309-4P-1, 4P-2 (known residuals): a clock 25 h 50 min ahead on a busy chain is accepted; a clock 60 minutes behind on a chain idle for 5 h is covered by the idle deadline only up to its margin', () => {
    const TRUE_NOW = 1_800_000_000;
    const busy = ok(
      swapClock(
        (TRUE_NOW + 25 * 3_600 + 50 * 60) * 1000,
        BigInt(TRUE_NOW - 60),
        DEFAULT_IDLE_POLICY,
        10,
      ),
    );
    expect(busy.base - BigInt(TRUE_NOW)).toBe(BigInt(25 * 3_600 + 50 * 60)); // listed in KNOWN-ISSUES
    const slow = ok(
      swapClock((TRUE_NOW - 3_600) * 1000, BigInt(TRUE_NOW - 5 * 3_600), DEFAULT_IDLE_POLICY, 10),
    );
    // Before: 10 minutes from a clock an hour slow was already past. Now 75 minutes: 15 minutes after the true time,
    // which is still before the second block (about 60 minutes away): this lag reverts, gas only (listed).
    expect(slow.deadline - BigInt(TRUE_NOW)).toBe(900n);
    // A lying RPC cannot move the deadline.
    expect(swapClock(TRUE_NOW * 1000, BigInt(TRUE_NOW + 121)).ok).toBe(false);
    expect(ok(swapClock(TRUE_NOW * 1000, BigInt(TRUE_NOW + 120))).base).toBe(
      BigInt(TRUE_NOW + 120),
    );
    expect(ok(swapClock(TRUE_NOW * 1000, BigInt(TRUE_NOW - 20 * 3_600))).base).toBe(
      BigInt(TRUE_NOW),
    );
    expect(swapClock(TRUE_NOW * 1000, BigInt(TRUE_NOW - 26 * 3_600 - 1)).ok).toBe(false);
  });

  it('reads the settler policy from the network file, with the launch values as default and bounds', () => {
    expect(parseIdlePolicy(undefined)).toEqual(DEFAULT_IDLE_POLICY);
    expect(parseIdlePolicy({ heartbeatSeconds: 43_200 })).toEqual({
      ...DEFAULT_IDLE_POLICY,
      heartbeatSeconds: 43_200,
    });
    expect(
      parseIdlePolicy({
        skipIdleBlocks: false,
        blockIntervalSeconds: 660,
        heartbeatSeconds: 86_400,
      }),
    ).toEqual({
      skipIdleBlocks: false,
      blockIntervalSeconds: 660,
      heartbeatSeconds: 86_400,
    });
    for (const bad of [
      { heartbeatSeconds: 60 },
      { heartbeatSeconds: 8 * 86_400 },
      { heartbeatSeconds: '86400' },
      { blockIntervalSeconds: 30 },
      { blockIntervalSeconds: 7 * 3_600 },
      { skipIdleBlocks: 'yes' },
      { other: 1 },
      [],
    ])
      expect(() => parseIdlePolicy(bad)).toThrow(/l2Idle/);
  });

  it('R309-3P-3: a waiting swap hold says what ends the wait on a quiet chain; other requests do not', () => {
    expect(idleWaitNote(hold('unknown'), 86_400)).toMatch(
      /only when it has work: on a quiet chain the finalized block that ends this wait can be up to 24 hours away/,
    );
    expect(idleWaitNote(hold('unknown'), 43_200)).toMatch(/up to 12 hours away/);
    expect(idleWaitNote(hold('unknown', [], intentOf(APPROVE, 'approval')), 86_400)).toBe('');
  });
});
