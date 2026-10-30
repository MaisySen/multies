/*
 * R41 (MB-199 CPU): small per isolate copies for signed in READ routes. The free plan stops a Worker at 10 ms of CPU
 * and each D1 query costs about 1 to 2 ms of it, so values that change rarely and are read on most page loads (a
 * person's preferences, their mail tabs) are kept here for a few seconds. Any write through the API by that person
 * drops their copies in this isolate (app.ts), and a write with no session drops every copy, so the person who
 * changed something sees it at once and everyone else within the TTL. Memory only: never a D1 write, nothing shared
 * across isolates.
 */
const registry = new Set<IsolateCache<unknown>>();

export class IsolateCache<V> {
  private map = new Map<string, { until: number; v: V }>();
  constructor(private ttlMs: number, private max = 2_000) { registry.add(this as IsolateCache<unknown>); }
  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.until > Date.now()) return hit.v;
    this.map.delete(key);
    return undefined;
  }
  set(key: string, v: V) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value as string);
    this.map.set(key, { until: Date.now() + this.ttlMs, v });
  }
  async getOr(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const v = await load();
    this.set(key, v);
    return v;
  }
  /** Drops every key that starts with `prefix` (keys are "<userId>:..."). */
  forgetPrefix(prefix: string) { for (const k of this.map.keys()) if (k.startsWith(prefix)) this.map.delete(k); }
  clear() { this.map.clear(); }
}

/** Drops one person's copies in every per isolate cache (all copies when no person is known). */
export function forgetUserCaches(userId?: string | null) {
  for (const c of registry) { if (userId) c.forgetPrefix(`${userId}:`); else c.clear(); }
}
