/**
 * R128 vault session: the opened private key and the folder keys live ONLY in this module's memory (never in
 * localStorage, sessionStorage, IndexedDB, the URL or a log). Locking drops every reference; closing the tab drops them
 * too. Auto lock after idle (5, 15, 30 or 60 min; a plain preference, not a secret) and when the page is hidden for good.
 */
import { useSyncExternalStore } from "react";
import { unwrapFolderKey } from "@/web/lib/vault-crypto";
import { VAULT_AUTO_LOCK_CHOICES, VAULT_AUTO_LOCK_DEFAULT, VAULT_CLIPBOARD_CLEAR_MS } from "@/shared/vault-r128";

let privateKey: CryptoKey | null = null;
let folderKeys = new Map<string, CryptoKey>();
const listeners = new Set<() => void>();
const lockHooks = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

export function setVaultOpen(pk: CryptoKey) { privateKey = pk; folderKeys = new Map(); emit(); armIdle(); }
export function lockVault() {
  if (!privateKey && !folderKeys.size) return;
  privateKey = null;
  folderKeys = new Map();
  disarmIdle();
  for (const h of lockHooks) h();
  emit();
}
export const isVaultOpen = () => !!privateKey;
/** Runs on every lock (the page clears its decrypted data and query cache here). */
export function onLock(h: () => void) { lockHooks.add(h); return () => { lockHooks.delete(h); }; }
export function useVaultOpen(): boolean {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, isVaultOpen, () => false);
}

/** The folder key for one version, unwrapped once per opening. */
export async function folderKey(folderId: string, version: number, wrapped: string): Promise<CryptoKey> {
  const id = `${folderId}:${version}`;
  const hit = folderKeys.get(id);
  if (hit) return hit;
  if (!privateKey) throw new Error("locked");
  const k = await unwrapFolderKey(wrapped, privateKey);
  folderKeys.set(id, k);
  return k;
}

// ---------------------------------------------------------------- auto lock

const PREF = "vault.autoLockMinutes";
export function autoLockMinutes(): number {
  try {
    const v = Number(globalThis.localStorage?.getItem(PREF));
    return (VAULT_AUTO_LOCK_CHOICES as readonly number[]).includes(v) ? v : VAULT_AUTO_LOCK_DEFAULT;
  } catch { return VAULT_AUTO_LOCK_DEFAULT; }
}
export function setAutoLockMinutes(m: number) {
  try { globalThis.localStorage?.setItem(PREF, String(m)); } catch { /* private mode: keep the default */ }
  if (privateKey) armIdle();
}

let timer: ReturnType<typeof setTimeout> | null = null;
let lastActive = 0;
const EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
function bump() {
  lastActive = Date.now();
}
function check() {
  if (!privateKey) return;
  const ms = autoLockMinutes() * 60_000;
  const idle = Date.now() - lastActive;
  if (idle >= ms) { lockVault(); return; }
  timer = setTimeout(check, Math.min(ms - idle, 30_000));
}
function onHide() { lockVault(); }
function armIdle() {
  if (typeof window === "undefined") return;
  disarmIdle();
  lastActive = Date.now();
  for (const e of EVENTS) window.addEventListener(e, bump, { passive: true });
  window.addEventListener("pagehide", onHide);
  timer = setTimeout(check, 30_000);
}
function disarmIdle() {
  if (typeof window === "undefined") return;
  if (timer) clearTimeout(timer);
  timer = null;
  for (const e of EVENTS) window.removeEventListener(e, bump);
  window.removeEventListener("pagehide", onHide);
}
/** For tests: pretend the person was idle for this long. */
export function idleForTest(ms: number) { lastActive = Date.now() - ms; check(); }

// ---------------------------------------------------------------- clipboard

let clearTimer: ReturnType<typeof setTimeout> | null = null;
/** Copies, then clears the clipboard after 30 s where the browser allows it (only while the page has focus). */
export async function copySecret(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    clearTimer = null;
    if (typeof document !== "undefined" && document.hasFocus()) void navigator.clipboard.writeText("").catch(() => undefined);
  }, VAULT_CLIPBOARD_CLEAR_MS);
}
