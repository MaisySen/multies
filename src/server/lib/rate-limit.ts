/**
 * Fixed-window in-memory limiter. Per process (per isolate on Workers), which is
 * enough to blunt credential stuffing; put a shared store behind this interface
 * when running many instances.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private limit: number, private windowMs: number, private now: () => number = Date.now) {}

  /** Returns true when the call is allowed. */
  take(key: string): boolean {
    const t = this.now();
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      if (this.hits.size > 10_000) this.sweep(t);
      return true;
    }
    cur.count++;
    return cur.count <= this.limit;
  }

  private sweep(t: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}
