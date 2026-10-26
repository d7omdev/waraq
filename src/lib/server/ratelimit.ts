const g = globalThis as unknown as { __waraqRate?: Map<string, { count: number; reset: number }> };
const buckets = (g.__waraqRate ??= new Map());

/** Fixed-window limiter. Returns retry-after seconds when blocked, else 0. */
export function hit(key: string, max: number, windowMs: number, now = Date.now()): number {
  if (buckets.size > 10_000) {
    for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
  }
  const b = buckets.get(key);
  if (!b || b.reset <= now) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return 0;
  }
  b.count++;
  if (b.count > max) return Math.ceil((b.reset - now) / 1000);
  return 0;
}

export function resetKey(key: string): void {
  buckets.delete(key);
}
