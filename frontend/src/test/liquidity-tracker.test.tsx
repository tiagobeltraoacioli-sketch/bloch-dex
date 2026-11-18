// Round 20 (agent 411): a deposit or a removal of liquidity is tracked by the SAME tracker as a swap, under the
// same rules as a swap wherever a second copy would spend twice: it carries the deadline of its saved call, is
// never requested from the wallet a second time, ends by its deadline at a canonical finalized block, and a
// REVERTED receipt releases the account only by the chain's rule for reverted requests. The approval of a pool's
// share token is an approval like any other.
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Address, type Hex } from 'viem';
import type { Rpc } from '../devnet4/chain';
import type { DevnetDeployment } from '../devnet4/record';
import { approveTransaction, type TransactionRequest } from '../devnet4/swap';
import {
  addLiquidityTransaction,
  decodeLiquidityCall,
  removeLiquidityTransaction,
  savedLiquidityDeadline,
} from '../mainnet/liquidity-tx';
import {
  parsePendingSwap,
  pendingSwapKey,
  usePendingSwap,
  type PendingSwap,
} from '../mainnet/pendingswap';
import {
  expiredSwap,
  finalizedSubmissionReceipt,
  holdsUntilDeadline,
  savedSwapDeadline,
  submissionContext,
  type SubmissionIntent,
} from '../mainnet/submission-outcome';
import {
  sameNonceReviewDetails,
  transactionForSameNonceReview,
} from '../mainnet/submission-review';
import type { Provider } from '../wallet';
import { browserLocksForTest } from './browser-locks';

const address = (digit: string) => `0x${digit.repeat(40)}` as Address;
const hash = (digit: string) => `0x${digit.repeat(64)}` as Hex;
const FROM = address('1'),
  TOKEN = address('2'),
  WRAPPED = address('3'),
  OTHER = address('4');
const BOUNDARY = { number: '0xf', hash: hash('b'), timestamp: '0xff' };
const DEADLINE = 4096n;
const ONE = hash('1');
const NATIVE_PAIR = { address: address('8'), token0: TOKEN, token1: WRAPPED };
const TOKEN_PAIR = { address: address('9'), token0: TOKEN, token1: OTHER };
const deployment: DevnetDeployment = {
  name: 'liquidity tracker fixture',
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
  tokens: [TOKEN, WRAPPED, OTHER].map((a) => ({
    address: a,
    symbol: 'TEST',
    cap: 1000000n,
    wrapped: a === WRAPPED,
  })),
  pairs: [NATIVE_PAIR, TOKEN_PAIR],
  gate: { decision: 'liquidity-enabled', finalizedNumber: 15n, finalizedHash: BOUNDARY.hash },
};
const context = submissionContext(deployment);
const key = pendingSwapKey(deployment.chainId, FROM);
const ADD: TransactionRequest = addLiquidityTransaction(
  deployment,
  NATIVE_PAIR,
  { desired0: 3000n, desired1: 10n ** 18n, min0: 2985n, min1: 995n * 10n ** 15n },
  FROM,
  DEADLINE,
);
const REMOVE: TransactionRequest = removeLiquidityTransaction(
  deployment,
  TOKEN_PAIR,
  { liquidity: 500n, min0: 10n, min1: 20n },
  FROM,
  DEADLINE,
);
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
const addIntent = intentOf(ADD, 'liquidity');
function hold(
  state: 'awaiting-wallet' | 'unknown',
  hashes: Hex[] = [],
  intent = addIntent,
  deadline = DEADLINE,
): PendingSwap {
  return {
    label: 'Add 1 ETH and 0.003 TEST',
    deadline,
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

function chain() {
  const state = {
    finalized: { number: 16n, hash: hash('a'), timestamp: 256n },
    latest: { number: 16n, hash: hash('a'), timestamp: 256n },
    nonce: 4n,
    bodies: new Map<Hex, Record<string, unknown>>(),
    receipts: new Map<Hex, Record<string, unknown>>(),
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
      if (tag === 'finalized') return view(state.finalized);
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
  to: ADD.to,
  input: ADD.data,
  value: q(ADD.value),
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

describe('liquidity calls: built for a recorded pair only, and read back exactly', () => {
  it('uses the native entry point for a side that is the wrapped native token, with the value as that side', () => {
    expect(ADD.to).toBe(deployment.router);
    expect(ADD.value).toBe(10n ** 18n);
    expect(decodeLiquidityCall(deployment, ADD.data, ADD.value)).toEqual({
      action: 'add',
      pair: NATIVE_PAIR,
      recipient: FROM,
      deadline: DEADLINE,
      desired0: 3000n,
      desired1: 10n ** 18n,
      min0: 2985n,
      min1: 995n * 10n ** 15n,
    });
    expect(decodeLiquidityCall(deployment, REMOVE.data, REMOVE.value)).toEqual({
      action: 'remove',
      pair: TOKEN_PAIR,
      recipient: FROM,
      deadline: DEADLINE,
      liquidity: 500n,
      min0: 10n,
      min1: 20n,
    });
    expect(savedLiquidityDeadline(ADD.data)).toBe(DEADLINE);
    expect(savedLiquidityDeadline(REMOVE.data)).toBe(DEADLINE);
  });

  it('refuses a pair the record does not list, a missing minimum, a minimum above its amount and a missing deadline', () => {
    const stranger = { address: address('a'), token0: TOKEN, token1: OTHER };
    const amounts = { desired0: 100n, desired1: 200n, min0: 99n, min1: 199n };
    expect(() => addLiquidityTransaction(deployment, stranger, amounts, FROM, DEADLINE)).toThrow(
      /not a pool of the verified deployment record/,
    );
    expect(() =>
      addLiquidityTransaction(deployment, TOKEN_PAIR, { ...amounts, min0: 0n }, FROM, DEADLINE),
    ).toThrow(/no valid minimums/);
    expect(() =>
      addLiquidityTransaction(deployment, TOKEN_PAIR, { ...amounts, min1: 201n }, FROM, DEADLINE),
    ).toThrow(/no valid minimums/);
    expect(() => addLiquidityTransaction(deployment, TOKEN_PAIR, amounts, FROM, 0n)).toThrow(
      /no deadline/,
    );
    expect(() =>
      removeLiquidityTransaction(
        deployment,
        stranger,
        { liquidity: 1n, min0: 1n, min1: 1n },
        FROM,
        DEADLINE,
      ),
    ).toThrow(/not a pool of the verified deployment record/);
    expect(() =>
      removeLiquidityTransaction(
        deployment,
        TOKEN_PAIR,
        { liquidity: 1n, min0: 0n, min1: 1n },
        FROM,
        DEADLINE,
      ),
    ).toThrow(/no valid minimums/);
  });
});

describe('a liquidity request is held like a swap', () => {
  it('names the kinds a second copy of which would spend twice', () => {
    expect(holdsUntilDeadline('swap')).toBe(true);
    expect(holdsUntilDeadline('liquidity')).toBe(true);
    expect(holdsUntilDeadline('approval')).toBe(false);
    expect(holdsUntilDeadline('skim')).toBe(false);
  });

  it('reads the deadline of a saved liquidity call, and a stored record must carry exactly that deadline', () => {
    expect(savedSwapDeadline(ADD.data)).toBe(DEADLINE);
    expect(savedSwapDeadline(REMOVE.data)).toBe(DEADLINE);
    store(hold('unknown'));
    expect(stored()?.intent?.kind).toBe('liquidity');
    expect(stored()?.deadline).toBe(DEADLINE);
    // A record whose deadline field is not the saved call's is unreadable as a whole (review R309-2P-4).
    store(hold('unknown', [], addIntent, DEADLINE + 1n));
    expect(stored()).toBeNull();
    store(hold('unknown', [], addIntent, 0n));
    expect(stored()).toBeNull();
  });

  it('offers no same-nonce review and never asks the wallet a second time', async () => {
    const c = chain();
    const wallet = walletThatMustNotBeAsked();
    store(hold('awaiting-wallet'));
    const { hook } = mount(c, wallet.provider, () => 300_000);
    await waitFor(() => expect(hook.result.current.open).toBe(true));
    expect(hook.result.current.review).toBeUndefined();
    await act(async () => {
      await expect(hook.result.current.reviewInWallet()).rejects.toThrow(
        /A liquidity request is never requested from the wallet a second time/,
      );
    });
    expect(wallet.request.mock.calls.some(([a]) => a.method === 'eth_sendTransaction')).toBe(false);
    expect(hook.result.current.tracked?.detail).toMatch(
      /The hold ends by itself once the request's deadline has passed in a finalized block\./,
    );
    expect(hook.result.current.tracked?.detail).not.toMatch(/swap deadline/);
    expect(() => transactionForSameNonceReview(addIntent, DEADLINE, deployment)).toThrow(
      /does not match an allowed transaction/,
    );
  });

  it('ends by its deadline at a canonical finalized block, in its own words, with no wallet request', async () => {
    const c = chain();
    c.state.finalized = c.state.latest = { number: 20n, hash: hash('9'), timestamp: DEADLINE + 1n };
    const wallet = walletThatMustNotBeAsked();
    store(hold('awaiting-wallet'));
    const { hook, onMined } = mount(c, wallet.provider, AFTER);
    await waitFor(() => expect(hook.result.current.tracked?.state).toBe('expired'));
    expect(stored()).toBeNull();
    expect(hook.result.current.tracked?.detail).toMatch(
      /^The request's deadline passed in canonical finalized block 20, and no transaction of this account used nonce 4 before it: sent from an ordinary wallet account this request did not execute, and it can no longer execute\./,
    );
    expect(hook.result.current.tracked?.detail).not.toMatch(/swap/i);
    expect(onMined).toHaveBeenCalledTimes(1);
    expect(wallet.request).not.toHaveBeenCalled();
  });

  it('keeps the hold while the finalized block is not past the deadline', async () => {
    const c = chain();
    c.state.finalized = { number: 20n, hash: hash('9'), timestamp: DEADLINE };
    c.state.latest = { number: 21n, hash: hash('8'), timestamp: DEADLINE + 50n };
    store(hold('unknown'));
    const { hook } = mount(c, walletThatMustNotBeAsked().provider, AFTER);
    await waitFor(() => expect(hook.result.current.open).toBe(true));
    await settle();
    expect(hook.result.current.tracked?.state).toBe('unknown');
    expect(stored()?.intent?.id).toBe(addIntent.id);
  });

  it('expires by the strict reader only, like a swap', async () => {
    const settled = chain();
    settled.state.finalized = settled.state.latest = {
      number: 20n,
      hash: hash('9'),
      timestamp: DEADLINE + 1n,
    };
    expect(await expiredSwap(settled.rpc, addIntent, context, DEADLINE, [])).not.toBeNull();
    const strict = chain();
    strict.state.finalized = { number: 16n, hash: hash('a'), timestamp: DEADLINE - 1n };
    const rpc = Object.assign(settled.rpc, { strict: strict.rpc });
    expect(await expiredSwap(rpc, addIntent, context, DEADLINE, [])).toBeNull();
    // An approval never ends by time, whatever it is an approval of.
    const approval = intentOf(
      approveTransaction(deployment, NATIVE_PAIR.address, FROM, 5n),
      'approval',
    );
    expect(await expiredSwap(settled.rpc, approval, context, 0n, [])).toBeNull();
  });

  it('a REVERTED receipt releases the account by the rule for reverted requests; a success by the settled view', async () => {
    const included = (status: '0x1' | '0x0') => {
      const settled = chain();
      settled.state.finalized = settled.state.latest = {
        number: 17n,
        hash: hash('c'),
        timestamp: 300n,
      };
      settled.state.bodies.set(ONE, body(ONE, true));
      settled.state.receipts.set(ONE, {
        transactionHash: ONE,
        from: FROM,
        to: ADD.to,
        blockNumber: '0x11',
        blockHash: hash('c'),
        status,
        gasUsed: '0x5208',
      });
      const strict = chain();
      strict.state.latest = { number: 17n, hash: hash('c'), timestamp: 300n };
      return { settled, strict, rpc: Object.assign(settled.rpc, { strict: strict.rpc }) };
    };
    const ok = included('0x1');
    expect(await finalizedSubmissionReceipt(ok.rpc, ONE, addIntent, context)).toMatchObject({
      status: 'success',
    });
    expect(ok.strict.rpc).not.toHaveBeenCalled();
    const bad = included('0x0');
    expect(await finalizedSubmissionReceipt(bad.rpc, ONE, addIntent, context)).toBeNull();
    expect(bad.strict.rpc).toHaveBeenCalledWith('eth_getBlockByNumber', ['finalized', false]);
    bad.strict.state.finalized = { number: 17n, hash: hash('c'), timestamp: 300n };
    expect(await finalizedSubmissionReceipt(bad.rpc, ONE, addIntent, context)).toMatchObject({
      status: 'reverted',
    });
  });

  it('a reverted liquidity request is shown with the block it reverted in, for the page to explain it', async () => {
    const c = chain();
    c.state.finalized = c.state.latest = { number: 17n, hash: hash('c'), timestamp: 300n };
    c.state.bodies.set(ONE, body(ONE, true));
    c.state.receipts.set(ONE, {
      transactionHash: ONE,
      from: FROM,
      to: ADD.to,
      blockNumber: '0x11',
      blockHash: hash('c'),
      status: '0x0',
      gasUsed: '0x5208',
    });
    store(hold('unknown', [ONE]));
    const { hook } = mount(c, walletThatMustNotBeAsked().provider, () => 300_000);
    await waitFor(() => expect(hook.result.current.tracked?.state).toBe('failed'));
    expect(hook.result.current.tracked?.receiptBlock).toBe(17n);
    expect(hook.result.current.tracked?.intent?.kind).toBe('liquidity');
  });
});

describe('the approval of pool shares is an approval', () => {
  it('passes the same-nonce review for a pair of the record, and for no other address', () => {
    const tx = approveTransaction(deployment, NATIVE_PAIR.address, FROM, 500n);
    const intent = intentOf(tx, 'approval');
    expect(transactionForSameNonceReview(intent, 0n, deployment)).toMatchObject({
      to: NATIVE_PAIR.address,
      data: tx.data,
      nonce: 4n,
    });
    expect(sameNonceReviewDetails(intent, 0n, deployment)).toContainEqual([
      'Exact allowance (base units)',
      '500',
    ]);
    const elsewhere = intentOf(
      approveTransaction(deployment, address('a'), FROM, 500n),
      'approval',
    );
    expect(() => transactionForSameNonceReview(elsewhere, 0n, deployment)).toThrow(
      /does not match an allowed transaction/,
    );
    // Still exact: an unlimited allowance of pool shares is refused like any other.
    const unlimited = intentOf(
      approveTransaction(deployment, NATIVE_PAIR.address, FROM, 2n ** 256n - 1n),
      'approval',
    );
    expect(() => transactionForSameNonceReview(unlimited, 0n, deployment)).toThrow(
      /does not match an allowed transaction/,
    );
  });
});
