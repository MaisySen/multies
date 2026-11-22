/**
 * OPS1 security review M2: when an account turned on two-step sign in.
 *
 * Better Auth 1.7.12's two-factor plugin records no enrolment time (two_factors has secret, backup codes, verified,
 * failed count and lock only) and nothing on the session says it passed the second step. When an account finishes
 * enrolling (POST /two-factor/verify-totp while signed in, the first time a code is accepted), the plugin sets
 * users.two_factor_enabled and swaps the request's session for a NEW one (a fresh created_at) inside the endpoint.
 * So a session that existed before enrolment, or the one the enrolment itself handed out, never passed a two-step
 * sign in, even though the account flag is now on.
 *
 * The auth after hook (auth/options.ts) records the enrolment time here once the endpoint has finished, so it is later
 * than the swapped session's created_at. operatorSession then refuses a console session created at or before it: the
 * operator signs in again, and that sign in asks for the second step. Stored in app_settings under one key per account
 * (a primary key read; no migration). Accounts that enrolled before this was added have no record and are not refused.
 */
import { eq } from "drizzle-orm";
import type { DB } from "../db";
import { appSettings } from "../db/schema";

const key = (userId: string) => `two_factor_enrolled_at:${userId}`;

/** Records that `userId` finished turning on two-step sign in at `at` (replacing an earlier record). */
export async function recordTwoFactorEnrolment(db: DB, userId: string, at: Date): Promise<void> {
  const value = String(at.getTime());
  await db.insert(appSettings).values({ key: key(userId), value }).onConflictDoUpdate({ target: appSettings.key, set: { value } });
}

/** When `userId` last finished turning on two-step sign in, or null when unknown. */
export async function twoFactorEnrolledAt(db: DB, userId: string): Promise<Date | null> {
  const row = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key(userId))).get();
  const ms = row ? Number(row.value) : Number.NaN;
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * True when this session was created after the account's last two-step enrolment (or no enrolment time is known):
 * the session came from a sign in that asked for the second step. False for a session created at or before it.
 * One primary key read per console request (no in-isolate copy: a later re-enrolment must apply at once).
 */
export async function sessionPostdatesEnrolment(db: DB, auth: { userId: string; sessionCreatedAt?: Date | null }): Promise<boolean> {
  const at = await twoFactorEnrolledAt(db, auth.userId);
  if (!at) return true;
  return !!auth.sessionCreatedAt && auth.sessionCreatedAt.getTime() > at.getTime();
}
