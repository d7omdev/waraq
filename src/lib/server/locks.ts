/** Per-key async mutex (promise chain). Shared across module instances via globalThis. */
const g = globalThis as unknown as { __waraqLocks?: Map<string, Promise<unknown>> };
const locks = (g.__waraqLocks ??= new Map());

export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chained = prev.catch(() => undefined).then(() => mine);
  locks.set(key, chained);
  try {
    await prev.catch(() => undefined);
    return await fn();
  } finally {
    release();
    if (locks.get(key) === chained) locks.delete(key);
  }
}

export const withDocLock = <T>(id: string, fn: () => Promise<T>) => withLock(`doc:${id}`, fn);
