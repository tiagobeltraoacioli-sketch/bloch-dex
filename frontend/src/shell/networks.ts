/**
 * Presentation data of the network switcher: names, public chain IDs and the
 * lamp key of each network (colours in styles/tokens.css). It configures
 * nothing: what a route reads and sends comes from the reviewed deployment
 * files, never from this list.
 */
export type NetworkKey =
  | 'bloch-l2'
  | 'ethereum'
  | 'linea'
  | 'arbitrum-one'
  | 'bnb-smart-chain'
  | 'base'
  | 'op-mainnet'
  | 'devnet4'
  | 'preview';

export type NetworkEntry = {
  key: NetworkKey;
  name: string;
  /** One or two letters shown in the lamp tile; no third-party logo is bundled. */
  glyph: string;
  chainId?: number;
  /** Where selecting it leads; absent while no deployment is published for it. */
  href?: string;
  /** One short line of status, from data the page really has. */
  status: string;
  state: 'available' | 'unavailable';
};

/** The EVM networks the DEX is planned on, in display order; none has a published deployment in this tree. */
export const PLANNED_NETWORKS: readonly Omit<NetworkEntry, 'href' | 'status' | 'state'>[] = [
  { key: 'ethereum', name: 'Ethereum', glyph: 'E', chainId: 1 },
  { key: 'linea', name: 'Linea', glyph: 'L', chainId: 59144 },
  { key: 'arbitrum-one', name: 'Arbitrum One', glyph: 'A', chainId: 42161 },
  { key: 'bnb-smart-chain', name: 'BNB Smart Chain', glyph: 'BN', chainId: 56 },
  { key: 'base', name: 'Base', glyph: 'Ba', chainId: 8453 },
  { key: 'op-mainnet', name: 'OP Mainnet', glyph: 'OP', chainId: 10 },
];

export function networkEntries(options: {
  blochChainId: number;
  blochRpcLive: boolean;
  devnet4: boolean;
}): NetworkEntry[] {
  return [
    {
      key: 'bloch-l2',
      name: 'Bloch L2',
      glyph: 'B',
      chainId: options.blochChainId,
      href: '#/mainnet',
      status: options.blochRpcLive ? 'Guarded launch' : 'Not yet live',
      state: 'available',
    },
    ...PLANNED_NETWORKS.map((n) => ({
      ...n,
      status: 'No deployment published',
      state: 'unavailable' as const,
    })),
    ...(options.devnet4
      ? [
          {
            key: 'devnet4' as const,
            name: 'Bloch L2 devnet4',
            glyph: 'D4',
            chainId: 700771,
            href: '#/devnet4',
            status: 'Zero value',
            state: 'available' as const,
          },
        ]
      : []),
    {
      key: 'preview',
      name: 'Preview',
      glyph: 'P',
      href: '#/trade',
      status: 'Sample data, no network',
      state: 'available',
    },
  ];
}
