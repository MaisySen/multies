import { eq, lt } from "drizzle-orm";
import type { DB } from "../db";
import { loginThrottle } from "../db/schema";

/**
 * Account lockout against password guessing spread over many IPs (credential stuffing).
 * The per-IP limits catch one noisy client; this counts failures per account.
 * After MAX_FAILURES failed sign-ins inside WINDOW, the account refuses password
 * sign-in for LOCK_FOR, whatever the IP. A successful sign-in clears the count.
 * Single sign-on and password reset still work while locked, so the real owner is
 * never stuck.
 */
export const LOCKOUT = { MAX_FAILURES: 10, WINDOW_MS: 15 * 60_000, LOCK_FOR_MS: 15 * 60_000 } as const;

const norm = (email: string) => email.trim().toLowerCase();

/** Returns the time the lock lifts, or null when sign-in may proceed. */
export async function lockedUntil(db: DB, email: string, now: Date): Promise<Date | null> {
  const row = await db.select().from(loginThrottle).where(eq(loginThrottle.email, norm(email))).get();
  if (!row?.lockedUntil) return null;
  const until = new Date(row.lockedUntil);
  return until > now ? until : null;
}

/** Records one failed password sign-in. Returns true when this failure locked the account. */
export async function recordFailure(db: DB, email: string, now: Date): Promise<boolean> {
  const key = norm(email);
  const row = await db.select().from(loginThrottle).where(eq(loginThrottle.email, key)).get();
  const fresh = !row || now.getTime() - new Date(row.windowStart).getTime() > LOCKOUT.WINDOW_MS;
  const failures = fresh ? 1 : row.failures + 1;
  const lock = failures >= LOCKOUT.MAX_FAILURES ? new Date(now.getTime() + LOCKOUT.LOCK_FOR_MS) : null;
  await db.insert(loginThrottle).values({ email: key, failures, windowStart: fresh ? now : row.windowStart, lockedUntil: lock })
    .onConflictDoUpdate({ target: loginThrottle.email, set: { failures, windowStart: fresh ? now : row!.windowStart, lockedUntil: lock } });
  return !!lock && failures === LOCKOUT.MAX_FAILURES;
}

export async function clearFailures(db: DB, email: string) {
  await db.delete(loginThrottle).where(eq(loginThrottle.email, norm(email)));
}

export async function pruneLockouts(db: DB, now: Date) {
  await db.delete(loginThrottle).where(lt(loginThrottle.windowStart, new Date(now.getTime() - 24 * 3600_000)));
}
