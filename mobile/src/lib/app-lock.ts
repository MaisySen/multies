import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform, type AppStateStatus } from "react-native";
import { kv } from "./kv";
import { secureStorage } from "./storage";
import { nativeLocalAuth } from "./native-modules";

/**
 * M4: Lock Multies. Face ID, Touch ID or the fingerprint, with a 4 to 6 digit PIN as the fallback.
 * - The PIN is never stored: only a salted, stretched SHA-256 hash, kept in the iOS Keychain or
 *   Android Keystore (expo-secure-store), with the failed attempt count beside it.
 * - Wrong PINs back off (30 s after 5, then 1, 5 and 15 minutes); the 10th wrong PIN signs out.
 * - Forgetting the PIN means signing out and signing back in. There is no bypass.
 * - Options: lock on open, or after 1, 5 or 15 minutes away; hide content in the app switcher.
 * - Off by default, with one friendly offer after sign in.
 * Uses expo-local-authentication, expo-secure-store and expo-crypto, all in the 1.10.0 store builds.
 */
export const LOCK_KEYS = { on: "lock:on", bio: "lock:biometric", after: "lock:after", hide: "lock:hide", offered: "lock:offered" } as const;
const PIN_KEY = "multies.lock.pin";
const FAILS_KEY = "multies.lock.fails";
export const PIN_MIN = 4, PIN_MAX = 6, MAX_FAILS = 10, ROUNDS = 2000;
export const AFTER_OPTIONS = [
  { id: "0", label: "Right away" }, { id: "60", label: "After 1 minute" }, { id: "300", label: "After 5 minutes" }, { id: "900", label: "After 15 minutes" },
] as const;
export type LockAfter = (typeof AFTER_OPTIONS)[number]["id"];

export interface LockSettings { on: boolean; biometric: boolean; after: LockAfter; hide: boolean; hasPin: boolean }
interface PinRecord { v: 1; salt: string; hash: string; rounds: number; length: number }
interface Fails { count: number; until: number }

/** 4 to 6 digits, nothing else. */
export function validPin(pin: string): boolean { return /^\d{4,6}$/.test(pin); }

/** Seconds to wait after this many wrong PINs in a row (0 = try again now). */
export function backoffSeconds(fails: number): number {
  if (fails < 5) return 0;
  return [30, 60, 300, 900][Math.min(fails - 5, 3)];
}

/** Whether coming back after awayMs should lock, for the chosen "Require" option. */
export function shouldLockOnReturn(awayMs: number, after: LockAfter): boolean {
  return awayMs >= Number(after) * 1000;
}

type Digest = (s: string) => Promise<string>;
function crypto() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  try { return require("expo-crypto") as typeof import("expo-crypto"); } catch { return null; }
}
const sha256: Digest = async (s) => {
  const C = crypto();
  if (!C) throw new Error("crypto unavailable");
  return C.digestStringAsync(C.CryptoDigestAlgorithm.SHA256, s);
};
/** A 16 byte salt from a cryptographic source. With none it throws, so no PIN is ever saved with a guessable salt. */
export function newSalt(): string {
  const C = crypto();
  const web = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  const bytes = C?.getRandomBytes ? C.getRandomBytes(16) : web?.getRandomValues ? web.getRandomValues(new Uint8Array(16)) : null;
  if (!bytes) throw new Error("This phone cannot make a secure PIN right now.");
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The stretched hash: rounds of SHA-256 over the salt, the round and the last value. Exported for tests. */
export async function hashPin(pin: string, salt: string, rounds = ROUNDS, digest: Digest = sha256): Promise<string> {
  let h = await digest(`multies-lock|${salt}|${pin}`);
  for (let i = 1; i < rounds; i++) h = await digest(`${salt}|${i}|${h}`);
  return h;
}

/** Same length strings compared without stopping early. */
export function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function readJSON<T>(key: string): Promise<T | null> {
  try { const s = await secureStorage.get(key); return s ? (JSON.parse(s) as T) : null; } catch { return null; }
}

export async function getLockSettings(): Promise<LockSettings> {
  const store = kv();
  const [on, bio, after, hide, pin] = await Promise.all([
    store.get(LOCK_KEYS.on).catch(() => null), store.get(LOCK_KEYS.bio).catch(() => null), store.get(LOCK_KEYS.after).catch(() => null),
    store.get(LOCK_KEYS.hide).catch(() => null), readJSON<PinRecord>(PIN_KEY),
  ]);
  const legacy = bio === "1" && on === null; // R37: "Unlock with Face ID" users keep their lock
  const a = AFTER_OPTIONS.some((o) => o.id === after) ? (after as LockAfter) : "0";
  return { on: on === "1" || legacy, biometric: bio === "1", after: a, hide: hide !== "0", hasPin: !!pin };
}

export async function saveLockSetting(key: "biometric" | "after" | "hide", value: boolean | LockAfter): Promise<void> {
  const v = typeof value === "boolean" ? (value ? "1" : "0") : value;
  await kv().set(LOCK_KEYS[key === "biometric" ? "bio" : key], v);
}

/** Turns the lock on with a new PIN (and Face ID when wanted and it passes once). */
export async function turnOnLock(pin: string, withBiometric: boolean): Promise<{ biometric: boolean }> {
  if (!validPin(pin)) throw new Error("A PIN is 4 to 6 digits.");
  await setPin(pin);
  let bio = false;
  if (withBiometric && (await biometricAvailable())) bio = await authenticate(`Use ${await biometricLabel()} for Multies`);
  await kv().set(LOCK_KEYS.bio, bio ? "1" : "0");
  await kv().set(LOCK_KEYS.on, "1");
  await kv().set(LOCK_KEYS.offered, "1");
  return { biometric: bio };
}

export async function setPin(pin: string): Promise<void> {
  const salt = newSalt();
  const rec: PinRecord = { v: 1, salt, hash: await hashPin(pin, salt), rounds: ROUNDS, length: pin.length };
  await secureStorage.set(PIN_KEY, JSON.stringify(rec));
  await secureStorage.remove(FAILS_KEY).catch(() => {});
}

export async function pinLength(): Promise<number> {
  return (await readJSON<PinRecord>(PIN_KEY))?.length ?? 4;
}

/** Turns the lock off (the caller asks for the PIN or Face ID first) and forgets the PIN. */
export async function turnOffLock(): Promise<void> {
  await kv().set(LOCK_KEYS.on, "0");
  await kv().set(LOCK_KEYS.bio, "0");
  await secureStorage.remove(PIN_KEY).catch(() => {});
  await secureStorage.remove(FAILS_KEY).catch(() => {});
}

/** Everything the lock keeps, removed at sign out. */
export async function clearLock(): Promise<void> {
  await turnOffLock();
  await kv().set(LOCK_KEYS.offered, "0");
}

export type PinResult = { ok: true } | { ok: false; waitSeconds: number; left: number; signOut: boolean };

export async function checkPin(pin: string, now = Date.now()): Promise<PinResult> {
  const rec = await readJSON<PinRecord>(PIN_KEY);
  const fails = (await readJSON<Fails>(FAILS_KEY)) ?? { count: 0, until: 0 };
  if (fails.until > now) return { ok: false, waitSeconds: Math.ceil((fails.until - now) / 1000), left: MAX_FAILS - fails.count, signOut: false };
  if (rec && sameHash(await hashPin(pin, rec.salt, rec.rounds), rec.hash)) {
    await secureStorage.remove(FAILS_KEY).catch(() => {});
    return { ok: true };
  }
  const count = fails.count + 1;
  const wait = backoffSeconds(count);
  await secureStorage.set(FAILS_KEY, JSON.stringify({ count, until: wait ? now + wait * 1000 : 0 }));
  return { ok: false, waitSeconds: wait, left: Math.max(0, MAX_FAILS - count), signOut: count >= MAX_FAILS };
}

export async function lockWait(now = Date.now()): Promise<number> {
  const f = await readJSON<Fails>(FAILS_KEY);
  return f && f.until > now ? Math.ceil((f.until - now) / 1000) : 0;
}

/** True while the Face ID sheet is up: it makes the app "inactive", which must not lock or cover. */
let authenticating = false;
export async function authenticate(prompt: string): Promise<boolean> {
  const L = nativeLocalAuth();
  if (!L) return false;
  authenticating = true;
  try {
    // The PIN is the fallback, so the phone's own passcode is not offered here.
    const r = await L.authenticateAsync({ promptMessage: prompt, cancelLabel: "Use PIN", disableDeviceFallback: true });
    return r.success;
  } catch { return false; } finally { setTimeout(() => { authenticating = false; }, 400); }
}

/** Whether to offer the lock once, after sign in. */
export async function shouldOfferLock(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  const s = await getLockSettings();
  return !s.on && (await kv().get(LOCK_KEYS.offered).catch(() => null)) !== "1";
}
export async function markLockOffered(): Promise<void> { await kv().set(LOCK_KEYS.offered, "1"); }

/** Whether this phone can unlock with Face ID, Touch ID or a fingerprint now (no router import, so the session can use this file). */
export async function biometricAvailable(): Promise<boolean> {
  const L = nativeLocalAuth();
  if (!L) return false;
  try { return (await L.hasHardwareAsync()) && (await L.isEnrolledAsync()); } catch { return false; }
}
export async function biometricLabel(): Promise<string> {
  const L = nativeLocalAuth();
  const ios = Platform.OS === "ios";
  if (!L) return ios ? "Face ID" : "fingerprint";
  try {
    const t = await L.supportedAuthenticationTypesAsync();
    if (t.includes(L.AuthenticationType.FACIAL_RECOGNITION)) return ios ? "Face ID" : "face unlock";
    if (t.includes(L.AuthenticationType.FINGERPRINT)) return ios ? "Touch ID" : "fingerprint";
  } catch { /* fall through */ }
  return ios ? "Face ID" : "fingerprint";
}

/** Screenshots on the web build turn the lock on with localStorage "m4-shots" (never on phones). */
function lockSupported(): boolean {
  if (Platform.OS !== "web") return true;
  return !!(globalThis as { localStorage?: Storage }).localStorage?.getItem("m4-shots");
}

/**
 * The app lock state for the root layout: locked at launch and on return per the settings, and
 * covered (content hidden) while the app is in the app switcher.
 */
export function useAppLock(active: boolean) {
  const [locked, setLocked] = useState(false);
  const [covered, setCovered] = useState(false);
  const [settings, setSettings] = useState<LockSettings | null>(null);
  const leftAt = useRef<number | null>(null);
  const refresh = useCallback(async () => { const s = await getLockSettings(); setSettings(s); return s; }, []);

  useEffect(() => {
    if (!active || !lockSupported()) { setLocked(false); setCovered(false); return; }
    let cancelled = false;
    refresh().then((s) => { if (!cancelled && s.on) setLocked(true); }).catch(() => {});
    const onChange = async (state: AppStateStatus) => {
      if (state === "active") {
        const s = await refresh();
        const away = leftAt.current;
        leftAt.current = null;
        if (s.on && away !== null && shouldLockOnReturn(Date.now() - away, s.after)) setLocked(true);
        setCovered(false);
      } else {
        if (authenticating) return;
        // The clock starts in the background; "inactive" (the app switcher, a system sheet) only covers.
        if (state === "background" && leftAt.current === null) leftAt.current = Date.now();
        const s = await refresh();
        if (s.on && s.hide) setCovered(true);
      }
    };
    const sub = AppState.addEventListener("change", (st) => { onChange(st).catch(() => {}); });
    // Android: the app switcher is a "blur" (the state stays active).
    const blur = Platform.OS === "android" ? AppState.addEventListener("blur", () => { onChange("inactive").catch(() => {}); }) : null;
    const focus = Platform.OS === "android" ? AppState.addEventListener("focus", () => { setCovered(false); }) : null;
    return () => { cancelled = true; sub.remove(); blur?.remove(); focus?.remove(); };
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  return { locked, covered, settings, unlock: () => setLocked(false), refresh };
}
