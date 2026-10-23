import { Platform } from "react-native";

/** A key value store for the offline cache and on-device tasks. SQLite on phones, localStorage on web. */
export interface KV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
  clear(prefix?: string): Promise<void>;
}

export function memoryKV(seed: Record<string, string> = {}): KV {
  const m = new Map(Object.entries(seed));
  return {
    async get(k) { return m.get(k) ?? null; },
    async set(k, v) { m.set(k, v); },
    async remove(k) { m.delete(k); },
    async keys(p) { return [...m.keys()].filter((k) => k.startsWith(p)); },
    async clear(p = "") { for (const k of [...m.keys()]) if (k.startsWith(p)) m.delete(k); },
  };
}

function webKV(): KV {
  const ls = globalThis.localStorage;
  if (!ls) return memoryKV();
  const NS = "mymail:";
  return {
    async get(k) { return ls.getItem(NS + k); },
    async set(k, v) { try { ls.setItem(NS + k, v); } catch { /* storage full: the cache is best effort */ } },
    async remove(k) { ls.removeItem(NS + k); },
    async keys(p) { return Object.keys(ls).filter((k) => k.startsWith(NS + p)).map((k) => k.slice(NS.length)); },
    async clear(p = "") { for (const k of Object.keys(ls)) if (k.startsWith(NS + p)) ls.removeItem(k); },
  };
}

function sqliteKV(): KV {
  // Loaded lazily so tests and the web build never touch the native module.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const SQLite = require("expo-sqlite") as typeof import("expo-sqlite");
  const ready = (async () => {
    const db = await SQLite.openDatabaseAsync("mymail-cache.db");
    await db.execAsync("PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL);");
    return db;
  })();
  return {
    async get(k) { const db = await ready; return (await db.getFirstAsync<{ value: string }>("SELECT value FROM kv WHERE key = ?", k))?.value ?? null; },
    async set(k, v) { const db = await ready; await db.runAsync("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)", k, v, Date.now()); },
    async remove(k) { const db = await ready; await db.runAsync("DELETE FROM kv WHERE key = ?", k); },
    async keys(p) { const db = await ready; return (await db.getAllAsync<{ key: string }>("SELECT key FROM kv WHERE key LIKE ? ORDER BY updated_at DESC", `${p}%`)).map((r) => r.key); },
    async clear(p = "") { const db = await ready; await db.runAsync("DELETE FROM kv WHERE key LIKE ?", `${p}%`); },
  };
}

let shared: KV | null = null;
export function kv(): KV {
  if (!shared) shared = Platform.OS === "web" ? webKV() : process.env.NODE_ENV === "test" ? memoryKV() : sqliteKV();
  return shared;
}
export function setKV(store: KV) { shared = store; }
