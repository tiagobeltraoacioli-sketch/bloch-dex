import { useEffect, useState } from 'react';
import { clockText } from './read-failure';

/**
 * Time left to the deadline saved with a tracked swap, counted down by this device's clock, second by second.
 * A display only: the hold itself ends on what the chain settles.
 */
export function DeadlineClock({
  deadline,
  sentAtMs,
  now,
  settled = 'finalized',
}: {
  /** Unix seconds. */
  deadline: bigint;
  sentAtMs: number;
  now: () => number;
  /** The network's word for the block that ends a hold (mainnet/wording.ts). */
  settled?: string;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const end = Number(deadline) * 1000;
  const left = end - now();
  const total = Math.max(1, end - sentAtMs);
  const done = Math.min(100, Math.max(0, ((total - left) / total) * 100));
  const at = new Date(end);
  const wall = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return (
    <span
      className="deadline-clock"
      data-passed={left <= 0 || undefined}
      data-soon={(left > 0 && left <= 5 * 60_000) || undefined}
    >
      <span className="deadline-bar" aria-hidden="true">
        <span style={{ width: `${done}%` }} />
      </span>
      <span className="deadline-text">
        {left > 0 ? (
          <>
            Saved deadline in{' '}
            <time className="clock-figure" dateTime={at.toISOString()} data-testid="deadline-left">
              {clockText(left / 1000)}
            </time>{' '}
            (at {wall}), by this device&apos;s clock.
          </>
        ) : (
          <>
            Saved deadline passed{' '}
            <span className="clock-figure" data-testid="deadline-left">
              {clockText(-left / 1000)}
            </span>{' '}
            ago (at {wall}), by this device&apos;s clock. Unless the swap&apos;s receipt arrives
            first, the page releases the hold by itself once a {settled} block is later than the
            deadline.
          </>
        )}
      </span>
    </span>
  );
}
