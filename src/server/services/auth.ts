import { and, eq, gt, lt, ne } from "drizzle-orm";
import type { DB } from "../db";
import { memberships, organizations, sessions, users } from "../db/schema";
import { hashPassword, newId, randomToken, sha256Hex, verifyPassword } from "../lib/crypto";
import { conflict, HttpError } from "../lib/errors";
import type { AuthContext } from "../context";
import type { SignupInput } from "@/shared/schemas";

export const SESSION_COOKIE = "mm_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_REFRESH_MS = 24 * 60 * 60 * 1000;

// A real hash of a random password, used to keep login timing constant for unknown emails.
let dummyHash: Promise<string> | null = null;

export async function createUserWithOrg(db: DB, input: SignupInput, opts: { isDemo?: boolean } = {}) {
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, input.email)).get();
  if (existing) throw conflict("An account with that email already exists. Try signing in.");
  const userId = newId("usr");
  const orgId = newId("org");
  await db.insert(users).values({ id: userId, email: input.email, name: input.name, passwordHash: await hashPassword(input.password) });
  await db.insert(organizations).values({
    id: orgId,
    name: input.organization?.trim() || `${input.name.split(" ")[0]}'s workspace`,
    isDemo: opts.isDemo ?? false,
  });
  await db.insert(memberships).values({ orgId, userId, role: "owner" });
  return { userId, orgId };
}

export async function authenticate(db: DB, email: string, password: string) {
  const user = await db.select().from(users).where(eq(users.email, email)).get();
  if (!user) {
    dummyHash ??= hashPassword(randomToken());
    await verifyPassword(password, await dummyHash);
    return null;
  }
  return (await verifyPassword(password, user.passwordHash)) ? user : null;
}

export async function createSession(db: DB, userId: string, meta: { ip?: string; userAgent?: string; now: Date }) {
  const membership = await db.select().from(memberships).where(eq(memberships.userId, userId)).get();
  if (!membership) throw new HttpError(403, "no_workspace", "This account has no workspace.");
  const token = randomToken(32);
  const id = newId("ses");
  await db.insert(sessions).values({
    id,
    tokenHash: await sha256Hex(token),
    userId,
    orgId: membership.orgId,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent?.slice(0, 300) ?? null,
    expiresAt: new Date(meta.now.getTime() + SESSION_TTL_MS),
    lastSeenAt: meta.now,
  });
  return { token, id };
}

/** Resolves a cookie token to an auth context, sliding the expiry forward once a day. */
export async function resolveSession(db: DB, token: string, now: Date): Promise<AuthContext | null> {
  const tokenHash = await sha256Hex(token);
  const row = await db
    .select({ s: sessions, u: users, m: memberships })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(memberships, and(eq(memberships.userId, sessions.userId), eq(memberships.orgId, sessions.orgId)))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)))
    .get();
  if (!row) return null;
  if (now.getTime() - row.s.lastSeenAt.getTime() > SESSION_REFRESH_MS) {
    await db.update(sessions)
      .set({ lastSeenAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) })
      .where(eq(sessions.id, row.s.id));
  }
  return { userId: row.u.id, email: row.u.email, name: row.u.name, orgId: row.s.orgId, role: row.m.role, sessionId: row.s.id };
}

export async function destroySession(db: DB, sessionId: string) {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

export async function purgeExpiredSessions(db: DB, now: Date) {
  await db.delete(sessions).where(lt(sessions.expiresAt, now));
}

export async function changePassword(db: DB, userId: string, keepSessionId: string, current: string, next: string) {
  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || !(await verifyPassword(current, user.passwordHash))) {
    throw new HttpError(422, "validation_failed", "Your current password is incorrect.", { fields: { currentPassword: "Your current password is incorrect." } });
  }
  await db.update(users).set({ passwordHash: await hashPassword(next) }).where(eq(users.id, userId));
  await db.delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)));
}

export async function signOutOtherSessions(db: DB, userId: string, keepSessionId: string) {
  await db.delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)));
}

/**
 * Deletes the user. Workspaces where they are the only member are deleted with
 * everything in them; in shared workspaces only their membership goes.
 */
export async function deleteAccount(db: DB, userId: string, password: string) {
  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    throw new HttpError(422, "validation_failed", "That password is incorrect.", { fields: { password: "That password is incorrect." } });
  }
  const mine = await db.select().from(memberships).where(eq(memberships.userId, userId));
  for (const m of mine) {
    const others = await db.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.orgId, m.orgId), ne(memberships.userId, userId)));
    if (!others.length) await db.delete(organizations).where(eq(organizations.id, m.orgId));
  }
  await db.delete(users).where(eq(users.id, userId));
}
