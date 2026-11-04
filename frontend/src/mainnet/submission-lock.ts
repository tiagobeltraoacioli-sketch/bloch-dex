// localStorage read/write pairs are not atomic between tabs. All journal
// mutations use this origin-scoped lock; an unavailable lock prevents sending.
export async function withSubmissionLock<T>(key: string, action: () => T | Promise<T>): Promise<T> {
  if (!navigator.locks?.request)
    throw new Error(
      'This browser cannot safely coordinate wallet submissions across tabs. Nothing was sent. Use a browser with Web Locks available.',
    );
  return navigator.locks.request(`postern.submission.${key}`, { mode: 'exclusive' }, action);
}
