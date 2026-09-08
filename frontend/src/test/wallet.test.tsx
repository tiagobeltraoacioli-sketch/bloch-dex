import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  connectAccount,
  discoverWallets,
  validAddress,
  validChain,
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
    expect(validChain('1')).toBe(false);
    expect(validChain('0x0')).toBe(false);
    await expect(connectAccount(fixture(vi.fn(async () => ['0x123'])).wallet)).rejects.toThrow(
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
    announce({ info: { uuid: id, name: 'Example' }, provider: f.wallet.provider });
    announce({ info: { uuid: id, name: 'Duplicate' }, provider: f.wallet.provider });
    announce({ info: { uuid: 'invalid', name: 'Invalid' }, provider: {} });
    announce(null);
    expect(found).toHaveBeenCalledTimes(1);
    expect(f.request).not.toHaveBeenCalled();
    stop();
    announce({ info: { uuid: id, name: 'After cleanup' }, provider: fixture().wallet.provider });
    expect(found).toHaveBeenCalledTimes(1);
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
  });
});
