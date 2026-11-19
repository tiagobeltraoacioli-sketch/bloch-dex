// The multichain site's mobile-wallet session (src/multichain/walletconnect.ts): what is asked of the wallet, what
// is accepted back, what is refused, and that nothing but eth_sendTransaction ever reaches the wallet.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureChain, sendTransaction } from '../devnet4/swap';
import { connectAccount } from '../wallet';
import { MULTICHAIN_SITE_NAME } from '../MultichainApp';
import { bundledChains } from '../multichain/config';
import { wasNotSent } from '../wallet-unsent';
import {
  MAX_CALLDATA_CHARS,
  USER_REJECTION_SENTENCES,
  WALLETCONNECT_EVENTS,
  WALLETCONNECT_METHODS,
  WALLETCONNECT_SITE_NAME,
  memoryStorage,
  mobileSessionProvider,
  mobileWalletLinks,
  normalizeApprovedMobileSession,
  normalizeMobileNamespace,
  normalizeMobileSessionEvent,
  normalizeMobileSessionUpdate,
  reviewedTransaction,
  validPairingUri,
} from '../multichain/walletconnect';

const SIX = bundledChains().map((c) => c.network.chainId);
const A = '0x' + '12'.repeat(20);
const B = '0x' + '34'.repeat(20);
const TOPIC = 'ab'.repeat(32);
// MetaMask Mobile's approved methods, whatever is asked: metamask-mobile app/core/WalletConnect/wc-config.ts
// `EVM_APPROVED_METHODS` (read by reviewer 412, copy `scratchpad/a412/ext/mm-wc-config.ts`, SHA-256 5b422979…).
const METAMASK_METHODS = [
  'eth_sendTransaction',
  'eth_sign',
  'eth_signTransaction',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
  'personal_sign',
  'eth_sendRawTransaction',
  'eth_accounts',
  'eth_getBalance',
  'eth_call',
  'eth_estimateGas',
  'eth_blockNumber',
  'eth_getCode',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
  'eth_getBlockByHash',
  'eth_getBlockByNumber',
  'net_version',
  'eth_chainId',
  'eth_requestAccounts',
  'wallet_addEthereumChain',
  'wallet_switchEthereumChain',
  'wallet_getPermissions',
  'wallet_requestPermissions',
  'wallet_watchAsset',
  'wallet_scanQRCode',
  'wallet_sendCalls',
  'wallet_getCallsStatus',
  'wallet_getCapabilities',
];
const URI = `wc:${'cd'.repeat(32)}@2?relay-protocol=irn&symKey=${'ef'.repeat(32)}&expiryTimestamp=1790000000`;
const namespace = (chains: number[], address = A, over: Record<string, unknown> = {}) => ({
  accounts: chains.map((id) => `eip155:${id}:${address}`),
  chains: chains.map((id) => `eip155:${id}`),
  methods: ['eth_sendTransaction'],
  events: ['accountsChanged', 'chainChanged'],
  ...over,
});
const session = (chains: number[], over: Record<string, unknown> = {}) => ({
  topic: TOPIC,
  expiry: Math.floor(Date.now() / 1000) + 600,
  namespaces: { eip155: namespace(chains) },
  peer: { metadata: { name: 'Pocket‮ wallet' } },
  ...over,
});
const tx = (chainId: number, over: Record<string, unknown> = {}) => ({
  from: A,
  to: B,
  data: '0x095ea7b3',
  value: '0x0',
  gas: '0x186a0',
  chainId: `0x${chainId.toString(16)}`,
  ...over,
});

describe('what the session asks for', () => {
  it('one method, two events, the six bundled chains, under the site name', () => {
    expect(SIX).toEqual([1, 8453, 42161, 10, 59144, 56]);
    expect([...WALLETCONNECT_METHODS]).toEqual(['eth_sendTransaction']);
    expect([...WALLETCONNECT_EVENTS]).toEqual(['accountsChanged', 'chainChanged']);
    expect(WALLETCONNECT_SITE_NAME).toBe(MULTICHAIN_SITE_NAME);
    expect(WALLETCONNECT_SITE_NAME).toBe('Bloch DEX');
  });
});

describe('the namespace a wallet approves', () => {
  it('accepts every asked chain, or fewer, with one account', () => {
    expect(normalizeMobileNamespace(namespace(SIX), SIX)).toEqual({ address: A, chainIds: SIX });
    expect(normalizeMobileNamespace(namespace([8453, 1]), SIX)).toEqual({
      address: A,
      chainIds: [8453, 1],
    });
    // `chains` is optional in a WalletConnect namespace; the accounts carry the chains.
    expect(normalizeMobileNamespace(namespace([10], A, { chains: undefined }), SIX)).toEqual({
      address: A,
      chainIds: [10],
    });
  });
  it.each([
    ['a chain that was not asked for', namespace([1, 137])],
    ['a chain listed twice', namespace([1, 1])],
    [
      'two different accounts',
      { ...namespace([1, 10]), accounts: [`eip155:1:${A}`, `eip155:10:${B}`] },
    ],
    [
      'two accounts on one chain',
      { ...namespace([1]), accounts: [`eip155:1:${A}`, `eip155:1:${B}`] },
    ],
    ['the zero address', namespace([1], '0x' + '00'.repeat(20))],
    ['no account', namespace([])],
    ['an account of another namespace', { ...namespace([1]), accounts: [`solana:1:${A}`] }],
    ['a chain id with a leading zero', { ...namespace([1]), accounts: [`eip155:01:${A}`] }],
    ['chains that differ from the accounts', { ...namespace([1]), chains: ['eip155:10'] }],
    ['more chains than accounts', { ...namespace([1]), chains: ['eip155:1', 'eip155:10'] }],
    ['typed-data signing instead', namespace([1], A, { methods: ['eth_signTypedData_v4'] })],
    [
      'a long list without the asked method',
      namespace([1], A, { methods: METAMASK_METHODS.filter((m) => m !== 'eth_sendTransaction') }),
    ],
    ['methods that are not a list', namespace([1], A, { methods: 'eth_sendTransaction' })],
    ['a method that is not text', namespace([1], A, { methods: ['eth_sendTransaction', 7] })],
    [
      'a method list beyond any wallet’s',
      namespace([1], A, {
        methods: ['eth_sendTransaction', ...Array.from({ length: 256 }, (_, i) => `m${i}`)],
      }),
    ],
    [
      'a method name beyond any method’s',
      namespace([1], A, { methods: ['eth_sendTransaction', 'x'.repeat(65)] }),
    ],
    ['no method', namespace([1], A, { methods: [] })],
    [
      'a method repeated',
      namespace([1], A, { methods: ['eth_sendTransaction', 'eth_sendTransaction'] }),
    ],
    ['an event missing', namespace([1], A, { events: ['accountsChanged'] })],
    ['the other event missing', namespace([1], A, { events: ['chainChanged', 'message'] })],
    [
      'an event repeated',
      namespace([1], A, { events: ['accountsChanged', 'chainChanged', 'chainChanged'] }),
    ],
    ['accounts that are not a list', { ...namespace([1]), accounts: `eip155:1:${A}` }],
  ])('refuses %s', (_, value) => {
    expect(normalizeMobileNamespace(value, SIX)).toBeNull();
  });
  // Restated after review R412-1 (decision of the coordinator, 2026-11-19): the two cases "a message-signing
  // method added" and "an event added" were refusals here. A wallet may list more than was asked (MetaMask Mobile
  // approves its whole list); the list is accepted when it holds what was asked, and what the extra entries could
  // do is pinned below: nothing ("an approved-but-unasked method never leaves the page").
  it('accepts a wallet that lists more methods and events than asked, as MetaMask Mobile does, in any order', () => {
    expect(METAMASK_METHODS).toContain('personal_sign');
    expect(METAMASK_METHODS).toHaveLength(31);
    expect(
      normalizeMobileNamespace(
        namespace([8453, 10], A, {
          methods: METAMASK_METHODS,
          events: ['chainChanged', 'accountsChanged'],
        }),
        SIX,
      ),
    ).toEqual({ address: A, chainIds: [8453, 10] });
    expect(
      normalizeMobileNamespace(
        namespace([1], A, {
          methods: ['personal_sign', 'eth_sendTransaction'],
          events: ['message', 'chainChanged', 'accountsChanged'],
        }),
        SIX,
      ),
    ).toEqual({ address: A, chainIds: [1] });
    // The bound is the wallet's own list, generously: 256 entries of at most 64 characters.
    expect(
      normalizeMobileNamespace(
        namespace([1], A, {
          methods: ['eth_sendTransaction', ...Array.from({ length: 255 }, (_, i) => `m${i}`)],
        }),
        SIX,
      ),
    ).not.toBeNull();
  });
  // R412-5 (c): the `chains` list, when present, is exactly the chains of the accounts.
  it('refuses a `chains` list shorter than the accounts’ chains, or that is not a list', () => {
    expect(
      normalizeMobileNamespace({ ...namespace([1, 10]), chains: ['eip155:1'] }, SIX),
    ).toBeNull();
    expect(normalizeMobileNamespace({ ...namespace([1, 10]), chains: [] }, SIX)).toBeNull();
    expect(normalizeMobileNamespace({ ...namespace([1]), chains: 'eip155:1' }, SIX)).toBeNull();
    expect(
      normalizeMobileNamespace({ ...namespace([1, 10]), chains: ['eip155:10', 'eip155:1'] }, SIX),
    ).toEqual({
      address: A,
      chainIds: [1, 10],
    });
  });
  it('refuses a hole in the account list', () => {
    const accounts = [`eip155:1:${A}`];
    accounts.length = 2;
    expect(normalizeMobileNamespace({ ...namespace([1]), accounts }, SIX)).toBeNull();
  });
});

describe('the approved session', () => {
  const now = Math.floor(Date.now() / 1000);
  it('is bound to its topic, its expiry, eip155 alone and the network of the page', () => {
    const approved = normalizeApprovedMobileSession(session([1, 8453]), SIX, 8453, now);
    expect(approved).toMatchObject({ topic: TOPIC, address: A, chainIds: [1, 8453] });
    expect(Object.isFrozen(approved)).toBe(true);
  });
  it.each([
    ['without the network of the page', session([1, 10]), 8453],
    [
      'with a second namespace',
      session([8453], { namespaces: { eip155: namespace([8453]), solana: {} } }),
      8453,
    ],
    ['without eip155', session([8453], { namespaces: {} }), 8453],
    ['already expired', session([8453], { expiry: now - 1 }), 8453],
    ['with an expiry beyond seven days', session([8453], { expiry: now + 604_801 }), 8453],
    ['with a topic that is not 32 bytes', session([8453], { topic: 'ab' }), 8453],
    ['that is not an object', 'session', 8453],
  ])('refuses a session %s', (_, value, route) => {
    expect(normalizeApprovedMobileSession(value, SIX, route, now)).toBeNull();
  });
});

describe('session events and updates', () => {
  const chains = [1, 8453];
  const event = (chainId: string, name: string, data: unknown, topic = TOPIC) => ({
    topic,
    params: { chainId, event: { name, data } },
  });
  it('ignores another session and events this page did not ask for, whatever their scope', () => {
    expect(
      normalizeMobileSessionEvent(
        event('eip155:1', 'accountsChanged', [B], 'other'),
        TOPIC,
        chains,
        A,
      ),
    ).toBeNull();
    expect(
      normalizeMobileSessionEvent(event('eip155:1', 'message', 'hello'), TOPIC, chains, A),
    ).toBeNull();
    expect(
      normalizeMobileSessionEvent(event('eip155:137', 'message', 'hello'), TOPIC, chains, A),
    ).toBeNull();
  });
  // Restated after R412-3: an accountsChanged event used to set the session's account to any one valid address.
  // The account is the namespace's; the event may only repeat it.
  it('an accountsChanged that names the session’s own account changes nothing; a chain of the session is followed in any spelling', () => {
    expect(
      normalizeMobileSessionEvent(event('eip155:1', 'accountsChanged', [A]), TOPIC, chains, A),
    ).toBeNull();
    expect(
      normalizeMobileSessionEvent(
        event('eip155:1', 'accountsChanged', [A.toUpperCase().replace('0X', '0x')]),
        TOPIC,
        chains,
        A,
      ),
    ).toBeNull();
    for (const data of ['0x2105', '8453', 8453])
      expect(
        normalizeMobileSessionEvent(event('eip155:1', 'chainChanged', data), TOPIC, chains, A),
      ).toEqual({
        disconnect: false,
        chainId: 8453,
      });
  });
  it.each([
    ['an account the session never approved (R412-3)', event('eip155:1', 'accountsChanged', [B])],
    [
      'its own account under a scope outside the session',
      event('eip155:137', 'accountsChanged', [A]),
    ],
    [
      'an account event without a chain',
      { topic: TOPIC, params: { event: { name: 'accountsChanged', data: [A] } } },
    ],
    ['no account', event('eip155:1', 'accountsChanged', [])],
    ['two accounts, its own among them', event('eip155:1', 'accountsChanged', [A, B])],
    ['its account in another form', event('eip155:1', 'accountsChanged', [`eip155:1:${A}`])],
    ['accounts that are not a list', event('eip155:1', 'accountsChanged', A)],
  ])('ends the session on %s', (_, message) => {
    expect(normalizeMobileSessionEvent(message, TOPIC, chains, A)).toEqual({ disconnect: true });
  });
  // Restated after R412-1 (decision): these three ended the session. A wallet reports the network selected in
  // the wallet; when that is not a chain of the session the report is ignored and nothing moves.
  it.each([
    ['a chain outside the session', event('eip155:1', 'chainChanged', '0x89')],
    ['a chain that was asked for but not approved', event('eip155:1', 'chainChanged', '0xa')],
    ['a chain that is not a number', event('eip155:1', 'chainChanged', 'base')],
    [
      'a chain of the session reported under a scope outside it',
      event('eip155:137', 'chainChanged', '0x2105'),
    ],
    [
      'a chain outside the session under a scope outside it',
      event('eip155:137', 'chainChanged', '0x89'),
    ],
    [
      'a chain event without a scope',
      { topic: TOPIC, params: { event: { name: 'chainChanged', data: '0x2105' } } },
    ],
  ])('ignores a chainChanged to %s: the session and its selected chain stay', (_, message) => {
    expect(normalizeMobileSessionEvent(message, TOPIC, chains, A)).toBeNull();
  });
  it('holds an update to the rules of the approval', () => {
    const update = (namespaces: unknown, topic = TOPIC) => ({ topic, params: { namespaces } });
    expect(
      normalizeMobileSessionUpdate(update({ eip155: namespace([1]) }, 'other'), TOPIC, SIX),
    ).toBeNull();
    expect(
      normalizeMobileSessionUpdate(update({ eip155: namespace([1, 10], B) }), TOPIC, SIX),
    ).toEqual({
      disconnect: false,
      address: B,
      chainIds: [1, 10],
    });
    // Restated after R412-1: an update that lists more methods is held to the approval's rule (accepted).
    expect(
      normalizeMobileSessionUpdate(
        update({ eip155: namespace([1], A, { methods: METAMASK_METHODS }) }),
        TOPIC,
        SIX,
      ),
    ).toEqual({ disconnect: false, address: A, chainIds: [1] });
    for (const namespaces of [
      { eip155: namespace([1, 137]) },
      { eip155: namespace([1]), solana: {} },
      { eip155: namespace([1], A, { methods: ['personal_sign'] }) },
      { eip155: namespace([1], A, { events: ['chainChanged'] }) },
      { eip155: { ...namespace([1, 10]), accounts: [`eip155:1:${A}`, `eip155:10:${B}`] } },
      {},
      undefined,
    ])
      expect(normalizeMobileSessionUpdate(update(namespaces), TOPIC, SIX)).toEqual({
        disconnect: true,
      });
  });
});

describe('the transaction sent to the wallet', () => {
  it('is the page’s own request, field for field', () => {
    const full = tx(8453, { nonce: '0x7', maxPriorityFeePerGas: '0x1', maxFeePerGas: '0x2' });
    expect(reviewedTransaction(full, A, 8453)).toEqual(full);
    expect(reviewedTransaction(tx(8453), A.toUpperCase().replace('0X', '0x'), 8453)).toEqual(
      tx(8453),
    );
  });
  it.each([
    ['without a chain', tx(8453, { chainId: undefined }), /does not name its chain/],
    ['with a decimal chain', tx(8453, { chainId: '8453' }), /does not name its chain/],
    ['for another chain', tx(1), /another chain/],
    ['from another account', tx(8453, { from: B }), /not from the connected account/],
    ['without a destination', tx(8453, { to: undefined }), /destination/],
    ['with odd call data', tx(8453, { data: '0x123' }), /call data/],
    ['without gas', tx(8453, { gas: undefined }), /valid gas/],
    ['with a value that is not a quantity', tx(8453, { value: '1' }), /valid value/],
    ['with one fee field', tx(8453, { maxFeePerGas: '0x2' }), /one fee field/],
    [
      'with a field the page does not send',
      tx(8453, { accessList: [] }),
      /does not send: accessList/,
    ],
    ['that is a string', '0xdeadbeef', /not an object/],
  ])('refuses a request %s', (_, value, message) => {
    expect(() => reviewedTransaction(value, A, 8453)).toThrow(message);
  });
  // R412-5 (b): the call data bound (64 KiB of data; the page's own calls are a few hundred bytes).
  it('accepts call data up to the bound and refuses one byte more', () => {
    expect(MAX_CALLDATA_CHARS).toBe(2 + 2 * 65_536);
    const atBound = `0x${'ab'.repeat(65_536)}`;
    expect(atBound).toHaveLength(MAX_CALLDATA_CHARS);
    expect(reviewedTransaction(tx(8453, { data: atBound }), A, 8453).data).toBe(atBound);
    expect(() => reviewedTransaction(tx(8453, { data: `${atBound}ab` }), A, 8453)).toThrow(
      /call data/,
    );
    expect(reviewedTransaction(tx(8453, { data: '0x' }), A, 8453).data).toBe('0x');
  });
});

function fakeClient() {
  const handlers = new Map<string, (value: unknown) => void>();
  const request = vi.fn<(value: unknown) => Promise<unknown>>();
  const disconnect = vi.fn().mockResolvedValue(undefined);
  const client = {
    on: vi.fn((name: string, fn: (value: unknown) => void) => handlers.set(name, fn)),
    off: vi.fn((name: string, fn: (value: unknown) => void) => {
      if (handlers.get(name) === fn) handlers.delete(name);
    }),
    disconnect,
    request,
  };
  return { client, handlers, request, disconnect };
}
function provided(chains = [1, 8453], route = 8453, over: Record<string, unknown> = {}) {
  const fake = fakeClient();
  const approved = normalizeApprovedMobileSession(
    session(chains, { namespaces: { eip155: namespace(chains, A, over) } }),
    SIX,
    route,
  )!;
  const provider = mobileSessionProvider(fake.client as never, approved, SIX, route);
  return { ...fake, provider };
}
const code = async (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: { code?: unknown }) => error.code,
  );

describe('the session as the page’s wallet', () => {
  beforeEach(() => vi.useRealTimers());

  it('answers the account and the chain itself and asks the wallet nothing', async () => {
    const { provider, request } = provided();
    expect(await provider.request({ method: 'eth_requestAccounts' })).toEqual([A]);
    expect(await provider.request({ method: 'eth_accounts' })).toEqual([A]);
    expect(await provider.request({ method: 'eth_chainId' })).toBe('0x2105');
    expect(await connectAccount({ id: 'postern-walletconnect', name: 'Pocket', provider })).toEqual(
      {
        address: A,
        chainId: '0x2105',
        name: 'Pocket',
      },
    );
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    'eth_call',
    'eth_getBalance',
    'eth_blockNumber',
    'eth_getTransactionReceipt',
    'eth_estimateGas',
    'personal_sign',
    'eth_sign',
    'eth_signTypedData_v4',
    'eth_signTransaction',
    'eth_sendRawTransaction',
    'wallet_watchAsset',
  ])('refuses %s here: the wallet is never asked to read or to sign a message', async (method) => {
    const { provider, request } = provided();
    expect(await code(provider.request({ method, params: [] }))).toBe(4200);
    expect(request).not.toHaveBeenCalled();
  });

  it('switches between the chains of the session without a wallet request (the page’s ensureChain)', async () => {
    const { provider, request } = provided([1, 8453, 10]);
    const changed = vi.fn();
    provider.on?.('chainChanged', changed);
    const params = (chainId: number) => ({
      chainId,
      chainName: `Chain ${chainId}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://rpc.example'],
    });
    await ensureChain(provider, params(10));
    expect(await provider.request({ method: 'eth_chainId' })).toBe('0xa');
    expect(changed).toHaveBeenCalledExactlyOnceWith('0xa');
    // Already there: nothing changes and nothing is announced again.
    await ensureChain(provider, params(10));
    expect(changed).toHaveBeenCalledOnce();
    // A chain that was asked for but that the wallet did not approve, and one this site never asks for.
    for (const outside of [59144, 137]) {
      await expect(ensureChain(provider, params(outside))).rejects.toThrow(
        `This wallet session does not include chain ${outside}, and a network cannot be added to an open session.`,
      );
      expect(await provider.request({ method: 'eth_chainId' })).toBe('0xa');
    }
    expect(
      await code(
        provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x89' }] }),
      ),
    ).toBe(4902);
    expect(await code(provider.request({ method: 'wallet_switchEthereumChain', params: [] }))).toBe(
      -32602,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('sends a transaction with its chain named, and returns the wallet’s hash as a claim', async () => {
    const { provider, request } = provided();
    const hash = '0x' + '9a'.repeat(32);
    request.mockResolvedValue(hash);
    const sent = await sendTransaction(provider, {
      from: A as `0x${string}`,
      to: B as `0x${string}`,
      data: '0x095ea7b3',
      value: 0n,
      gas: 100_000n,
      chainId: 8453,
      nonce: 7n,
    });
    expect(sent).toBe(hash);
    expect(request).toHaveBeenCalledExactlyOnceWith({
      topic: TOPIC,
      chainId: 'eip155:8453',
      request: { method: 'eth_sendTransaction', params: [tx(8453, { nonce: '0x7' })] },
    });
  });

  it('sends nothing for a request without a chain, for another chain, or from another account', async () => {
    const { provider, request } = provided();
    expect(
      await code(
        provider.request({
          method: 'eth_sendTransaction',
          params: [tx(8453, { chainId: undefined })],
        }),
      ),
    ).toBe(-32602);
    expect(await code(provider.request({ method: 'eth_sendTransaction', params: [tx(1)] }))).toBe(
      4901,
    );
    expect(
      await code(
        provider.request({ method: 'eth_sendTransaction', params: [tx(8453, { from: B })] }),
      ),
    ).toBe(4100);
    expect(
      await code(provider.request({ method: 'eth_sendTransaction', params: [tx(8453), tx(8453)] })),
    ).toBe(-32602);
    expect(await code(provider.request({ method: 'eth_sendTransaction' }))).toBe(-32602);
    // The page's helper leaves the chain out when its caller does: refused here, not sent on the selected chain.
    await expect(
      sendTransaction(provider, {
        from: A as `0x${string}`,
        to: B as `0x${string}`,
        data: '0x',
        value: 0n,
        gas: 1n,
      }),
    ).rejects.toThrow('does not name its chain');
    expect(request).not.toHaveBeenCalled();
  });

  // Restated after R412-2: code 5000 used to be read as a user rejection whatever its text. It is one only with a
  // sentence of the sourced list; MetaMask Mobile answers every failure of eth_sendTransaction with 5000.
  it('reads 4001, and 5000 with a known rejection sentence, as a rejection; keeps other answers apart; refuses a hash that is not one', async () => {
    const { provider, request } = provided();
    const send = () => provider.request({ method: 'eth_sendTransaction', params: [tx(8453)] });
    request.mockRejectedValueOnce({ code: 4001, message: 'anything at all' });
    expect(await code(send())).toBe(4001);
    expect([...USER_REJECTION_SENTENCES]).toEqual([
      'User rejected.',
      'MetaMask Tx Signature: User denied transaction signature.',
      'User rejected the request.',
    ]);
    for (const sentence of USER_REJECTION_SENTENCES) {
      request.mockRejectedValueOnce({ code: 5000, message: sentence });
      await expect(send()).rejects.toMatchObject({
        code: 4001,
        message: 'The request was rejected in the wallet.',
      });
      request.mockRejectedValueOnce({ code: 5000, message: `  ${sentence}\n` });
      expect(await code(send())).toBe(4001);
    }
    request.mockRejectedValueOnce({ code: -32000, message: 'insufficient funds\u202e' });
    await expect(send()).rejects.toMatchObject({ code: -32000, message: 'insufficient funds' });
    request.mockRejectedValueOnce(new Error('Request expired. Please try again.'));
    await expect(send()).rejects.not.toHaveProperty('code');
    request.mockRejectedValueOnce({
      get code() {
        throw new Error('trap');
      },
    });
    await expect(send()).rejects.toThrow('The wallet did not complete the request.');
    for (const answer of [
      '0x1234',
      null,
      { hash: '0x' + '9a'.repeat(32) },
      '0x' + 'zz'.repeat(32),
    ]) {
      request.mockResolvedValueOnce(answer);
      await expect(send()).rejects.toThrow('The wallet did not return a transaction hash.');
    }
  });

  it.each([
    // MetaMask Mobile, WalletConnect2Session.ts handleSendTransaction: one `try` around adding the transaction,
    // `await trx.result` and the delivery of the result; its `catch` answers 5000 with the error's own text.
    ['a publish error after the user confirmed', 'Failed to publish message: relay timeout'],
    [
      'a failure to deliver the result after the transaction was published',
      "No matching key. session topic doesn't exist",
    ],
    ['a validation error', 'Invalid transaction params: from is not a valid address'],
    ['an RPC failure after signing', 'nonce too low'],
    [
      'a sentence that only contains a rejection sentence',
      'Error: User rejected. Then the node failed',
    ],
    ['a rejection sentence in another case', 'user rejected.'],
    ['no text', undefined],
    ['text that is not text', { toString: (): string => 'User rejected.' }],
  ])(
    '5000 with %s is NOT a rejection: the page keeps its "outcome unknown" hold (R412-2)',
    async (_, message) => {
      const { provider, request } = provided();
      request.mockRejectedValueOnce({ code: 5000, message });
      const error = (await provider
        .request({ method: 'eth_sendTransaction', params: [tx(8453)] })
        .catch((e: unknown) => e)) as { code?: unknown };
      expect(error.code).toBe(5000);
      expect(error.code).not.toBe(4001);
      // And it is not marked as "nothing was sent": it came back from the wallet.
      expect(wasNotSent(error)).toBe(false);
    },
  );

  it('a method the wallet approved but the page did not ask for never leaves the page (R412-1)', async () => {
    // The session as MetaMask Mobile approves it: every method the wallet knows.
    const { provider, request } = provided([1, 8453], 8453, {
      methods: METAMASK_METHODS,
      events: ['chainChanged', 'accountsChanged'],
    });
    const local = [
      'eth_sendTransaction',
      'eth_accounts',
      'eth_requestAccounts',
      'eth_chainId',
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
    ];
    const refused = METAMASK_METHODS.filter((m) => !local.includes(m));
    expect(refused).toHaveLength(25);
    for (const method of refused) {
      const error = (await provider
        .request({ method, params: [A, '0x68656c6c6f'] })
        .catch((e: unknown) => e)) as { code?: unknown };
      expect([method, error.code]).toEqual([method, 4200]);
    }
    expect(request).not.toHaveBeenCalled();
    // The one method that is sent is still sent, and only that one.
    request.mockResolvedValue('0x' + '9a'.repeat(32));
    await provider.request({ method: 'eth_sendTransaction', params: [tx(8453)] });
    expect(
      request.mock.calls.map(([call]) => (call as { request: { method: string } }).request.method),
    ).toEqual(['eth_sendTransaction']);
  });

  // R412-5 (a): the relay request is scoped to the chain SELECTED in the session, not the one it was opened on.
  it('after the selected chain moved, the request scope and the transaction field are both the new chain', async () => {
    const { provider, request, handlers } = provided([1, 8453, 10], 8453);
    request.mockResolvedValue('0x' + '9a'.repeat(32));
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xa' }] });
    await provider.request({ method: 'eth_sendTransaction', params: [tx(10)] });
    expect(request).toHaveBeenLastCalledWith({
      topic: TOPIC,
      chainId: 'eip155:10',
      request: { method: 'eth_sendTransaction', params: [tx(10)] },
    });
    // The chain it was opened on is now "another chain".
    expect(
      await code(provider.request({ method: 'eth_sendTransaction', params: [tx(8453)] })),
    ).toBe(4901);
    // The same when the wallet moved it (a chain of the session).
    handlers.get('session_event')?.({
      topic: TOPIC,
      params: { chainId: 'eip155:10', event: { name: 'chainChanged', data: '0x1' } },
    });
    await provider.request({ method: 'eth_sendTransaction', params: [tx(1)] });
    expect(request).toHaveBeenLastCalledWith({
      topic: TOPIC,
      chainId: 'eip155:1',
      request: { method: 'eth_sendTransaction', params: [tx(1)] },
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  // R412-6: a refusal raised here before the relay is called is marked, and nothing else is.
  it('marks its own refusals as "nothing was sent", and no answer of the wallet', async () => {
    const { provider, request, handlers } = provided();
    const caught = (promise: Promise<unknown>) =>
      promise.then(
        () => null,
        (e: unknown) => e,
      );
    for (const params of [
      [tx(1)],
      [tx(8453, { from: B })],
      [tx(8453, { chainId: undefined })],
      [tx(8453, { accessList: [] })],
      [tx(8453), tx(8453)],
    ])
      expect(
        wasNotSent(await caught(provider.request({ method: 'eth_sendTransaction', params }))),
      ).toBe(true);
    expect(
      wasNotSent(await caught(provider.request({ method: 'personal_sign', params: [] }))),
    ).toBe(true);
    expect(
      wasNotSent(
        await caught(
          provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x89' }] }),
        ),
      ),
    ).toBe(true);
    expect(request).not.toHaveBeenCalled();
    // From here on the relay was called: whatever comes back is not "nothing was sent".
    request.mockRejectedValueOnce({ code: 4001, message: 'User rejected the request.' });
    expect(
      wasNotSent(
        await caught(provider.request({ method: 'eth_sendTransaction', params: [tx(8453)] })),
      ),
    ).toBe(false);
    request.mockRejectedValueOnce(new Error('Request expired. Please try again.'));
    expect(
      wasNotSent(
        await caught(provider.request({ method: 'eth_sendTransaction', params: [tx(8453)] })),
      ),
    ).toBe(false);
    request.mockImplementationOnce(() => {
      throw new Error('the client refused to publish');
    });
    expect(
      wasNotSent(
        await caught(provider.request({ method: 'eth_sendTransaction', params: [tx(8453)] })),
      ),
    ).toBe(false);
    request.mockResolvedValueOnce('not a hash');
    expect(
      wasNotSent(
        await caught(provider.request({ method: 'eth_sendTransaction', params: [tx(8453)] })),
      ),
    ).toBe(false);
    // A request that was waiting when the session ended may have been signed: unknown, not unsent.
    request.mockReturnValueOnce(new Promise(() => {}));
    const open = caught(provider.request({ method: 'eth_sendTransaction', params: [tx(8453)] }));
    handlers.get('session_delete')?.({ topic: TOPIC });
    expect(wasNotSent(await open)).toBe(false);
    // After the end nothing is sent any more, and that is known.
    const after = await caught(
      provider.request({ method: 'eth_sendTransaction', params: [tx(8453)] }),
    );
    expect((after as { code: number }).code).toBe(4900);
    expect(wasNotSent(after)).toBe(true);
    expect(request).toHaveBeenCalledTimes(5);
    // The mark cannot be put on an error from outside this page's code by setting a property.
    expect(
      wasNotSent(Object.assign(new Error('x'), { unsent: true, notSent: true, code: 4901 })),
    ).toBe(false);
  });

  it('a session deleted by the wallet tells the page, and an unanswered request ends as unknown, not rejected', async () => {
    const { provider, request, handlers, disconnect } = provided();
    const gone = vi.fn();
    provider.on?.('disconnect', gone);
    request.mockReturnValue(new Promise(() => {}));
    const open = provider.request({ method: 'eth_sendTransaction', params: [tx(8453)] });
    handlers.get('session_delete')?.({ topic: 'other' });
    expect(gone).not.toHaveBeenCalled();
    handlers.get('session_delete')?.({ topic: TOPIC });
    expect(gone).toHaveBeenCalledOnce();
    expect(await code(open)).toBe(4900);
    expect(handlers.size).toBe(0);
    // The wallet closed it: nothing to close remotely.
    expect(disconnect).not.toHaveBeenCalled();
    expect(await code(provider.request({ method: 'eth_accounts' }))).toBe(4900);
    expect(
      await code(provider.request({ method: 'eth_sendTransaction', params: [tx(8453)] })),
    ).toBe(4900);
    expect(request).toHaveBeenCalledOnce();
  });

  // Restated after R412-1 and R412-3. Before: an accountsChanged event moved the account to any address, and a
  // chainChanged to a chain outside the session ended it. Now the account moves only with the namespace (a
  // session_update), an event for another account ends the session, and a chain outside the session is ignored.
  it('follows a chain of the session, ignores a chain outside it, and keeps sending on the page’s chain', async () => {
    const { provider, handlers, disconnect, request } = provided([1, 8453]);
    const accounts = vi.fn(),
      chains = vi.fn(),
      gone = vi.fn();
    provider.on?.('accountsChanged', accounts);
    provider.on?.('chainChanged', chains);
    provider.on?.('disconnect', gone);
    const event = (chainId: string, name: string, data: unknown) =>
      handlers.get('session_event')?.({ topic: TOPIC, params: { chainId, event: { name, data } } });
    event('eip155:8453', 'chainChanged', '0x1');
    expect(chains).toHaveBeenCalledExactlyOnceWith('0x1');
    expect(await provider.request({ method: 'eth_chainId' })).toBe('0x1');
    // The wallet reports networks the session does not hold (MetaMask Mobile reports the one selected in the app).
    event('eip155:1', 'chainChanged', '0x89');
    event('eip155:1', 'chainChanged', '0xa');
    event('eip155:137', 'chainChanged', '0x89');
    event('eip155:1', 'chainChanged', 'somewhere');
    event('eip155:1', 'accountsChanged', [A]);
    expect(chains).toHaveBeenCalledOnce();
    expect(accounts).not.toHaveBeenCalled();
    expect(gone).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    expect(handlers.size).toBe(4);
    expect(await provider.request({ method: 'eth_chainId' })).toBe('0x1');
    expect(await provider.request({ method: 'eth_accounts' })).toEqual([A]);
    // The next transaction still names the session's selected chain, twice, whatever the wallet has selected.
    request.mockResolvedValue('0x' + '9a'.repeat(32));
    await provider.request({ method: 'eth_sendTransaction', params: [tx(1)] });
    expect(request).toHaveBeenCalledExactlyOnceWith({
      topic: TOPIC,
      chainId: 'eip155:1',
      request: { method: 'eth_sendTransaction', params: [tx(1)] },
    });
    expect(await code(provider.request({ method: 'eth_sendTransaction', params: [tx(137)] }))).toBe(
      4901,
    );
  });

  it('an accountsChanged event for an account the session never approved ends the session (R412-3)', async () => {
    const { provider, handlers, disconnect, request } = provided([1, 8453]);
    const accounts = vi.fn(),
      gone = vi.fn();
    provider.on?.('accountsChanged', accounts);
    provider.on?.('disconnect', gone);
    handlers.get('session_event')?.({
      topic: TOPIC,
      params: { chainId: 'eip155:8453', event: { name: 'accountsChanged', data: [B] } },
    });
    // The page is never shown the other account: it is told the wallet is gone.
    expect(accounts).not.toHaveBeenCalled();
    expect(gone).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledExactlyOnceWith({
      topic: TOPIC,
      reason: { code: 6000, message: 'Unsupported session update' },
    });
    expect(handlers.size).toBe(0);
    expect(await code(provider.request({ method: 'eth_accounts' }))).toBe(4900);
    expect(
      await code(
        provider.request({ method: 'eth_sendTransaction', params: [tx(8453, { from: B })] }),
      ),
    ).toBe(4900);
    expect(request).not.toHaveBeenCalled();
  });

  it('the account moves with the namespace: after a session_update names another account, that one is the session’s', async () => {
    const { provider, handlers, disconnect, request } = provided([1, 8453]);
    const accounts = vi.fn();
    provider.on?.('accountsChanged', accounts);
    handlers.get('session_update')?.({
      topic: TOPIC,
      params: { namespaces: { eip155: namespace([1, 8453], B, { methods: METAMASK_METHODS }) } },
    });
    expect(accounts).toHaveBeenCalledExactlyOnceWith([B]);
    expect(await provider.request({ method: 'eth_accounts' })).toEqual([B]);
    // An event that repeats the new account changes nothing; the old account is now the foreign one.
    const event = (data: unknown) =>
      handlers.get('session_event')?.({
        topic: TOPIC,
        params: { chainId: 'eip155:8453', event: { name: 'accountsChanged', data } },
      });
    event([B]);
    expect(accounts).toHaveBeenCalledOnce();
    expect(disconnect).not.toHaveBeenCalled();
    // The transaction path binds to the new account: the old one is refused, in the page.
    expect(
      await code(provider.request({ method: 'eth_sendTransaction', params: [tx(8453)] })),
    ).toBe(4100);
    expect(request).not.toHaveBeenCalled();
    event([A]);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  // R412-5 (d): a change that arrives for a session that has ended does nothing, even through a handler that
  // was taken before the end.
  it('nothing is applied after the session ended', async () => {
    const { provider, handlers, disconnect } = provided([1, 8453]);
    const stale = {
      event: handlers.get('session_event')!,
      update: handlers.get('session_update')!,
    };
    const accounts = vi.fn(),
      chains = vi.fn(),
      gone = vi.fn();
    provider.disconnect?.();
    expect(disconnect).toHaveBeenCalledOnce();
    // Listeners registered after the end are not kept, and a stale change reaches nobody and closes nothing.
    provider.on?.('accountsChanged', accounts);
    provider.on?.('chainChanged', chains);
    provider.on?.('disconnect', gone);
    stale.event({
      topic: TOPIC,
      params: { chainId: 'eip155:8453', event: { name: 'chainChanged', data: '0x1' } },
    });
    stale.event({
      topic: TOPIC,
      params: { chainId: 'eip155:8453', event: { name: 'accountsChanged', data: [B] } },
    });
    stale.update({ topic: TOPIC, params: { namespaces: { eip155: namespace([1], B) } } });
    stale.update({ topic: TOPIC, params: { namespaces: {} } });
    expect(accounts).not.toHaveBeenCalled();
    expect(chains).not.toHaveBeenCalled();
    expect(gone).not.toHaveBeenCalled();
    // In particular no second remote close "Unsupported session update" for a session already closed.
    expect(disconnect).toHaveBeenCalledExactlyOnceWith({
      topic: TOPIC,
      reason: { code: 6000, message: 'User disconnected' },
    });
  });

  it('accepts an update that keeps the selected chain or lists more methods, and closes on one that drops the chain, the asked method, or adds a chain', async () => {
    const update = (handlers: Map<string, (value: unknown) => void>, eip155: unknown) =>
      handlers.get('session_update')?.({ topic: TOPIC, params: { namespaces: { eip155 } } });
    const kept = provided([1, 8453]);
    const accounts = vi.fn();
    kept.provider.on?.('accountsChanged', accounts);
    update(kept.handlers, namespace([8453, 10], B));
    expect(accounts).toHaveBeenCalledExactlyOnceWith([B]);
    await kept.provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0xa' }],
    });
    expect(
      await code(
        kept.provider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: '0x1' }],
        }),
      ),
    ).toBe(4902);
    // Restated after R412-1: an update that adds personal_sign used to end the session. It is accepted, and the
    // method still cannot be sent ("a method the wallet approved but the page did not ask for…", above).
    update(
      kept.handlers,
      namespace([8453, 10], B, { methods: ['eth_sendTransaction', 'personal_sign'] }),
    );
    update(kept.handlers, namespace([8453, 10], B, { methods: METAMASK_METHODS }));
    expect(kept.disconnect).not.toHaveBeenCalled();
    expect(await code(kept.provider.request({ method: 'personal_sign', params: [] }))).toBe(4200);
    expect(kept.request).not.toHaveBeenCalled();

    for (const eip155 of [
      namespace([1]),
      namespace([1, 8453], A, { methods: ['personal_sign'] }),
      namespace([1, 8453], A, { events: ['chainChanged'] }),
      namespace([1, 8453, 137]),
    ]) {
      const dropped = provided([1, 8453]);
      const gone = vi.fn();
      dropped.provider.on?.('disconnect', gone);
      update(dropped.handlers, eip155);
      expect(gone).toHaveBeenCalledOnce();
      expect(dropped.disconnect).toHaveBeenCalledWith({
        topic: TOPIC,
        reason: { code: 6000, message: 'Unsupported session update' },
      });
    }
  });

  it('ends at the approved expiry, by timer or at the next request, and closes the remote session', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-18T12:00:00Z'));
    const expiring = (seconds: number) => {
      const fake = fakeClient();
      const approved = normalizeApprovedMobileSession(
        session([8453], { expiry: Math.floor(Date.now() / 1000) + seconds }),
        SIX,
        8453,
      )!;
      return {
        ...fake,
        provider: mobileSessionProvider(fake.client as never, approved, SIX, 8453),
      };
    };
    const timed = expiring(1);
    const gone = vi.fn();
    timed.provider.on?.('disconnect', gone);
    await vi.advanceTimersByTimeAsync(1000);
    expect(gone).toHaveBeenCalledOnce();
    expect(timed.disconnect).toHaveBeenCalledWith({
      topic: TOPIC,
      reason: { code: 6000, message: 'Session expired' },
    });
    // A throttled timer that has not fired: the next request sees the clock.
    const late = expiring(1);
    vi.setSystemTime(new Date('2026-11-18T12:00:03Z'));
    expect(
      await code(late.provider.request({ method: 'eth_sendTransaction', params: [tx(8453)] })),
    ).toBe(4900);
    expect(late.request).not.toHaveBeenCalled();
    expect(late.disconnect).toHaveBeenCalledWith({
      topic: TOPIC,
      reason: { code: 6000, message: 'Session expired' },
    });
  });

  it('the page letting go closes the remote session once and tells no listener', async () => {
    const { provider, disconnect, handlers } = provided();
    const gone = vi.fn();
    provider.on?.('disconnect', gone);
    provider.disconnect?.();
    provider.disconnect?.();
    expect(disconnect).toHaveBeenCalledExactlyOnceWith({
      topic: TOPIC,
      reason: { code: 6000, message: 'User disconnected' },
    });
    expect(gone).not.toHaveBeenCalled();
    expect(handlers.size).toBe(0);
  });
});

describe('pairing code and links', () => {
  it('accepts a WalletConnect v2 pairing URI and nothing else', () => {
    expect(validPairingUri(URI)).toBe(true);
    for (const value of [
      '',
      'https://example.org/',
      'javascript:alert(1)',
      `wc:${'cd'.repeat(32)}@1?bridge=x&key=y`,
      `wc:short@2?symKey=1`,
      `${URI} `,
      `${URI}"onload="x`,
      `${URI}<script>`,
      'wc:' + 'a'.repeat(3000),
      undefined,
    ])
      expect(validPairingUri(value)).toBe(false);
  });
  it('links carry the URI and nothing else, to the scheme and to two wallet hosts read in those wallets’ own code (R412-8)', () => {
    const links = mobileWalletLinks(URI);
    expect(links.map((l) => [l.name, l.app])).toEqual([
      ['Open in a wallet app', true],
      ['MetaMask', false],
      ['Rainbow', false],
    ]);
    expect(links[0].href).toBe(URI);
    expect(links.slice(1).map((l) => l.href)).toEqual([
      `https://metamask.app.link/wc?uri=${encodeURIComponent(URI)}`,
      `https://rnbwapp.com/wc?uri=${encodeURIComponent(URI)}`,
    ]);
    for (const link of links.slice(1)) {
      const url = new URL(link.href);
      expect([...url.searchParams.keys()]).toEqual(['uri']);
      expect(url.searchParams.get('uri')).toBe(URI);
    }
    // No host that was not verified: the pairing key goes nowhere else.
    expect(links.map((l) => (l.app ? 'wc:' : new URL(l.href).host))).toEqual([
      'wc:',
      'metamask.app.link',
      'rnbwapp.com',
    ]);
    expect(mobileWalletLinks('https://evil.example/?wc')).toEqual([]);
  });
});

describe('session storage', () => {
  it('keeps the client’s state in memory, as copies, and nowhere in the browser', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const storage = memoryStorage();
    const value = { topics: ['a'] };
    await storage.setItem('wc@2:core:pairing', value);
    value.topics.push('b');
    expect(await storage.getItem('wc@2:core:pairing')).toEqual({ topics: ['a'] });
    expect(await storage.getKeys()).toEqual(['wc@2:core:pairing']);
    expect(await storage.getEntries()).toEqual([['wc@2:core:pairing', { topics: ['a'] }]]);
    expect(await storage.getItem('missing')).toBeUndefined();
    await storage.removeItem('wc@2:core:pairing');
    expect(await storage.getKeys()).toEqual([]);
    expect(await memoryStorage().getKeys()).toEqual([]);
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });
});

describe('connecting', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });
  function mocked(approval: () => Promise<unknown>, uri: unknown = URI) {
    const fake = fakeClient();
    const connect = vi.fn().mockResolvedValue({ uri, approval });
    const init = vi.fn().mockResolvedValue({ ...fake.client, connect });
    vi.doMock('@walletconnect/sign-client', () => ({ default: { init } }));
    return { ...fake, connect, init };
  }
  const load = async () => (await import('../multichain/walletconnect')).connectMobileWallet;

  it('asks for the live chains as an offer, one method and two events, under the site name, with nothing stored', async () => {
    const { init, connect, request } = mocked(async () => session([1, 8453]));
    const connectMobileWallet = await load();
    const onUri = vi.fn();
    const wallet = await connectMobileWallet({
      signal: new AbortController().signal,
      chainIds: [1, 8453, 10],
      routeChainId: 8453,
      onUri,
    });
    expect(onUri).toHaveBeenCalledExactlyOnceWith(URI);
    expect(init).toHaveBeenCalledOnce();
    const options = init.mock.calls[0][0];
    expect(options.metadata).toEqual({
      name: 'Bloch DEX',
      description: 'Swaps on public networks. Every transaction is confirmed in your wallet.',
      url: location.origin,
      icons: [],
    });
    expect(options.projectId).toBe('e263eead656b6d61ecdee75a71e100bb');
    expect(options.telemetryEnabled).toBe(false);
    expect(Object.keys(options.storage).sort()).toEqual([
      'getEntries',
      'getItem',
      'getKeys',
      'removeItem',
      'setItem',
    ]);
    expect(options.relayUrl).toBeUndefined();
    expect(connect).toHaveBeenCalledExactlyOnceWith({
      optionalNamespaces: {
        eip155: {
          chains: ['eip155:1', 'eip155:8453', 'eip155:10'],
          methods: ['eth_sendTransaction'],
          events: ['accountsChanged', 'chainChanged'],
        },
      },
    });
    expect(wallet.id).toBe('postern-walletconnect');
    expect(wallet.name).toBe('Pocket wallet');
    expect(await wallet.provider.request({ method: 'eth_chainId' })).toBe('0x2105');
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ['a chain that was not offered', () => session([8453, 137])],
    [
      'every method but the one asked',
      () =>
        session([8453], {
          namespaces: {
            eip155: namespace([8453], A, {
              methods: METAMASK_METHODS.filter((m) => m !== 'eth_sendTransaction'),
            }),
          },
        }),
    ],
    [
      'two accounts',
      () =>
        session([8453], {
          namespaces: {
            eip155: { ...namespace([1, 8453]), accounts: [`eip155:1:${A}`, `eip155:8453:${B}`] },
          },
        }),
    ],
    ['only other chains than the page’s', () => session([1])],
    [
      'a second namespace',
      () => session([8453], { namespaces: { eip155: namespace([8453]), solana: {} } }),
    ],
  ])('refuses a wallet that approves %s, and closes its session', async (_, approved) => {
    const { disconnect, client } = mocked(async () => approved());
    const connectMobileWallet = await load();
    await expect(
      connectMobileWallet({
        signal: new AbortController().signal,
        chainIds: [1, 8453, 10],
        routeChainId: 8453,
        onUri: () => {},
      }),
    ).rejects.toThrow('Wallet returned an unsupported session');
    expect(disconnect).toHaveBeenCalledExactlyOnceWith({
      topic: TOPIC,
      reason: { code: 6000, message: 'Unsupported session' },
    });
    expect(client.on).not.toHaveBeenCalled();
  });

  it('does not load the client for a page that has no live network to connect on', async () => {
    const { init } = mocked(async () => session([8453]));
    const connectMobileWallet = await load();
    for (const [chainIds, routeChainId] of [
      [[], 8453],
      [[1, 10], 8453],
      [[8453, 8453], 8453],
      [[8453, 0], 8453],
    ] as [number[], number][])
      await expect(
        connectMobileWallet({
          signal: new AbortController().signal,
          chainIds,
          routeChainId,
          onUri: () => {},
        }),
      ).rejects.toThrow('No live network to connect a wallet to');
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      connectMobileWallet({
        signal: aborted.signal,
        chainIds: [8453],
        routeChainId: 8453,
        onUri: () => {},
      }),
    ).rejects.toThrow('Connection cancelled');
    expect(init).not.toHaveBeenCalled();
  });

  it('shows no code that is not a pairing URI, and closes an approval that still arrives', async () => {
    const { disconnect } = mocked(async () => session([8453]), 'https://evil.example/pair');
    const connectMobileWallet = await load();
    const onUri = vi.fn();
    await expect(
      connectMobileWallet({
        signal: new AbortController().signal,
        chainIds: [8453],
        routeChainId: 8453,
        onUri,
      }),
    ).rejects.toThrow('No pairing code returned');
    expect(onUri).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(disconnect).toHaveBeenCalledWith({
        topic: TOPIC,
        reason: { code: 6000, message: 'Connection cancelled' },
      }),
    );
  });

  // R412-5 (e): cancelled while the proposal was being sent, before any code was shown.
  it('a pairing cancelled right after the proposal went out is still observed: a late approval is closed', async () => {
    let approve!: (value: unknown) => void;
    const approval = vi.fn(() => new Promise((resolve) => (approve = resolve)));
    const fake = fakeClient();
    const controller = new AbortController();
    const connect = vi.fn(async () => {
      controller.abort();
      return { uri: URI, approval };
    });
    vi.doMock('@walletconnect/sign-client', () => ({
      default: { init: vi.fn().mockResolvedValue({ ...fake.client, connect }) },
    }));
    const connectMobileWallet = await load();
    const onUri = vi.fn();
    await expect(
      connectMobileWallet({
        signal: controller.signal,
        chainIds: [8453],
        routeChainId: 8453,
        onUri,
      }),
    ).rejects.toThrow('Connection cancelled');
    expect(onUri).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(approval).toHaveBeenCalledOnce());
    expect(fake.disconnect).not.toHaveBeenCalled();
    approve(session([8453]));
    await vi.waitFor(() =>
      expect(fake.disconnect).toHaveBeenCalledExactlyOnceWith({
        topic: TOPIC,
        reason: { code: 6000, message: 'Connection cancelled' },
      }),
    );
    expect(fake.client.on).not.toHaveBeenCalled();
  });

  it('connects a wallet that approves its whole method list (MetaMask Mobile), and still asks it for one method', async () => {
    const { request, disconnect } = mocked(async () =>
      session([8453, 10], {
        namespaces: {
          eip155: namespace([8453, 10], A, {
            methods: METAMASK_METHODS,
            events: ['chainChanged', 'accountsChanged'],
          }),
        },
        peer: { metadata: { name: 'MetaMask Wallet' } },
      }),
    );
    const connectMobileWallet = await load();
    const wallet = await connectMobileWallet({
      signal: new AbortController().signal,
      chainIds: [8453, 10],
      routeChainId: 8453,
      onUri: () => {},
    });
    expect(wallet.name).toBe('MetaMask Wallet');
    expect(disconnect).not.toHaveBeenCalled();
    expect(
      await code(wallet.provider.request({ method: 'personal_sign', params: ['0x00', A] })),
    ).toBe(4200);
    expect(
      await code(wallet.provider.request({ method: 'eth_signTypedData_v4', params: [A, '{}'] })),
    ).toBe(4200);
    expect(request).not.toHaveBeenCalled();
  });

  it('a cancelled pairing leaves no session behind when the wallet approves late', async () => {
    let approve!: (value: unknown) => void;
    const { disconnect, client } = mocked(() => new Promise((resolve) => (approve = resolve)));
    const connectMobileWallet = await load();
    const controller = new AbortController();
    const onUri = vi.fn();
    const pending = connectMobileWallet({
      signal: controller.signal,
      chainIds: [8453],
      routeChainId: 8453,
      onUri,
    });
    await vi.waitFor(() => expect(onUri).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toThrow('Connection cancelled');
    expect(disconnect).not.toHaveBeenCalled();
    approve(session([8453]));
    await vi.waitFor(() =>
      expect(disconnect).toHaveBeenCalledExactlyOnceWith({
        topic: TOPIC,
        reason: { code: 6000, message: 'Connection cancelled' },
      }),
    );
    expect(client.on).not.toHaveBeenCalled();
  });

  it('a pairing the wallet declines, or that expires, is an error and leaves nothing attached', async () => {
    const { client, disconnect } = mocked(async () => {
      throw { code: 5000, message: 'User rejected.' };
    });
    const connectMobileWallet = await load();
    await expect(
      connectMobileWallet({
        signal: new AbortController().signal,
        chainIds: [8453],
        routeChainId: 8453,
        onUri: () => {},
      }),
    ).rejects.toMatchObject({ code: 5000 });
    expect(client.on).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
  });
});
