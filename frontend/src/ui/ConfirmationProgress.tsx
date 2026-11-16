import { useEffect, useRef, useState } from 'react';
import type { Hex } from 'viem';
import type { Rpc } from '../devnet4/chain';
import { classifyReadFailure } from './read-failure';
import {
  confirmationProgress,
  type ProgressFacts,
  type ProgressRule,
} from './confirmation-progress';

const quantity = (value: unknown): bigint | null =>
  typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value) ? BigInt(value) : null;

/**
 * Under a tracked transaction on a public network: where it stands against the network's confirmation rule.
 * Two plain reads per look (the receipt and a block header), from whichever endpoint answers; a look that fails
 * is said and the next one comes later (twice as late each time, up to a minute). It shows; it decides nothing.
 */
export function ConfirmationProgress({
  rpc,
  hash,
  rule,
  blockSeconds,
  pollMs = 4000,
}: {
  rpc: Rpc;
  hash: Hex;
  rule: ProgressRule;
  blockSeconds: number | null;
  pollMs?: number;
}) {
  const [facts, setFacts] = useState<ProgressFacts>({ included: null, reference: null });
  const [trouble, setTrouble] = useState<'' | 'limited' | 'silent'>('');
  const depth = 'depth' in rule ? rule.depth : null;
  const tag = 'tag' in rule ? rule.tag : null;
  const ruleRef = useRef(rule);
  ruleRef.current = rule;
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wait = pollMs;
    const look = async () => {
      try {
        const receipt = (await rpc('eth_getTransactionReceipt', [hash])) as {
          blockNumber?: unknown;
        } | null;
        const reference =
          'depth' in ruleRef.current
            ? quantity(await rpc('eth_blockNumber', []))
            : quantity(
                (
                  (await rpc('eth_getBlockByNumber', ['finalized', false])) as {
                    number?: unknown;
                  } | null
                )?.number,
              );
        if (!live) return;
        setFacts({ included: quantity(receipt?.blockNumber), reference });
        setTrouble('');
        wait = pollMs;
      } catch (error) {
        if (!live) return;
        const text = error instanceof Error ? error.message : '';
        setTrouble(classifyReadFailure(text).kind === 'rate-limited' ? 'limited' : 'silent');
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
  const progress = confirmationProgress(rule, blockSeconds, facts);
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
            : 'The endpoint did not answer, so this count is behind; the page keeps looking.'}
        </span>
      )}
      <span className="confirm-foot">
        A count from one endpoint, shown for orientation. The hold ends only when the page has
        verified the receipt itself.
      </span>
    </span>
  );
}
