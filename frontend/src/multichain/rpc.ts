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
  /** The release of a hold by a REVERTED swap's receipt (the user may then retry); absent: the strict rule. */
  reverted?: ConfirmationRule;
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
 * THE RULE OF THIS FILE (reviews R309-MC-3, R328-4 to R328-6, R328-3P-4): on a public chain every endpoint is a
 * third party, and nothing that can become, or bound, what the user signs, and nothing that ends a hold, is ever
 * one endpoint's word. With two or more endpoints listed (one alone, a rehearsal file, is used as it is):
 *
 *   state at a block hash   (`eth_call`, `eth_getCode`, `eth_getBalance`, `eth_getStorageAt`,
 *                           `eth_getTransactionCount` with `{ blockHash }`): asked of two endpoints, used only
 *                           when both give the same answer.
 *   state at a TAG or NUMBER the same methods with `latest`, `finalized`, `safe`, a block number, or no block at
 *                           all: never sent as they are. The block is first resolved by the rules below, and
 *                           the read is then made at its HASH, as above. (At `c462735` such a read went to the
 *                           first endpoint alone, and the route's latest-block comparison quote, which becomes
 *                           the signed quote after "reconfirm", was one.)
 *   `pending` nonce         asked of two endpoints; the HIGHER answer (it only ever makes the page refuse).
 *   the block of a tag      `latest`: among the heads answered, the two newest must be close (at most
 *                           HEAD_GAP_BLOCKS blocks or HEAD_GAP_SECONDS of chain time apart, else BEHIND); the
 *                           OLDER of the two is used, a block both have. `finalized`, `safe`: the OLDER of two
 *                           answers. In each case the other endpoint must report the SAME block (hash and
 *                           timestamp) at that height, so the header, with the time a deadline is counted from,
 *                           is not one endpoint's either. A third endpoint is asked when one of the first two
 *                           fails or lags.
 *   a block by number/hash  two endpoints must report the same hash and timestamp; block 0, which many nodes
 *                           have pruned and which is compared with the pinned genesis, needs one.
 *   a transaction, receipt  two endpoints must report the same inclusion and status; until then `null`, "not
 *                           seen yet", which never ends a hold.
 * Left to the first endpoint that answers: the chain id (compared with the pinned one), fee data and gas
 * estimates (the wallet sets the fee on these chains; the page states its own gas limits).
 * An endpoint that cannot answer (a rate limit, a block it does not have or has pruned) is asked again with a
 * growing pause, then a further listed endpoint stands in; that is UNCONFIRMED, never a disagreement.
 */
export const HEAD_GAP_BLOCKS = 2n;
export function agreeingRpc(endpoints: Rpc[], retryDelayMs = 500): Rpc {
  const fallback = fallbackRpc(endpoints);
  if (endpoints.length < 2) return fallback;
  const pause = (attempt: number) =>
    new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** attempt));
  type Answer = { ok: true; value: string } | { ok: false; reverted: boolean; error: unknown };
  const ask = async (endpoint: Rpc, method: string, params: unknown[]): Promise<Answer> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return { ok: true, value: JSON.stringify(await endpoint(method, params)) };
      } catch (error) {
        if (isExecutionError(error)) return { ok: false, reverted: true, error };
        if (attempt === 2) return { ok: false, reverted: false, error };
        await pause(attempt);
      }
    }
  };
  /** Two endpoints, the same answer; a further endpoint stands in for one that cannot answer. */
  const agreed = async (method: string, params: unknown[]): Promise<unknown> => {
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
  type Header = { number: bigint; time: bigint; hash: string; block: unknown; from: Rpc };
  const header = (block: unknown, from: Rpc): Header | null => {
    const b = block as { number?: unknown; hash?: unknown; timestamp?: unknown } | null;
    const number = quantityOf(b?.number);
    const time = quantityOf(b?.timestamp);
    return number !== null && time !== null && typeof b?.hash === 'string'
      ? { number, time, hash: b.hash, block, from }
      : null;
  };
  const headerOf = async (
    endpoint: Rpc,
    tag: unknown,
    rest: unknown[],
    tries: number,
  ): Promise<Header | null> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const found = header(await endpoint('eth_getBlockByNumber', [tag, ...rest]), endpoint);
        if (found) return found;
      } catch {
        // Asked again below.
      }
      if (attempt + 1 >= tries) return null;
      await pause(attempt);
    }
  };
  /** `chosen` must be the block the other endpoint has at that height. */
  const confirm = async (chosen: Header, other: Header, rest: unknown[]): Promise<unknown> => {
    const same =
      other.number === chosen.number
        ? other
        : await headerOf(other.from, `0x${chosen.number.toString(16)}`, rest, 3);
    if (!same) throw new ChainError(UNCONFIRMED);
    if (same.hash !== chosen.hash || same.time !== chosen.time) throw new ChainError(DISAGREEMENT);
    return chosen.block;
  };
  const tagBlock = async (params: unknown[]): Promise<unknown> => {
    const [tag, ...rest] = params;
    const newest = tag === 'latest';
    const tries = newest ? 2 : 3;
    const answers = await Promise.all(
      endpoints.slice(0, 2).map((endpoint) => headerOf(endpoint, tag, rest, tries)),
    );
    const usable = () => {
      const given = answers
        .filter((a): a is Header => a !== null)
        .sort((a, b) => (a.number < b.number ? 1 : a.number > b.number ? -1 : 0));
      if (given.length < 2) return null;
      const [newer, older] = given;
      // A head far behind the other is a lagging endpoint, not a block to settle on.
      const apart =
        newest &&
        newer.number - older.number > HEAD_GAP_BLOCKS &&
        newer.time - older.time > HEAD_GAP_SECONDS;
      return apart
        ? ('apart' as const)
        : { newer, older: newest ? older : given[given.length - 1] };
    };
    for (const endpoint of endpoints.slice(2)) {
      const now = usable();
      if (now !== null && now !== 'apart') break;
      answers.push(await headerOf(endpoint, tag, rest, tries));
    }
    const pair = usable();
    if (pair === null) throw new ChainError(UNCONFIRMED);
    if (pair === 'apart') throw new ChainError(BEHIND);
    return confirm(pair.older, pair.newer, rest);
  };
  const lookup = async (method: string, params: unknown[]): Promise<unknown> => {
    if (method === 'eth_getBlockByNumber' && params[0] === '0x0') return fallback(method, params);
    const one = async (endpoint: Rpc) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return header(await endpoint(method, params), endpoint);
        } catch {
          await pause(attempt);
        }
      }
      return null;
    };
    const answers = await Promise.all(endpoints.slice(0, 2).map(one));
    for (const endpoint of endpoints.slice(2)) {
      if (answers.filter(Boolean).length >= 2) break;
      answers.push(await one(endpoint));
    }
    const known = answers.filter((a): a is Header => a !== null);
    // A block only one endpoint has is not a block yet.
    if (known.length < 2) return null;
    if (known[0].hash !== known[1].hash || known[0].time !== known[1].time)
      throw new ChainError(DISAGREEMENT);
    return known[0].block;
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
  /** The highest pending nonce two endpoints report: a queued transaction one of them hides still counts. */
  const pendingCount = async (params: unknown[]): Promise<unknown> => {
    const answers = await Promise.all(
      endpoints.slice(0, 2).map((endpoint) => ask(endpoint, 'eth_getTransactionCount', params)),
    );
    for (const endpoint of endpoints.slice(2)) {
      if (answers.filter((a) => a.ok).length >= 2) break;
      answers.push(await ask(endpoint, 'eth_getTransactionCount', params));
    }
    const counts = answers
      .map((a) => (a.ok ? quantityOf(JSON.parse(a.value)) : null))
      .filter((n): n is bigint => n !== null);
    if (counts.length < 2) throw new ChainError(UNCONFIRMED);
    return `0x${counts.reduce((a, b) => (b > a ? b : a)).toString(16)}`;
  };
  return async (method, params) => {
    if (method === 'eth_getBlockByNumber') {
      const tag = params[0];
      if (tag === 'latest' || tag === 'finalized' || tag === 'safe') return tagBlock(params);
      return lookup(method, params);
    }
    if (method === 'eth_getBlockByHash') return lookup(method, params);
    if (method === 'eth_getTransactionReceipt' || method === 'eth_getTransactionByHash')
      return included(method, params);
    if (!PINNED_METHODS.has(method)) return fallback(method, params);
    if (isPinned(method, params)) return agreed(method, params);
    // State by tag, by number, or with no block named: resolved to a block two endpoints agree on, then read at
    // its hash. Never one endpoint's `latest`.
    const arity = method === 'eth_getStorageAt' ? 3 : 2;
    const at = params.length >= arity ? params[arity - 1] : 'latest';
    if (at === 'pending' && method === 'eth_getTransactionCount') return pendingCount(params);
    if (typeof at !== 'string' || at === 'pending' || at === 'earliest')
      throw new ChainError('chain: this read names no block that two endpoints can agree on');
    const block = (
      at === 'latest' || at === 'finalized' || at === 'safe'
        ? await tagBlock([at, false])
        : await lookup('eth_getBlockByNumber', [at, false])
    ) as { hash?: string } | null;
    if (!block?.hash) throw new ChainError(UNCONFIRMED);
    return agreed(method, [...params.slice(0, arity - 1), { blockHash: block.hash }]);
  };
}

/**
 * The route's RPC of one public chain: agreeing endpoints, settled by the chain's rule, with its strict reader
 * and, when the chain states one, the reader that settles a REVERTED swap (review R328-3P-3).
 */
export type ChainRpc = Rpc & { strict: Rpc; reverted: Rpc };
export function chainRpc(endpoints: Rpc[], confirmation: Confirmation = FINALIZED_ONLY): ChainRpc {
  const base = agreeingRpc(endpoints);
  const settled = settledRpc(base, confirmation.settle);
  // A new function object even when the rule is `finalized`, so `strict` is never put on a shared function.
  const rpc: Rpc = (method, params) => settled(method, params);
  const strict = settledRpc(base, confirmation.strict);
  return Object.assign(rpc, {
    strict,
    reverted: confirmation.reverted ? settledRpc(base, confirmation.reverted) : strict,
  });
}
export const chainHttpRpc = (urls: string[], confirmation?: Confirmation): ChainRpc =>
  chainRpc(
    urls.map((url) => httpRpc(url)),
    confirmation,
  );
