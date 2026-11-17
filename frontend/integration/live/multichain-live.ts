// The multichain page's own RPC stack against the REAL public endpoints of the six chains, read-only (reviews
// R328-4 and R328-5: loopback forks keep every block's state and cannot show what public endpoints refuse).
// No wallet, no transaction, nothing signed; a few requests per second per chain; a refused request is retried
// after a pause and reported.
//
//   cd frontend && npx vite-node integration/live/multichain-live.ts [-- --hold SECONDS] [--chains key,key] [--out FILE]
//
// Per chain, with `chainHttpRpc(network.rpc.urls, network.confirmation)` exactly as MultichainApp.tsx builds it:
//   snapshot   what the route reads when it takes a snapshot: chain id, block 0, the settle block (the request for
//              `finalized`), then reads pinned to that block's hash, each answered alike by two endpoints: the
//              code of the wrapped token and of Multicall3 against the pins of the network file, the token's
//              symbol(), the fee address's balance and nonce
//   head       what the route reads before it asks a wallet: `latest`, and the nonce pinned to that head's hash
//   strict     what ends a hold without a receipt: the strict block (`rpc.strict`), and the nonce pinned to it
//   aged       the snapshot block kept for --hold seconds (default 75), as a page left open: the same pinned read
//              every 15 s. A refusal here is what the route's renewed snapshot (snapshotMaxAgeMs, 30 s) avoids;
//   renewed    after that, a new snapshot block and the pinned reads again (the page after its next renewal)
// Exit status 0 when snapshot, head, strict and renewed held on every chain ("aged" is reported, not required).
import { readFileSync, writeFileSync } from 'node:fs';
import { keccak256, type Hex } from 'viem';
import { parseChain } from '../../src/multichain/config';
import { chainHttpRpc } from '../../src/multichain/rpc';

const args = process.argv.slice(2);
const option = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const holdSeconds = Number(option('--hold') ?? 75);
const shared = JSON.parse(
  readFileSync(new URL('../../../deployments/multichain.json', import.meta.url), 'utf8'),
) as { chains: string[]; feeTo: { address: string } };
const keys = option('--chains')?.split(',') ?? shared.chains;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (error: unknown) => String((error as Error)?.message ?? error).slice(0, 140);
/** One retry after a pause: a public endpoint's rate limit is not the page's failure. */
async function attempt<T>(
  work: () => Promise<T>,
): Promise<{ value?: T; error?: string; retried: boolean }> {
  try {
    return { value: await work(), retried: false };
  } catch (first) {
    await sleep(4_000);
    try {
      return { value: await work(), retried: true };
    } catch (error) {
      return { error: `${text(first)} | again: ${text(error)}`, retried: true };
    }
  }
}

async function one(key: string) {
  const file = (name: string) =>
    JSON.parse(
      readFileSync(new URL(`../../../deployments/${key}/${name}`, import.meta.url), 'utf8'),
    );
  const network = file('frontend.network.json');
  const chain = parseChain(network, file('frontend.record.json'));
  const rpc = chainHttpRpc(chain.rpcUrls, chain.confirmation);
  const who = shared.feeTo.address;
  const row: Record<string, unknown> = {
    chain: key,
    endpoints: chain.rpcUrls,
    rule: chain.confirmation,
  };
  const block = (r: typeof rpc, tag: string) =>
    r('eth_getBlockByNumber', [tag, false]) as Promise<{
      number: string;
      hash: Hex;
      timestamp: string;
    }>;
  const pinnedReads = async (hash: Hex) => {
    const at = { blockHash: hash };
    const wrapped = (await rpc('eth_getCode', [chain.wrapped.address, at])) as Hex;
    const multicall = (await rpc('eth_getCode', [chain.multicall3.address, at])) as Hex;
    if (keccak256(wrapped) !== chain.wrapped.codeHash)
      throw new Error('the wrapped token code is not the pinned code');
    if (keccak256(multicall) !== chain.multicall3.codeHash)
      throw new Error('the Multicall3 code is not the pinned code');
    await rpc('eth_call', [{ to: chain.tokens[0].address, data: '0x95d89b41' }, at]);
    await rpc('eth_getBalance', [who, at]);
    return Number(BigInt((await rpc('eth_getTransactionCount', [who, at])) as string));
  };
  const snapshot = async () => {
    const id = Number(BigInt((await rpc('eth_chainId', [])) as string));
    if (id !== chain.network.chainId) throw new Error(`chain id ${id}`);
    const genesis = (await rpc('eth_getBlockByNumber', ['0x0', false])) as { hash: string };
    if (genesis.hash !== chain.network.genesisHash) throw new Error('genesis differs');
    const settled = await block(rpc, 'finalized');
    const nonce = await pinnedReads(settled.hash);
    return { settled, nonce };
  };
  const first = await attempt(snapshot);
  row.snapshot =
    first.error ??
    `ok${first.retried ? ' (second try)' : ''}: block ${Number(BigInt(first.value!.settled.number))}`;
  const head = await attempt(async () => {
    const latest = await block(rpc, 'latest');
    await rpc('eth_getTransactionCount', [who, { blockHash: latest.hash, requireCanonical: true }]);
    return latest;
  });
  row.head =
    head.error ??
    `ok${head.retried ? ' (second try)' : ''}: ${Math.round(Date.now() / 1000 - Number(BigInt(head.value!.timestamp)))} s behind this clock`;
  const strict = await attempt(async () => {
    const final = await block(rpc.strict, 'finalized');
    await rpc.strict('eth_getTransactionCount', [
      who,
      { blockHash: final.hash, requireCanonical: true },
    ]);
    return final;
  });
  row.strict =
    strict.error ??
    `ok${strict.retried ? ' (second try)' : ''}: block ${Number(BigInt(strict.value!.number))}, ${Math.round((Date.now() / 1000 - Number(BigInt(strict.value!.timestamp))) / 60)} min old`;
  // What settles a reverted swap (the chain's own rule for it, R328-3P-3), and the comparison quote's shape: an
  // eth_call at the TAG `latest`, which the stack must turn into a read at a hash two endpoints agree on.
  const reverted = await attempt(async () => {
    const final = await block(rpc.reverted, 'finalized');
    await rpc.reverted('eth_getTransactionCount', [
      who,
      { blockHash: final.hash, requireCanonical: true },
    ]);
    return final;
  });
  row.reverted =
    reverted.error ??
    `ok${reverted.retried ? ' (second try)' : ''}: ${Math.round(Date.now() / 1000 - Number(BigInt(reverted.value!.timestamp)))} s old`;
  const byTag = await attempt(async () => {
    await rpc('eth_call', [{ to: chain.tokens[0].address, data: '0x95d89b41' }, 'latest']);
    return Number(BigInt((await rpc('eth_getTransactionCount', [who, 'pending'])) as string));
  });
  row.latestTagRead = byTag.error ?? `ok${byTag.retried ? ' (second try)' : ''}`;
  const aged: string[] = [];
  if (first.value) {
    const started = Date.now();
    while (Date.now() - started < holdSeconds * 1000) {
      await sleep(15_000);
      const seconds = Math.round((Date.now() - started) / 1000);
      const read = await rpc('eth_getBalance', [who, { blockHash: first.value.settled.hash }]).then(
        () => 'ok',
        (error) => text(error),
      );
      aged.push(`${seconds} s: ${read}`);
    }
  }
  row.aged = aged;
  const renewed = await attempt(snapshot);
  row.renewed =
    renewed.error ??
    `ok${renewed.retried ? ' (second try)' : ''}: block ${Number(BigInt(renewed.value!.settled.number))}`;
  row.pass = [first, head, strict, reverted, byTag, renewed].every((r) => r.value !== undefined);
  return row;
}

const rows = await Promise.all(
  keys.map((key) => one(key).catch((error) => ({ chain: key, pass: false, error: text(error) }))),
);
for (const row of rows) console.log(JSON.stringify(row));
const out = option('--out');
if (out)
  writeFileSync(
    out,
    `${JSON.stringify({ at: new Date().toISOString(), holdSeconds, rows }, null, 2)}\n`,
  );
console.log(
  `multichain live read-only check: ${rows.every((r) => r.pass) ? 'PASS' : 'FAIL'} (${rows.filter((r) => r.pass).length} of ${rows.length} chains)`,
);
process.exit(rows.every((r) => r.pass) ? 0 : 1);
