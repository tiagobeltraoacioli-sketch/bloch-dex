// Reads of a public chain through its reviewed endpoints. Three layers, composed by `chainRpc` at the end of this
// file: `fallbackRpc` (the first endpoint that answers), `agreeingRpc` (reads pinned to a block hash must be equal
// on two endpoints, and the block a tag names is taken from two endpoints), `settledRpc` (the chain's confirmation
// rule in place of `finalized`).
// fallbackRpc: an endpoint that fails (network error, HTTP error, a JSON-RPC error that says the node cannot serve
// the request) is skipped for this request and the next is tried; an execution error (a revert) is the chain's
// answer and is returned as it is. A block asked by number or by hash that an endpoint does not have (`null`) is
// asked of the next one: block 0, which identifies the chain, is not served by every public node (history
// pruning), and a block at the head may not have reached every endpoint yet.
import { ChainError, httpRpc, type Rpc } from '../devnet4/chain';

/** JSON-RPC error codes that are the chain's own answer to a call, not an endpoint's failure. */
const EXECUTION_ERROR_CODES = new Set([3, -32015]);

const isBlockLookup = (method: string, params: unknown[]): boolean =>
  method === 'eth_getBlockByHash' ||
  (method === 'eth_getBlockByNumber' &&
    typeof params[0] === 'string' &&
    /^0x[0-9a-f]+$/i.test(params[0]));

export function fallbackRpc(endpoints: Rpc[]): Rpc {
  if (endpoints.length === 0) throw new Error('no RPC endpoint');
  return async (method, params) => {
    let last: unknown;
    let unknownBlock = false;
    const lookup = isBlockLookup(method, params);
    const wantsGenesis = method === 'eth_getBlockByNumber' && params[0] === '0x0';
    for (const endpoint of endpoints) {
      try {
        const result = await endpoint(method, params);
        if (lookup && result === null) {
          unknownBlock = true;
          if (wantsGenesis) last = new ChainError('chain: this endpoint does not serve block 0');
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
    // No endpoint has the block: that is an answer (`null`), except for block 0, which every chain has.
    if (unknownBlock && !wantsGenesis) return null;
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
export const BEHIND =
  'chain: one RPC endpoint of this network is behind the other. Nothing is shown from it and nothing is sent; try again shortly.';
/** The two heads may be this much chain time apart (block timestamps); measured gaps are a few blocks. */
export const HEAD_GAP_SECONDS = 90n;
export const UNCONFIRMED =
  'chain: a second RPC endpoint could not confirm this read. Nothing is shown from it and nothing is sent; try again shortly.';

/**
 * Review R309-MC-3: on a public chain every endpoint is a third party. Everything the page shows and signs from
 * (reserves, the binding quote, balances, allowances, code hashes, the account nonce) is read at a block hash;
 * such a read is asked of TWO endpoints and used only when both give the same answer. One endpoint alone (a
 * rehearsal file) is used as it is.
 *
 * Which block those reads are pinned to is also taken from two endpoints, so that one endpoint cannot hold the
 * page on a true but old state (the binding quote is compared with the head before the wallet is asked):
 *   `latest`              the OLDER of the two heads, so that it is a block both endpoints have (a read pinned to
 *                         it, or to a block a confirmation depth behind it, is answered by both), and only while
 *                         the two heads are at most HEAD_GAP_SECONDS of chain time apart: an endpoint that lags
 *                         further, or withholds new blocks, makes the page stop (BEHIND) instead of holding it on
 *                         an old state. With one endpoint unreachable the other's head is used; the pinned
 *                         reads then need a further endpoint.
 *   `finalized`, `safe`   the OLDER of the two answers, and both must answer. These tags are a claim about
 *                         finality; one endpoint alone cannot make the page treat a newer block as final.
 * A transaction and its receipt (`eth_getTransactionByHash`, `eth_getTransactionReceipt`) release a hold, so they
 * count only when two endpoints report the same inclusion (and, for a receipt, the same status): until then the
 * answer is `null`, "not known yet", which never ends a hold; two different inclusions are a disagreement
 * (review R328-6: one endpoint's false "reverted" must not free the account for a second swap).
 * Other requests (blocks by number or hash, fee data, the pending nonce) go to the first endpoint that answers,
 * as before: the route re-checks blocks by number and hash itself.
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
  type TagAnswer = { number: bigint; time: bigint; block: unknown } | null;
  const tagged = async (endpoint: Rpc, params: unknown[], tries: number): Promise<TagAnswer> => {
    for (let attempt = 1; ; attempt++) {
      try {
        const block = (await endpoint('eth_getBlockByNumber', params)) as {
          number?: unknown;
          hash?: unknown;
          timestamp?: unknown;
        } | null;
        const number = quantityOf(block?.number);
        if (number !== null && typeof block?.hash === 'string')
          return { number, time: quantityOf(block.timestamp) ?? 0n, block };
      } catch {
        // An endpoint that cannot answer is asked again below.
      }
      if (attempt >= tries) return null;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  };
  const tagBlock = async (params: unknown[]): Promise<unknown> => {
    const newest = params[0] === 'latest';
    // The head: one try each; a finality tag: both must answer.
    const answers = await Promise.all(
      endpoints.slice(0, 2).map((endpoint) => tagged(endpoint, params, newest ? 1 : 3)),
    );
    for (const endpoint of endpoints.slice(2)) {
      if (answers.filter(Boolean).length >= 2) break;
      answers.push(await tagged(endpoint, params, newest ? 1 : 3));
    }
    const given = answers.filter((a): a is NonNullable<TagAnswer> => a !== null);
    if (newest) {
      if (given.length === 0) return fallback('eth_getBlockByNumber', params);
      if (given.length === 1) return given[0].block;
      const [a, b] = given;
      const [older, newer] = a.number <= b.number ? [a, b] : [b, a];
      if (newer.time - older.time > HEAD_GAP_SECONDS) throw new ChainError(BEHIND);
      return older.block;
    }
    if (given.length < 2) throw new ChainError(UNCONFIRMED);
    return given.slice(0, 2).reduce((a, b) => (b.number < a.number ? b : a)).block;
  };
  /** What two endpoints must say alike about a transaction or its receipt. */
  const inclusion = (value: unknown): string | null => {
    if (value === null || typeof value !== 'object') return null;
    const v = value as Record<string, unknown>;
    return JSON.stringify([v.blockHash ?? null, v.blockNumber ?? null, v.status ?? null]);
  };
  const included = async (method: string, params: unknown[]): Promise<unknown> => {
    const one = (endpoint: Rpc) =>
      endpoint(method, params).then(
        (value) => ({ value, key: inclusion(value) }),
        () => null,
      );
    const answers = await Promise.all(endpoints.slice(0, 2).map(one));
    for (const endpoint of endpoints.slice(2)) {
      if (answers.filter((a) => a && a.key !== null).length >= 2) break;
      answers.push(await one(endpoint));
    }
    const known = answers.filter(
      (a): a is { value: unknown; key: string } => a !== null && a.key !== null,
    );
    // Not known to two endpoints yet: unresolved.
    if (known.length < 2) return null;
    if (known[0].key !== known[1].key) throw new ChainError(DISAGREEMENT);
    return known[0].value;
  };
  return async (method, params) => {
    if (
      method === 'eth_getBlockByNumber' &&
      (params[0] === 'latest' || params[0] === 'finalized' || params[0] === 'safe')
    )
      return tagBlock(params);
    if (method === 'eth_getTransactionReceipt' || method === 'eth_getTransactionByHash')
      return included(method, params);
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
