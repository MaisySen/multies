/**
 * R33: stored copies of the work lists (My Work, task lists, the mail list) for when the browser is offline.
 *
 * The page keeps the last answer of each list in IndexedDB, NOT in the service worker cache: a URL cache
 * is shared by everyone who signs in on the device, while these copies are keyed by person and workspace
 * ("v1|<user>|<workspace>|<list>"), so another account never reads them. Bounds: the first 200 rows of
 * each list and 5 MB in all (oldest copies go first). Everything is wiped at sign out (clearOfflineData).
 * A copy is read only when the network read fails, and the strip at the top then says
 * "Offline. Showing your last copy from 10:42." (pattern from files/teardowns/rea/linear/offline-push.md).
 */
import { useSyncExternalStore } from "react";
import { ApiError } from "./api";
import { readMeCache } from "./me-cache"; // R45

export const OFFLINE_DB = "multies-offline";
export const OFFLINE_STORE = "lists";
export const MAX_ROWS = 200;
export const MAX_BYTES = 5 * 1024 * 1024;
const VERSION = "v1";

export interface StoredCopy { key: string; at: number; bytes: number; data: unknown }

/** Where copies live. IndexedDB in the browser; tests pass a Map backed store. */
export interface OfflineStore {
  get(key: string): Promise<StoredCopy | undefined>;
  put(copy: StoredCopy): Promise<void>;
  delete(key: string): Promise<void>;
  all(): Promise<StoredCopy[]>;
  clear(): Promise<void>;
}

/** The scope is the signed in person and their current workspace. Null until /account/me answers. */
export interface OfflineScope { userId: string; orgId: string }

export function scopeOf(me: { user?: { id?: string } | null; organization?: { id?: string } | null } | null | undefined): OfflineScope | null {
  const userId = me?.user?.id;
  if (!userId) return null;
  return { userId, orgId: me?.organization?.id ?? "personal" };
}

/** The storage key: one person, one workspace, one list. A different person or workspace gets a different key. */
export function copyKey(scope: OfflineScope, list: string): string {
  const clean = (s: string) => s.replace(/\|/g, "_");
  return `${VERSION}|${clean(scope.userId)}|${clean(scope.orgId)}|${list}`;
}

/** The first MAX_ROWS rows of a list answer: an array, or an object whose array fields are lists. */
export function trimRows<T>(data: T, max = MAX_ROWS): T {
  if (Array.isArray(data)) return data.slice(0, max) as T;
  if (data && typeof data === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) out[k] = Array.isArray(v) ? v.slice(0, max) : v;
    return out as T;
  }
  return data;
}

/** Copies to drop so the total stays under the byte budget, oldest first. The newest copy is never dropped. */
export function evictionsFor(copies: Pick<StoredCopy, "key" | "at" | "bytes">[], maxBytes = MAX_BYTES): string[] {
  const sorted = [...copies].sort((a, b) => b.at - a.at);
  let total = 0;
  const drop: string[] = [];
  sorted.forEach((c, i) => {
    total += c.bytes;
    if (i > 0 && total > maxBytes) drop.push(c.key);
  });
  return drop;
}

/** A read that failed because there is no connection (not a 4xx or 5xx answer). */
export function isOfflineError(e: unknown): boolean {
  if (e instanceof ApiError) return e.status === 0;
  return e instanceof TypeError;
}

// ---------------------------------------------------------------- IndexedDB store

function idbStore(): OfflineStore | null {
  if (typeof indexedDB === "undefined") return null;
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () => (dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(OFFLINE_DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(OFFLINE_STORE, { keyPath: "key" }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbp = null; reject(req.error); };
  }));
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T> => {
    const d = await db();
    return new Promise<T>((resolve, reject) => {
      const tx = d.transaction(OFFLINE_STORE, mode);
      const r = fn(tx.objectStore(OFFLINE_STORE));
      tx.oncomplete = () => resolve((r ? r.result : undefined) as T);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };
  return {
    get: (key) => run<StoredCopy | undefined>("readonly", (s) => s.get(key)),
    put: (copy) => run<void>("readwrite", (s) => { s.put(copy); }),
    delete: (key) => run<void>("readwrite", (s) => { s.delete(key); }),
    all: () => run<StoredCopy[]>("readonly", (s) => s.getAll()),
    clear: () => run<void>("readwrite", (s) => { s.clear(); }),
  };
}

let store: OfflineStore | null | undefined;
function getStore(): OfflineStore | null {
  if (store === undefined) store = idbStore();
  return store;
}
/** Tests only: swap the store. */
export function setOfflineStoreForTests(s: OfflineStore | null) { store = s; }

// ---------------------------------------------------------------- scope

let scope: OfflineScope | null = null;
let scopeWaiters: ((s: OfflineScope | null) => void)[] = [];

/** The app frame calls this when /account/me answers (and with null at sign out). */
export function setOfflineScope(next: OfflineScope | null) {
  scope = next;
  if (next) { const w = scopeWaiters; scopeWaiters = []; w.forEach((f) => f(next)); }
}

function waitForScope(ms: number): Promise<OfflineScope | null> {
  if (scope) return Promise.resolve(scope);
  return new Promise((resolve) => {
    const t = setTimeout(() => { scopeWaiters = scopeWaiters.filter((f) => f !== done); resolve(scope); }, ms);
    const done = (s: OfflineScope | null) => { clearTimeout(t); resolve(s); };
    scopeWaiters.push(done);
  });
}

// ---------------------------------------------------------------- "showing your last copy" state

const shown = new Map<string, number>();
const listeners = new Set<() => void>();
let snapshot: number | null = null;
function emit() {
  snapshot = shown.size ? Math.min(...shown.values()) : null;
  listeners.forEach((l) => l());
}

/** The time of the oldest stored copy on screen now, or null when every list is fresh. */
export function useShownCopyAt(): number | null {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => snapshot, () => null);
}
export function shownCopyAt(): number | null { return snapshot; }

// ---------------------------------------------------------------- the wrapper

/** Saves a fresh answer. Essential only to this device; no server write. Failures are ignored. */
export async function saveCopy(list: string, data: unknown, s: OfflineScope | null = scope, st: OfflineStore | null = getStore(), now = Date.now()): Promise<void> {
  if (!s || !st) return;
  try {
    const trimmed = trimRows(data);
    const bytes = JSON.stringify(trimmed).length * 2;
    if (bytes > MAX_BYTES) return;
    const key = copyKey(s, list);
    await st.put({ key, at: now, bytes, data: trimmed });
    const drop = evictionsFor((await st.all()).map(({ key: k, at, bytes: b }) => ({ key: k, at, bytes: b })));
    await Promise.all(drop.map((k) => st.delete(k)));
  } catch { /* storage full or blocked: lists still work online */ }
}

export async function readCopy(list: string, s: OfflineScope | null = scope, st: OfflineStore | null = getStore()): Promise<StoredCopy | undefined> {
  if (!s || !st) return undefined;
  try { return await st.get(copyKey(s, list)); } catch { return undefined; }
}

/**
 * R45 (MB-203): the last stored copy of a list, for drawing it at once while the network read runs (slow links).
 * The scope is the signed in person's (from /account/me), or before that answers, the saved account copy, which is
 * per person and dropped on sign out, on a 401 and when another person signs in (lib/me-cache.ts).
 */
export async function readLastCopy<T>(list: string, st: OfflineStore | null = getStore()): Promise<{ data: T; at: number } | null> {
  const s = scope ?? scopeOf(readMeCache());
  const c = await readCopy(list, s, st);
  return c ? { data: c.data as T, at: c.at } : null;
}

/**
 * Wraps a list's query function: a fresh answer is returned and stored; when the read fails for want of a
 * connection, the stored copy for this person and workspace is returned instead and the strip shows its time.
 * Use with networkMode "offlineFirst" so the read is tried once while the browser says it is offline.
 */
export function withOfflineCopy<T>(list: string, fetcher: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      const fresh = await fetcher();
      if (shown.delete(list)) emit();
      void saveCopy(list, fresh);
      return fresh;
    } catch (e) {
      if (!isOfflineError(e)) throw e;
      const s = await waitForScope(4000);
      const copy = await readCopy(list, s);
      if (!copy) throw e;
      shown.set(list, copy.at);
      emit();
      return copy.data as T;
    }
  };
}

/**
 * PRIV1b (WC4): forget the stored copies whose list name starts with `prefix` (a mailbox that answered 404: the share
 * was taken back, so its last list must not come back offline). This person and workspace only. Never throws.
 */
export async function dropCopies(prefix: string, s: OfflineScope | null = scope ?? scopeOf(readMeCache()), st: OfflineStore | null = getStore()): Promise<void> {
  let changed = false;
  for (const k of [...shown.keys()]) if (k.startsWith(prefix)) changed = shown.delete(k) || changed;
  if (changed) emit();
  if (!s || !st) return;
  try {
    const head = copyKey(s, prefix);
    const drop = (await st.all()).filter((c) => c.key.startsWith(head)).map((c) => c.key);
    await Promise.all(drop.map((k) => st.delete(k)));
  } catch { /* blocked */ }
}

/** Sign out: forget every stored list on this device. Never throws. */
export async function wipeOfflineLists(st: OfflineStore | null = getStore()): Promise<void> {
  scope = null;
  shown.clear();
  emit();
  try { await st?.clear(); } catch { /* blocked */ }
}

/** "10:42" in the person's own clock, for the strip. */
export function copyTimeLabel(at: number, locale?: string): string {
  return new Date(at).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}
