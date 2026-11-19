// The tracked transaction of this account, as the route's one tracker holds it (mainnet/pendingswap.ts), shown on
// the Pools and Portfolio screens and in the liquidity dialog. It reads the tracker and decides nothing: the
// hold, its end and the recovery controls are the tracker's and stay with the Activity list of the Trade screen.
// For a deposit or removal that reverted it adds the reason, inferred from the chain (mainnet/liquidity.ts).
import { useEffect, useState } from 'react';
import type { Address, Hex } from 'viem';
import type { LivePool, Rpc } from '../devnet4/chain';
import type { DevnetDeployment } from '../devnet4/record';
import { explainLiquidityRevert, liquidityRevertText } from '../mainnet/liquidity';
import type { usePendingSwap } from '../mainnet/pendingswap';
import { holdsUntilDeadline } from '../mainnet/submission-outcome';
import { worded, wording } from '../mainnet/wording';
import { ConfirmationProgress } from '../ui/ConfirmationProgress';
import type { ProgressRule } from '../ui/confirmation-progress';
import { CopyButton } from '../ui/CopyButton';
import { DeadlineClock } from '../ui/DeadlineClock';

export type ConfirmationFacts = {
  rule: ProgressRule;
  blockSeconds: number | null;
  reverted?: ProgressRule;
};

export function TrackedStatus({
  pendingSwap,
  rpc,
  deployment,
  pools,
  sideName,
  confirmation,
  receiptPollMs,
  now,
  onActivity,
}: {
  pendingSwap: ReturnType<typeof usePendingSwap>;
  rpc: Rpc;
  deployment: DevnetDeployment;
  pools: LivePool[];
  /** The name the page shows for a pool side (the native coin for the wrapped token). */
  sideName: (pool: LivePool, side: 0 | 1) => string;
  confirmation?: ConfirmationFacts;
  receiptPollMs?: number;
  now: () => number;
  /** Opens the Trade screen's Activity list, where the recovery controls are. */
  onActivity: () => void;
}) {
  const tracked = pendingSwap.tracked;
  const [why, setWhy] = useState<{ id: string; text: string } | null>(null);
  const failedLiquidity =
    tracked?.state === 'failed' && tracked.intent?.kind === 'liquidity' ? tracked : null;
  const intentId = failedLiquidity?.intent?.id ?? null;
  const block = failedLiquidity?.receiptBlock ?? null;
  useEffect(() => {
    if (!failedLiquidity?.intent || block === null) return;
    let current = true;
    const { intent } = failedLiquidity;
    void explainLiquidityRevert(
      rpc,
      deployment,
      pools,
      { data: intent.data as Hex, value: BigInt(intent.value), from: intent.from as Address },
      block,
    ).then((result) => {
      if (!current) return;
      const pool = result.call ? pools.find((p) => p.address === result.call!.pair.address) : null;
      const names = pool
        ? ([sideName(pool, 0), sideName(pool, 1)] as const)
        : (['the first token', 'the second token'] as const);
      setWhy({
        id: intent.id,
        text: liquidityRevertText(result, names, result.call?.action ?? 'add'),
      });
    });
    return () => {
      current = false;
    };
    // One explanation per reverted request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intentId, block === null]);
  if (!tracked && !pendingSwap.storageProblem && !pendingSwap.unreadable) return null;
  const open = tracked?.state === 'pending' || tracked?.state === 'unknown';
  return (
    <div className="live-tracked" role="status" aria-live="polite" aria-label="Tracked transaction">
      {pendingSwap.storageProblem && (
        <p className="form-error">
          {worded(pendingSwap.storageProblem)} No new transaction can be sent.
        </p>
      )}
      {pendingSwap.unreadable && (
        <p className="form-error">
          A saved record of an earlier request of this account cannot be read, so nothing can be
          sent. It is explained under Activity on the Trade screen.
        </p>
      )}
      {tracked && (
        <>
          <p className="live-tracked-line" data-state={tracked.state}>
            <strong>{tracked.label}</strong>: <span className="state-pill">{tracked.state}</span>
          </p>
          {tracked.hash && (
            <p className="hashline">
              <code>{tracked.hash}</code>
              <CopyButton value={tracked.hash} what="transaction hash" />
            </p>
          )}
          <p className="muted">{worded(tracked.detail)}</p>
          {confirmation && tracked.hash && open && (
            <ConfirmationProgress
              rpc={rpc}
              hash={tracked.hash}
              rule={confirmation.rule}
              blockSeconds={confirmation.blockSeconds}
              pollMs={receiptPollMs}
              reverted={
                tracked.intent && holdsUntilDeadline(tracked.intent.kind)
                  ? confirmation.reverted
                  : undefined
              }
              now={now}
            />
          )}
          {tracked.deadline > 0n && open && (
            <DeadlineClock
              deadline={tracked.deadline}
              sentAtMs={tracked.sentAtMs}
              now={now}
              settled={wording.settled}
            />
          )}
          {failedLiquidity && (
            <p className="notice" aria-label="Why it reverted">
              {why && why.id === intentId
                ? worded(why.text)
                : 'Reading from the chain why it reverted…'}
            </p>
          )}
          {open && (
            <p className="microcopy">
              Nothing else can be sent from this account on this network until this one is settled.{' '}
              <button type="button" className="text-link" onClick={onActivity}>
                Tracking and recovery are under Activity on the Trade screen
              </button>
            </p>
          )}
        </>
      )}
    </div>
  );
}
