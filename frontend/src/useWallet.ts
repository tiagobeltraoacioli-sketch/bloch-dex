import { useEffect, useRef, useState } from 'react';
import { connectAccount, discoverWallets, validAddress, validChain, walletError } from './wallet';
import type { WalletAccount, WalletOption } from './wallet';

export function useWallet() {
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const busy = useRef(false);
  const cleanup = useRef<() => void>(() => {});
  useEffect(() => {
    const stop = discoverWallets((wallet) =>
      setWallets((previous) =>
        previous.some((w) => w.id === wallet.id || w.provider === wallet.provider)
          ? previous
          : [...previous, wallet],
      ),
    );
    return () => {
      stop();
      cleanup.current();
      generation.current++;
      busy.current = false;
    };
  }, []);

  function disconnect() {
    generation.current++;
    busy.current = false;
    cleanup.current();
    cleanup.current = () => {};
    setAccount(null);
    setPending(false);
    setError('');
  }

  async function connect(wallet: WalletOption) {
    if (busy.current) return;
    busy.current = true;
    const attempt = ++generation.current;
    cleanup.current();
    setAccount(null);
    setPending(true);
    setError('');
    // Observe before requesting accounts so changes during an open prompt invalidate it.
    let initializing = true;
    let latestAccounts: unknown;
    let latestChain: unknown;
    const onAccounts = (...args: unknown[]) => {
      if (attempt !== generation.current) return;
      latestAccounts = args[0];
      if (initializing) return;
      if (!Array.isArray(latestAccounts) || !validAddress(latestAccounts[0])) {
        disconnect();
        return;
      }
      const address = latestAccounts[0];
      setAccount((current) => (current ? { ...current, address } : null));
    };
    const onChain = (...args: unknown[]) => {
      if (attempt !== generation.current) return;
      latestChain = args[0];
      if (initializing) return;
      if (!validChain(latestChain)) {
        disconnect();
        return;
      }
      const chainId = latestChain;
      setAccount((current) => (current ? { ...current, chainId } : null));
    };
    const onDisconnect = () => {
      if (attempt === generation.current) disconnect();
    };
    const provider = wallet.provider;
    const listeners = [
      ['accountsChanged', onAccounts],
      ['chainChanged', onChain],
      ['disconnect', onDisconnect],
    ] as const;
    cleanup.current = () => {
      for (const [event, listener] of listeners) provider.removeListener?.(event, listener);
      if (wallet.id === 'postern-walletconnect') provider.disconnect?.();
    };
    try {
      for (const [event, listener] of listeners) provider.on?.(event, listener);
      const result = await connectAccount(wallet);
      if (attempt !== generation.current) return;
      if (latestAccounts !== undefined) {
        if (!Array.isArray(latestAccounts) || !validAddress(latestAccounts[0]))
          throw new Error('Account unavailable.');
        result.address = latestAccounts[0];
      }
      if (latestChain !== undefined) {
        if (!validChain(latestChain)) throw new Error('Network unavailable.');
        result.chainId = latestChain;
      }
      initializing = false;
      setAccount(result);
    } catch (failure) {
      if (attempt !== generation.current) return;
      cleanup.current();
      setError(walletError(failure));
    } finally {
      if (attempt === generation.current) {
        busy.current = false;
        setPending(false);
      }
    }
  }
  return { wallets, account, pending, error, connect, disconnect };
}
