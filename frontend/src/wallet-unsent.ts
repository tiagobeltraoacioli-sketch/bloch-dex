// A refusal raised in the page before anything was handed to a wallet. The page's transaction path saves its
// intent before it calls the wallet, and treats every error that is not a user rejection as "outcome unknown",
// because an injected wallet may have signed. A provider implemented in this page (the multichain site's
// mobile-wallet session) can know more: when it refuses a request itself, before the relay is called, nothing
// left the page. It marks that error here, and the route releases the intent it had saved.
//
// The mark is held in this module (a WeakSet), not on the error: a wallet, an extension or a relay cannot put it
// on an error of its own, so the "outcome unknown" rule is as strict as before for everything that comes from
// outside the page.
const unsent = new WeakSet<object>();

/** Marks an error as raised before anything was sent. Only for code that can prove it. */
export function notSent<T extends object>(error: T): T {
  unsent.add(error);
  return error;
}

export function wasNotSent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && unsent.has(error);
}
