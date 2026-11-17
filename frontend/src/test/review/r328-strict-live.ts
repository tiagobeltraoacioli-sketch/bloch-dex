// Review r17 (agent 328), read-only against the reviewed public endpoints: the page's own RPC stack
// (multichain/rpc.ts `chainHttpRpc`) asked for the one hash-pinned read that ends a hold without a receipt
// (submission-outcome.ts `expiredSwap`: eth_getTransactionCount at the STRICT block), and for the same read at
// the settle block. Run: npx vite-node src/test/review/r328-strict-live.ts [chain ...]
import { readFileSync } from 'node:fs';
import { chainHttpRpc } from '../../multichain/rpc';

const account = '0x775a993F09Bd80aeCF8F8c2ADe0C84158E3a0544';
const keys = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['op-mainnet', 'base', 'arbitrum-one', 'linea', 'bnb-smart-chain', 'ethereum'];
for (const key of keys) {
  const network = JSON.parse(
    readFileSync(new URL(`../../../../deployments/${key}/frontend.network.json`, import.meta.url), 'utf8'),
  );
  const rpc = chainHttpRpc(network.rpc.urls, network.confirmation);
  const row: Record<string, unknown> = { chain: key, settle: network.confirmation.settle, strict: network.confirmation.strict };
  for (const [name, reader] of [
    ['settle', rpc],
    ['strict', rpc.strict],
  ] as const) {
    const started = Date.now();
    try {
      const head = (await reader('eth_getBlockByNumber', ['latest', false])) as { timestamp: string };
      const block = (await reader('eth_getBlockByNumber', ['finalized', false])) as { hash: string; timestamp: string };
      const age = Number(BigInt(head.timestamp) - BigInt(block.timestamp));
      const nonce = await reader('eth_getTransactionCount', [account, { blockHash: block.hash, requireCanonical: true }]);
      row[name] = { blockAgeSeconds: age, nonce, ms: Date.now() - started };
    } catch (error) {
      row[name] = { error: (error as Error).message, ms: Date.now() - started };
    }
  }
  console.log(JSON.stringify(row));
}
