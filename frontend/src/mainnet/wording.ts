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
  /**
   * The word for the block this page reads and settles at: `finalized` where that is the chain's own finality
   * (the Bloch L2, and a public chain whose rule is its `finalized` tag), `confirmed` where the network file
   * names a confirmation depth or the `safe` tag (src/multichain/config.ts, `parseConfirmation`).
   */
  settled: 'finalized' | 'confirmed';
  /** Subject of "… are unavailable" when the page cannot read the chain. */
  reads: string;
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
  settled: 'finalized',
  reads: 'Mainnet reads',
});
export const wording: Wording = { ...BLOCH_L2_WORDING };
export function setWording(next: Wording): void {
  Object.assign(wording, next);
}

/** `wording.settled` with a capital: "Finalized block 12", "Confirmed block 12". */
export const settledCapital = (): string =>
  wording.settled.charAt(0).toUpperCase() + wording.settled.slice(1);

/**
 * A sentence written by the route's logic modules (hold texts, refusals, receipts), in this network's words. Those
 * modules were written for the Bloch L2 and say "finalized"; on a network that settles on a confirmation depth
 * the page says "confirmed" instead (the network's confirmation note, always on the page, says what that means).
 * With the Bloch L2's words, and on any network whose rule is the chain's own `finalized` block, the text is
 * returned as it is.
 */
export function worded(text: string): string {
  if (wording.settled === 'finalized') return text;
  return text
    .replace(/\bfinalized\b/g, wording.settled)
    .replace(/\bFinalized\b/g, settledCapital())
    .replace(/\bfinality\b/g, 'confirmation')
    .replace(/\bFinality\b/g, 'Confirmation');
}
