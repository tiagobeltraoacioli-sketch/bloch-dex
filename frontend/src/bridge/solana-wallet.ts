// Message signing by the user's own Solana wallet, without a wallet SDK: the Wallet Standard's window events
// (what current Solana wallets register through) and the older injected `window.solana` / `window.phantom.solana`
// object. Only two things are ever asked of a wallet here: its public address (connect) and a signature over the
// one line of text the page shows (signMessage). No Solana transaction is requested by this module.
import { base58Decode, base58Encode, type Bytes } from './codec';

export type SolanaSigner = {
  id: string;
  /** Untrusted display name of the wallet, bounded. */
  name: string;
  /** Connect and return the wallet's addresses (base58). */
  connect(): Promise<string[]>;
  /** Sign the UTF-8 bytes of `message` with the key of `address`; returns the 64-byte signature. */
  signMessage(address: string, message: string): Promise<Bytes>;
};

const cleanName = (value: unknown) =>
  (typeof value === 'string' ? value : 'Solana wallet').replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Solana wallet';
const bytes = (value: unknown): Bytes | null =>
  value instanceof Uint8Array ? value : Array.isArray(value) && value.every((b) => Number.isInteger(b) && b >= 0 && b < 256) ? Uint8Array.from(value) : null;

type StandardAccount = { address?: unknown; publicKey?: unknown; features?: unknown };
type StandardWallet = {
  name?: unknown;
  accounts?: StandardAccount[];
  features?: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>> | undefined>;
};

function fromStandard(wallet: StandardWallet, index: number): SolanaSigner | null {
  const connect = wallet.features?.['standard:connect']?.connect;
  const sign = wallet.features?.['solana:signMessage']?.signMessage;
  if (typeof connect !== 'function' || typeof sign !== 'function') return null;
  const accountOf = (address: string) => (wallet.accounts ?? []).find((a) => a.address === address);
  return {
    id: `standard-${index}`,
    name: cleanName(wallet.name),
    async connect() {
      const answer = (await connect.call(wallet.features!['standard:connect'])) as { accounts?: StandardAccount[] } | undefined;
      return (answer?.accounts ?? wallet.accounts ?? []).map((a) => a.address).filter((a): a is string => typeof a === 'string');
    },
    async signMessage(address, message) {
      const account = accountOf(address);
      if (!account) throw new Error('The wallet no longer offers this account.');
      const answer = (await sign.call(wallet.features!['solana:signMessage'], { account, message: new TextEncoder().encode(message) })) as { signature?: unknown }[] | undefined;
      const signature = bytes(answer?.[0]?.signature);
      if (!signature || signature.length !== 64) throw new Error('The wallet did not return a 64-byte signature.');
      return signature;
    },
  };
}

type Injected = {
  isPhantom?: boolean;
  publicKey?: { toBase58?: () => string; toBytes?: () => Uint8Array } | null;
  connect?: () => Promise<{ publicKey?: { toBase58?: () => string; toBytes?: () => Uint8Array } } | undefined>;
  signMessage?: (message: Uint8Array, display?: string) => Promise<{ signature?: unknown } | Uint8Array>;
};
function fromInjected(provider: Injected, id: string, name: string): SolanaSigner | null {
  if (typeof provider.connect !== 'function' || typeof provider.signMessage !== 'function') return null;
  const text = (key: Injected['publicKey']) => (key?.toBase58 ? key.toBase58() : key?.toBytes ? base58Encode(key.toBytes()) : null);
  return {
    id,
    name,
    async connect() {
      const answer = await provider.connect!();
      const address = text(answer?.publicKey ?? provider.publicKey);
      return address && base58Decode(address)?.length === 32 ? [address] : [];
    },
    async signMessage(address, message) {
      if (text(provider.publicKey) !== address) throw new Error('The wallet is on another account now.');
      const answer = await provider.signMessage!(new TextEncoder().encode(message), 'utf8');
      const signature = bytes(answer instanceof Uint8Array ? answer : answer?.signature);
      if (!signature || signature.length !== 64) throw new Error('The wallet did not return a 64-byte signature.');
      return signature;
    },
  };
}

/** Find the Solana wallets of this browser without asking any of them for anything. Returns a stop function. */
export function discoverSolanaSigners(onSigner: (signer: SolanaSigner) => void): () => void {
  const seen = new Set<unknown>();
  let count = 0;
  const register = (...wallets: unknown[]) => {
    for (const wallet of wallets) {
      if (!wallet || typeof wallet !== 'object' || seen.has(wallet) || count >= 12) continue;
      seen.add(wallet);
      try {
        const signer = fromStandard(wallet as StandardWallet, count);
        if (signer) {
          count++;
          onSigner(signer);
        }
      } catch {
        /* a wallet object that throws on inspection is skipped */
      }
    }
    return () => {};
  };
  const onRegister = (event: Event) => {
    try {
      const callback = (event as CustomEvent<unknown>).detail;
      if (typeof callback === 'function') (callback as (api: { register: typeof register }) => void)({ register });
    } catch {
      /* skipped */
    }
  };
  window.addEventListener('wallet-standard:register-wallet', onRegister);
  try {
    window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: { register } }));
  } catch {
    /* no CustomEvent: no standard wallets */
  }
  const legacy = window.setTimeout(() => {
    if (count > 0) return;
    try {
      const w = window as unknown as { phantom?: { solana?: Injected }; solana?: Injected };
      const provider = w.phantom?.solana ?? w.solana;
      const signer = provider && fromInjected(provider, 'injected', provider.isPhantom ? 'Phantom' : 'Solana wallet');
      if (signer) onSigner(signer);
    } catch {
      /* skipped */
    }
  }, 400);
  return () => {
    window.clearTimeout(legacy);
    window.removeEventListener('wallet-standard:register-wallet', onRegister);
  };
}
