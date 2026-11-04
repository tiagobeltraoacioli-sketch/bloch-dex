// A FIFO model for jsdom. Actual browser Web Locks remain a separate integration check.
export function browserLocksForTest() {
  const tails = new Map<string, Promise<void>>();
  const pending = new Map<string, number>();
  return {
    request<T>(
      name: string,
      options: LockOptions,
      action: (lock: Lock | null) => T | Promise<T>,
    ): Promise<T> {
      if (options.ifAvailable && pending.has(name))
        return Promise.resolve().then(() => action(null));
      pending.set(name, (pending.get(name) ?? 0) + 1);
      const done = () => {
        const count = pending.get(name)! - 1;
        if (count) pending.set(name, count);
        else pending.delete(name);
      };
      const result = (tails.get(name) ?? Promise.resolve()).then(() =>
        action({ name, mode: 'exclusive' } as Lock),
      );
      tails.set(name, result.then(done, done));
      return result;
    },
  };
}
