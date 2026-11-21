/**
 * R41 (MB-221, MB-202): the invite a person opened is remembered in this browser for 7 days, so it survives
 * the sign up page, the confirmation email and coming back through "Back to Multies" (/login?confirmed=1).
 * Only the invite token is kept (the link itself), never an email or anything from the account.
 */
import { api } from "@/web/lib/api";
import { browserTimeZone } from "@/web/lib/format";
import { cleanLocale } from "@/shared/locale";
import type { Me } from "@/web/lib/types";

const KEY = "multies.pendingInvite";
const TTL_MS = 7 * 24 * 3600_000;

export function rememberInvite(token: string) {
  try { localStorage.setItem(KEY, JSON.stringify({ token, at: Date.now() })); } catch { /* private mode */ }
}

export function forgetInvite() {
  try { localStorage.removeItem(KEY); } catch { /* private mode */ }
}

/** The remembered invite token, or null when there is none or it is older than 7 days. */
export function pendingInviteToken(now = Date.now()): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { token?: unknown; at?: unknown };
    if (typeof v.token !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(v.token) || typeof v.at !== "number" || now - v.at > TTL_MS) { forgetInvite(); return null; }
    return v.token;
  } catch {
    return null;
  }
}

/** Where sign in should land: the page the person asked for, else the remembered invite, else My Work. */
export function signInDestination(next: string | null, home: string): string {
  const ok = (n: string | null) => !!n && (n.startsWith("/app") || n.startsWith("/invite/") || n.startsWith("/oauth/authorize?") || (n.startsWith("/mnet/authorize?") || n.startsWith("/mnet/enroll?") || n.startsWith("/mnet/enroll-v1?")) || n === "/mnet/devices");
  if (ok(next)) return next!;
  const token = pendingInviteToken();
  return token ? `/invite/${token}` : home;
}

/**
 * After joining from an invite: someone new to Multies is not walked through Welcome and email setup.
 * Their zone and language come from this browser (changeable in Settings), only when they have none yet.
 */
export async function settleAfterJoin(): Promise<void> {
  forgetInvite();
  try {
    const me = await api.get<Me>("/account/me");
    if (!me.onboarding?.needed) return;
    await api.patch("/account/preferences", { timezone: browserTimeZone() ?? "UTC", ...(cleanLocale(navigator.language) ? { locale: cleanLocale(navigator.language) } : {}) });
  } catch { /* the Welcome form still covers it */ }
}
