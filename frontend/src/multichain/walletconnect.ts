// The multichain site's mobile-wallet session (Reown / WalletConnect v2): a wallet on a phone connects by QR code
// or by a link that opens the wallet app, and signs the transactions of this page.
//
// What the session is, and is not:
//  - It asks the wallet for ONE method, eth_sendTransaction, and two events (accountsChanged, chainChanged), on
//    the chains the caller names (the networks of this site whose bundled record is live). No message signing.
//  - The wallet is never asked to read anything. eth_accounts and eth_chainId are answered here, from the approved
//    session; every other method is refused here. The page reads the chain from its own two agreeing endpoints.
//  - A WalletConnect session holds several chains at once and every request names its chain (CAIP-2), so
//    wallet_switchEthereumChain is answered here as well: it selects another chain OF THE SESSION and nothing is
//    sent to the wallet. A chain outside the session cannot be added to it: the user connects again.
//  - A transaction is sent only when it names its chain, that chain is the selected one, and its sender is the
//    session's account. The hash the wallet returns is only a claim: the page verifies it on its own endpoints.
//  - The namespace the wallet approves is compared exactly: only eip155, only chains that were asked for, one and
//    the same account on each, exactly the methods and events asked for. Anything else is refused and the remote
//    session is closed. The same holds for every later update or event of the session.
//  - Nothing of the session is written to browser storage: it lives in this page's memory and ends with it.
//
// The account-only session of the Bloch L2 preview is another module (qr-wallet.ts) with its own, narrower rules.
import type SignClientType from '@walletconnect/sign-client';
import { validAddress, walletDisplayName, type Provider, type WalletOption } from '../wallet';
import {
  REOWN_PROJECT_ID,
  exactPermissionList,
  isRecord,
  isSessionTopic,
} from '../walletconnect-shared';

/** The name the wallet shows for this site (the multichain site is "Bloch DEX"; MultichainApp.tsx). */
export const WALLETCONNECT_SITE_NAME = 'Bloch DEX';
/** The only method ever sent to the wallet. */
export const WALLETCONNECT_METHODS = ['eth_sendTransaction'] as const;
export const WALLETCONNECT_EVENTS = ['accountsChanged', 'chainChanged'] as const;
/** useWallet.ts closes the remote session of a wallet with this id when the page lets go of it. */
export const WALLETCONNECT_WALLET_ID = 'postern-walletconnect';
const MAX_CHAINS = 16;
const MAX_SESSION_SECONDS = 604_800;
const MAX_CALLDATA_CHARS = 2 + 2 * 65_536;

const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i;
const DATA = /^0x(?:[0-9a-f]{2})*$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const CAIP_ACCOUNT = /^eip155:([1-9][0-9]{0,15}):(0x[0-9a-fA-F]{40})$/;
const CAIP_CHAIN = /^eip155:([1-9][0-9]{0,15})$/;

export const caipChain = (chainId: number) => `eip155:${chainId}`;
const hexChain = (chainId: number) => `0x${chainId.toString(16)}`;

/** An error the page's wallet code can read: `code` as in EIP-1193 / EIP-1474. */
function failure(message: string, code: number): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

function validChainIds(value: readonly number[]): boolean {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= MAX_CHAINS &&
    new Set(value).size === value.length &&
    value.every((id) => Number.isSafeInteger(id) && id > 0)
  );
}

type Namespace = { accounts?: unknown; chains?: unknown; methods?: unknown; events?: unknown };
export type ApprovedNamespace = { address: string; chainIds: number[] };

/**
 * The eip155 namespace a wallet approved, or sent in an update, against what was asked. The wallet may approve
 * fewer chains than asked (a wallet that does not know one of them), never one that was not asked for.
 */
export function normalizeMobileNamespace(
  value: Namespace | undefined,
  requested: readonly number[],
): ApprovedNamespace | null {
  if (!isRecord(value) || !validChainIds(requested)) return null;
  const { accounts, chains } = value;
  if (!Array.isArray(accounts) || accounts.length < 1 || accounts.length > requested.length)
    return null;
  const chainIds: number[] = [];
  let address: string | null = null;
  // An index loop: Array.every and for-of skip nothing here, but a hole must not validate as an account.
  for (let index = 0; index < accounts.length; index++) {
    const account: unknown = accounts[index];
    const match = typeof account === 'string' ? CAIP_ACCOUNT.exec(account) : null;
    if (!match) return null;
    const chainId = Number(match[1]);
    if (!requested.includes(chainId) || chainIds.includes(chainId) || !validAddress(match[2]))
      return null;
    // One account, the same on every chain: the page shows and checks a single sender.
    if (address !== null && address.toLowerCase() !== match[2].toLowerCase()) return null;
    address ??= match[2];
    chainIds.push(chainId);
  }
  if (address === null) return null;
  if (chains !== undefined) {
    if (!Array.isArray(chains) || chains.length !== chainIds.length) return null;
    const listed: number[] = [];
    for (let index = 0; index < chains.length; index++) {
      const chain: unknown = chains[index];
      const match = typeof chain === 'string' ? CAIP_CHAIN.exec(chain) : null;
      if (!match) return null;
      const chainId = Number(match[1]);
      if (!chainIds.includes(chainId) || listed.includes(chainId)) return null;
      listed.push(chainId);
    }
  }
  if (
    !exactPermissionList(value.methods, WALLETCONNECT_METHODS) ||
    !exactPermissionList(value.events, WALLETCONNECT_EVENTS)
  )
    return null;
  return { address, chainIds };
}

function onlyEip155(namespaces: unknown): Namespace | null {
  if (
    !isRecord(namespaces) ||
    Object.keys(namespaces).length !== 1 ||
    !Object.hasOwn(namespaces, 'eip155')
  )
    return null;
  return namespaces.eip155 as Namespace;
}

export type ApprovedSession = Readonly<{
  topic: string;
  expiry: number;
  address: string;
  chainIds: readonly number[];
  name: unknown;
}>;

/** The session a wallet approved, or null when it is not exactly what this page can use. */
export function normalizeApprovedMobileSession(
  value: unknown,
  requested: readonly number[],
  routeChainId: number,
  now = Math.floor(Date.now() / 1000),
): ApprovedSession | null {
  if (!isRecord(value)) return null;
  const { topic, expiry } = value;
  if (
    !isSessionTopic(topic) ||
    !Number.isSafeInteger(expiry) ||
    (expiry as number) <= now ||
    (expiry as number) > now + MAX_SESSION_SECONDS
  )
    return null;
  const eip155 = onlyEip155(value.namespaces);
  const namespace = eip155 ? normalizeMobileNamespace(eip155, requested) : null;
  // A session without the network of the page the user is on cannot send what that page builds.
  if (!namespace || !namespace.chainIds.includes(routeChainId)) return null;
  const peer = isRecord(value.peer) ? value.peer : null,
    metadata = peer && isRecord(peer.metadata) ? peer.metadata : null;
  return Object.freeze({
    topic,
    expiry: expiry as number,
    address: namespace.address,
    chainIds: Object.freeze([...namespace.chainIds]),
    name: metadata?.name,
  });
}

function chainIdOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || value.length > 66 || !/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value))
    return null;
  try {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : null;
  } catch {
    return null;
  }
}

type SessionEvent = {
  topic?: unknown;
  params?: { chainId?: unknown; event?: { name?: unknown; data?: unknown } };
};
type SessionUpdate = { topic?: unknown; params?: { namespaces?: unknown } };
export type SessionChange =
  | { disconnect: true }
  | { disconnect: false; address: string }
  | { disconnect: false; chainId: number }
  | { disconnect: false; address: string; chainIds: number[] };

/**
 * An event of the session. Null: not for this session, or an event this page did not ask for (ignored). A chain
 * or an account outside the approved session ends the session.
 */
export function normalizeMobileSessionEvent(
  message: SessionEvent,
  topic: string,
  chainIds: readonly number[],
): SessionChange | null {
  if (!isRecord(message) || message.topic !== topic) return null;
  const params = isRecord(message.params) ? message.params : null;
  const scope = typeof params?.chainId === 'string' ? CAIP_CHAIN.exec(params.chainId) : null;
  if (!scope || !chainIds.includes(Number(scope[1]))) return { disconnect: true };
  const event = isRecord(params?.event) ? params.event : null;
  if (event?.name === 'accountsChanged') {
    const accounts = event.data;
    if (!Array.isArray(accounts) || accounts.length !== 1 || !validAddress(accounts[0]))
      return { disconnect: true };
    return { disconnect: false, address: accounts[0] };
  }
  if (event?.name === 'chainChanged') {
    const chainId = chainIdOf(event.data);
    return chainId !== null && chainIds.includes(chainId)
      ? { disconnect: false, chainId }
      : { disconnect: true };
  }
  return null;
}

/** A namespace update sent by the wallet: the same rules as the approval, against the same request. */
export function normalizeMobileSessionUpdate(
  message: SessionUpdate,
  topic: string,
  requested: readonly number[],
): SessionChange | null {
  if (!isRecord(message) || message.topic !== topic) return null;
  const eip155 = onlyEip155(isRecord(message.params) ? message.params.namespaces : undefined);
  const namespace = eip155 ? normalizeMobileNamespace(eip155, requested) : null;
  if (!namespace) return { disconnect: true };
  return { disconnect: false, address: namespace.address, chainIds: namespace.chainIds };
}

const TRANSACTION_FIELDS = [
  'from',
  'to',
  'data',
  'value',
  'gas',
  'chainId',
  'nonce',
  'maxPriorityFeePerGas',
  'maxFeePerGas',
];

/**
 * The transaction object of an eth_sendTransaction request, as this page builds it (devnet4/swap.ts
 * `sendTransaction`), or a refusal. It must name its chain, that chain must be the selected one, and the sender
 * must be the session's account. Returns a copy with only the reviewed fields.
 */
export function reviewedTransaction(
  value: unknown,
  address: string,
  chainId: number,
): Record<string, string> {
  if (!isRecord(value)) throw failure('The transaction request is not an object.', -32602);
  for (const key of Object.keys(value))
    if (!TRANSACTION_FIELDS.includes(key))
      throw failure(`The transaction request has a field this page does not send: ${key}.`, -32602);
  const { from, to, data, value: amount, gas, nonce, maxPriorityFeePerGas, maxFeePerGas } = value;
  const named = typeof value.chainId === 'string' && QUANTITY.test(value.chainId);
  if (!named) throw failure('The transaction request does not name its chain.', -32602);
  if (chainIdOf(value.chainId) !== chainId)
    throw failure(
      'The transaction request names another chain than the one selected for this wallet session.',
      4901,
    );
  if (!validAddress(from) || from.toLowerCase() !== address.toLowerCase())
    throw failure('The transaction request is not from the connected account.', 4100);
  if (!validAddress(to)) throw failure('The transaction request has no valid destination.', -32602);
  if (typeof data !== 'string' || !DATA.test(data) || data.length > MAX_CALLDATA_CHARS)
    throw failure('The transaction request has no valid call data.', -32602);
  const quantities = { value: amount, gas, nonce, maxPriorityFeePerGas, maxFeePerGas };
  const reviewed: Record<string, string> = { from, to, data, chainId: hexChain(chainId) };
  for (const [name, quantity] of Object.entries(quantities)) {
    const required = name === 'value' || name === 'gas';
    if (quantity === undefined && !required) continue;
    if (typeof quantity !== 'string' || !QUANTITY.test(quantity))
      throw failure(`The transaction request has no valid ${name}.`, -32602);
    reviewed[name] = quantity;
  }
  if ((maxPriorityFeePerGas === undefined) !== (maxFeePerGas === undefined))
    throw failure('The transaction request names one fee field without the other.', -32602);
  return reviewed;
}

/** What the wallet answered to a request, as an error the page's code reads the same way as an injected wallet's. */
function peerFailure(error: unknown): Error & { code?: number } {
  let code: unknown;
  let text: unknown;
  try {
    if (error && typeof error === 'object') {
      code = (error as { code?: unknown }).code;
      text = (error as { message?: unknown }).message;
    }
  } catch {
    // A rejection value is untrusted, accessor-backed objects included.
  }
  // 4001 is EIP-1193's "user rejected the request"; 5000 is WalletConnect's "user rejected", which wallets send
  // for the same act. Both come from the same peer with the same authority, so the page reads both as 4001.
  if (code === 4001 || code === 5000)
    return failure('The request was rejected in the wallet.', 4001);
  const message = walletDisplayName(text, 'The wallet did not complete the request.');
  return Number.isSafeInteger(code) ? failure(message, code as number) : new Error(message);
}

type Client = Pick<SignClientType, 'on' | 'off' | 'disconnect' | 'request'>;

/**
 * The EIP-1193 view of an approved session, for useWallet.ts and the page's transaction path. Exported for the
 * tests; the page obtains it through connectMobileWallet only.
 */
export function mobileSessionProvider(
  c: Client,
  session: ApprovedSession,
  requested: readonly number[],
  routeChainId: number,
): Provider {
  const { topic, expiry } = session;
  let address = session.address;
  let chainIds = [...session.chainIds];
  let current = routeChainId;
  let active = true;
  let expiryTimer: number | undefined;
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const waiting = new Set<(error: Error) => void>();
  // Errors raised here, as opposed to answers of the wallet.
  const local = new WeakSet<Error>();
  const emit = (event: string, ...args: unknown[]) =>
    listeners.get(event)?.forEach((listener) => listener(...args));
  const detach = () => {
    c.off('session_delete', deleted);
    c.off('session_expire', deleted);
    c.off('session_event', changed);
    c.off('session_update', updated);
  };
  const closeRemote = (message: string) =>
    void c.disconnect({ topic, reason: { code: 6000, message } }).catch(() => {});
  const deactivate = (notify: boolean) => {
    if (!active) return false;
    active = false;
    detach();
    if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
    // A request the wallet has not answered may still be signed there: its outcome is unknown, not refused.
    const ended = failure('The wallet session ended before the wallet answered.', 4900);
    local.add(ended);
    for (const reject of waiting) reject(ended);
    waiting.clear();
    if (notify) emit('disconnect');
    listeners.clear();
    return true;
  };
  const expire = () => {
    if (deactivate(true)) closeRemote('Session expired');
  };
  const refuse = () => {
    if (deactivate(true)) closeRemote('Unsupported session update');
  };
  const deleted = (message: { topic?: unknown }) => {
    if (message?.topic === topic) deactivate(true);
  };
  const apply = (change: SessionChange | null) => {
    if (!active || !change) return;
    if (change.disconnect) return refuse();
    if ('chainIds' in change) {
      // The wallet dropped the selected chain from the session: nothing more can be sent on it.
      if (!change.chainIds.includes(current)) return refuse();
      chainIds = [...change.chainIds];
    }
    if ('address' in change && change.address.toLowerCase() !== address.toLowerCase()) {
      address = change.address;
      emit('accountsChanged', [address]);
    }
    if ('chainId' in change && change.chainId !== current) {
      current = change.chainId;
      emit('chainChanged', hexChain(current));
    }
  };
  const changed = (message: unknown) =>
    apply(normalizeMobileSessionEvent(message as SessionEvent, topic, chainIds));
  const updated = (message: unknown) =>
    apply(normalizeMobileSessionUpdate(message as SessionUpdate, topic, requested));
  c.on('session_delete', deleted);
  c.on('session_expire', deleted);
  c.on('session_event', changed as never);
  c.on('session_update', updated as never);
  expiryTimer = window.setTimeout(expire, Math.max(0, expiry * 1000 - Date.now()));

  const select = (params: unknown[] | undefined) => {
    const wanted = chainIdOf(isRecord(params?.[0]) ? params[0].chainId : undefined);
    if (wanted === null) throw failure('The network request names no chain.', -32602);
    if (!chainIds.includes(wanted))
      // 4902: "unrecognized chain". The page then asks to add it, which a session cannot do (below).
      throw failure(
        `This wallet session does not include chain ${wanted}. Disconnect and connect the wallet again on that network's page.`,
        4902,
      );
    if (wanted !== current) {
      current = wanted;
      emit('chainChanged', hexChain(current));
    }
    return null;
  };

  return {
    async request({ method, params }) {
      if (!active || expiry * 1000 <= Date.now()) {
        expire();
        throw failure('The wallet session has ended. Connect the wallet again.', 4900);
      }
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address];
      if (method === 'eth_chainId') return hexChain(current);
      if (method === 'wallet_switchEthereumChain') return select(params);
      if (method === 'wallet_addEthereumChain') {
        const wanted = chainIdOf(isRecord(params?.[0]) ? params[0].chainId : undefined);
        if (wanted !== null && chainIds.includes(wanted)) return select(params);
        throw failure(
          `This wallet session does not include chain ${wanted ?? 'unknown'}, and a network cannot be added to an open session. Disconnect and connect the wallet again on that network's page.`,
          4901,
        );
      }
      if (method !== 'eth_sendTransaction')
        throw failure(
          `This wallet session only sends transactions; ${walletDisplayName(method, 'this method')} is not asked of the wallet.`,
          4200,
        );
      if (!Array.isArray(params) || params.length !== 1)
        throw failure('The transaction request is not a single transaction.', -32602);
      const transaction = reviewedTransaction(params[0], address, current);
      let hash: unknown;
      try {
        hash = await new Promise<unknown>((resolve, reject) => {
          waiting.add(reject);
          c.request({
            topic,
            // Named explicitly, and equal to the transaction's own chainId field (reviewedTransaction).
            chainId: caipChain(current),
            request: { method: 'eth_sendTransaction', params: [transaction] },
          }).then(
            (value) => (waiting.delete(reject), resolve(value)),
            (error: unknown) => (waiting.delete(reject), reject(error)),
          );
        });
      } catch (error) {
        throw error instanceof Error && local.has(error) ? error : peerFailure(error);
      }
      // Only a claim: the page looks this hash up on its own endpoints before it shows any outcome.
      if (typeof hash !== 'string' || !HASH.test(hash))
        throw new Error('The wallet did not return a transaction hash.');
      return hash;
    },
    on(event, listener) {
      if (!active) return;
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener);
    },
    disconnect() {
      if (deactivate(false)) closeRemote('User disconnected');
    },
  };
}

/** Session state lives in this page's memory only: nothing of it is left in the browser after the page closes. */
export function memoryStorage() {
  const entries = new Map<string, unknown>();
  const copy = <T>(value: T): T => (value === undefined ? value : structuredClone(value));
  return {
    getKeys: async () => [...entries.keys()],
    getEntries: async <T>() => [...entries.entries()].map(([k, v]) => [k, copy(v)] as [string, T]),
    getItem: async <T>(key: string) => copy(entries.get(key)) as T | undefined,
    setItem: async <T>(key: string, value: T) => void entries.set(key, copy(value)),
    removeItem: async (key: string) => void entries.delete(key),
  };
}

/** A pairing URI of WalletConnect v2, as the client returns it; anything else is not shown or linked. */
export function validPairingUri(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 2048 &&
    /^wc:[0-9a-f]{64}@2\?[A-Za-z0-9%&=._~:+,;!*'()/?@$-]+$/.test(value)
  );
}

/**
 * Links that hand the pairing URI to a wallet app on the same phone. `wc:` is the scheme wallets register; the
 * three named links are those wallets' own universal-link hosts, fixed here, carrying nothing but the URI.
 */
export function mobileWalletLinks(uri: string): { name: string; href: string; app: boolean }[] {
  if (!validPairingUri(uri)) return [];
  const encoded = encodeURIComponent(uri);
  return [
    { name: 'Open in a wallet app', href: uri, app: true },
    { name: 'MetaMask', href: `https://metamask.app.link/wc?uri=${encoded}`, app: false },
    { name: 'Trust Wallet', href: `https://link.trustwallet.com/wc?uri=${encoded}`, app: false },
    { name: 'Rainbow', href: `https://rnbwapp.com/wc?uri=${encoded}`, app: false },
  ];
}

let client: SignClientType | undefined;
const CANCELLED = 'Connection cancelled';

export type MobileWalletRequest = {
  signal: AbortSignal;
  /** The chains offered to the wallet: the networks of this site whose bundled record is live. */
  chainIds: readonly number[];
  /** The network of the page the user connects on. A session without it is refused. */
  routeChainId: number;
  /** Called once with the pairing URI: the page shows it as a QR code and as links. */
  onUri(uri: string): void;
};

/**
 * Open a session with a mobile wallet. Nothing of WalletConnect is loaded, and no relay connection exists,
 * before this is called (by the user pressing the connect button): the client is imported here.
 */
export async function connectMobileWallet(request: MobileWalletRequest): Promise<WalletOption> {
  const { signal, routeChainId, onUri } = request;
  const requested = [...request.chainIds];
  if (!validChainIds(requested) || !requested.includes(routeChainId))
    throw Error('No live network to connect a wallet to');
  if (signal.aborted) throw Error(CANCELLED);
  const { default: SignClient } = await import('@walletconnect/sign-client');
  if (signal.aborted) throw Error(CANCELLED);
  client ??= await SignClient.init({
    projectId: REOWN_PROJECT_ID,
    metadata: {
      name: WALLETCONNECT_SITE_NAME,
      description: 'Swaps on public networks. Every transaction is confirmed in your wallet.',
      url: location.origin,
      icons: [],
    },
    storage: memoryStorage(),
    telemetryEnabled: false,
    logger: 'silent',
  });
  if (signal.aborted) throw Error(CANCELLED);
  const c = client;
  const closeLate = (session: unknown, message: string) => {
    const topic = isRecord(session) ? session.topic : undefined;
    if (isSessionTopic(topic))
      return c.disconnect({ topic, reason: { code: 6000, message } }).catch(() => {});
  };
  const { uri, approval } = await c.connect({
    // Offered, not required: a wallet that does not know one of the chains can still approve the others.
    optionalNamespaces: {
      eip155: {
        chains: requested.map(caipChain),
        methods: [...WALLETCONNECT_METHODS],
        events: [...WALLETCONNECT_EVENTS],
      },
    },
  });
  const abandonApproval = () => {
    // connect() already sent the proposal. Observe its result even though the page no longer waits, so a late
    // approval cannot leave an abandoned remote session.
    void Promise.resolve()
      .then(approval)
      .then((session) => closeLate(session, CANCELLED))
      .catch(() => {});
  };
  if (signal.aborted) {
    abandonApproval();
    throw Error(CANCELLED);
  }
  if (!validPairingUri(uri)) {
    abandonApproval();
    throw Error('No pairing code returned');
  }
  let cancelled = false;
  let rejectCancelled: (error: Error) => void = () => {};
  const cancellation = new Promise<never>((_, reject) => {
    rejectCancelled = reject;
  });
  const cancel = () => {
    cancelled = true;
    rejectCancelled(Error(CANCELLED));
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    let approved: Promise<unknown>;
    try {
      approved = approval();
    } catch (error) {
      throw error instanceof Error ? error : Error('The connection could not be started');
    }
    void approved.then(
      (session) => {
        if (cancelled) void closeLate(session, CANCELLED);
      },
      () => {},
    );
    try {
      onUri(uri);
    } catch {
      cancelled = true;
      throw Error('The pairing code could not be shown');
    }
    const session = await Promise.race([approved, cancellation]);
    if (cancelled || signal.aborted) {
      cancelled = true;
      await closeLate(session, CANCELLED);
      throw Error(CANCELLED);
    }
    const approvedSession = normalizeApprovedMobileSession(session, requested, routeChainId);
    if (!approvedSession) {
      await closeLate(session, 'Unsupported session');
      throw Error('Wallet returned an unsupported session');
    }
    return {
      id: WALLETCONNECT_WALLET_ID,
      name: walletDisplayName(approvedSession.name, 'Mobile wallet'),
      provider: mobileSessionProvider(c, approvedSession, requested, routeChainId),
    };
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
