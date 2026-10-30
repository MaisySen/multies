import { useSyncExternalStore } from "react";
import type { KV } from "./kv";
import type { MessagePage, MessageSummary, ThreadView } from "@/api/types";
import { ApiError } from "@/api/errors";

/** How many list pages and threads to keep for reading offline. */
export const CACHE_LIMITS = { lists: 12, threads: 60, tasks: 60 };

let offline = false;
const listeners = new Set<() => void>();
export function setOffline(v: boolean) { if (v !== offline) { offline = v; listeners.forEach((l) => l()); } }
export function useOffline() {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => offline, () => offline);
}

/**
 * Runs a request; on success the result is cached under `key`. When the network is down the
 * cached copy comes back instead, and the app shows an offline banner.
 */
export async function cached<T>(store: KV, key: string, fetcher: () => Promise<T>): Promise<T> {
  try {
    const v = await fetcher();
    setOffline(false);
    store.set(key, JSON.stringify({ at: Date.now(), v })).then(() => prune(store, key)).catch(() => {});
    return v;
  } catch (err) {
    if (err instanceof ApiError && err.isNetwork) {
      setOffline(true);
      const hit = await store.get(key);
      if (hit) return (JSON.parse(hit) as { v: T }).v;
    }
    throw err;
  }
}

async function prune(store: KV, key: string) {
  const prefix = (["thread:", "list:", "task:", "worklist:"] as const).find((p) => key.startsWith(p));
  if (!prefix) return;
  const limit = prefix === "thread:" ? CACHE_LIMITS.threads : prefix === "task:" ? CACHE_LIMITS.tasks : CACHE_LIMITS.lists;
  const keys = await store.keys(prefix);
  for (const k of keys.slice(limit)) await store.remove(k);
}

/** Searches mail already on the phone, for when there's no connection. */
export async function searchCache(store: KV, query: string): Promise<MessageSummary[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const seen = new Map<string, MessageSummary>();
  for (const k of await store.keys("list:")) {
    const hit = await store.get(k);
    if (!hit) continue;
    for (const m of (JSON.parse(hit) as { v: MessagePage }).v.messages) seen.set(m.id, m);
  }
  for (const k of await store.keys("thread:")) {
    const hit = await store.get(k);
    if (!hit) continue;
    for (const m of (JSON.parse(hit) as { v: ThreadView }).v.thread) {
      const prev = seen.get(m.id);
      seen.set(m.id, { ...(prev ?? m), snippet: m.text.slice(0, 200) });
    }
  }
  return [...seen.values()]
    .filter((m) => [m.subject, m.snippet, m.from.address, m.from.name ?? ""].join(" ").toLowerCase().includes(q))
    .sort((a, b) => b.date.localeCompare(a.date));
}
