import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('WalletConnect session adapter', () => {
  beforeEach(() => vi.resetModules());

  it('forwards approved account updates and closes an out-of-scope chain change', async () => {
    const handlers = new Map<string, (value: any) => void>(),
      disconnect = vi.fn().mockResolvedValue(undefined);
    const session = {
      topic: 'ab'.repeat(32),
      expiry: Math.floor(Date.now() / 1000) + 600,
      namespaces: {
        eip155: {
          accounts: ['eip155:84001:0x' + '12'.repeat(20)],
          chains: ['eip155:84001'],
          methods: ['eth_accounts', 'eth_chainId'],
          events: ['accountsChanged', 'chainChanged'],
        },
      },
      peer: { metadata: { name: 'Mobile\u202e wallet' } },
    };
    const client = {
      connect: vi.fn().mockResolvedValue({ uri: 'wc:test', approval: async () => session }),
      on: vi.fn((name: string, fn: (value: any) => void) => handlers.set(name, fn)),
      off: vi.fn((name: string, fn: (value: any) => void) => {
        if (handlers.get(name) === fn) handlers.delete(name);
      }),
      disconnect,
    };
    let modalState: (value: { open: boolean }) => void = () => {};
    const modal = {
      open: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      subscribeState: vi.fn((fn: (value: { open: boolean }) => void) => {
        modalState = fn;
        return vi.fn();
      }),
    };
    vi.doMock('@walletconnect/sign-client', () => ({
      default: { init: vi.fn().mockResolvedValue(client) },
    }));
    vi.doMock('@reown/appkit/core', () => ({ createAppKit: () => modal }));
    vi.doMock('@reown/appkit/networks', () => ({ defineChain: (value: unknown) => value }));
    const { connectQrWallet } = await import('../qr-wallet');
    const wallet = await connectQrWallet(new AbortController().signal);
    expect(wallet.name).toBe('Mobile wallet');
    expect(await wallet.provider.request({ method: 'eth_accounts' })).toEqual([
      '0x' + '12'.repeat(20),
    ]);
    const accounts = vi.fn(),
      chains = vi.fn();
    wallet.provider.on?.('accountsChanged', accounts);
    wallet.provider.on?.('chainChanged', chains);
    handlers.get('session_event')?.({
      topic: session.topic,
      params: {
        chainId: 'eip155:84001',
        event: { name: 'accountsChanged', data: ['0x' + '34'.repeat(20)] },
      },
    });
    expect(accounts).toHaveBeenCalledWith(['0x' + '34'.repeat(20)]);
    expect(await wallet.provider.request({ method: 'eth_accounts' })).toEqual([
      '0x' + '34'.repeat(20),
    ]);
    handlers.get('session_update')?.({
      topic: session.topic,
      params: {
        namespaces: {
          eip155: {
            accounts: ['eip155:84001:0x' + '56'.repeat(20)],
            chains: ['eip155:84001'],
            methods: ['eth_accounts', 'eth_chainId'],
            events: ['accountsChanged', 'chainChanged'],
          },
        },
      },
    });
    expect(accounts).toHaveBeenLastCalledWith(['0x' + '56'.repeat(20)]);
    handlers.get('session_event')?.({
      topic: session.topic,
      params: { chainId: 'eip155:1', event: { name: 'chainChanged', data: '0x1' } },
    });
    expect(chains).toHaveBeenCalledWith('eip155:1');
    expect(disconnect).toHaveBeenCalledWith({
      topic: session.topic,
      reason: { code: 6000, message: 'Unsupported session update' },
    });
    await expect(wallet.provider.request({ method: 'eth_accounts' })).rejects.toThrow(
      'Session expired',
    );
    expect(handlers.size).toBe(0);
    expect(modal.open).toHaveBeenCalledWith({ uri: 'wc:test' });
    expect(modal.close).toHaveBeenCalled();
    expect(modalState).toBeTypeOf('function');
  });

  it('rejects an expired approved session before exposing a provider', async () => {
    const session = {
      topic: 'cd'.repeat(32),
      expiry: Math.floor(Date.now() / 1000) - 1,
      namespaces: {
        eip155: {
          accounts: ['eip155:84001:0x' + '12'.repeat(20)],
          chains: ['eip155:84001'],
          methods: ['eth_accounts', 'eth_chainId'],
          events: ['accountsChanged', 'chainChanged'],
        },
      },
      peer: { metadata: { name: 'Mobile' } },
    };
    const disconnect = vi.fn().mockResolvedValue(undefined),
      client = {
        connect: vi.fn().mockResolvedValue({ uri: 'wc:test', approval: async () => session }),
        on: vi.fn(),
        off: vi.fn(),
        disconnect,
      };
    const modal = {
      open: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      subscribeState: vi.fn(() => vi.fn()),
    };
    vi.doMock('@walletconnect/sign-client', () => ({
      default: { init: vi.fn().mockResolvedValue(client) },
    }));
    vi.doMock('@reown/appkit/core', () => ({ createAppKit: () => modal }));
    vi.doMock('@reown/appkit/networks', () => ({ defineChain: (value: unknown) => value }));
    const { connectQrWallet } = await import('../qr-wallet');
    await expect(connectQrWallet(new AbortController().signal)).rejects.toThrow(
      'unsupported session',
    );
    expect(disconnect).toHaveBeenCalledWith({
      topic: session.topic,
      reason: { code: 6000, message: 'Unsupported session' },
    });
    expect(client.on).not.toHaveBeenCalled();
  });
});
