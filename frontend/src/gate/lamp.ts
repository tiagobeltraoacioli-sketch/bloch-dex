/**
 * The lamp over the gate is the page's state light. This file only names the state from facts the swap card
 * already has; it decides nothing and nothing reads it back. The stylesheet (styles/gate.css) turns the name
 * into light: dim, kindling, lit, a slow pulse, a settled glow, an amber or red cast.
 */
export type LampState = 'idle' | 'kindling' | 'lit' | 'pending' | 'settled' | 'warn' | 'danger';

export type LampFacts = {
  /** A quote is being read. */
  quoting: boolean;
  hasQuote: boolean;
  /** A wallet request of the card is in flight. */
  busy: boolean;
  /** A swap is held until its outcome is known. */
  holdOpen: boolean;
  /** State of the tracked swap, if any (mainnet/pendingswap.ts). */
  tracked?: string;
  /** State of the last step in the card's own list (approvals, refused requests). */
  lastStep?: string;
  /** Something on the card says the swap is refused or would revert. */
  refused: boolean;
  /** Something on the card asks for the user's attention before sending (not a refusal). */
  caution: boolean;
};

export function lampState(f: LampFacts): LampState {
  if (f.tracked === 'failed') return f.quoting ? 'kindling' : f.hasQuote ? 'lit' : 'danger';
  if (f.tracked === 'unknown' || f.tracked === 'expired' || f.tracked === 'replaced')
    return f.holdOpen ? 'warn' : f.quoting ? 'kindling' : f.hasQuote ? 'lit' : 'warn';
  if (f.holdOpen || f.tracked === 'pending' || f.busy) return 'pending';
  if (f.refused) return 'danger';
  if (f.quoting) return 'kindling';
  if (f.caution) return 'warn';
  if (f.hasQuote) return 'lit';
  if (f.lastStep === 'failed' || f.lastStep === 'unknown') return 'danger';
  if (f.tracked === 'mined' || f.lastStep === 'mined') return 'settled';
  return 'idle';
}
