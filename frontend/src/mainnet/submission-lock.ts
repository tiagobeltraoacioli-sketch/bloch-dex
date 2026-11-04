// localStorage read/write pairs are not atomic between tabs. All journal
// mutations use this origin-scoped lock; an unavailable lock prevents sending.
export async function withSubmissionLock<T>(key: string, action: () => T | Promise<T>): Promise<T> {
  if (!navigator.locks?.request)
    throw new Error(
      'This browser cannot safely coordinate wallet submissions across tabs. Nothing was sent. Use a browser with Web Locks available.',
    );
  return navigator.locks.request(`postern.submission.${key}`, { mode: 'exclusive' }, action);
}

/** Keep the wallet interaction exclusive until its promise settles. A click
 * while another wallet is open is refused, never queued for a later send. */
export async function withWalletRequestLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  if (!navigator.locks?.request)
    throw new Error(
      'This browser cannot safely coordinate wallet submissions across tabs. Nothing was sent. Use a browser with Web Locks available.',
    );
  return navigator.locks.request(
    `postern.wallet-request.${key}`,
    { mode: 'exclusive', ifAvailable: true },
    (lock) => {
      if (!lock)
        throw new Error(
          'Another wallet request is still open for this account. Finish it before reviewing the same nonce. Nothing was queued.',
        );
      return action();
    },
  );
}
