import { useEffect, useState } from 'react';

/**
 * Time left to the deadline saved with a tracked swap, by this device's clock.
 * A display only: the hold itself ends on what the chain finalizes.
 */
export function DeadlineClock({
  deadline,
  sentAtMs,
  now,
}: {
  /** Unix seconds. */
  deadline: bigint;
  sentAtMs: number;
  now: () => number;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((t) => t + 1), 15_000);
    return () => clearInterval(timer);
  }, []);
  const end = Number(deadline) * 1000;
  const left = end - now();
  const total = Math.max(1, end - sentAtMs);
  const done = Math.min(100, Math.max(0, ((total - left) / total) * 100));
  const minutes = Math.ceil(left / 60_000);
  return (
    <span className="deadline-clock" data-passed={left <= 0 || undefined}>
      <span className="deadline-bar" aria-hidden="true">
        <span style={{ width: `${done}%` }} />
      </span>
      <span className="deadline-text">
        {left > 0
          ? `Saved deadline in about ${minutes} min, by this device's clock.`
          : "Saved deadline passed, by this device's clock."}
      </span>
    </span>
  );
}
