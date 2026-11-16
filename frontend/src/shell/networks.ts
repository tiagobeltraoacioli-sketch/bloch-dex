/**
 * Network switcher data. Two sources:
 *
 * - `PublishedNetwork`: a network this build has a route for, described by the caller from its reviewed network
 *   file (name, chain ID, where its route is, one line of status). This is the adapter interface: the Bloch L2
 *   site passes its one network; the multichain site passes one entry per bundled chain.
 * - `PLANNED_NETWORKS`: presentation only (names, public chain IDs). A planned network that the caller did not
 *   publish is listed as "No deployment published" and cannot be selected.
 *
 * Nothing here configures what a route reads or sends. Lamp colours are keyed by `key` in styles/tokens.css;
 * the keys are the directory names under deployments/.
 */
export type NetworkKey = string;

export type PublishedNetwork = {
  key: NetworkKey;
  name: string;
  chainId?: number;
  href: string;
  status: string;
};

export type NetworkEntry = {
  key: NetworkKey;
  name: string;
  /** One or two letters shown in the lamp tile; no third-party logo is bundled. */
  glyph: string;
  chainId?: number;
  /** Where selecting it leads; absent while no deployment is published for it. */
  href?: string;
  status: string;
  state: 'available' | 'unavailable';
};

export const PLANNED_NETWORKS: readonly { key: NetworkKey; name: string; chainId: number }[] = [
  { key: 'bloch-l2', name: 'Bloch L2', chainId: 700770 },
  { key: 'ethereum', name: 'Ethereum', chainId: 1 },
  { key: 'linea', name: 'Linea', chainId: 59144 },
  { key: 'arbitrum-one', name: 'Arbitrum One', chainId: 42161 },
  { key: 'bnb-smart-chain', name: 'BNB Smart Chain', chainId: 56 },
  { key: 'base', name: 'Base', chainId: 8453 },
  { key: 'op-mainnet', name: 'OP Mainnet', chainId: 10 },
];

const GLYPHS: Record<string, string> = {
  'bloch-l2': 'B',
  ethereum: 'E',
  linea: 'L',
  'arbitrum-one': 'A',
  'bnb-smart-chain': 'BN',
  base: 'Ba',
  'op-mainnet': 'OP',
  devnet4: 'D4',
  preview: 'P',
};
const glyphOf = (key: string, name: string) => GLYPHS[key] ?? name.slice(0, 2);

/** Published networks first in the planned order, then the planned ones without a deployment, then the rest. */
export function networkEntries(published: readonly PublishedNetwork[]): NetworkEntry[] {
  const byKey = new Map(published.map((n) => [n.key, n]));
  const planned: NetworkEntry[] = PLANNED_NETWORKS.map((p) => {
    const live = byKey.get(p.key);
    return live
      ? { ...live, glyph: glyphOf(live.key, live.name), state: 'available' }
      : {
          ...p,
          glyph: glyphOf(p.key, p.name),
          status: 'No deployment published',
          state: 'unavailable',
        };
  });
  const others: NetworkEntry[] = published
    .filter((n) => !PLANNED_NETWORKS.some((p) => p.key === n.key))
    .map((n) => ({ ...n, glyph: glyphOf(n.key, n.name), state: 'available' }));
  return [...planned, ...others];
}
