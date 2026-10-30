import { ApiError } from "@/api/errors";

/**
 * R33: the rules that keep a person signed in. The app signs out only on a definite answer that
 * the session is gone (the server says the grant is invalid or revoked, or a fresh session check
 * finds no session). A network error, a timeout, a busy server or a rate limit never signs anyone
 * out: the app keeps the session and its cached data and tries again later.
 */

/** Error codes that mean the session can never work again, so a refresh is pointless. */
export const DEFINITE_CODES = new Set(["invalid_grant", "session_revoked", "revoked", "session_not_found", "account_deleted", "user_banned"]);

export type FailureVerdict = "keep" | "refresh" | "signOut";

/**
 * What to do after a request failed. `refreshed` is true when this request already went through
 * one refresh and was retried.
 */
export function verdictFor(err: unknown, refreshed = false): FailureVerdict {
  if (!(err instanceof ApiError)) return "keep"; // a thrown TypeError, a timeout, anything unknown
  if (err.status !== 401) return "keep"; // 0 network, 408, 429, 5xx, 403 permission: never a sign out
  if (DEFINITE_CODES.has(err.code)) return "signOut";
  return refreshed ? "signOut" : "refresh";
}

export type RefreshOutcome = "ok" | "gone" | "unknown";

/**
 * Reads the answer of a session check (Better Auth's get-session): a session is "ok", a null body
 * or a 401 is "gone" (definite), anything else (no network, 5xx, timeout) is "unknown" and the
 * session is kept.
 */
export function refreshOutcome(result: { body?: unknown; error?: unknown }): RefreshOutcome {
  if (result.error !== undefined) {
    const e = result.error;
    if (e instanceof ApiError && e.status === 401) return "gone";
    if (e instanceof ApiError && e.status === 403 && DEFINITE_CODES.has(e.code)) return "gone";
    return "unknown";
  }
  const b = result.body as { session?: unknown } | null | undefined;
  return b && typeof b === "object" && b.session ? "ok" : "gone";
}

/**
 * One refresh in flight at a time: every request that hits a 401 while a refresh runs waits for
 * that same refresh, then retries once.
 */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null;
  return () => {
    if (!running) running = fn().finally(() => { running = null; });
    return running;
  };
}

/** Refresh ahead of expiry: inside this window, or when the last check is older than a day. */
export const EARLY_REFRESH_MS = 24 * 60 * 60 * 1000;

export function shouldRefreshEarly(expiresAt: number | null, lastRefreshAt: number, now = Date.now()): boolean {
  if (expiresAt !== null && expiresAt - now < EARLY_REFRESH_MS) return true;
  return now - lastRefreshAt > EARLY_REFRESH_MS;
}

/** The session cookie's expiry from a Set-Cookie header, in ms, or null when it does not say. */
export function sessionExpiry(setCookie: string | null | undefined, now = Date.now()): number | null {
  if (!setCookie) return null;
  for (const part of setCookie.split(/,(?=\s*[^;,=\s]+=[^;,]*)/)) {
    const [pair, ...attrs] = part.split(";");
    if (!pair.split("=")[0].trim().endsWith("session_token")) continue;
    for (const a of attrs) {
      const [k, v = ""] = a.split("=");
      const key = k.trim().toLowerCase();
      if (key === "max-age" && Number(v) > 0) return now + Number(v) * 1000;
      if (key === "expires") { const t = Date.parse(a.slice(a.indexOf("=") + 1).trim()); if (!Number.isNaN(t)) return t; }
    }
  }
  return null;
}
