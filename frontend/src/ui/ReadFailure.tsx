import { useEffect, useState, type ReactNode } from 'react';
import { CloudOff, GitCompareArrows, Hourglass, RefreshCw, TriangleAlert } from 'lucide-react';
import { clockText, type ReadFailure as Failure } from './read-failure';

const ICON = {
  disagreement: GitCompareArrows,
  unconfirmed: CloudOff,
  'rate-limited': Hourglass,
  unreachable: CloudOff,
  other: TriangleAlert,
} as const;

/**
 * The page could not read the chain. The message (children) is the route's own sentence, in full; around it: what
 * kind of failure it is, what the page does about it, and the one control that reads again. When the page retries
 * by itself the time of the next read is counted down; "Read now" asks at once.
 */
export function ReadFailureBlock({
  failure,
  retryAt,
  now,
  onRetry,
  children,
}: {
  failure: Failure;
  /** Milliseconds (the page's clock) of the next automatic read, or null when the page waits for the user. */
  retryAt: number | null;
  now: () => number;
  onRetry: () => void;
  children: ReactNode;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (retryAt === null) return;
    const timer = setInterval(() => tick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [retryAt]);
  const Icon = ICON[failure.kind];
  return (
    <div
      className="read-failure"
      data-kind={failure.kind}
      role="alert"
      aria-label="Reads unavailable"
    >
      <p className="read-failure-title">
        <Icon size={18} aria-hidden="true" /> {failure.title}
      </p>
      <p className="read-failure-message">{children}</p>
      {failure.advice && <p className="read-failure-advice">{failure.advice}</p>}
      <div className="read-failure-actions">
        {retryAt !== null && (
          <span className="read-failure-countdown" data-testid="read-retry">
            Reading again in{' '}
            <span className="clock-figure">{clockText((retryAt - now()) / 1000)}</span>
          </span>
        )}
        <button type="button" className="button secondary" onClick={onRetry}>
          <RefreshCw size={16} aria-hidden="true" /> {retryAt !== null ? 'Read now' : 'Read again'}
        </button>
      </div>
    </div>
  );
}
