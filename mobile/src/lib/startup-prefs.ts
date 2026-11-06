import { Platform } from "react-native";

/**
 * MPAR2: tiny settings the app reads before its first screen draws (language, appearance, accent). They have to be
 * read synchronously, because the colours and words are chosen once when the app starts. Phones keep them in the
 * secure store's synchronous calls (already in the store builds), the web build in localStorage, tests in memory.
 * Every call fails soft: a missing or broken store reads as "not set" and a write that fails is skipped.
 */
const NS = "multies.pref.";
const mem = new Map<string, string>();

type SyncStore = { getItem(k: string): string | null; setItem(k: string, v: string): void; deleteItemAsync?(k: string): Promise<void> };

function nativeStore(): SyncStore | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const S = require("expo-secure-store") as SyncStore;
    return typeof S?.getItem === "function" && typeof S?.setItem === "function" ? S : null;
  } catch { return null; }
}

function backend(): "web" | "native" | "memory" {
  if (process.env.NODE_ENV === "test") return "memory";
  return Platform.OS === "web" ? "web" : "native";
}

export function readPref(key: string): string | null {
  try {
    const b = backend();
    if (b === "memory") return mem.get(key) ?? null;
    if (b === "web") return globalThis.localStorage?.getItem(NS + key) ?? null;
    return nativeStore()?.getItem(NS + key) ?? null;
  } catch { return null; }
}

export function writePref(key: string, value: string | null): void {
  try {
    const b = backend();
    if (b === "memory") { if (value == null) mem.delete(key); else mem.set(key, value); return; }
    if (b === "web") { if (value == null) globalThis.localStorage?.removeItem(NS + key); else globalThis.localStorage?.setItem(NS + key, value); return; }
    const s = nativeStore();
    if (!s) return;
    if (value == null) void s.deleteItemAsync?.(NS + key)?.catch?.(() => {}); else s.setItem(NS + key, value);
  } catch { /* best effort */ }
}

/** Tests: forget everything kept in memory. */
export function resetPrefsForTests() { mem.clear(); }
