import type { Me } from "./types";
import { ApiError, isTransientError } from "./api";

/**
 * R40 (MB-200): the last good copy of GET /account/me, kept in memory and in
 * localStorage, so the app shell paints at once and a failed account check
 * refreshes in the background instead of blanking the app. The copy is per
 * person: it is dropped on sign out, on a 401, and when another person signs in.
 */
const KEY = "multies.me.v1";
let memory: Me | undefined;

export function readMeCache(): Me | undefined {
  if (memory) return memory;
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { v: 1; me: Me };
    if (parsed?.v !== 1 || !parsed.me?.user?.id) return undefined;
    memory = parsed.me;
    return memory;
  } catch {
    return undefined;
  }
}

export function writeMeCache(me: Me | undefined | null): void {
  if (!me?.user?.id) return;
  memory = me;
  try { localStorage.setItem(KEY, JSON.stringify({ v: 1, me })); } catch { /* storage full or blocked */ }
}

export function clearMeCache(): void {
  memory = undefined;
  try { localStorage.removeItem(KEY); } catch { /* blocked */ }
}

/** Backoff for the account check: 3 tries after the first, 400 ms, 1.2 s, 3 s. */
export const ME_RETRY_DELAYS = [400, 1200, 3000];

export function meRetry(failureCount: number, err: unknown): boolean {
  return isTransientError(err) && failureCount < ME_RETRY_DELAYS.length;
}

export function meRetryDelay(attempt: number): number {
  return ME_RETRY_DELAYS[Math.min(attempt, ME_RETRY_DELAYS.length - 1)]!;
}

/** True when the account check failed because the person is not signed in. */
export function isSignedOut(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}
