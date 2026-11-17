// Review r17 (agent 328), read-only against the reviewed public endpoints: what the route does right before it
// asks the wallet (submission-outcome.ts `submissionBoundary`): the head, then the account nonce PINNED to the
// head's hash, which the page's RPC stack asks of both endpoints. Counts how often that read is confirmed.
// Run: npx vite-node src/test/review/r328-head-live.ts [rounds]
import { readFileSync } from 'node:fs';
import { chainHttpRpc } from '../../multichain/rpc';

const account = '0x775a993F09Bd80aeCF8F8c2ADe0C84158E3a0544';
const rounds = Number(process.argv[2] ?? 10);
const keys = ['op-mainnet', 'base', 'arbitrum-one', 'linea', 'bnb-smart-chain', 'ethereum'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rows = await Promise.all(
  keys.map(async (key) => {
    const network = JSON.parse(
      readFileSync(new URL(`../../../../deployments/${key}/frontend.network.json`, import.meta.url), 'utf8'),
    );
    const rpc = chainHttpRpc(network.rpc.urls, network.confirmation);
    const row = { chain: key, rounds, confirmed: 0, refused: 0, slowestMs: 0, errors: {} as Record<string, number> };
    for (let i = 0; i < rounds; i++) {
      const started = Date.now();
      try {
        const head = (await rpc('eth_getBlockByNumber', ['latest', false])) as { hash: string };
        await rpc('eth_getTransactionCount', [account, { blockHash: head.hash, requireCanonical: true }]);
        row.confirmed++;
      } catch (error) {
        row.refused++;
        const text = (error as Error).message.slice(0, 60);
        row.errors[text] = (row.errors[text] ?? 0) + 1;
      }
      row.slowestMs = Math.max(row.slowestMs, Date.now() - started);
      await sleep(2500);
    }
    return row;
  }),
);
for (const row of rows) console.log(JSON.stringify(row));
