/**
 * R103: spell check settings, per person on this device: on or off and the language (20). The browser's own
 * dictionary underlines words and suggests fixes on right click; "Check spelling" adds our list of common typos.
 */
import { useCallback, useSyncExternalStore } from "react";
import { isSpellLang, type SpellLang } from "@/shared/docs-plus";

export interface SpellPref { on: boolean; lang: SpellLang; ignore: string[] }
const KEY = "mm_spell_r103";
const listeners = new Set<() => void>();
let cache: SpellPref | null = null;

function defaultLang(): SpellLang {
  const nav = typeof navigator !== "undefined" ? navigator.language : "en-AU";
  return isSpellLang(nav) ? nav : nav.startsWith("en-US") ? "en-US" : nav.startsWith("en-GB") ? "en-GB" : "en-AU";
}

export function readSpellPref(): SpellPref {
  if (cache) return cache;
  let v: Partial<SpellPref> = {};
  try { v = JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<SpellPref>; } catch { /* first use */ }
  cache = { on: v.on !== false, lang: isSpellLang(v.lang) ? v.lang : defaultLang(), ignore: Array.isArray(v.ignore) ? v.ignore.filter((w) => typeof w === "string").slice(0, 500) : [] };
  return cache;
}

export function writeSpellPref(p: Partial<SpellPref>) {
  cache = { ...readSpellPref(), ...p };
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* private mode */ }
  for (const l of listeners) l();
}

export function useSpellPref(): [SpellPref, (p: Partial<SpellPref>) => void] {
  const pref = useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, readSpellPref, readSpellPref);
  return [pref, useCallback((p: Partial<SpellPref>) => writeSpellPref(p), [])];
}
