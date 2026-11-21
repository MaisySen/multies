/**
 * OPS1: the Users section's calls and shapes (/api/console/users, routes/console/users.ts on the server).
 * Lists go through DataTable; these are the detail read and the changes, each with a reason.
 */
import { api } from "@/web/lib/api";
import { consoleGet } from "@/web/lib/console-api";

export interface ConsoleUserRow {
  id: string; email: string; name: string; emailVerified: boolean; role: string | null; operator: boolean;
  banned: boolean; banReason: string | null; banExpires: string | null; twoFactorEnabled: boolean; lastLoginMethod: string | null;
  kind: "person" | "agent"; workspaces: number; createdAt: string;
}

export interface ConsoleUserMembership {
  memberId: string; orgId: string; orgName: string; plan: string; effectivePlan: string; isDemo: boolean; suspendedAt: string | null;
  role: "owner" | "admin" | "member"; kind: "human" | "agent"; joinedAt: string;
}

export interface ConsoleUserDetail {
  profile: {
    id: string; email: string; name: string; emailVerified: boolean; image: string | null; role: string | null; operator: boolean;
    banned: boolean; banReason: string | null; banExpires: string | null; lastLoginMethod: string | null;
    timezone: string | null; locale: string | null; createdAt: string; updatedAt: string;
  };
  memberships: ConsoleUserMembership[];
  accounts: { id: string; providerId: string; accountId: string; hasPassword: boolean; scope: string | null; createdAt: string; updatedAt: string }[];
  twoFactor: { enabled: boolean; configured: boolean; verified: boolean | null; failedAttempts: number; lockedUntil: string | null };
  lockout: { locked: boolean; lockedUntil: string | null; failures: number; windowStart: string | null };
  activeSessions: number;
}

export interface ConsoleUserSession {
  id: string; createdAt: string; updatedAt: string; expiresAt: string; active: boolean;
  ipAddress: string | null; userAgent: string | null; loginMethod: string | null; activeOrganizationId: string | null; impersonatedBy: string | null;
}

export const userKey = (id: string) => ["console", "user", id] as const;

const base = (id: string) => `/console/users/${encodeURIComponent(id)}`;

export const usersApi = {
  detail: (id: string) => consoleGet<ConsoleUserDetail>(base(id)),
  revokeSession: (id: string, sessionId: string, reason: string) => api.post<{ ok: true }>(`${base(id)}/sessions/${encodeURIComponent(sessionId)}/revoke`, { reason }),
  revokeAll: (id: string, reason: string) => api.post<{ ok: true; sessionsEnded: number }>(`${base(id)}/sessions/revoke-all`, { reason }),
  ban: (id: string, reason: string, expiresInDays: number | null) => api.post<{ ok: true }>(`${base(id)}/ban`, { reason, expiresInDays }),
  unban: (id: string, reason: string) => api.post<{ ok: true }>(`${base(id)}/unban`, { reason }),
  clearLockout: (id: string, reason: string) => api.post<{ ok: true; wasLocked: boolean }>(`${base(id)}/clear-lockout`, { reason }),
  verify: (id: string, reason: string) => api.post<{ ok: true; alreadyVerified: boolean }>(`${base(id)}/verify`, { reason }),
  remove: (id: string, reason: string) => api.del<{ ok: true }>(base(id), { reason }),
};

/** A language code in plain words in the operator's language ("en" -> "English"); the code when there is no name. */
export function languageName(code: string | null | undefined): string | null {
  if (!code) return null;
  try { return new Intl.DisplayNames(undefined, { type: "language" }).of(code) ?? code; } catch { return code; }
}

/** "credential" reads as "Password"; providers get a capital letter. No method yet reads "No sign in yet". */
export function signInMethodLabel(method: string | null | undefined, none = "No sign in yet"): string {
  if (!method) return none;
  const m = method.toLowerCase();
  if (m === "credential" || m === "email") return "Password";
  if (m === "auth0") return "Single sign on";
  if (m === "magic-link") return "Email link";
  if (m === "passkey") return "Passkey";
  return m.charAt(0).toUpperCase() + m.slice(1);
}

/** A short device name from a user agent ("Chrome on macOS"). */
export function deviceLabel(ua: string | null | undefined): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /Multies|okhttp|CFNetwork|Expo/i.test(ua) ? "Multies app" : "Browser";
  const os = /iPhone|iPad|iOS/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}
