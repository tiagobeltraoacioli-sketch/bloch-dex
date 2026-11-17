import { useEffect, useRef, useState } from 'react';
import type { Hex } from 'viem';
import type { Rpc } from '../devnet4/chain';
import { classifyReadFailure } from './read-failure';
import {
  confirmationProgress,
  revertedProgress,
  type ProgressFacts,
  type ProgressRule,
} from './confirmation-progress';

const quantity = (value: unknown): bigint | null =>
  typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value) ? BigInt(value) : null;

/**
 * Under a tracked transaction on a public network: where it stands against the network's confirmation rule.
 * Two plain reads per look (the receipt and a block number or header) through the route's own RPC; a look that fails
 * is said and the next one comes later (twice as late each time, up to a minute). It shows; it decides nothing.
 */
export function ConfirmationProgress({
  rpc,
  hash,
  rule,
  blockSeconds,
  pollMs = 4000,
  reverted,
  now = () => Date.now(),
}: {
  rpc: Rpc;
  hash: Hex;
  rule: ProgressRule;
  blockSeconds: number | null;
  pollMs?: number;
  /** The rule that settles a REVERTED swap on this network (`confirmation.reverted`, else the strict rule). Set for
   * a swap only: a reverted approval is settled like a success. */
  reverted?: ProgressRule;
  now?: () => number;
}) {
  const [facts, setFacts] = useState<ProgressFacts & { failed: boolean }>({
    included: null,
    reference: null,
    failed: false,
  });
  const [trouble, setTrouble] = useState<'' | 'limited' | 'disagree' | 'silent'>('');
  const depth = 'depth' in rule ? rule.depth : null;
  const tag = 'tag' in rule ? rule.tag : null;
  const ruleRef = useRef(rule);
  ruleRef.current = rule;
  const revertedRef = useRef(reverted);
  revertedRef.current = reverted;
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wait = pollMs;
    const look = async () => {
      try {
        const receipt = (await rpc('eth_getTransactionReceipt', [hash])) as {
          blockNumber?: unknown;
          status?: unknown;
        } | null;
        // A reverted swap is counted against the network's rule for a reverted swap (R328-3P-3).
        const failed = receipt?.status === '0x0' && !!revertedRef.current;
        const counted = failed ? revertedRef.current! : ruleRef.current;
        const reference =
          'depth' in counted
            ? quantity(await rpc('eth_blockNumber', []))
            : quantity(
                (
                  (await rpc('eth_getBlockByNumber', [counted.tag, false])) as {
                    number?: unknown;
                  } | null
                )?.number,
              );
        if (!live) return;
        setFacts({ included: quantity(receipt?.blockNumber), reference, failed });
        setTrouble('');
        wait = pollMs;
      } catch (error) {
        if (!live) return;
        const text = error instanceof Error ? error.message : '';
        const kind = classifyReadFailure(text).kind;
        setTrouble(
          kind === 'rate-limited' ? 'limited' : kind === 'disagreement' ? 'disagree' : 'silent',
        );
        wait = Math.min(wait * 2, 60_000);
      }
      if (live) timer = setTimeout(() => void look(), wait);
    };
    void look();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [rpc, hash, depth, tag, pollMs]);
  const progress =
    facts.failed && reverted && facts.included !== null
      ? revertedProgress(
          reverted,
          blockSeconds,
          { included: facts.included, reference: facts.reference },
          now(),
        )
      : confirmationProgress(rule, blockSeconds, facts);
  return (
    <span
      className="confirm-progress"
      data-phase={progress.phase}
      data-testid="confirmation-progress"
    >
      <span className="confirm-head">{progress.headline}</span>
      <span
        className="confirm-bar"
        role="progressbar"
        aria-label="Confirmations"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
      >
        <span style={{ width: `${progress.percent}%` }} />
      </span>
      <span className="confirm-detail">{progress.detail}</span>
      {trouble && (
        <span className="confirm-trouble" role="status">
          {trouble === 'limited'
            ? 'The endpoint is limiting requests, so this count is behind; the page looks again less often for a while. Your transaction is not affected.'
            : trouble === 'disagree'
              ? 'The endpoints give different answers about this transaction, so the count is not shown as current; the page keeps looking, and the hold stays.'
              : 'The endpoint did not answer, so this count is behind; the page keeps looking.'}
        </span>
      )}
      <span className="confirm-foot">
        A count shown for orientation. The hold ends only when the page has verified the receipt
        itself.
      </span>
    </span>
  );
}
