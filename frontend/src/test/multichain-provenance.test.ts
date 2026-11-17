// Provenance of everything the multichain page reads (review R328-3P-4): nothing that can become, or bound, a
// signed value, and nothing that ends a hold, may be one endpoint's word. Two guards:
//   1. every JSON-RPC method the route's sources name is classified here; a new, unclassified one fails;
//   2. with one lying endpoint in any position, no classified read ever returns the liar's answer, and no state
//      read ever reaches an endpoint by tag: it is resolved to a block two endpoints agree on and sent by hash.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Rpc } from '../devnet4/chain';
import { agreeingRpc, chainRpc } from '../multichain/rpc';

/** How the RPC stack of a public chain answers each method the page sends. */
const PROVENANCE: Record<string, 'two endpoints' | 'pinned identity' | 'not signed'> = {
  eth_call: 'two endpoints',
  eth_getCode: 'two endpoints',
  eth_getBalance: 'two endpoints',
  eth_getStorageAt: 'two endpoints',
  eth_getTransactionCount: 'two endpoints',
  eth_getBlockByNumber: 'two endpoints',
  eth_getBlockByHash: 'two endpoints',
  eth_getTransactionByHash: 'two endpoints',
  eth_getTransactionReceipt: 'two endpoints',
  // Compared with the chain id pinned in the network file; a false answer stops the page.
  eth_chainId: 'pinned identity',
  // The Bloch L2's new-slot fee only (off on these chains by the network file): the wallet sets the fee here.
  eth_maxPriorityFeePerGas: 'not signed',
  eth_createAccessList: 'not signed',
};
/** Sent to the wallet, not to an endpoint. */
const WALLET = new Set([
  'eth_accounts',
  'eth_requestAccounts',
  'eth_sendTransaction',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
]);

const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const q = (n: number) => `0x${n.toString(16)}`;
const STATE = new Set([
  'eth_call',
  'eth_getCode',
  'eth_getBalance',
  'eth_getStorageAt',
  'eth_getTransactionCount',
]);
const blockParam = (method: string, params: unknown[]) =>
  params[method === 'eth_getStorageAt' ? 2 : 1];

/** An endpoint at head 1,000; `lie` changes every answer it gives in a way the test can recognise. */
function endpoint(lie: boolean) {
  const seen: [string, unknown[]][] = [];
  const rpc = vi.fn<Rpc>(async (method, params) => {
    seen.push([method, params]);
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_getBlockByNumber' || method === 'eth_getBlockByHash') {
      const tag = params[0] as string;
      const n =
        tag === 'latest'
          ? 1_000
          : tag === 'finalized'
            ? 936
            : tag === 'safe'
              ? 968
              : Number(BigInt(tag));
      // The liar reports the right hash with another time (a deadline is counted from the head's time).
      return { number: q(n), hash: h(n), timestamp: q(5_000 + n + (lie ? 777 : 0)) };
    }
    if (method === 'eth_getTransactionReceipt' || method === 'eth_getTransactionByHash')
      return { blockHash: h(990), blockNumber: q(990), status: lie ? '0x0' : '0x1', lie };
    if (method === 'eth_getTransactionCount' && blockParam(method, params) === 'pending')
      return lie ? '0x4' : '0x5'; // the liar hides a queued transaction
    if (STATE.has(method)) {
      const at = blockParam(method, params) as { blockHash?: string } | string | undefined;
      const where = typeof at === 'object' && at ? at.blockHash : `TAG:${String(at)}`;
      return lie ? `LIE:${method}:${where}` : `truth:${method}:${where}`;
    }
    return lie ? 'LIE' : 'truth';
  });
  return { rpc, seen };
}
const isLie = (value: unknown) =>
  JSON.stringify(value ?? null).includes('LIE') ||
  (value as { lie?: boolean } | null)?.lie === true ||
  (value as { timestamp?: string } | null)?.timestamp === q(5_000 + 1_000 + 777) ||
  value === '0x4';

describe("provenance: no read that can feed a signed value or a hold decision is one endpoint's word", () => {
  it('every JSON-RPC method the route names is classified', () => {
    const root = join(__dirname, '..');
    const files = [
      ...['devnet4', 'mainnet', 'multichain'].flatMap((dir) =>
        readdirSync(join(root, dir)).map((f) => join(root, dir, f)),
      ),
      join(root, 'MainnetLive.tsx'),
      join(root, 'MultichainApp.tsx'),
    ].filter((f) => /\.tsx?$/.test(f));
    const named = new Set<string>();
    for (const file of files)
      for (const m of readFileSync(file, 'utf8').matchAll(
        /'((?:eth|net|web3|wallet)_[A-Za-z0-9]+)'/g,
      ))
        named.add(m[1]);
    const unclassified = [...named].filter((m) => !(m in PROVENANCE) && !WALLET.has(m));
    expect(unclassified).toEqual([]);
    expect(named.has('eth_call') && named.has('eth_getTransactionReceipt')).toBe(true);
  });

  const requests: [string, unknown[]][] = [];
  for (const at of [{ blockHash: h(995) }, 'latest', 'finalized', 'safe', q(990), undefined]) {
    const tail = at === undefined ? [] : [at];
    requests.push(['eth_call', [{ to: h(1).slice(0, 42), data: '0x' }, ...tail]]);
    requests.push(['eth_getCode', [h(1).slice(0, 42), ...tail]]);
    requests.push(['eth_getBalance', [h(1).slice(0, 42), ...tail]]);
    requests.push(['eth_getStorageAt', [h(1).slice(0, 42), '0x0', ...tail]]);
    requests.push(['eth_getTransactionCount', [h(1).slice(0, 42), ...tail]]);
  }
  requests.push(['eth_getTransactionCount', [h(1).slice(0, 42), 'pending']]);
  for (const tag of ['latest', 'finalized', 'safe', q(990)])
    requests.push(['eth_getBlockByNumber', [tag, false]]);
  requests.push(['eth_getBlockByHash', [h(990), false]]);
  requests.push(['eth_getTransactionReceipt', [h(3)]]);
  requests.push(['eth_getTransactionByHash', [h(3)]]);

  it('R328-3P-4: with one lying endpoint, first or second or among three, no such read returns its answer', async () => {
    const layouts = [
      [true, false],
      [false, true],
      [true, false, false],
      [false, true, false],
    ];
    for (const layout of layouts) {
      const nodes = layout.map((lie) => endpoint(lie));
      const rpc = agreeingRpc(
        nodes.map((n) => n.rpc),
        0,
      );
      for (const [method, params] of requests) {
        expect(PROVENANCE[method]).toBe('two endpoints');
        const result = await rpc(method, params).then(
          (value) => ({ value }),
          (error: Error) => ({ error: error.message }),
        );
        const where = `${JSON.stringify(layout)} ${method} ${JSON.stringify(params)}`;
        // Either the truth two endpoints agree on, or "not known", or a refusal: never the liar's value.
        if ('value' in result) expect(isLie(result.value), where).toBe(false);
        else expect(result.error, where).toMatch(/^chain: /);
        // With a third, honest endpoint a state read by hash is answered (the liar is outvoted or refused).
      }
      // No endpoint was ever asked for state by tag: the stack resolves the block first and reads by hash.
      for (const node of nodes)
        for (const [method, params] of node.seen)
          if (STATE.has(method)) {
            const at = blockParam(method, params);
            expect(
              (typeof at === 'object' && at !== null) ||
                (at === 'pending' && method === 'eth_getTransactionCount'),
              `${method} reached an endpoint with block ${JSON.stringify(at)}`,
            ).toBe(true);
          }
    }
  });

  it('the comparison quote at `latest` (it becomes the signed quote after "reconfirm") is read at an agreed hash', async () => {
    const [a, b] = [endpoint(false), endpoint(false)];
    const rpc = chainRpc([a.rpc, b.rpc], { settle: { depth: 5 }, strict: { tag: 'finalized' } });
    // What MainnetLive's crossCheck sends: an eth_call at the tag `latest`.
    expect(await rpc('eth_call', [{ to: h(1).slice(0, 42), data: '0x' }, 'latest'])).toBe(
      `truth:eth_call:${h(1_000)}`,
    );
    for (const node of [a, b])
      expect(node.seen.filter(([m]) => m === 'eth_call')).toEqual([
        ['eth_call', [{ to: h(1).slice(0, 42), data: '0x' }, { blockHash: h(1_000) }]],
      ]);
    // The pending nonce: the higher of the two answers (a queued transaction one endpoint hides still counts).
    const [liar, honest] = [endpoint(true), endpoint(false)];
    expect(
      await agreeingRpc([liar.rpc, honest.rpc], 0)('eth_getTransactionCount', [
        h(1).slice(0, 42),
        'pending',
      ]),
    ).toBe('0x5');
  });
});
