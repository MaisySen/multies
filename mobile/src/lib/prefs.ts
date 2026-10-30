import { useEffect, useSyncExternalStore } from "react";
import { kv } from "./kv";

/**
 * R33: small choices saved on this phone (not cleared at sign out, they belong to the phone):
 * haptics on or off, the four swipe actions per list, and whether the swipe hint was seen.
 */
export type MailSwipe = "archive" | "snooze" | "read" | "delete" | "none";
export type TaskSwipe = "complete" | "schedule" | "delete" | "none";
export interface SwipeSet<T> { rightShort: T; rightLong: T; leftShort: T; leftLong: T }
export interface Prefs {
  haptics: boolean;
  mailSwipes: SwipeSet<MailSwipe>;
  taskSwipes: SwipeSet<TaskSwipe>;
  swipeHintSeen: boolean;
}

export const MAIL_SWIPE_CHOICES: { id: MailSwipe; label: string }[] = [
  { id: "archive", label: "Archive" }, { id: "snooze", label: "Snooze" }, { id: "read", label: "Mark read or unread" }, { id: "delete", label: "Delete" }, { id: "none", label: "None" },
];
export const TASK_SWIPE_CHOICES: { id: TaskSwipe; label: string }[] = [
  { id: "complete", label: "Complete" }, { id: "schedule", label: "Schedule" }, { id: "delete", label: "Delete" }, { id: "none", label: "None" },
];
export const SWIPE_SLOTS: { id: keyof SwipeSet<string>; label: string }[] = [
  { id: "rightShort", label: "Short swipe right" }, { id: "rightLong", label: "Long swipe right" },
  { id: "leftShort", label: "Short swipe left" }, { id: "leftLong", label: "Long swipe left" },
];

export const DEFAULT_PREFS: Prefs = {
  haptics: true,
  mailSwipes: { rightShort: "archive", rightLong: "read", leftShort: "snooze", leftLong: "delete" },
  taskSwipes: { rightShort: "complete", rightLong: "none", leftShort: "schedule", leftLong: "delete" },
  swipeHintSeen: false,
};

const KEY = "prefs:v1";
let current: Prefs = DEFAULT_PREFS;
let loaded = false;
const listeners = new Set<() => void>();

/** Reads a saved value, keeping defaults for anything missing or unknown. */
export function parsePrefs(raw: string | null): Prefs {
  if (!raw) return DEFAULT_PREFS;
  try {
    const p = JSON.parse(raw) as Partial<Prefs>;
    const pick = <T extends string>(set: unknown, def: SwipeSet<T>, ok: readonly T[]): SwipeSet<T> => {
      const s = (set && typeof set === "object" ? set : {}) as Record<string, unknown>;
      const out = { ...def };
      for (const k of Object.keys(def) as (keyof SwipeSet<T>)[]) if (ok.includes(s[k] as T)) out[k] = s[k] as T;
      return out;
    };
    return {
      haptics: typeof p.haptics === "boolean" ? p.haptics : DEFAULT_PREFS.haptics,
      mailSwipes: pick(p.mailSwipes, DEFAULT_PREFS.mailSwipes, MAIL_SWIPE_CHOICES.map((c) => c.id)),
      taskSwipes: pick(p.taskSwipes, DEFAULT_PREFS.taskSwipes, TASK_SWIPE_CHOICES.map((c) => c.id)),
      swipeHintSeen: p.swipeHintSeen === true,
    };
  } catch { return DEFAULT_PREFS; }
}

export function getPrefs(): Prefs { return current; }

export async function loadPrefs(): Promise<Prefs> {
  if (loaded) return current;
  loaded = true;
  current = parsePrefs(await kv().get(KEY).catch(() => null));
  listeners.forEach((l) => l());
  return current;
}

export function setPrefs(patch: Partial<Prefs>) {
  current = { ...current, ...patch };
  loaded = true;
  listeners.forEach((l) => l());
  kv().set(KEY, JSON.stringify(current)).catch(() => {});
}

export function usePrefs(): Prefs {
  useEffect(() => { void loadPrefs(); }, []);
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, getPrefs, getPrefs);
}
