import { validAccounts, walletDisplayName, type WalletOption, type Provider } from './wallet';
import type SignClientType from '@walletconnect/sign-client';
const projectId = 'e263eead656b6d61ecdee75a71e100bb';
let client: SignClientType | undefined;
let appkit: Awaited<ReturnType<typeof createModal>> | undefined;
const CHAIN = 'eip155:84001';
const CHAIN_HEX = '0x14821';
const METHODS = ['eth_accounts', 'eth_chainId'];
const EVENTS = ['accountsChanged', 'chainChanged'];

type SessionEvent = {
  topic?: unknown;
  params?: { chainId?: unknown; event?: { name?: unknown; data?: unknown } };
};
type Namespace = { accounts?: unknown; chains?: unknown; methods?: unknown; events?: unknown };
type SessionUpdate = { topic?: unknown; params?: { namespaces?: unknown } };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function exactPermissionList(value: unknown, required: string[]) {
  return (
    Array.isArray(value) &&
    value.length === required.length &&
    new Set(value).size === value.length &&
    required.every((item) => value.includes(item))
  );
}
export function normalizeWalletNamespace(value: Namespace | undefined) {
  const accounts = value?.accounts,
    chains = value?.chains;
  const account = Array.isArray(accounts) && accounts.length === 1 ? accounts[0] : null;
  const address =
    typeof account === 'string' && /^eip155:84001:0x[a-fA-F0-9]{40}$/.test(account)
      ? account.split(':')[2]
      : null;
  if (
    !address ||
    !validAccounts([address]) ||
    (chains !== undefined &&
      (!Array.isArray(chains) || chains.length !== 1 || chains[0] !== CHAIN)) ||
    !exactPermissionList(value?.methods, METHODS) ||
    !exactPermissionList(value?.events, EVENTS)
  )
    return null;
  return { address };
}
export function normalizeWalletSessionEvent(message: SessionEvent, topic: string) {
  if (message?.topic !== topic) return null;
  const chain = message.params?.chainId,
    event = message.params?.event;
  if (chain !== CHAIN) return { disconnect: true, event: 'chainChanged', value: chain };
  if (event?.name === 'accountsChanged') {
    const accounts = event.data;
    if (!validAccounts(accounts) || accounts.length !== 1)
      return { disconnect: true, event: 'accountsChanged', value: [] };
    return {
      disconnect: false,
      event: 'accountsChanged',
      value: [accounts[0]],
      address: accounts[0],
    };
  }
  if (event?.name === 'chainChanged') {
    const value = event.data;
    let supported = false;
    try {
      supported =
        typeof value === 'string' &&
        value.length <= 66 &&
        /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value) &&
        BigInt(value) === 84001n;
    } catch {}
    return supported
      ? { disconnect: false, event: 'chainChanged', value: CHAIN_HEX }
      : { disconnect: true, event: 'chainChanged', value };
  }
  return null;
}
export function normalizeWalletSessionUpdate(
  message: SessionUpdate,
  topic: string,
  currentAddress: string,
) {
  if (message?.topic !== topic) return null;
  const namespaces = message.params?.namespaces;
  if (
    !namespaces ||
    typeof namespaces !== 'object' ||
    Array.isArray(namespaces) ||
    Object.keys(namespaces).length !== 1 ||
    !Object.hasOwn(namespaces, 'eip155')
  )
    return { disconnect: true, event: 'accountsChanged', value: [] };
  const namespace = normalizeWalletNamespace((namespaces as { eip155?: Namespace }).eip155);
  if (!namespace) return { disconnect: true, event: 'accountsChanged', value: [] };
  const { address } = namespace;
  return address.toLowerCase() === currentAddress.toLowerCase()
    ? null
    : { disconnect: false, event: 'accountsChanged', value: [address], address };
}
export function normalizeApprovedWalletSession(
  value: unknown,
  now = Math.floor(Date.now() / 1000),
) {
  if (!isRecord(value)) return null;
  const topic = value.topic,
    expiry = value.expiry,
    namespaces = value.namespaces;
  if (
    typeof topic !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(topic) ||
    !Number.isSafeInteger(expiry) ||
    (expiry as number) <= now ||
    (expiry as number) > now + 604800 ||
    !isRecord(namespaces) ||
    Object.keys(namespaces).length !== 1 ||
    !Object.hasOwn(namespaces, 'eip155')
  )
    return null;
  const namespace = normalizeWalletNamespace(namespaces.eip155 as Namespace | undefined);
  if (!namespace) return null;
  const peer = isRecord(value.peer) ? value.peer : null,
    metadata = peer && isRecord(peer.metadata) ? peer.metadata : null;
  return Object.freeze({
    topic,
    expiry: expiry as number,
    address: namespace.address,
    name: metadata?.name,
  });
}
async function createModal() {
  const { createAppKit } = await import('@reown/appkit/core');
  const { defineChain } = await import('@reown/appkit/networks');
  return createAppKit({
    projectId,
    manualWCControl: true,
    networks: [
      defineChain({
        id: 84001,
        chainNamespace: 'eip155',
        caipNetworkId: 'eip155:84001',
        name: 'Bloch L2 experimental testnet',
        nativeCurrency: { name: 'Test Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: ['https://blochdex.com/rpc'] } },
        testnet: true,
      }),
    ],
    metadata: {
      name: 'Postern DEX',
      description: 'Connect an account to the DEX preview',
      url: location.origin,
      icons: [],
    },
    themeMode: 'dark',
    themeVariables: { '--w3m-accent': '#c6f779', '--w3m-border-radius-master': '3px' },
    features: { analytics: false, email: false, socials: false, swaps: false, onramp: false },
  });
}
export async function connectQrWallet(signal: AbortSignal): Promise<WalletOption> {
  const { default: SignClient } = await import('@walletconnect/sign-client');
  if (signal.aborted) throw Error('Connection cancelled');
  client ??= await SignClient.init({
    projectId,
    metadata: {
      name: 'Postern DEX',
      description: 'Account connection only; trading preview',
      url: location.origin,
      icons: [],
    },
    telemetryEnabled: false,
    logger: 'silent',
  });
  if (signal.aborted) throw Error('Connection cancelled');
  const c = client;
  appkit ??= await createModal();
  if (signal.aborted) throw Error('Connection cancelled');
  const { uri, approval } = await c.connect({
    requiredNamespaces: { eip155: { chains: [CHAIN], methods: METHODS, events: EVENTS } },
  });
  if (signal.aborted) throw Error('Connection cancelled');
  if (!uri) throw Error('No pairing QR returned');
  const modal = appkit;
  const closeModal = async () => {
    try {
      await modal.close();
    } catch {
      /* Modal cleanup cannot restore or authorize a cancelled session. */
    }
  };
  try {
    await modal.open({ uri });
  } catch (failure) {
    await closeModal();
    throw failure;
  }
  if (signal.aborted) {
    await closeModal();
    throw Error('Connection cancelled');
  }
  let cancelled: boolean = Boolean(signal.aborted);
  let rejectCancelled: (error: Error) => void = () => {};
  const cancellation = new Promise<never>((_, reject) => {
    rejectCancelled = reject;
  });
  const cancel = () => {
    cancelled = true;
    rejectCancelled(Error('Connection cancelled'));
    void closeModal();
  };
  signal.addEventListener('abort', cancel, { once: true });
  let unsubscribe = () => {};
  try {
    unsubscribe = modal.subscribeState((state) => {
      if (!state.open) cancel();
    });
    const approved = approval();
    void approved.then(
      (session) => {
        const topic = isRecord(session) && session.topic;
        if (cancelled && typeof topic === 'string' && /^[0-9a-f]{64}$/i.test(topic))
          void c
            .disconnect({
              topic,
              reason: { code: 6000, message: 'Connection cancelled' },
            })
            .catch(() => {});
      },
      () => {},
    );
    const session = await Promise.race([approved, cancellation]);
    unsubscribe();
    unsubscribe = () => {};
    if (cancelled || signal.aborted) {
      const topic = isRecord(session) && session.topic;
      if (typeof topic === 'string' && /^[0-9a-f]{64}$/i.test(topic))
        await c.disconnect({
          topic,
          reason: { code: 6000, message: 'Connection cancelled' },
        });
      throw Error('Connection cancelled');
    }
    const now = Math.floor(Date.now() / 1000);
    const approvedSession = normalizeApprovedWalletSession(session, now);
    if (!approvedSession) {
      if (typeof session?.topic === 'string' && /^[0-9a-f]{64}$/i.test(session.topic))
        await c.disconnect({
          topic: session.topic,
          reason: { code: 6000, message: 'Unsupported session' },
        });
      throw Error('Wallet returned an unsupported session');
    }
    const { topic, expiry } = approvedSession;
    let address = approvedSession.address;
    let active = true;
    let expiryTimer: number | undefined;
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const emit = (event: string, ...args: unknown[]) =>
      listeners.get(event)?.forEach((fn) => fn(...args));
    const detach = () => {
      c.off('session_delete', deleted);
      c.off('session_expire', deleted);
      c.off('session_event', changed);
      c.off('session_update', updated);
    };
    const deactivate = (notify: boolean) => {
      if (!active) return false;
      active = false;
      detach();
      if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
      if (notify) emit('disconnect');
      listeners.clear();
      return true;
    };
    const expire = () => {
      if (deactivate(true))
        void c
          .disconnect({ topic, reason: { code: 6000, message: 'Session expired' } })
          .catch(() => {});
    };
    const deleted = (message: { topic?: unknown }) => {
      if (message?.topic === topic) deactivate(true);
    };
    const changed = (message: SessionEvent) => {
      if (!active) return;
      const update = normalizeWalletSessionEvent(message, topic);
      if (!update) return;
      if ('address' in update && typeof update.address === 'string') address = update.address;
      if (update.disconnect) {
        active = false;
        detach();
        if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
      }
      emit(update.event, update.value);
      if (update.disconnect) {
        emit('disconnect');
        listeners.clear();
        void c
          .disconnect({ topic, reason: { code: 6000, message: 'Unsupported session update' } })
          .catch(() => {});
      }
    };
    const updated = (message: SessionUpdate) => {
      if (!active) return;
      const update = normalizeWalletSessionUpdate(message, topic, address);
      if (!update) return;
      if ('address' in update && typeof update.address === 'string') address = update.address;
      if (update.disconnect) {
        active = false;
        detach();
        if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
      }
      emit(update.event, update.value);
      if (update.disconnect) {
        emit('disconnect');
        listeners.clear();
        void c
          .disconnect({ topic, reason: { code: 6000, message: 'Unsupported session update' } })
          .catch(() => {});
      }
    };
    c.on('session_delete', deleted);
    c.on('session_expire', deleted);
    c.on('session_event', changed);
    c.on('session_update', updated);
    expiryTimer = window.setTimeout(expire, Math.max(0, expiry * 1000 - Date.now()));
    const provider: Provider = {
      async request({ method }) {
        if (!active || expiry * 1000 <= Date.now()) {
          expire();
          throw Error('Session expired');
        }
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address];
        if (method === 'eth_chainId') return CHAIN_HEX;
        throw Error(
          'This DEX preview requests account access only. Transactions require a verified deployment.',
        );
      },
      on(event, fn) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(fn);
      },
      removeListener(event, fn) {
        listeners.get(event)?.delete(fn);
      },
      disconnect() {
        if (deactivate(false))
          void c
            .disconnect({ topic, reason: { code: 6000, message: 'User disconnected' } })
            .catch(() => {});
      },
    };
    await closeModal();
    return {
      id: 'postern-walletconnect',
      name: walletDisplayName(approvedSession.name, 'Mobile wallet'),
      provider,
    };
  } finally {
    unsubscribe();
    signal.removeEventListener('abort', cancel);
    await closeModal();
  }
}
