import { useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import { router } from "expo-router";
import { kv } from "./kv";
import { nativeLocalAuth, nativeQuickActions, nativeStoreReview } from "./native-modules";

/*
 * R37 (store build 1.10.0, native batch 1): app icon quick actions, Face ID or fingerprint unlock
 * and the store review prompt. Each one fails soft: with the native module missing (an older
 * binary, web, tests) nothing happens and the app works as before.
 */

/** The four app icon quick actions (press and hold the app icon). */
export const QUICK_ACTIONS = [
  { id: "new-task", title: "New task", icon: "symbol:checklist", href: "/task/new" },
  { id: "compose", title: "Compose", icon: "symbol:square.and.pencil", href: "/compose" },
  { id: "search", title: "Search", icon: "symbol:magnifyingglass", href: "/search" },
  { id: "inbox", title: "Inbox", icon: "symbol:tray", href: "/inbox" },
] as const;

/** Where a quick action goes, or null for anything unknown. */
export function quickActionHref(action: { id?: string; params?: Record<string, unknown> | null } | null | undefined): string | null {
  if (!action) return null;
  const href = action.params?.href;
  if (typeof href === "string" && href.startsWith("/")) return href;
  return QUICK_ACTIONS.find((a) => a.id === action.id)?.href ?? null;
}

/** Registers the quick actions and opens the right screen when one is used. Call once signed in. */
export function useQuickActions() {
  useEffect(() => {
    const Q = nativeQuickActions();
    if (!Q) return;
    // Android draws its own icon for a shortcut without one; iOS gets the SF Symbol.
    Q.setItems(QUICK_ACTIONS.map((a) => ({ id: a.id, title: a.title, icon: Platform.OS === "ios" ? a.icon : null, params: { href: a.href } }))).catch(() => {});
    const go = (a: Parameters<typeof quickActionHref>[0]) => { const href = quickActionHref(a); if (href) router.push(href as never); };
    if (Q.initial) setTimeout(() => go(Q.initial), 0);
    const sub = Q.addListener((a) => go(a));
    return () => sub.remove();
  }, []);
}

const LOCK_KEY = "lock:biometric";

/** Whether this phone can unlock with Face ID, Touch ID or a fingerprint right now. */
export async function biometricAvailable(): Promise<boolean> {
  const L = nativeLocalAuth();
  if (!L) return false;
  try { return (await L.hasHardwareAsync()) && (await L.isEnrolledAsync()); } catch { return false; }
}

/** The label for the switch: "Face ID" on iPhones with it, "Touch ID" or "fingerprint" otherwise. */
export async function biometricLabel(): Promise<string> {
  const L = nativeLocalAuth();
  if (!L) return "Face ID";
  try {
    const types = await L.supportedAuthenticationTypesAsync();
    if (types.includes(L.AuthenticationType.FACIAL_RECOGNITION)) return Platform.OS === "ios" ? "Face ID" : "face unlock";
    if (types.includes(L.AuthenticationType.FINGERPRINT)) return Platform.OS === "ios" ? "Touch ID" : "fingerprint";
  } catch { /* fall through */ }
  return Platform.OS === "ios" ? "Face ID" : "fingerprint";
}

export async function getBiometricLock(): Promise<boolean> {
  return (await kv().get(LOCK_KEY).catch(() => null)) === "1";
}

/** Turns the lock on (after one successful check, so nobody locks themselves out) or off. */
export async function setBiometricLock(on: boolean): Promise<boolean> {
  if (on) {
    if (!(await biometricAvailable())) return false;
    if (!(await authenticate("Turn on unlock"))) return false;
  }
  await kv().set(LOCK_KEY, on ? "1" : "0");
  return on;
}

async function authenticate(prompt: string): Promise<boolean> {
  const L = nativeLocalAuth();
  if (!L) return true;
  try {
    const r = await L.authenticateAsync({ promptMessage: prompt, cancelLabel: "Cancel", disableDeviceFallback: false });
    return r.success;
  } catch { return false; }
}

/**
 * R37: when the person turned the lock on, the app asks for Face ID (or the fingerprint) at launch
 * and each time it comes back from the background. Off by default. Fails soft: without the module
 * or enrolled biometrics it never locks.
 */
export function useBiometricLock(active: boolean) {
  const [locked, setLocked] = useState(false);
  const asking = useRef(false);
  const unlock = async () => {
    if (asking.current) return;
    asking.current = true;
    const ok = await authenticate("Unlock Multies");
    asking.current = false;
    if (ok) setLocked(false);
  };
  useEffect(() => {
    if (!active || Platform.OS === "web") { setLocked(false); return; }
    let cancelled = false;
    const check = async () => {
      if (!(await getBiometricLock()) || !(await biometricAvailable()) || cancelled) return;
      setLocked(true);
      unlock();
    };
    check();
    let last = AppState.currentState;
    const sub = AppState.addEventListener("change", (s) => {
      if (last === "background" && s === "active") check();
      last = s;
    });
    return () => { cancelled = true; sub.remove(); };
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  return { locked, unlock };
}

const DONE_KEY = "review:done";
const ASKED_KEY = "review:asked";
/** How many completed tasks before the one store review prompt. */
export const REVIEW_AFTER = 5;

/** Whether this completion should show the review prompt: the fifth, once ever. */
export function shouldAskForReview(doneCount: number, alreadyAsked: boolean): boolean {
  return !alreadyAsked && doneCount >= REVIEW_AFTER;
}

/** R37: counts a completed task; after the fifth, asks once for a store review (the system may skip it). */
export async function recordTaskCompleted(): Promise<void> {
  try {
    const n = Number((await kv().get(DONE_KEY)) ?? "0") + 1;
    await kv().set(DONE_KEY, String(n));
    const asked = (await kv().get(ASKED_KEY)) === "1";
    if (!shouldAskForReview(n, asked)) return;
    const S = nativeStoreReview();
    if (!S || !(await S.isAvailableAsync())) return;
    await kv().set(ASKED_KEY, "1");
    setTimeout(() => { S.requestReview().catch(() => {}); }, 1200);
  } catch { /* best effort */ }
}
