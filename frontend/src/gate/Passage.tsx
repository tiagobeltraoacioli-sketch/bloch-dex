import { GateGlyph } from '../shell/BrandMark';

/**
 * A transaction's passage through the gate, drawn from the state the page already shows in words next to it:
 * asked of the wallet, sent (a hash is known), settled or turned back. Decorative (aria-hidden): the state and
 * every sentence about it stay in the text.
 */
export type PassageStage = 'wallet' | 'sent' | 'settled' | 'failed' | 'unknown';

export function passageStage(state: string, hasHash: boolean): PassageStage {
  if (state === 'mined') return 'settled';
  if (state === 'failed') return 'failed';
  if (state === 'waiting') return 'wallet';
  if (state === 'pending' && hasHash) return 'sent';
  return 'unknown';
}

export function Passage({ stage, settled }: { stage: PassageStage; settled: string }) {
  const reached = stage === 'wallet' ? 0 : stage === 'settled' || stage === 'failed' ? 2 : 1;
  const labels = ['Wallet', 'Sent', settled.slice(0, 1).toUpperCase() + settled.slice(1)];
  return (
    <span className="passage" data-stage={stage} data-reached={reached} aria-hidden="true">
      <span className="passage-track">
        <span className="passage-fill" />
        <span className="passage-mote" />
        {labels.map((label, i) => (
          <span
            key={label}
            className="passage-node"
            data-done={i < reached || stage === 'settled' || undefined}
            data-here={i === reached || undefined}
          >
            {i === 2 && <GateGlyph size={14} />}
          </span>
        ))}
      </span>
      <span className="passage-labels">
        {labels.map((label, i) => (
          <span key={label} data-here={i === reached || undefined}>
            {i === 1 && stage === 'unknown'
              ? 'Not known'
              : i === 2 && stage === 'failed'
                ? 'Reverted'
                : label}
          </span>
        ))}
      </span>
    </span>
  );
}
