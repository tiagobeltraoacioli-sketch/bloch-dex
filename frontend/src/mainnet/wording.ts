// The few words of the mainnet route that name the chain. The defaults are the Bloch L2's and are never changed
// by the Bloch L2 site: its bundle does not contain the code that calls `setWording`. The multichain site
// (src/multichain) sets them for the selected public chain before it renders the route.
export type Wording = {
  /** "Your wallet is no longer on the … network." */
  network: string;
  /** Badge and heading. */
  title: string;
  /** "The DEX is not deployed on … yet." */
  where: string;
  /** "finalized …", "latest …", "next …". */
  block: string;
  /** "… looks stalled", "… is unavailable". */
  finality: string;
  /** Label of the pinned genesis hash. */
  genesis: string;
  /** The native coin's symbol in the swap form. */
  native: string;
  /** The end of the heading paragraph. */
  launch: string;
  /** In the same-nonce review text: when the page suggests a fee. */
  feeSuggestion: string;
  /** Subject of "… makes a block at least every …". */
  chain: string;
  /**
   * What a latest block older than one block interval means: `idle-l2`, the Bloch L2 waiting for work (the swap
   * lands in the second block, the deadline is raised); `stale-rpc`, a chain that never waits for work, so the
   * RPC is behind (the user is told, the deadline is not changed).
   */
  quiet: 'idle-l2' | 'stale-rpc';
};
export const BLOCH_L2_WORDING: Readonly<Wording> = Object.freeze({
  network: 'Bloch L2',
  title: 'Bloch L2 mainnet',
  where: 'the Bloch L2 mainnet',
  block: 'L2 block',
  finality: 'L2 finality',
  genesis: 'L2 genesis',
  native: 'BLCH',
  launch: 'Pools have fixed reserve caps; this is a guarded launch.',
  feeSuggestion:
    "The page suggests a priority fee only when the call creates new storage slots on the L2, from its own simulation and never from an error's figures; you can adjust fees in the wallet.",
  chain: 'The L2',
  quiet: 'idle-l2',
});
export const wording: Wording = { ...BLOCH_L2_WORDING };
export function setWording(next: Wording): void {
  Object.assign(wording, next);
}
