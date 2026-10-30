import type { KV } from "./kv";

/** R36: the last few searches, newest first, kept on this phone only (no server write). */
const KEY = "search:recent";
export const RECENT_MAX = 6;

export async function readRecent(store: KV): Promise<string[]> {
  try {
    const raw = await store.get(KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch { return []; }
}

/** Puts `q` first, drops a repeat of it (any case), keeps RECENT_MAX. Ignores one letter searches. */
export function pushRecent(list: string[], q: string): string[] {
  const t = q.trim();
  if (t.length < 2) return list;
  return [t, ...list.filter((x) => x.toLowerCase() !== t.toLowerCase())].slice(0, RECENT_MAX);
}

export async function saveRecent(store: KV, list: string[]): Promise<void> {
  try { await store.set(KEY, JSON.stringify(list.slice(0, RECENT_MAX))); } catch { /* a full store just forgets */ }
}
