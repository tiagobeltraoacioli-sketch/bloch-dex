// Index of the public chains of the multichain site, read from the reviewed per-chain files
// (deployments/<chain>/frontend.network.json and frontend.record.json, written by
// scripts/multichain/frontend-files.mjs; the order is deployments/multichain.json `chains`).
// Only three fields are imported by name (chain name, chain ID, record status), so a bundle that uses this index
// for its network switcher does not contain the chains' endpoints, tokens or addresses.
import type { PlannedNetwork } from './networks';

const pick = (found: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(found).map(([path, value]) => [path.split('/').slice(-2, -1)[0], value]),
  );
const names = pick(
  import.meta.glob('../../../deployments/*/frontend.network.json', {
    eager: true,
    import: 'chainName',
  }),
);
const ids = pick(
  import.meta.glob('../../../deployments/*/frontend.network.json', {
    eager: true,
    import: 'chainId',
  }),
);
const statuses = pick(
  import.meta.glob('../../../deployments/*/frontend.record.json', {
    eager: true,
    import: 'status',
  }),
);
const order = Object.values(
  import.meta.glob('../../../deployments/multichain.json', { eager: true, import: 'chains' }),
)[0] as string[];

export type IndexedChain = { key: string; name: string; chainId: number; recordStatus: string };

export const CHAIN_INDEX: readonly IndexedChain[] = order
  .filter((key) => typeof names[key] === 'string' && Number.isInteger(ids[key]))
  .map((key) => ({
    key,
    name: names[key] as string,
    chainId: ids[key] as number,
    recordStatus: typeof statuses[key] === 'string' ? (statuses[key] as string) : 'unknown',
  }));

/** One line of status for a chain that this page has no route for. */
export const indexedStatus = (chain: IndexedChain) =>
  chain.recordStatus === 'not-deployed' ? 'Not deployed yet' : 'On the multichain site';

export const plannedFromIndex = (): PlannedNetwork[] =>
  CHAIN_INDEX.map((c) => ({
    key: c.key,
    name: c.name,
    chainId: c.chainId,
    status: indexedStatus(c),
  }));
