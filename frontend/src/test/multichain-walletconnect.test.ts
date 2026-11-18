// The multichain site's mobile-wallet session (src/multichain/walletconnect.ts): what is asked of the wallet, what
// is accepted back, what is refused, and that nothing but eth_sendTransaction ever reaches the wallet.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureChain, sendTransaction } from '../devnet4/swap';
import { connectAccount } from '../wallet';
import { MULTICHAIN_SITE_NAME } from '../MultichainApp';
import { bundledChains } from '../multichain/config';
import {
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
    [
      'a message-signing method added',
      namespace([1], A, { methods: ['eth_sendTransaction', 'personal_sign'] }),
    ],
    ['typed-data signing instead', namespace([1], A, { methods: ['eth_signTypedData_v4'] })],
    ['no method', namespace([1], A, { methods: [] })],
    [
      'a method repeated',
      namespace([1], A, { methods: ['eth_sendTransaction', 'eth_sendTransaction'] }),
    ],
    ['an event missing', namespace([1], A, { events: ['accountsChanged'] })],
    [
      'an event added',
      namespace([1], A, { events: ['accountsChanged', 'chainChanged', 'message'] }),
    ],
    ['accounts that are not a list', { ...namespace([1]), accounts: `eip155:1:${A}` }],
  ])('refuses %s', (_, value) => {
    expect(normalizeMobileNamespace(value, SIX)).toBeNull();
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
  it('ignores another session and events this page did not ask for', () => {
    expect(
      normalizeMobileSessionEvent(
        event('eip155:1', 'accountsChanged', [B], 'other'),
        TOPIC,
        chains,
      ),
    ).toBeNull();
    expect(
      normalizeMobileSessionEvent(event('eip155:1', 'message', 'hello'), TOPIC, chains),
    ).toBeNull();
  });
  it('takes one new account, and a chain of the session in any spelling', () => {
    expect(
      normalizeMobileSessionEvent(event('eip155:1', 'accountsChanged', [B]), TOPIC, chains),
    ).toEqual({
      disconnect: false,
      address: B,
    });
    for (const data of ['0x2105', '8453', 8453])
      expect(
        normalizeMobileSessionEvent(event('eip155:1', 'chainChanged', data), TOPIC, chains),
      ).toEqual({
        disconnect: false,
        chainId: 8453,
      });
  });
  it.each([
    ['an event scoped to a chain outside the session', event('eip155:137', 'accountsChanged', [B])],
    [
      'an event without a chain',
      { topic: TOPIC, params: { event: { name: 'accountsChanged', data: [B] } } },
    ],
    ['no account', event('eip155:1', 'accountsChanged', [])],
    ['two accounts', event('eip155:1', 'accountsChanged', [A, B])],
    ['an account in another form', event('eip155:1', 'accountsChanged', [`eip155:1:${B}`])],
    ['a change to a chain outside the session', event('eip155:1', 'chainChanged', '0x89')],
    [
      'a change to a chain that was asked for but not approved',
      event('eip155:1', 'chainChanged', '0xa'),
    ],
    ['a chain that is not a number', event('eip155:1', 'chainChanged', 'base')],
  ])('ends the session on %s', (_, message) => {
    expect(normalizeMobileSessionEvent(message, TOPIC, chains)).toEqual({ disconnect: true });
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
    for (const namespaces of [
      { eip155: namespace([1, 137]) },
      { eip155: namespace([1]), solana: {} },
      { eip155: namespace([1], A, { methods: ['eth_sendTransaction', 'personal_sign'] }) },
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
function provided(chains = [1, 8453], route = 8453) {
  const fake = fakeClient();
  const approved = normalizeApprovedMobileSession(session(chains), SIX, route)!;
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

  it('reads a rejection in the wallet as 4001, keeps other answers apart, and refuses a hash that is not one', async () => {
    const { provider, request } = provided();
    const send = () => provider.request({ method: 'eth_sendTransaction', params: [tx(8453)] });
    request.mockRejectedValueOnce({ code: 4001, message: 'User rejected the request.' });
    expect(await code(send())).toBe(4001);
    request.mockRejectedValueOnce({ code: 5000, message: 'User rejected.' });
    expect(await code(send())).toBe(4001);
    request.mockRejectedValueOnce({ code: -32000, message: 'insufficient funds‮' });
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

  it('follows the account and the chain inside the session, and closes on anything outside it', async () => {
    const { provider, handlers, disconnect, request } = provided([1, 8453]);
    const accounts = vi.fn(),
      chains = vi.fn(),
      gone = vi.fn();
    provider.on?.('accountsChanged', accounts);
    provider.on?.('chainChanged', chains);
    provider.on?.('disconnect', gone);
    const event = (chainId: string, name: string, data: unknown) =>
      handlers.get('session_event')?.({ topic: TOPIC, params: { chainId, event: { name, data } } });
    event('eip155:8453', 'accountsChanged', [B]);
    expect(accounts).toHaveBeenCalledExactlyOnceWith([B]);
    expect(await provider.request({ method: 'eth_accounts' })).toEqual([B]);
    // The transaction path now binds to the new account: the old one is refused.
    expect(
      await code(provider.request({ method: 'eth_sendTransaction', params: [tx(8453)] })),
    ).toBe(4100);
    event('eip155:8453', 'chainChanged', '0x1');
    expect(chains).toHaveBeenCalledExactlyOnceWith('0x1');
    expect(await provider.request({ method: 'eth_chainId' })).toBe('0x1');
    expect(gone).not.toHaveBeenCalled();
    event('eip155:1', 'chainChanged', '0x89');
    expect(gone).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledExactlyOnceWith({
      topic: TOPIC,
      reason: { code: 6000, message: 'Unsupported session update' },
    });
    expect(handlers.size).toBe(0);
    expect(await code(provider.request({ method: 'eth_chainId' }))).toBe(4900);
    expect(request).not.toHaveBeenCalled();
  });

  it('accepts an update that keeps the selected chain and closes on one that drops it or adds a permission', async () => {
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
    expect(kept.disconnect).not.toHaveBeenCalled();

    for (const eip155 of [
      namespace([1]),
      namespace([1, 8453], A, { methods: ['eth_sendTransaction', 'personal_sign'] }),
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
  it('links carry the URI and nothing else, to the scheme and to three fixed wallet hosts', () => {
    const links = mobileWalletLinks(URI);
    expect(links.map((l) => [l.name, l.app])).toEqual([
      ['Open in a wallet app', true],
      ['MetaMask', false],
      ['Trust Wallet', false],
      ['Rainbow', false],
    ]);
    expect(links[0].href).toBe(URI);
    expect(links.slice(1).map((l) => l.href)).toEqual([
      `https://metamask.app.link/wc?uri=${encodeURIComponent(URI)}`,
      `https://link.trustwallet.com/wc?uri=${encodeURIComponent(URI)}`,
      `https://rnbwapp.com/wc?uri=${encodeURIComponent(URI)}`,
    ]);
    for (const link of links.slice(1)) {
      const url = new URL(link.href);
      expect([...url.searchParams.keys()]).toEqual(['uri']);
      expect(url.searchParams.get('uri')).toBe(URI);
    }
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
      'message signing added',
      () =>
        session([8453], {
          namespaces: {
            eip155: namespace([8453], A, { methods: ['eth_sendTransaction', 'personal_sign'] }),
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
