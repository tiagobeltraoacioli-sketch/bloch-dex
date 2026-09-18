import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  connectAccount,
  isMetaMaskWallet,
  METAMASK_MOBILE_URL,
  discoverWallets,
  validAddress,
  validAccounts,
  validChain,
  walletDisplayName,
  walletError,
  type Provider,
  type WalletOption,
} from '../wallet';
import { useWallet } from '../useWallet';

const address = '0x' + '12'.repeat(20);
const secondAddress = '0x' + '34'.repeat(20);
const id = 'a6bb9030-064e-4a24-9a8d-4e67708d5760';
function fixture(
  request = vi.fn(
    async ({ method }: { method: string }): Promise<unknown> =>
      method === 'eth_requestAccounts' ? [address] : '0x1',
  ),
) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const provider: Provider = {
    request,
    on: (event, handler) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    },
    removeListener: (event, handler) => {
      listeners.get(event)?.delete(handler);
    },
  };
  const wallet: WalletOption = { id, name: 'Test wallet', provider };
  return {
    wallet,
    request,
    listeners,
    emit: (event: string, value?: unknown) => {
      for (const fn of listeners.get(event) ?? []) fn(value);
    },
  };
}

describe('wallet identification boundary', () => {
  it('normalizes untrusted wallet names without display controls or split Unicode', () => {
    expect(walletDisplayName('  Safe\u202eemaN\n Wallet  ')).toBe('Safe emaN Wallet');
    expect(walletDisplayName('\u2066\u2069', 'Mobile wallet')).toBe('Mobile wallet');
    expect(walletDisplayName('😀'.repeat(61))).toBe('😀'.repeat(60));
    expect(walletDisplayName('a'.repeat(1_000_000))).toBe('a'.repeat(60));
    expect(walletDisplayName(null)).toBe('Browser wallet');
  });
  it('keeps mobile destinations fixed regardless of untrusted provider metadata', () => {
    const f = fixture();
    expect(isMetaMaskWallet({ ...f.wallet, name: 'MetaMask', rdns: 'evil.io.metamask' })).toBe(
      false,
    );
    expect(isMetaMaskWallet({ ...f.wallet, rdns: 'io.metamask' })).toBe(true);
    expect(
      isMetaMaskWallet({ ...f.wallet, provider: { ...f.wallet.provider, isMetaMask: true } }),
    ).toBe(false);
    expect(
      isMetaMaskWallet({
        ...f.wallet,
        id: 'legacy-injected',
        provider: { ...f.wallet.provider, isMetaMask: true },
      }),
    ).toBe(true);
    expect(
      isMetaMaskWallet({
        ...f.wallet,
        id: 'legacy-injected',
        provider: Object.defineProperty({}, 'isMetaMask', {
          get: () => {
            throw Error('hostile provider metadata');
          },
        }) as Provider,
      }),
    ).toBe(false);
    expect(METAMASK_MOBILE_URL).toBe(
      'https://metamask.app.link/dapp/blochdex.com/?connect=metamask',
    );
    expect(f.request).not.toHaveBeenCalled();
  });
  it('requests only accounts and chain ID after explicit connection', async () => {
    const f = fixture();
    expect(await connectAccount(f.wallet)).toEqual({
      address,
      chainId: '0x1',
      name: 'Test wallet',
    });
    expect(f.request.mock.calls.map(([request]) => request.method)).toEqual([
      'eth_requestAccounts',
      'eth_chainId',
    ]);
  });
  it('rejects malformed accounts and network IDs', async () => {
    expect(validAddress('0x123')).toBe(false);
    expect(validAddress('0x' + '00'.repeat(20))).toBe(false);
    expect(validAccounts([address, secondAddress])).toBe(true);
    expect(validAccounts([address, 'invalid'])).toBe(false);
    expect(validAccounts(Array(21).fill(address))).toBe(false);
    expect(validChain('1')).toBe(false);
    expect(validChain('0x0')).toBe(false);
    expect(validChain('0x01')).toBe(false);
    expect(validChain('0X1')).toBe(false);
    expect(validChain('0x' + 'f'.repeat(65))).toBe(false);
    expect(validChain('0x' + 'f'.repeat(64))).toBe(true);
    await expect(connectAccount(fixture(vi.fn(async () => ['0x123'])).wallet)).rejects.toThrow(
      'valid account',
    );
    await expect(connectAccount(fixture(vi.fn(async () => [address, 'invalid'])).wallet)).rejects.toThrow(
      'valid account',
    );
    await expect(connectAccount(fixture(vi.fn(async () => Array(21).fill(address))).wallet)).rejects.toThrow(
      'valid account',
    );
    await expect(
      connectAccount(
        fixture(
          vi.fn(async ({ method }) => (method === 'eth_requestAccounts' ? [address] : 'mainnet')),
        ).wallet,
      ),
    ).rejects.toThrow('valid network');
  });
  it('discovers wallets without account prompts and ignores malformed announcements', () => {
    const found = vi.fn();
    const f = fixture();
    const stop = discoverWallets(found);
    const announce = (detail: unknown) =>
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
    announce({ info: { uuid: id, name: 'Example\u202e\n wallet' }, provider: f.wallet.provider });
    announce({ info: { uuid: id, name: 'Duplicate' }, provider: f.wallet.provider });
    announce({
      info: { uuid: id.toUpperCase(), name: 'Duplicate ID' },
      provider: fixture().wallet.provider,
    });
    announce({ info: { uuid: 'invalid', name: 'Invalid' }, provider: {} });
    announce(new Proxy({}, { get: () => { throw Error('hostile announcement'); } }));
    announce(null);
    expect(found).toHaveBeenCalledTimes(1);
    expect(found.mock.calls[0][0].name).toBe('Example wallet');
    expect(f.request).not.toHaveBeenCalled();
    stop();
    announce({ info: { uuid: id, name: 'After cleanup' }, provider: fixture().wallet.provider });
    expect(found).toHaveBeenCalledTimes(1);
  });
  it.each([true, false])('discovers delayed mobile injection (event: %s) without RPC', (event) => {
    vi.useFakeTimers();
    const original = window.ethereum;
    delete window.ethereum;
    const found = vi.fn();
    const f = fixture();
    const stop = discoverWallets(found);
    try {
      vi.advanceTimersByTime(750);
      expect(found).not.toHaveBeenCalled();
      window.ethereum = { ...f.wallet.provider, isMetaMask: true };
      if (event) window.dispatchEvent(new Event('ethereum#initialized'));
      else vi.advanceTimersByTime(250);
      expect(found).toHaveBeenCalledTimes(1);
      expect(found.mock.calls[0][0].name).toBe('MetaMask');
      vi.advanceTimersByTime(6000);
      window.dispatchEvent(new Event('ethereum#initialized'));
      expect(found).toHaveBeenCalledTimes(1);
      expect(f.request).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      stop();
      window.ethereum = original;
      vi.useRealTimers();
    }
  });
  it.each(['focus', 'pageshow', 'postern:discover-wallets'])(
    'rescans on %s after retries expire and cleans up every discovery path',
    (event) => {
      vi.useFakeTimers();
      const original = window.ethereum;
      delete window.ethereum;
      const found = vi.fn();
      const requested = vi.fn();
      const f = fixture();
      window.addEventListener('eip6963:requestProvider', requested);
      const stop = discoverWallets(found);
      try {
        vi.advanceTimersByTime(6000);
        window.ethereum = f.wallet.provider;
        window.dispatchEvent(new Event(event));
        expect(found).toHaveBeenCalledTimes(1);
        expect(requested).toHaveBeenCalledTimes(2);
        stop();
        window.ethereum = fixture().wallet.provider;
        for (const name of [
          'focus',
          'pageshow',
          'postern:discover-wallets',
          'ethereum#initialized',
        ]) {
          window.dispatchEvent(new Event(name));
        }
        window.dispatchEvent(
          new CustomEvent('eip6963:announceProvider', {
            detail: { info: { uuid: id, name: 'Late' }, provider: window.ethereum },
          }),
        );
        vi.runAllTimers();
        expect(found).toHaveBeenCalledTimes(1);
        expect(requested).toHaveBeenCalledTimes(2);
        expect(f.request).not.toHaveBeenCalled();
      } finally {
        stop();
        window.removeEventListener('eip6963:requestProvider', requested);
        window.ethereum = original;
        vi.useRealTimers();
      }
    },
  );
  it('keeps the announcement grace period, caps legacy discoveries and cancels pending retries', () => {
    vi.useFakeTimers();
    const original = window.ethereum;
    const f = fixture();
    window.ethereum = f.wallet.provider;
    const found = vi.fn();
    const stop = discoverWallets(found);
    try {
      window.dispatchEvent(new Event('ethereum#initialized'));
      expect(found).not.toHaveBeenCalled();
      for (let index = 0; index < 20; index++) {
        const uniqueId = `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
        window.dispatchEvent(
          new CustomEvent('eip6963:announceProvider', {
            detail: {
              info: { uuid: uniqueId, name: 'Wallet' },
              provider: fixture().wallet.provider,
            },
          }),
        );
      }
      vi.advanceTimersByTime(250);
      expect(found).toHaveBeenCalledTimes(20);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      stop();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(6000);
      expect(found).toHaveBeenCalledTimes(20);
      expect(f.request).not.toHaveBeenCalled();
    } finally {
      stop();
      window.ethereum = original;
      vi.useRealTimers();
    }
  });
  it('handles account changes, network changes and disconnect', async () => {
    const f = fixture();
    const { result, unmount } = renderHook(() => useWallet());
    await act(async () => {
      await result.current.connect(f.wallet);
    });
    expect(result.current.account?.address).toBe(address);
    act(() => f.emit('accountsChanged', [secondAddress]));
    expect(result.current.account?.address).toBe(secondAddress);
    act(() => f.emit('chainChanged', '0x89'));
    expect(result.current.account?.chainId).toBe('0x89');
    act(() => f.emit('accountsChanged', []));
    expect(result.current.account).toBeNull();
    expect([...f.listeners.values()].every((handlers) => handlers.size === 0)).toBe(true);
    unmount();
  });
  it('disconnects on malformed account lists and snapshots pending account events', async () => {
    let resolveAccounts!: (value: unknown) => void;
    const pendingAccounts = new Promise((resolve) => { resolveAccounts = resolve; });
    const f = fixture(vi.fn(async ({ method }) => method === 'eth_requestAccounts' ? pendingAccounts : '0x1'));
    const { result } = renderHook(() => useWallet());
    let connection!: Promise<void>;
    act(() => { connection = result.current.connect(f.wallet); });
    const eventAccounts = [secondAddress];
    act(() => f.emit('accountsChanged', eventAccounts));
    eventAccounts[0] = 'invalid';
    await act(async () => { resolveAccounts([address]); await connection; });
    expect(result.current.account?.address).toBe(secondAddress);
    act(() => f.emit('accountsChanged', [address, 'invalid']));
    expect(result.current.account).toBeNull();
  });
  it('does not reconnect after a cancelled in-flight wallet prompt', async () => {
    let resolveAccounts!: (value: unknown) => void;
    const pendingAccounts = new Promise((resolve) => {
      resolveAccounts = resolve;
    });
    const f = fixture(
      vi.fn(async ({ method }) => (method === 'eth_requestAccounts' ? pendingAccounts : '0x1')),
    );
    const { result } = renderHook(() => useWallet());
    let connection!: Promise<void>;
    act(() => {
      connection = result.current.connect(f.wallet);
    });
    expect(result.current.pending).toBe(true);
    act(() => result.current.disconnect());
    await act(async () => {
      resolveAccounts([address]);
      await connection;
    });
    expect(result.current.account).toBeNull();
    expect(result.current.pending).toBe(false);
  });
  it('deduplicates synchronous connection attempts and reconciles pending account changes', async () => {
    let resolveAccounts!: (value: unknown) => void;
    const pendingAccounts = new Promise((resolve) => {
      resolveAccounts = resolve;
    });
    const f = fixture(
      vi.fn(async ({ method }) => (method === 'eth_requestAccounts' ? pendingAccounts : '0x1')),
    );
    const { result } = renderHook(() => useWallet());
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.connect(f.wallet);
      second = result.current.connect(f.wallet);
      f.emit('accountsChanged', [secondAddress]);
    });
    await act(async () => {
      resolveAccounts([address]);
      await Promise.all([first, second]);
    });
    expect(
      f.request.mock.calls.filter(([args]) => args.method === 'eth_requestAccounts'),
    ).toHaveLength(1);
    expect(result.current.account?.address).toBe(secondAddress);
  });
  it('reports rejected, pending and offline connection errors', async () => {
    const rejected = fixture(
      vi.fn(async () => {
        throw { code: 4001 };
      }),
    );
    const { result } = renderHook(() => useWallet());
    await act(async () => result.current.connect(rejected.wallet));
    await waitFor(() => expect(result.current.error).toMatch(/declined/));
    expect(walletError({ code: -32002 })).toMatch(/already open/);
    expect(walletError({ code: 4900 })).toMatch(/offline/);
    expect(walletError(new Proxy({}, { has: () => { throw Error('hostile provider error'); } }))).toMatch(
      /Could not connect/,
    );
  });
});
