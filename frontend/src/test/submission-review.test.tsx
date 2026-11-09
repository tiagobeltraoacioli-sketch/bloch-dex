import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, type Address, type Hex } from 'viem';
import { ERC20_ABI, type Rpc } from '../devnet4/chain';
import type { DevnetDeployment } from '../devnet4/record';
import {
  approveTransaction,
  ROUTER_ABI,
  swapTransaction,
  type TransactionRequest,
} from '../devnet4/swap';
import {
  parsePendingSwap,
  pendingSwapKey,
  usePendingSwap,
  type PendingSwap,
} from '../mainnet/pendingswap';
import { skimTransaction } from '../mainnet/reads';
import {
  submissionBoundary,
  submissionContext,
  verifySameNonceReview,
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
const HEAD = { number: '0x10', hash: hash('a'), timestamp: '0x100' };
const BOUNDARY = { number: '0xf', hash: hash('b'), timestamp: '0xff' };
const INCLUDED = { number: '0x11', hash: hash('c'), timestamp: '0x101' };
const ONE = hash('1'),
  TWO = hash('2');
const deployment: DevnetDeployment = {
  name: 'Isolated review fixture',
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
  pairs: [
    { address: address('8'), token0: TOKEN, token1: WRAPPED },
    { address: address('9'), token0: WRAPPED, token1: OTHER },
  ],
  gate: { decision: 'liquidity-enabled', finalizedNumber: 15n, finalizedHash: BOUNDARY.hash },
};
const context = submissionContext(deployment);
const key = pendingSwapKey(deployment.chainId, FROM);
const intentOf = (
  tx: TransactionRequest,
  kind: SubmissionIntent['kind'] = 'approval',
): SubmissionIntent => ({
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
const approval = () => intentOf(approveTransaction(deployment, TOKEN, FROM, 123n));
function saved(intent = approval(), deadline = 0n, hashes: Hex[] = []): PendingSwap {
  return {
    label: 'Untrusted local label',
    deadline,
    sentAtMs: 0,
    intent,
    ...(hashes.length ? { hash: hashes.at(-1), candidateHashes: hashes } : {}),
    walletAttempt: {
      id: '87654321-1234-1234-1234-123456789abc',
      mode: 'initial',
      state: 'unknown',
      startedAtMs: 0,
    },
  };
}
function store(value: PendingSwap) {
  localStorage.setItem(
    key,
    JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  );
}
const stored = () => parsePendingSwap(localStorage.getItem(key));
function fixture(initial = saved()) {
  store(initial);
  const bodies = new Map<Hex, Record<string, unknown>>();
  const receipts = new Map<Hex, Record<string, unknown>>();
  let nonce = 4n;
  const queued = { count: 0n };
  let head = HEAD;
  const rpc = vi.fn<Rpc>(async (method, params) => {
    if (method === 'eth_chainId') return '0xab162';
    if (method === 'eth_getBlockByNumber') {
      if (params[0] === '0x0') return { number: '0x0', hash: deployment.genesisHash };
      if (params[0] === BOUNDARY.number) return BOUNDARY;
      if (params[0] === 'finalized') return receipts.size ? INCLUDED : HEAD;
      if (params[0] === INCLUDED.number) return INCLUDED;
      return head;
    }
    if (method === 'eth_getTransactionCount') {
      // Round 14 (H1): a review is only offered while nothing from the account is queued.
      if (params[1] === 'pending') return `0x${(nonce + queued.count).toString(16)}`;
      return `0x${nonce.toString(16)}`;
    }
    if (method === 'eth_getTransactionByHash') return bodies.get(params[0] as Hex) ?? null;
    if (method === 'eth_getTransactionReceipt') return receipts.get(params[0] as Hex) ?? null;
    throw new Error(`Unexpected RPC ${method}`);
  });
  const addBody = (h: Hex, intent = initial.intent!) =>
    bodies.set(h, {
      hash: h,
      from: intent.from,
      to: intent.to,
      input: intent.data,
      value: `0x${BigInt(intent.value).toString(16)}`,
      chainId: '0xab162',
      nonce: '0x4',
      blockNumber: INCLUDED.number,
      blockHash: INCLUDED.hash,
    });
  const mine = (h: Hex) => {
    addBody(h);
    receipts.set(h, {
      transactionHash: h,
      from: initial.intent!.from,
      to: initial.intent!.to,
      blockNumber: INCLUDED.number,
      blockHash: INCLUDED.hash,
      status: '0x1',
      gasUsed: '0x1000',
    });
  };
  const provider: Provider = {
    request: vi.fn(async ({ method }) => {
      if (method === 'eth_chainId') return '0xab162';
      if (method === 'eth_sendTransaction') {
        addBody(TWO);
        return TWO;
      }
      throw new Error(`Unexpected wallet ${method}`);
    }),
  };
  const onMined = vi.fn();
  const args = {
    rpc,
    provider,
    account: FROM,
    chainId: deployment.chainId,
    deployment,
    enabled: true,
    now: () => 300000,
    onMined,
    intervalMs: 2,
  };
  const mount = () => renderHook((current) => usePendingSwap(current), { initialProps: args });
  return {
    rpc,
    queued,
    provider,
    bodies,
    receipts,
    args,
    mount,
    mine,
    addBody,
    onMined,
    setNonce: (n: bigint) => {
      nonce = n;
    },
    setHead: (h: typeof HEAD) => {
      head = h;
    },
  };
}

beforeEach(() => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: browserLocksForTest() });
});

describe('allowed same-nonce call reconstruction', () => {
  it('rebuilds exact approvals and derives the allowance and spender from calldata', () => {
    const intent = approval();
    expect(transactionForSameNonceReview(intent, 0n, deployment)).toEqual({
      ...approveTransaction(deployment, TOKEN, FROM, 123n),
      chainId: deployment.chainId,
      nonce: 4n,
    });
    expect(sameNonceReviewDetails(intent, 0n, deployment)).toContainEqual([
      'Exact allowance (base units)',
      '123',
    ]);
    expect(sameNonceReviewDetails(intent, 0n, deployment)).toContainEqual([
      'Spender',
      deployment.router,
    ]);
  });
  it.each([
    { to: address('e') },
    { gas: '200000' },
    { value: '1' },
    { deploymentId: hash('e') },
    { data: '0x1234' as Hex },
    { data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [OTHER, 123n] }) },
    {
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [deployment.router, 2n ** 256n - 1n],
      }),
    },
  ])('rejects a modified approval outside the reviewed body case %#', (change) => {
    expect(() =>
      transactionForSameNonceReview({ ...approval(), ...change }, 0n, deployment),
    ).toThrow();
  });
  it('rejects an approval with a fabricated deadline', () => {
    expect(() => transactionForSameNonceReview(approval(), 999n, deployment)).toThrow();
  });
  it.each(['token-token', 'native-token', 'token-native'] as const)(
    'preserves %s swap bytes and the original deadline',
    (kind) => {
      const nativeIn = kind === 'native-token',
        nativeOut = kind === 'token-native';
      const path = nativeIn
        ? [WRAPPED, TOKEN]
        : nativeOut
          ? [TOKEN, WRAPPED]
          : [TOKEN, WRAPPED, OTHER];
      const tx = swapTransaction(
        deployment,
        {
          amountIn: 123n,
          minimumOut: 100n,
          amountOut: 110n,
          path,
          amounts: [],
          executionLossBps: [],
          blockNumber: 16n,
        },
        { token: path[0], native: nativeIn },
        { token: path.at(-1)!, native: nativeOut },
        FROM,
        999n,
      );
      expect(transactionForSameNonceReview(intentOf(tx, 'swap'), 999n, deployment)).toEqual({
        ...tx,
        chainId: deployment.chainId,
        nonce: 4n,
      });
      expect(() =>
        transactionForSameNonceReview(intentOf(tx, 'swap'), 1000n, deployment),
      ).toThrow();
    },
  );
  it.each([
    [100n, [TOKEN, WRAPPED], OTHER, 999n],
    [0n, [TOKEN, WRAPPED], FROM, 999n],
    [100n, [TOKEN, OTHER], FROM, 999n],
    [100n, [TOKEN, WRAPPED, TOKEN], FROM, 999n],
  ] as const)(
    'refuses a different recipient, zero minimum or an unapproved path case %#',
    (minimum, path, recipient, deadline) => {
      const tx = {
        from: FROM,
        to: deployment.router,
        value: 0n,
        gas: 250000n,
        data: encodeFunctionData({
          abi: ROUTER_ABI,
          functionName: 'swapExactTokensForTokens',
          args: [123n, minimum, path, recipient, deadline],
        }),
      };
      expect(() => transactionForSameNonceReview(intentOf(tx, 'swap'), 999n, deployment)).toThrow();
    },
  );
  it('only rebuilds skims to the original sender at an approved pair', () => {
    const tx = skimTransaction(deployment.pairs[0].address, FROM);
    expect(transactionForSameNonceReview(intentOf(tx, 'skim'), 0n, deployment)).toEqual({
      ...tx,
      chainId: deployment.chainId,
      nonce: 4n,
    });
    const differentRecipient = { ...skimTransaction(tx.to, OTHER), from: FROM };
    expect(() =>
      transactionForSameNonceReview(intentOf(differentRecipient, 'skim'), 0n, deployment),
    ).toThrow();
    expect(() =>
      transactionForSameNonceReview(intentOf({ ...tx, to: TOKEN }, 'skim'), 0n, deployment),
    ).toThrow();
  });
});

describe('explicit same-nonce wallet review', () => {
  it('makes no second wallet request while the original is still queued at the sequencer', async () => {
    const f = fixture(saved(approval(), 0n, [ONE]));
    f.queued.count = 1n;
    const hook = f.mount();
    await waitFor(() => expect(hook.result.current.open).toBe(true));
    await expect(hook.result.current.reviewInWallet()).rejects.toThrow(
      /still queued at the sequencer/,
    );
    expect(
      vi.mocked(f.provider.request).mock.calls.filter(([a]) => a.method === 'eth_sendTransaction'),
    ).toHaveLength(0);
    expect(stored()).toMatchObject({ hash: ONE, candidateHashes: [ONE] });
  });
  it('persists a new attempt before the wallet, retains prior candidates and sends no automatic fees', async () => {
    const f = fixture(saved(approval(), 0n, [ONE]));
    const original = f.provider.request;
    f.provider.request = vi.fn(async (args) => {
      if (args.method === 'eth_sendTransaction') {
        expect(stored()?.walletAttempt).toMatchObject({ mode: 'review', state: 'awaiting-wallet' });
        expect(stored()?.candidateHashes).toContain(ONE);
      }
      return original(args);
    });
    const hook = f.mount();
    await act(async () => {
      await hook.result.current.reviewInWallet();
    });
    expect(f.provider.request).toHaveBeenCalledWith({
      method: 'eth_sendTransaction',
      params: [
        {
          from: FROM,
          to: TOKEN,
          data: approval().data,
          value: '0x0',
          gas: '0x186a0',
          chainId: '0xab162',
          nonce: '0x4',
        },
      ],
    });
    expect(stored()).toMatchObject({
      hash: TWO,
      candidateHashes: [ONE, TWO],
      intent: approval(),
      walletAttempt: { mode: 'review', state: 'returned' },
    });
    expect(
      f.rpc.mock.calls.some(([m, p]) => m === 'eth_getTransactionCount' && p[1] === 'pending'),
    ).toBe(true);
    expect(hook.result.current.open).toBe(true);
  });
  it.each([
    Object.assign(new Error('cancelled'), { code: 4001 }),
    new Error('lost wallet reply'),
    Object.assign(new Error('underpriced'), { code: -32000 }),
  ])('retains the original hold after a refused or lost review: %s', async (error) => {
    const f = fixture(saved(approval(), 0n, [ONE]));
    f.provider.request = vi.fn(async ({ method }) => {
      if (method === 'eth_chainId') return '0xab162';
      throw error;
    });
    const hook = f.mount();
    await act(async () => {
      await expect(hook.result.current.reviewInWallet()).rejects.toThrow();
    });
    expect(stored()?.intent).toEqual(approval());
    expect(stored()?.candidateHashes).toEqual([ONE]);
    expect(stored()?.walletAttempt?.state).toBe(
      'code' in error && error.code === 4001 ? 'rejected' : 'unknown',
    );
    expect(hook.result.current.open).toBe(true);
  });
  it('settles an older candidate that wins after a newer candidate was returned', async () => {
    const f = fixture(saved(approval(), 0n, [ONE]));
    const hook = f.mount();
    await act(async () => {
      await hook.result.current.reviewInWallet();
    });
    f.mine(ONE);
    await waitFor(() =>
      expect(hook.result.current.tracked).toMatchObject({ state: 'mined', hash: ONE }),
    );
    expect(localStorage.getItem(key)).toBeNull();
    expect(f.onMined).toHaveBeenCalledOnce();
  });
  it('retains candidates and resumes polling after reload', async () => {
    const f = fixture(saved(approval(), 0n, [ONE]));
    const first = f.mount();
    await act(async () => {
      await first.result.current.reviewInWallet();
    });
    first.unmount();
    const second = f.mount();
    f.mine(ONE);
    await waitFor(() => expect(second.result.current.tracked?.state).toBe('mined'));
    expect(localStorage.getItem(key)).toBeNull();
  });
  it('blocks an already consumed canonical nonce without creating another wallet request', async () => {
    const f = fixture();
    f.setNonce(5n);
    const hook = f.mount();
    await act(async () => {
      await expect(hook.result.current.reviewInWallet()).rejects.toThrow(/nonce no longer matches/);
    });
    expect(f.provider.request).not.toHaveBeenCalled();
    expect(stored()?.intent?.nonce).toBe('4');
  });
  it('never renews an expired swap deadline', async () => {
    const tx = swapTransaction(
      deployment,
      {
        amountIn: 123n,
        amountOut: 100n,
        minimumOut: 99n,
        path: [TOKEN, WRAPPED],
        amounts: [],
        executionLossBps: [],
        blockNumber: 16n,
      },
      { token: TOKEN, native: false },
      { token: WRAPPED, native: true },
      FROM,
      256n,
    );
    const f = fixture(saved(intentOf(tx, 'swap'), 256n));
    const hook = f.mount();
    await act(async () => {
      await expect(hook.result.current.reviewInWallet()).rejects.toThrow(/deadline has passed/);
    });
    expect(f.provider.request).not.toHaveBeenCalled();
    expect(stored()?.deadline).toBe(256n);
  });
  it('rejects the second tab while a wallet promise is alive and does not queue it', async () => {
    const f = fixture();
    let resolve!: (value: Hex) => void;
    f.provider.request = vi.fn(async ({ method }) =>
      method === 'eth_chainId'
        ? '0xab162'
        : new Promise<Hex>((r) => {
            resolve = r;
          }),
    );
    const one = f.mount(),
      two = f.mount();
    let pending!: Promise<Hex>;
    act(() => {
      pending = one.result.current.reviewInWallet();
    });
    await waitFor(() => expect(resolve).toBeTypeOf('function'));
    await act(async () => {
      await expect(two.result.current.reviewInWallet()).rejects.toThrow(/Nothing was queued/);
    });
    expect(f.provider.request).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolve(TWO);
      await pending;
    });
    expect(f.provider.request).toHaveBeenCalledTimes(2);
    expect(stored()?.hash).toBe(TWO);
  });
  it('the long lock also protects an initial wallet await from another tab reviewing its new hold', async () => {
    const f = fixture();
    let release!: () => void;
    const one = f.mount(),
      two = f.mount();
    let initial!: Promise<void>;
    act(() => {
      initial = one.result.current.withWalletRequest(
        () =>
          new Promise<void>((r) => {
            release = r;
          }),
      );
    });
    await waitFor(() => expect(release).toBeTypeOf('function'));
    await act(async () => {
      await expect(two.result.current.reviewInWallet()).rejects.toThrow(/still open/);
    });
    expect(f.provider.request).not.toHaveBeenCalled();
    await act(async () => {
      release();
      await initial;
    });
  });
  it.each(['account', 'provider', 'rpc', 'enabled', 'unmounted'] as const)(
    'sends nothing when %s changes during async review',
    async (change) => {
      const f = fixture();
      let release!: () => void;
      const base = f.rpc;
      const slow: Rpc = async (m, p) => {
        if (m === 'eth_getTransactionCount' && p[1] !== 'pending')
          await new Promise<void>((r) => {
            release = r;
          });
        return base(m, p);
      };
      const args = { ...f.args, rpc: slow };
      const hook = renderHook((current) => usePendingSwap(current), { initialProps: args });
      let pending!: Promise<unknown>;
      act(() => {
        pending = hook.result.current.reviewInWallet().catch((error: unknown) => error);
      });
      await waitFor(() => expect(release).toBeTypeOf('function'));
      if (change === 'unmounted') hook.unmount();
      else
        hook.rerender({
          ...args,
          ...(change === 'account'
            ? { account: OTHER }
            : change === 'provider'
              ? { provider: { request: vi.fn() } }
              : change === 'rpc'
                ? { rpc: base }
                : { enabled: false }),
        });
      await act(async () => {
        release();
        expect(await pending).toBeInstanceOf(Error);
      });
      expect(
        vi
          .mocked(f.provider.request)
          .mock.calls.filter(([a]) => a.method === 'eth_sendTransaction'),
      ).toHaveLength(0);
      expect(stored()?.intent).toEqual(approval());
    },
  );
  it('does not request the wallet if saving the review fails', async () => {
    const f = fixture(),
      hook = f.mount();
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    try {
      await act(async () => {
        await expect(hook.result.current.reviewInWallet()).rejects.toThrow(/could not be saved/);
      });
      expect(
        vi
          .mocked(f.provider.request)
          .mock.calls.filter(([a]) => a.method === 'eth_sendTransaction'),
      ).toHaveLength(0);
      expect(stored()?.walletAttempt?.mode).toBe('initial');
    } finally {
      set.mockRestore();
    }
  });
  it('keeps the original hold when the returned candidate cannot be persisted', async () => {
    const f = fixture(saved(approval(), 0n, [ONE])),
      hook = f.mount();
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const original = f.provider.request;
    f.provider.request = vi.fn(async (args) => {
      if (args.method === 'eth_sendTransaction')
        set.mockImplementation(() => {
          throw new Error('full');
        });
      return original(args);
    });
    try {
      await act(async () => {
        await expect(hook.result.current.reviewInWallet()).rejects.toThrow(
          /hash update could not be saved/,
        );
      });
      expect(stored()?.candidateHashes).toEqual([ONE]);
      expect(hook.result.current.open).toBe(true);
      expect(hook.result.current.tracked?.candidateHashes).toContain(TWO);
    } finally {
      set.mockRestore();
    }
  });
  it('refuses a changed journal body even if its id was retained during review', async () => {
    const f = fixture(),
      hook = f.mount();
    const original = f.provider.request;
    f.provider.request = vi.fn(async (args) => {
      if (args.method === 'eth_chainId')
        store({ ...saved(), intent: { ...approval(), value: '1' } });
      return original(args);
    });
    await act(async () => {
      await expect(hook.result.current.reviewInWallet()).rejects.toThrow(/changed/);
    });
    expect(
      vi.mocked(f.provider.request).mock.calls.filter(([a]) => a.method === 'eth_sendTransaction'),
    ).toHaveLength(0);
    expect(stored()?.intent?.value).toBe('1');
  });
  it('does not revive a hold when an older candidate finalizes while the wallet is open', async () => {
    const f = fixture(saved(approval(), 0n, [ONE])),
      hook = f.mount();
    let release!: (hash: Hex) => void;
    f.provider.request = vi.fn(async ({ method }) =>
      method === 'eth_chainId'
        ? '0xab162'
        : new Promise<Hex>((r) => {
            release = r;
          }),
    );
    let pending!: Promise<unknown>;
    act(() => {
      pending = hook.result.current.reviewInWallet().catch((error: unknown) => error);
    });
    await waitFor(() => expect(release).toBeTypeOf('function'));
    f.mine(ONE);
    await waitFor(() => expect(hook.result.current.tracked?.state).toBe('mined'));
    await act(async () => {
      release(TWO);
      await pending;
    });
    expect(localStorage.getItem(key)).toBeNull();
    expect(hook.result.current.storageProblem).toBeNull();
    expect(hook.result.current.open).toBe(false);
  });
});

describe('same-nonce canonical preconditions', () => {
  it.each([
    null,
    {},
    { number: '0x10' },
    { number: '0x010', hash: HEAD.hash },
    { ...HEAD, hash: hash('0') },
    'rpc-error',
  ])('blocks initial and repeated requests for invalid finality case %#', async (value) => {
    const f = fixture();
    const rpc: Rpc = async (m, p) => {
      if (m === 'eth_getBlockByNumber' && p[0] === 'finalized') {
        if (value === 'rpc-error')
          throw Object.assign(new Error('follower status lost'), { code: -32001 });
        return value;
      }
      return f.rpc(m, p);
    };
    await expect(submissionBoundary(rpc, context, FROM)).rejects.toThrow(/finality is unavailable/);
    const hook = renderHook(() => usePendingSwap({ ...f.args, rpc }));
    await act(async () => {
      await expect(hook.result.current.reviewInWallet()).rejects.toThrow(/finality is unavailable/);
    });
    expect(f.provider.request).not.toHaveBeenCalled();
    expect(stored()?.intent).toEqual(approval());
  });
  it('blocks finality lost during review and refuses an inconsistent finalized checkpoint', async () => {
    for (const stage of ['lost', 'noncanonical', 'beyond-head']) {
      const f = fixture();
      let reads = 0;
      const rpc: Rpc = async (m, p) => {
        if (m === 'eth_getBlockByNumber' && p[0] === 'finalized') {
          if (stage === 'lost' && ++reads > 1) throw new Error('follower lost');
          if (stage === 'noncanonical') return { ...HEAD, hash: hash('e') };
          if (stage === 'beyond-head') return INCLUDED;
        }
        return f.rpc(m, p);
      };
      await expect(verifySameNonceReview(rpc, approval(), context, 0n)).rejects.toThrow();
    }
  });
  it('rejects a different genesis, changed boundary, changed head and unsupported hash nonce read', async () => {
    for (const reason of ['genesis', 'boundary', 'head', 'nonce']) {
      const f = fixture();
      let heads = 0;
      const rpc: Rpc = async (m, p) => {
        if (reason === 'genesis' && m === 'eth_getBlockByNumber' && p[0] === '0x0')
          return { number: '0x0', hash: hash('e') };
        if (reason === 'boundary' && m === 'eth_getBlockByNumber' && p[0] === BOUNDARY.number)
          return { ...BOUNDARY, hash: hash('e') };
        if (reason === 'head' && m === 'eth_getBlockByNumber' && p[0] === 'latest' && ++heads > 1)
          return INCLUDED;
        if (reason === 'nonce' && m === 'eth_getTransactionCount')
          throw new Error('EIP1898 unavailable');
        return f.rpc(m, p);
      };
      await expect(verifySameNonceReview(rpc, approval(), context, 0n)).rejects.toThrow();
    }
  });
});

describe('explicit local closure after a finalized replacement', () => {
  function cancelled() {
    const f = fixture(saved(approval(), 0n, [TWO]));
    f.mine(ONE);
    f.bodies.set(ONE, { ...f.bodies.get(ONE)!, to: FROM, input: '0x', value: '0x0' });
    f.receipts.set(ONE, { ...f.receipts.get(ONE)!, to: FROM });
    f.setNonce(5n);
    return f;
  }
  it('a hash check is read-only; only a separate action closes the hold as replaced', async () => {
    const f = cancelled(),
      hook = f.mount();
    const before = localStorage.getItem(key);
    let proof!: Awaited<ReturnType<typeof hook.result.current.checkReplacement>>;
    await act(async () => {
      proof = await hook.result.current.checkReplacement(ONE);
    });
    expect(localStorage.getItem(key)).toBe(before);
    expect(hook.result.current.open).toBe(true);
    expect(f.provider.request).not.toHaveBeenCalled();
    await act(async () => {
      await hook.result.current.closeReplacement(proof);
    });
    expect(localStorage.getItem(key)).toBeNull();
    expect(hook.result.current.tracked).toMatchObject({
      state: 'replaced',
      hash: ONE,
      label: 'Original approval request',
    });
    expect(hook.result.current.tracked?.detail).toContain('original request did not execute');
    expect(hook.result.current.open).toBe(false);
    expect(f.provider.request).not.toHaveBeenCalled();
    // Refresh canonical balances because the replacement can have different effects.
    expect(f.onMined).toHaveBeenCalledOnce();
  });
  it('rechecks consumed nonce and finality on confirmation and retains the hold if they disappear', async () => {
    const f = cancelled(),
      hook = f.mount();
    const proof = await hook.result.current.checkReplacement(ONE);
    f.setNonce(4n);
    await act(async () => {
      await expect(hook.result.current.closeReplacement(proof)).rejects.toThrow(/nonce consumed/);
    });
    expect(stored()?.intent).toEqual(approval());
    expect(f.provider.request).not.toHaveBeenCalled();
  });
  it('does not clear a different hold with a previously displayed proof', async () => {
    const f = cancelled(),
      hook = f.mount();
    const proof = await hook.result.current.checkReplacement(ONE);
    store(saved({ ...approval(), id: '87654321-4321-1234-1234-123456789abc', nonce: '5' }));
    await act(async () => {
      await expect(hook.result.current.closeReplacement(proof)).rejects.toThrow(/changed/);
    });
    expect(stored()?.intent?.nonce).toBe('5');
  });
  it('rejects confirmation when the displayed replacement body changed', async () => {
    const f = cancelled(),
      hook = f.mount();
    const proof = await hook.result.current.checkReplacement(ONE);
    f.bodies.set(ONE, { ...f.bodies.get(ONE)!, value: '0x1' });
    await act(async () => {
      await expect(hook.result.current.closeReplacement(proof)).rejects.toThrow(/evidence changed/);
    });
    expect(stored()?.intent).toEqual(approval());
  });
  it('retains the hold if storage refuses the explicit local closure', async () => {
    const f = cancelled(),
      hook = f.mount();
    const proof = await hook.result.current.checkReplacement(ONE);
    const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      await act(async () => {
        await expect(hook.result.current.closeReplacement(proof)).rejects.toThrow(
          /could not clear/,
        );
      });
      expect(stored()?.intent).toEqual(approval());
    } finally {
      remove.mockRestore();
    }
  });
  it('blocks a stale confirmation after account or RPC context changes', async () => {
    const f = cancelled(),
      hook = f.mount();
    const proof = await hook.result.current.checkReplacement(ONE);
    const stale = hook.result.current.closeReplacement;
    hook.rerender({ ...f.args, account: OTHER });
    await act(async () => {
      await expect(stale(proof)).rejects.toThrow(/context changed/);
    });
    expect(stored()?.intent).toEqual(approval());
  });
  it('ignores a delayed wallet response after an explicitly closed replacement', async () => {
    const f = cancelled(),
      hook = f.mount();
    const proof = await hook.result.current.checkReplacement(ONE);
    await act(async () => {
      await hook.result.current.closeReplacement(proof);
    });
    await act(async () => {
      expect(await hook.result.current.updateSubmission(approval().id, TWO)).toBe(true);
    });
    expect(localStorage.getItem(key)).toBeNull();
    expect(hook.result.current.tracked?.state).toBe('replaced');
    expect(hook.result.current.open).toBe(false);
  });
  it('a live wallet promise cannot revive a closed hold or overwrite a newer intent when it returns', async () => {
    const f = fixture();
    let release!: (value: Hex) => void;
    f.provider.request = vi.fn(async ({ method }) =>
      method === 'eth_chainId'
        ? '0xab162'
        : new Promise<Hex>((resolve) => {
            release = resolve;
          }),
    );
    const hook = f.mount();
    let pending!: Promise<Hex>;
    act(() => {
      pending = hook.result.current.reviewInWallet();
    });
    await waitFor(() => expect(release).toBeTypeOf('function'));
    f.mine(ONE);
    f.bodies.set(ONE, { ...f.bodies.get(ONE)!, to: FROM, input: '0x', value: '0x0' });
    f.receipts.set(ONE, { ...f.receipts.get(ONE)!, to: FROM });
    f.setNonce(5n);
    const proof = await hook.result.current.checkReplacement(ONE);
    await act(async () => {
      await hook.result.current.closeReplacement(proof);
    });
    expect(localStorage.getItem(key)).toBeNull();
    // The live wallet lock still refuses another request in this origin.
    await act(async () => {
      await expect(hook.result.current.withWalletRequest(async () => {})).rejects.toThrow(
        /Nothing was queued/,
      );
    });
    // Even a newer external journal record cannot be overwritten by this old reply.
    const next = saved({ ...approval(), id: '87654321-4321-1234-1234-123456789abc', nonce: '5' });
    store(next);
    const retained = localStorage.getItem(key);
    await act(async () => {
      release(TWO);
      await pending;
    });
    expect(localStorage.getItem(key)).toBe(retained);
    expect(stored()?.intent?.nonce).toBe('5');
    expect(f.provider.request).toHaveBeenCalledTimes(2);
  });
  it('cannot prove a replacement for a legacy hold without a fixed nonce', async () => {
    const f = cancelled();
    store({ hash: TWO, label: 'Legacy', deadline: 0n, sentAtMs: 0 });
    const hook = f.mount();
    await act(async () => {
      await expect(hook.result.current.checkReplacement(ONE)).rejects.toThrow(/no saved nonce/);
    });
    expect(stored()?.hash).toBe(TWO);
    expect(f.provider.request).not.toHaveBeenCalled();
  });
});
