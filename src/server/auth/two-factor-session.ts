/**
 * OPS1 security review M2: which sessions proved a second factor.
 *
 * Better Auth 1.7.12 asks for the two-step code only after /sign-in/email, /sign-in/username and
 * /sign-in/phone-number (two-factor plugin, after hook). A sign in through an OAuth provider, /mobile/exchange or a
 * passkey never asks, and nothing on the session says whether the code was given. So the console marks the session
 * itself, and operatorSession requires the mark:
 *
 * - The auth after hook (auth/options.ts) marks the NEW session when /two-factor/verify-totp, /verify-otp or
 *   /verify-backup-code succeeds and hands out a session. That is either the second step of a sign in (no session
 *   before it) or the end of an enrolment (signed in; the plugin swaps the session after the first accepted code, so
 *   the code was just proven). A signed in re-check of a code hands out no session and marks nothing.
 * - A passkey sign in (routes/passkeys-des1.ts) is marked too: the app's passkeys require user verification
 *   (userVerification "required" at registration and sign in), so the passkey is a second factor on its own.
 * - Marks are written ONLY for accounts that hold an operator role or are listed in PLATFORM_ADMIN_EMAILS, so an
 *   ordinary sign in costs no write. Stored in app_settings as two_factor_session:<userId>:<sessionId> (a primary key
 *   read per console request; no migration).
 * - Stale marks are bounded: a mark only counts for the request's own live session, each new mark deletes the same
 *   person's marks whose session is gone, and turning two-step off deletes all of that person's marks.
 *
 * A trusted device cookie lets /sign-in/email skip the code; such a session is not marked, so the console asks for a
 * sign in with the code.
 */
import { and, eq, gte, lt } from "drizzle-orm";
import type { Deps } from "../context";
import { appSettings, sessions } from "../db/schema";
import { inIds } from "../lib/sql-chunks";

export type SecondFactor = "totp" | "otp" | "backup_code" | "enrolment" | "passkey";

const prefix = (userId: string) => `two_factor_session:${userId}:`;
const markKey = (userId: string, sessionId: string) => `${prefix(userId)}${sessionId}`;
/** Every key of one person's marks: [prefix, prefix + U+FFFF), a range over the primary key. */
const range = (userId: string) => and(gte(appSettings.key, prefix(userId)), lt(appSettings.key, `${prefix(userId)}￿`));

/**
 * Marks `sessionId` as having proved a second factor, for an operator or a PLATFORM_ADMIN_EMAILS account only.
 * Returns whether a mark was written.
 */
export async function markTwoFactorSession(deps: Pick<Deps, "db" | "config" | "now">, user: { id: string; email: string; role?: string | null }, sessionId: string, how: SecondFactor): Promise<boolean> {
  const { isProtectedAccount } = await import("../services/console/users");
  if (!isProtectedAccount(deps.config, { id: user.id, email: user.email, role: user.role ?? null })) return false;
  const value = JSON.stringify({ how, at: deps.now().toISOString() });
  await deps.db.insert(appSettings).values({ key: markKey(user.id, sessionId), value }).onConflictDoUpdate({ target: appSettings.key, set: { value } });
  // Tidy this person's marks whose session no longer exists (signed out, revoked, expired and swept).
  const marks = await deps.db.select({ key: appSettings.key }).from(appSettings).where(range(user.id));
  const ids = marks.map((m) => m.key.slice(prefix(user.id).length));
  if (ids.length > 1) {
    const live = new Set((await deps.db.select({ id: sessions.id }).from(sessions).where(inIds(sessions.id, ids))).map((r) => r.id));
    const stale = marks.filter((m, i) => !live.has(ids[i]!)).map((m) => m.key);
    if (stale.length) await deps.db.delete(appSettings).where(inIds(appSettings.key, stale));
  }
  return true;
}

/** Whether this live session proved a second factor (one primary key read). */
export async function sessionHasSecondFactor(deps: Pick<Deps, "db">, userId: string, sessionId: string): Promise<boolean> {
  const row = await deps.db.select({ key: appSettings.key }).from(appSettings).where(eq(appSettings.key, markKey(userId, sessionId))).get();
  return !!row;
}

/** Forgets every mark of one person (two-step sign in turned off). */
export async function clearTwoFactorMarks(deps: Pick<Deps, "db">, userId: string): Promise<void> {
  await deps.db.delete(appSettings).where(range(userId));
}
