// How far a sent transaction is from the block this page settles at, in words. A display only: the numbers come
// from one endpoint's block header and receipt; the hold ends on the tracker's own verified receipt
// (mainnet/pendingswap.ts), never on this.

export type ProgressRule = { depth: number } | { tag: 'finalized' | 'safe' };
export type ProgressFacts = {
  /** Block of the transaction's receipt, or null while no endpoint shows one. */
  included: bigint | null;
  /** Depth rule: the head block. Tag rule: the chain's block of that tag. */
  reference: bigint | null;
};
export type Progress = {
  phase: 'unseen' | 'counting' | 'reached';
  /** Share of the way, 0 to 100, for the bar. */
  percent: number;
  headline: string;
  detail: string;
};

const blocks = (n: number | bigint) =>
  BigInt(n) === 1n ? '1 block' : `${n.toLocaleString('en-US')} blocks`;
const span = (seconds: number): string =>
  seconds < 90
    ? `about ${Math.max(1, Math.round(seconds))} s`
    : `about ${Math.round(seconds / 60)} min`;

export function confirmationProgress(
  rule: ProgressRule,
  blockSeconds: number | null,
  facts: ProgressFacts,
): Progress {
  const goal =
    'depth' in rule
      ? `${blocks(rule.depth)} on top of its block`
      : `the chain's own ${rule.tag} block to reach its block`;
  if (facts.included === null || facts.reference === null)
    return {
      phase: 'unseen',
      percent: 0,
      headline: 'Not in a block yet',
      detail: `Once it is in a block, this page waits for ${goal}.`,
    };
  if ('depth' in rule) {
    const have = facts.reference > facts.included ? Number(facts.reference - facts.included) : 0;
    const shown = Math.min(have, rule.depth);
    if (have >= rule.depth)
      return {
        phase: 'reached',
        percent: 100,
        headline: `In block ${facts.included}: ${shown} of ${rule.depth} confirmations`,
        detail: 'Depth reached. The page is checking the receipt before it releases the hold.',
      };
    const left = rule.depth - have;
    return {
      phase: 'counting',
      percent: Math.round((have / rule.depth) * 100),
      headline: `In block ${facts.included}: ${shown} of ${rule.depth} confirmations`,
      detail: `${blocks(left)} to go${blockSeconds ? `, ${span(left * blockSeconds)} at this network's block time` : ''}.`,
    };
  }
  if (facts.reference >= facts.included)
    return {
      phase: 'reached',
      percent: 100,
      headline: `In block ${facts.included}: the chain's ${rule.tag} block has reached it`,
      detail: 'The page is checking the receipt before it releases the hold.',
    };
  const behind = facts.included - facts.reference;
  return {
    phase: 'counting',
    percent: 0,
    headline: `In block ${facts.included}: waiting for the chain's ${rule.tag} block`,
    detail: `The chain's ${rule.tag} block is ${blocks(behind)} behind it${blockSeconds ? ` (${span(Number(behind) * blockSeconds)} of blocks; the chain decides when it moves)` : ''}.`,
  };
}
