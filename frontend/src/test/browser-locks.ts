// A FIFO model for jsdom. Actual browser Web Locks remain a separate integration check.
export function browserLocksForTest() {
  const tails = new Map<string, Promise<void>>();
  return {
    request<T>(name: string, _options: LockOptions, action: () => T | Promise<T>): Promise<T> {
      const result = (tails.get(name) ?? Promise.resolve()).then(action);
      tails.set(
        name,
        result.then(
          () => {},
          () => {},
        ),
      );
      return result;
    },
  };
}
