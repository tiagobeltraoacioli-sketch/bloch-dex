export type Provider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
};
export type WalletOption = { id: string; name: string; provider: Provider };
export type WalletAccount = { address: string; chainId: string; name: string };

declare global {
  interface Window {
    ethereum?: Provider;
  }
}

export function validAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}
export function validChain(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(value) && BigInt(value) > 0n;
}

/** Discover providers without requesting accounts. Names are untrusted text; icons are not loaded. */
export function discoverWallets(onWallet: (wallet: WalletOption) => void): () => void {
  const seen = new Set<Provider>();
  const announce = (event: Event) => {
    const detail: unknown = (event as CustomEvent<unknown>).detail;
    if (!detail || typeof detail !== 'object') return;
    const { info, provider } = detail as {
      info?: { uuid?: unknown; name?: unknown };
      provider?: Provider;
    };
    if (
      !provider ||
      typeof provider.request !== 'function' ||
      !info ||
      typeof info.uuid !== 'string' ||
      typeof info.name !== 'string'
    )
      return;
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(info.uuid) ||
      seen.has(provider) ||
      seen.size >= 20
    )
      return;
    seen.add(provider);
    onWallet({ id: info.uuid, name: info.name.slice(0, 60) || 'Browser wallet', provider });
  };
  window.addEventListener('eip6963:announceProvider', announce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  // A short grace period gives multi-wallet announcements precedence over the legacy slot.
  const timer = window.setTimeout(() => {
    const provider = window.ethereum;
    if (provider && typeof provider.request === 'function' && !seen.has(provider)) {
      seen.add(provider);
      onWallet({ id: 'legacy-injected', name: 'Browser wallet', provider });
    }
  }, 250);
  return () => {
    window.clearTimeout(timer);
    window.removeEventListener('eip6963:announceProvider', announce);
  };
}

export async function connectAccount(wallet: WalletOption): Promise<WalletAccount> {
  const accounts = await wallet.provider.request({ method: 'eth_requestAccounts' });
  if (!Array.isArray(accounts) || !validAddress(accounts[0]))
    throw new Error('The wallet did not return a valid account.');
  const chainId = await wallet.provider.request({ method: 'eth_chainId' });
  if (!validChain(chainId)) throw new Error('The wallet did not return a valid network.');
  return { address: accounts[0], chainId, name: wallet.name };
}

export function walletError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 4001) return 'Connection declined. You can try again when you are ready.';
  if (code === -32002) return 'A connection request is already open. Check your wallet.';
  if (code === 4900 || code === 4901) return 'Your wallet is offline. Reconnect it and try again.';
  return 'Could not connect to this wallet. Unlock it and try again.';
}
