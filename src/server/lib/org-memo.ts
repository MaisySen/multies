/**
 * R25 API speed: a per isolate, short lived memo for read mostly lookups keyed by workspace.
 *
 * - Scoped to one database handle (a WeakMap on deps.db), so tests with their own database and
 *   two workspaces never share entries, and an entry can never cross into another org.
 * - Short TTL: a Worker runs many isolates, and a write in one only clears that isolate's copy.
 *   Others catch up within the TTL. Writers call invalidate() so the isolate that wrote reads its
 *   own write at once.
 * - Holds the loader's promise, so concurrent readers in one request share a single query, and a
 *   failed load is dropped instead of cached.
 * - Only workspace settings style data belongs here (field definitions, statuses). Never sessions,
 *   memberships or anything a permission check reads.
 */
type Entry = { at: number; value: Promise<unknown> };
const stores = new WeakMap<object, Map<string, Entry>>();
const MAX_ENTRIES = 2_000;

let clock: () => number = () => Date.now();
/** Test hook: move the memo's clock. Pass nothing to go back to Date.now. */
export function setMemoClock(fn?: () => number) { clock = fn ?? (() => Date.now()); }

function storeFor(db: object) {
  let s = stores.get(db);
  if (!s) { s = new Map(); stores.set(db, s); }
  return s;
}

export function orgMemo<T>(name: string, ttlMs: number) {
  const key = (orgId: string) => `${name}\u0000${orgId}`;
  return {
    get(db: object, orgId: string, load: () => PromiseLike<T>): Promise<T> {
      const s = storeFor(db);
      const k = key(orgId);
      const hit = s.get(k);
      const now = clock();
      if (hit && now - hit.at < ttlMs) return hit.value as Promise<T>;
      if (s.size >= MAX_ENTRIES) s.clear();
      // Promise.resolve: a query builder is a thenable that runs again on every await; this runs it once.
      const value = Promise.resolve().then(load);
      s.set(k, { at: now, value });
      value.catch(() => { if (s.get(k)?.value === value) s.delete(k); });
      return value;
    },
    invalidate(db: object, orgId: string) { stores.get(db)?.delete(key(orgId)); },
    /** Test hook: is there a live entry for this org? */
    has(db: object, orgId: string) { const e = stores.get(db)?.get(key(orgId)); return !!e && clock() - e.at < ttlMs; },
  };
}
