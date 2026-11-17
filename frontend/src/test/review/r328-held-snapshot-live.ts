// Review r17 (agent 328), read-only against the reviewed public endpoints: the route takes one snapshot block
// (MainnetLive.tsx: readSnapshot on load, on Refresh and after a mined transaction; no timer) and pins every later
// read to its hash, the quote included (`{ blockHash: at }`). This asks the page's own RPC stack for a pinned
// read at the settle block at once, and again after the snapshot is 90, 180 and 300 seconds old.
// Run: npx vite-node src/test/review/r328-held-snapshot-live.ts
import { readFileSync } from 'node:fs';
import { chainHttpRpc } from '../../multichain/rpc';

const keys = ['op-mainnet', 'base', 'arbitrum-one', 'linea', 'bnb-smart-chain', 'ethereum'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rows = await Promise.all(
  keys.map(async (key) => {
    const network = JSON.parse(
      readFileSync(new URL(`../../../../deployments/${key}/frontend.network.json`, import.meta.url), 'utf8'),
    );
    const rpc = chainHttpRpc(network.rpc.urls, network.confirmation);
    const row: Record<string, unknown> = { chain: key };
    const started = Date.now();
    let snapshot: { hash: string };
    try {
      snapshot = (await rpc('eth_getBlockByNumber', ['finalized', false])) as { hash: string };
    } catch (error) {
      return { chain: key, snapshot: (error as Error).message };
    }
    const quoteLikeRead = () =>
      rpc('eth_call', [
        { to: network.wrappedNative.address, data: '0x18160ddd' },
        { blockHash: snapshot.hash },
      ]).then(
        () => 'ok',
        (error: Error) => `ERROR: ${error.message}`,
      );
    row['0 s'] = await quoteLikeRead();
    for (const at of [90, 180, 300]) {
      await sleep(Math.max(0, started + at * 1000 - Date.now()));
      row[`${at} s`] = await quoteLikeRead();
    }
    return row;
  }),
);
for (const row of rows) console.log(JSON.stringify(row));
