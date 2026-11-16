// Reads of a public chain through its reviewed endpoints. Three layers, composed by `chainRpc` at the end of this
// file: `fallbackRpc` (the first endpoint that answers), `agreeingRpc` (reads pinned to a block hash must be equal
// on two endpoints), `settledRpc` (the chain's confirmation rule in place of `finalized`).
// fallbackRpc: An endpoint that fails (network
// error, HTTP error, a JSON-RPC error that says the node cannot serve the request) is skipped for this request and
// the next is tried; an execution error (a revert) is the chain's answer and is returned as it is. Block 0, which
// identifies the chain, is not served by every public node (history pruning): `null` for it also moves on.
import { ChainError, httpRpc, type Rpc } from '../devnet4/chain';

/** JSON-RPC error codes that are the chain's own answer to a call, not an endpoint's failure. */
const EXECUTION_ERROR_CODES = new Set([3, -32015]);

export function fallbackRpc(endpoints: Rpc[]): Rpc {
  if (endpoints.length === 0) throw new Error('no RPC endpoint');
  return async (method, params) => {
    let last: unknown;
    for (const endpoint of endpoints) {
      try {
        const result = await endpoint(method, params);
        const wantsGenesis = method === 'eth_getBlockByNumber' && params[0] === '0x0';
        if (wantsGenesis && result === null) {
          last = new ChainError('chain: this endpoint does not serve block 0');
          continue;
        }
        return result;
      } catch (error) {
        if (error instanceof ChainError && error.code !== undefined) {
          if (EXECUTION_ERROR_CODES.has(error.code) || /execution reverted/i.test(error.message))
            throw error;
        }
        last = error;
      }
    }
    throw last;
  };
}

export const fallbackHttpRpc = (urls: string[]): Rpc =>
  fallbackRpc(urls.map((url) => httpRpc(url)));

/**
 * The confirmation rule of a public chain (network file `confirmation`, review R309-MC-2). The route was built
 * for the Bloch L2, where `finalized` is the natural settlement point; on most public chains `finalized` is 15
 * minutes to hours behind the head. A rule names the block the route treats as settled instead:
 *   { tag: 'finalized' | 'safe' }   the chain's own tag
 *   { depth: N }                    the block N blocks behind the head
 */
export type ConfirmationRule = { tag: 'finalized' | 'safe' } | { depth: number };
export type Confirmation = {
  /** Reads, quotes, and the release of a hold by the saved call's own receipt. */
  settle: ConfirmationRule;
  /** The release of a hold WITHOUT that receipt: the deadline passed, or another transaction used the nonce. */
  strict: ConfirmationRule;
};
export const FINALIZED_ONLY: Confirmation = Object.freeze({
  settle: Object.freeze({ tag: 'finalized' as const }),
  strict: Object.freeze({ tag: 'finalized' as const }),
});

const quantityOf = (value: unknown): bigint | null =>
  typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value) ? BigInt(value) : null;

/**
 * The route asks for its settlement block as `eth_getBlockByNumber('finalized')` and pins every read to that
 * block's hash. This wrapper answers that one request by the chain's rule and passes everything else through, so
 * the route's logic (hash-pinned reads, canonical re-checks, holds, same-nonce review) is the same code on every
 * chain. A depth answer never goes backwards: a lower head (another endpoint answered) returns the last block
 * given, which the route's own canonical check still verifies.
 */
export function settledRpc(rpc: Rpc, rule: ConfirmationRule): Rpc {
  if ('tag' in rule && rule.tag === 'finalized') return rpc;
  let last: { number: bigint; block: unknown } | null = null;
  return async (method, params) => {
    if (method !== 'eth_getBlockByNumber' || params[0] !== 'finalized') return rpc(method, params);
    if ('tag' in rule) return rpc(method, [rule.tag, ...params.slice(1)]);
    const head = (await rpc('eth_getBlockByNumber', ['latest', false])) as { number?: unknown };
    const number = quantityOf(head?.number);
    if (number === null) throw new ChainError('chain: the RPC returned no head block');
    const wanted = number > BigInt(rule.depth) ? number - BigInt(rule.depth) : 0n;
    if (last && wanted < last.number) return last.block;
    const block = (await rpc('eth_getBlockByNumber', [
      `0x${wanted.toString(16)}`,
      ...params.slice(1),
    ])) as { number?: unknown; hash?: unknown } | null;
    if (!block || quantityOf(block.number) !== wanted || typeof block.hash !== 'string')
      throw new ChainError('chain: the RPC did not return the confirmed block');
    last = { number: wanted, block };
    return block;
  };
}

/** Reads whose answer is fixed by a block hash: two honest endpoints give the same bytes. */
const PINNED_METHODS = new Set([
  'eth_call',
  'eth_getCode',
  'eth_getBalance',
  'eth_getStorageAt',
  'eth_getTransactionCount',
]);
const isPinned = (method: string, params: unknown[]): boolean => {
  const at = params[params.length - 1];
  return (
    PINNED_METHODS.has(method) &&
    typeof at === 'object' &&
    at !== null &&
    typeof (at as { blockHash?: unknown }).blockHash === 'string'
  );
};
const isExecutionError = (error: unknown): boolean =>
  error instanceof ChainError &&
  error.code !== undefined &&
  (EXECUTION_ERROR_CODES.has(error.code) || /execution reverted/i.test(error.message));

export const DISAGREEMENT =
  'chain: the two RPC endpoints of this network disagree about the chain. Nothing is shown from it and nothing is sent.';
export const UNCONFIRMED =
  'chain: a second RPC endpoint could not confirm this read. Nothing is shown from it and nothing is sent; try again shortly.';

/**
 * Review R309-MC-3: on a public chain every endpoint is a third party. Everything the page shows and signs from
 * (reserves, the binding quote, balances, allowances, code hashes, the account nonce) is read at a block hash;
 * such a read is asked of TWO endpoints and used only when both give the same answer. One endpoint alone (a
 * rehearsal file) is used as it is. Other requests (block headers, receipts, the latest-block cross-check, fee
 * data) go to the first endpoint that answers, as before: the route re-checks blocks by number and hash itself.
 * A second endpoint that does not know the block yet is asked again (twice, half a second apart); a further
 * endpoint, when the file lists one, stands in for an endpoint that keeps failing.
 */
export function agreeingRpc(endpoints: Rpc[], retryDelayMs = 500): Rpc {
  const fallback = fallbackRpc(endpoints);
  if (endpoints.length < 2) return fallback;
  type Answer = { ok: true; value: string } | { ok: false; reverted: boolean; error: unknown };
  const ask = async (endpoint: Rpc, method: string, params: unknown[]): Promise<Answer> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return { ok: true, value: JSON.stringify(await endpoint(method, params)) };
      } catch (error) {
        if (isExecutionError(error)) return { ok: false, reverted: true, error };
        if (attempt === 2) return { ok: false, reverted: false, error };
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  };
  return async (method, params) => {
    if (!isPinned(method, params)) return fallback(method, params);
    const answers: Answer[] = await Promise.all(
      endpoints.slice(0, 2).map((endpoint) => ask(endpoint, method, params)),
    );
    for (const endpoint of endpoints.slice(2)) {
      if (answers.filter((a) => a.ok || a.reverted).length >= 2) break;
      answers.push(await ask(endpoint, method, params));
    }
    const given = answers.filter((a) => a.ok || a.reverted);
    if (given.length < 2) throw new ChainError(UNCONFIRMED);
    const [a, b] = given;
    if (a.ok && b.ok && a.value === b.value) return JSON.parse(a.value) as unknown;
    if (!a.ok && !b.ok) throw a.error;
    throw new ChainError(DISAGREEMENT);
  };
}

/** The route's RPC of one public chain: agreeing endpoints, settled by the chain's rule, with its strict reader. */
export type ChainRpc = Rpc & { strict: Rpc };
export function chainRpc(endpoints: Rpc[], confirmation: Confirmation = FINALIZED_ONLY): ChainRpc {
  const base = agreeingRpc(endpoints);
  const settled = settledRpc(base, confirmation.settle);
  // A new function object even when the rule is `finalized`, so `strict` is never put on a shared function.
  const rpc: Rpc = (method, params) => settled(method, params);
  return Object.assign(rpc, { strict: settledRpc(base, confirmation.strict) });
}
export const chainHttpRpc = (urls: string[], confirmation?: Confirmation): ChainRpc =>
  chainRpc(
    urls.map((url) => httpRpc(url)),
    confirmation,
  );
