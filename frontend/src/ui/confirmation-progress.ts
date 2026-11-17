// How far a sent transaction is from the block this page settles at, in words. A display only: the numbers come
// from the route's RPC (a receipt and a block number or header); the hold ends on the tracker's own verified receipt
// (mainnet/pendingswap.ts), never on this.

export type ProgressRule = { depth: number } | { tag: 'finalized' | 'safe' };
export type ProgressFacts = {
  /** Block of the transaction's receipt, or null while no endpoint shows one. */
  included: bigint | null;
  /** Depth rule: the head block. Tag rule: the chain's block of that tag. */
  reference: bigint | null;
};
export type Progress = {
  phase: 'unseen' | 'counting' | 'reached' | 'reverted';
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
        detail:
          'Depth reached. The page releases the hold once it has verified the receipt itself; that can take longer than this count.',
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
      detail:
        'The page releases the hold once it has verified the receipt itself; that can take longer than this count.',
    };
  const behind = facts.included - facts.reference;
  return {
    phase: 'counting',
    percent: 0,
    headline: `In block ${facts.included}: waiting for the chain's ${rule.tag} block`,
    detail: `The chain's ${rule.tag} block is ${blocks(behind)} behind it${blockSeconds ? ` (${span(Number(behind) * blockSeconds)} of blocks; the chain decides when it moves)` : ''}.`,
  };
}

const clock = (ms: number) => {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
};

/**
 * A swap whose receipt says REVERTED (review R328-3P-3): the page holds the account until the network's rule for a
 * reverted swap (`confirmation.reverted`, else the strict rule) covers the receipt's block, because a second swap
 * sent earlier could execute next to the first if that block were replaced. The time is an estimate (blocks left
 * times the network's block time, by this device's clock); the hold itself ends on the receipt the page verifies.
 * `facts.reference` is the head (depth rule) or the block of the rule's tag.
 */
export function revertedProgress(
  rule: ProgressRule,
  blockSeconds: number | null,
  facts: { included: bigint; reference: bigint | null },
  nowMs: number,
): Progress {
  const goal =
    'depth' in rule
      ? `${blocks(rule.depth)} are on top of block ${facts.included}`
      : `the chain's own ${rule.tag} block has reached block ${facts.included}`;
  const why = `Until ${goal}, that block could still be replaced, and a second swap sent now could execute next to this one; so this page holds this account until then, and only then lets you swap again.`;
  const left =
    facts.reference === null
      ? null
      : 'depth' in rule
        ? BigInt(rule.depth) - (facts.reference > facts.included ? facts.reference - facts.included : 0n)
        : facts.included - facts.reference;
  if (left !== null && left <= 0n)
    return {
      phase: 'reverted',
      percent: 100,
      headline: `Reverted in block ${facts.included}; this account can send again once the page has verified the reverted receipt`,
      detail: `${why} That point is reached: the hold ends as soon as the page has checked the receipt itself.`,
    };
  const percent =
    'depth' in rule && left !== null
      ? Math.round((Number(BigInt(rule.depth) - left) / rule.depth) * 100)
      : 0;
  if (left === null || blockSeconds === null)
    return {
      phase: 'reverted',
      percent,
      headline: `Reverted in block ${facts.included}; this account can send again once ${goal}`,
      detail: why,
    };
  const at = nowMs + Number(left) * blockSeconds * 1000;
  return {
    phase: 'reverted',
    percent,
    headline: `Reverted in block ${facts.included}; this account can send again at about ${clock(at)}`,
    detail: `${why} ${blocks(left)} to go${'tag' in rule ? ` (the ${rule.tag} block moves when the chain decides; this time assumes it keeps pace)` : ''}; the time is an estimate by this device's clock.`,
  };
}
