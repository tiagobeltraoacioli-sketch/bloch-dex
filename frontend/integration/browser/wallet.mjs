// A simulated wallet for the browser harness. The page sees an ordinary EIP-1193 provider announced through EIP-6963;
// every request crosses a DevTools binding to this file, where a throwaway key signs with viem. No key is in the page.
// It reproduces, on demand, what wallets do with a request: broadcast it, hold it in their own queue, speed it up,
// cancel it, drop it, reject it, ignore the fields a site suggests, or lose the structured data of an RPC error.
// It is a simulation: a real wallet's nonce tracker, rebroadcast timer and prompts are not reproduced here.
import { keccak256, parseTransaction } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

/** Runs in the page before any page script. */
export const PROVIDER_SCRIPT = String.raw`
(() => {
  const waiting = new Map();
  const listeners = new Map();
  let seq = 0;
  window.__walletReply = (id, ok, value) => {
    const entry = waiting.get(id);
    if (!entry) return;
    waiting.delete(id);
    if (ok) return entry.resolve(value);
    const error = new Error(value.message);
    error.code = value.code;
    if ('data' in value) error.data = value.data;
    entry.reject(error);
  };
  window.__walletEmit = (name, value) => (listeners.get(name) ?? []).forEach((f) => f(value));
  const provider = {
    request({ method, params }) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        waiting.set(id, { resolve, reject });
        window.__walletBridge(JSON.stringify({ id, method, params: params ?? [] }));
      });
    },
    on(name, f) { listeners.set(name, [...(listeners.get(name) ?? []), f]); },
    removeListener(name, f) { listeners.set(name, (listeners.get(name) ?? []).filter((x) => x !== f)); },
  };
  const announce = () =>
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
      detail: Object.freeze({
        info: { uuid: '0d3b5c1e-7a2f-4c6b-9e1d-5f8a7b6c4d21', name: 'Harness wallet', icon: '', rdns: 'invalid.postern-harness' },
        provider,
      }),
    }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
})();`;

const hex = (n) => `0x${BigInt(n).toString(16)}`;
export const USER_REJECTED = { code: 4001, message: 'User rejected the request.' };

export function createWallet({ rpc, chainId }) {
  const account = privateKeyToAccount(generatePrivateKey()); // throwaway, never written anywhere
  const address = account.address.toLowerCase();
  const state = {
    chainId: hex(chainId),
    /** What the next eth_sendTransaction does: 'broadcast' | 'broadcast-reply-lost' | 'hold' | 'hold-reply-lost' | 'reject' | 'error-plain' | 'error-fee-data' | 'error-fee-data-lost' | 'never-answer'. */
    next: [],
    /** A wallet that takes the nonce from its own tracker, whatever the site asks. */
    ignoreNonce: false,
    /** A wallet that prices every transaction itself. */
    ignoreFees: false,
    fees: { maxFeePerGas: 5_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n },
  };
  const requests = []; // every provider request, in order
  const signed = []; // every transaction the wallet signed: { hash, raw, tx, broadcast, origin }
  const open = []; // prompts left open ('never-answer')

  const sign = async (tx, origin) => {
    const raw = await account.signTransaction({ type: 'eip1559', chainId, ...tx });
    const entry = { hash: keccak256(raw), raw, tx, broadcast: false, origin };
    signed.push(entry);
    return entry;
  };
  const broadcast = async (entry) => {
    const hash = await rpc('eth_sendRawTransaction', [entry.raw]);
    if (hash !== entry.hash) throw new Error('the node returned another hash');
    entry.broadcast = true;
    return hash;
  };
  /** The wallet's own next nonce: the node's pending count, or one past anything it signed and still holds. */
  const ownNonce = async () => {
    const pending = BigInt(await rpc('eth_getTransactionCount', [address, 'pending']));
    const held = signed.filter((s) => !s.replaced && !s.refused).reduce((max, s) => (BigInt(s.tx.nonce) + 1n > max ? BigInt(s.tx.nonce) + 1n : max), 0n);
    return pending > held ? pending : held;
  };

  async function sendTransaction(request) {
    const mode = state.next.shift() ?? 'broadcast';
    if (mode === 'reject') throw USER_REJECTED;
    if (mode === 'never-answer') return new Promise((resolve, reject) => open.push({ request, resolve, reject }));
    const requestedNonce = request.nonce === undefined ? undefined : BigInt(request.nonce);
    const nonce = state.ignoreNonce || requestedNonce === undefined ? await ownNonce() : requestedNonce;
    const siteFees = request.maxFeePerGas !== undefined && request.maxPriorityFeePerGas !== undefined && !state.ignoreFees;
    const tx = {
      nonce: Number(nonce),
      to: request.to,
      data: request.data ?? '0x',
      value: BigInt(request.value ?? '0x0'),
      gas: BigInt(request.gas ?? '0x7a120'),
      maxFeePerGas: siteFees ? BigInt(request.maxFeePerGas) : state.fees.maxFeePerGas,
      maxPriorityFeePerGas: siteFees ? BigInt(request.maxPriorityFeePerGas) : state.fees.maxPriorityFeePerGas,
    };
    const entry = await sign(tx, 'site');
    entry.requestedNonce = requestedNonce === undefined ? null : requestedNonce.toString();
    entry.siteFees = siteFees;
    if (mode === 'hold') return entry.hash; // accepted by the wallet, kept in its own queue
    // Accepted and queued by the wallet, but the reply to the page is lost (a dropped WalletConnect session, a closed popup).
    if (mode === 'hold-reply-lost') throw { code: -32603, message: 'Request expired. Please try again.' };
    if (mode.startsWith('error')) {
      // The wallet's node refused the signed transaction before its queue (the L2's admission refusal, see the L2
      // repository docs/MAINNET-RPC-READINESS.md). Nothing was published. Wallets differ in what they pass on.
      entry.refused = true;
      const head = await rpc('eth_getBlockByNumber', ['latest', false]);
      const base = BigInt(head.baseFeePerGas);
      const gasUsed = 46_000n;
      const required = (200_000_000_000_000n + gasUsed - 1n) / gasUsed;
      const data = {
        kind: 'sequencer-fee-underpriced', transactionHash: entry.hash, headHash: head.hash, headNumber: head.number,
        baseFeePerGas: hex(base), requiredPriorityFeePerGas: hex(required), requiredMaxFeePerGas: hex(required + base),
        effectivePriorityFeePerGas: hex(tx.maxPriorityFeePerGas), gasUsed: hex(gasUsed), freshSlots: '0x1',
        chargedFreshSlots: '0x1', freshSlotPriceWei: hex(200_000_000_000_000n), scope: 'latest-state-next-block',
      };
      const message = 'transaction underpriced for sequencer policy; use the transaction-specific fee in error.data (inclusion is not guaranteed)';
      if (mode === 'error-fee-data') throw { code: -32000, message, data };
      if (mode === 'error-fee-data-lost') throw { code: -32603, message: `Internal JSON-RPC error. ${message}` };
      throw { code: -32603, message: 'Internal JSON-RPC error.' };
    }
    await broadcast(entry);
    // Published, but the reply to the page is lost.
    if (mode === 'broadcast-reply-lost') throw { code: -32603, message: 'Request expired. Please try again.' };
    return entry.hash;
  }

  return {
    address,
    state,
    requests,
    signed,
    open,
    sends: () => requests.filter((r) => r.method === 'eth_sendTransaction'),
    async handle(method, params) {
      requests.push({ method, params });
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address];
      if (method === 'eth_chainId') return state.chainId;
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') {
        state.chainId = params[0].chainId;
        return null;
      }
      if (method === 'eth_sendTransaction') return sendTransaction(params[0]);
      throw { code: 4200, message: `the harness wallet does not implement ${method}` };
    },
    /** The wallet finally publishes a transaction it held. */
    release: (entry) => broadcast(entry),
    /** "Speed up": the same call at the same nonce with higher fees; a different hash. */
    async speedUp(entry, { publish = true } = {}) {
      const next = await sign({ ...entry.tx, maxFeePerGas: entry.tx.maxFeePerGas * 2n, maxPriorityFeePerGas: entry.tx.maxPriorityFeePerGas * 2n }, 'speed-up');
      entry.replaced = true;
      if (publish) await broadcast(next);
      return next;
    },
    /** "Cancel": a zero-value transfer to the account itself at the same nonce with higher fees. */
    async cancel(entry) {
      const next = await sign({ nonce: entry.tx.nonce, to: account.address, data: '0x', value: 0n, gas: 21_000n, maxFeePerGas: entry.tx.maxFeePerGas * 2n, maxPriorityFeePerGas: entry.tx.maxPriorityFeePerGas * 2n }, 'cancel');
      entry.replaced = true;
      await broadcast(next);
      return next;
    },
    /** Any other transaction the user sends from the wallet itself (here: 1 wei to a fixed address). */
    async sendOwn(nonce) {
      const entry = await sign({ nonce: Number(nonce ?? (await ownNonce())), to: `0x${'5e'.repeat(20)}`, data: '0x', value: 1n, gas: 21_000n, ...state.fees }, 'wallet');
      await broadcast(entry);
      return entry;
    },
    decode: (raw) => parseTransaction(raw),
  };
}
