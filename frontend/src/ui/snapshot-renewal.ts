// When the route takes a new snapshot block on a public network (reviews R328-5, R328-3P-2). Every read of the route
// is pinned to the snapshot block's hash and must be answered by two endpoints; public endpoints stop serving an
// old block's state, so the snapshot's age is bounded. This module only decides WHEN; the renewal itself is the
// route's existing Refresh (a new load of the snapshot), and the swap card keeps the user's inputs across it.
//
// Two kinds of renewal:
// - background: at the pace of the bound, but never while the user is typing in the card, reading a quote, waiting
//   on a wallet request, under an open hold, while a failed read counts down its own retry, while a read is in
//   flight, or in a hidden tab. A paused renewal happens at the first check after the pause ends.
// - on demand: before a quote is built, and before a swap is sent from a quote, when the snapshot is older than the
//   bound (renew first, then quote at the new block); once when a pinned quote read is refused as UNCONFIRMED.

/** The user typed in the card this recently: they are mid-entry. */
export const ENTRY_QUIET_MS = 10_000;
/** How often the background renewal looks whether it is due (it renews only when the snapshot is past the bound). */
export const RENEWAL_CHECK_MS = 5_000;

/** Scaled for a short bound (tests use a bound of a few hundred milliseconds); the production values above. */
export const entryQuietMs = (maxAgeMs: number) => Math.min(ENTRY_QUIET_MS, Math.floor(maxAgeMs / 2));
export const renewalCheckMs = (maxAgeMs: number) =>
  Math.max(20, Math.min(RENEWAL_CHECK_MS, Math.floor(maxAgeMs / 8)));

/** A monotonic clock for ages: a change of the device's wall clock must not make an old snapshot look new. Tests
 * replace `renewalClock.now` to move ages without waiting; nothing else writes it. */
export const renewalClock = {
  now: (): number =>
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now(),
};
export const monotonicMs = (): number => renewalClock.now();

export type BackgroundFacts = {
  /** Milliseconds since the snapshot on screen was read. */
  ageMs: number;
  maxAgeMs: number;
  /** Milliseconds since the user last typed or chose in the swap card. */
  sinceEditMs: number;
  quoteOnScreen: boolean;
  walletRequest: boolean;
  holdOpen: boolean;
  /** A failed read is on screen, with its own counted retry. */
  failure: boolean;
  /** A read of the snapshot is already in flight. */
  reading: boolean;
  hidden: boolean;
};

export type RenewalPause =
  | 'not-due'
  | 'reading'
  | 'failure'
  | 'hold'
  | 'wallet-request'
  | 'hidden'
  | 'mid-entry'
  | 'reading-quote';

/** 'renew', or the first reason the background renewal waits. */
export function backgroundRenewal(f: BackgroundFacts): 'renew' | RenewalPause {
  if (f.ageMs < f.maxAgeMs) return 'not-due';
  if (f.reading) return 'reading';
  if (f.failure) return 'failure';
  if (f.holdOpen) return 'hold';
  if (f.walletRequest) return 'wallet-request';
  if (f.hidden) return 'hidden';
  if (f.sinceEditMs < entryQuietMs(f.maxAgeMs)) return 'mid-entry';
  // A quote on screen is never changed under the user's eyes (R344-UI-5 (1)); a quote older than the bound is not
  // sent either: the Swap button renews and quotes again first (`staleAt`).
  if (f.quoteOnScreen) return 'reading-quote';
  return 'renew';
}

/** True when a quote must not be built (or sent) on the snapshot on screen: renew first. */
export const staleAt = (ageMs: number, maxAgeMs: number | undefined): boolean =>
  maxAgeMs !== undefined && ageMs >= maxAgeMs;

/** Why a card was remounted on a newer block on demand; told to the user once, in the new card. */
export type RenewalReason = 'quote' | 'swap' | 'unconfirmed';

const boundWords = (maxAgeMs: number) =>
  maxAgeMs >= 120_000
    ? `${Math.round(maxAgeMs / 60_000)} minutes`
    : `${Math.max(1, Math.round(maxAgeMs / 1000))} seconds`;

export function renewalText(reason: RenewalReason, maxAgeMs: number): string {
  const bound = boundWords(maxAgeMs);
  switch (reason) {
    case 'quote':
      return `The block this page read was more than ${bound} old, so it read a newer block before quoting.`;
    case 'swap':
      return `Nothing was sent: the quote was read at a block more than ${bound} old, so the page read a newer block and quoted again. Check the figures, then press Swap again.`;
    case 'unconfirmed':
      return 'A second endpoint could not confirm the quote at the older block, so the page read a newer block once and quoted again.';
  }
}

/** A quote cannot be read now without renewing, and renewing now would clear what the card holds. */
export function cannotRenewText(why: 'hold' | 'wallet-request', maxAgeMs: number): string {
  const bound = boundWords(maxAgeMs);
  return why === 'hold'
    ? `The block this page read is more than ${bound} old, and it is renewed when the hold ends; no quote is read on it until then.`
    : `The block this page read is more than ${bound} old; get the quote again once the wallet request has ended.`;
}
