/**
 * R45: a production test session for the build team, so a UI change can be clicked through on live while the
 * public demo is paused. App side only: nothing at the identity provider.
 *
 * POST /api/_test-session with the header x-test-session equal to the TEST_SESSION_TOKEN secret (at least 32
 * characters) makes one session for the user named by TEST_SESSION_USER_ID, and answers its cookie. Without the
 * secret and both ids set (the normal state), or with a wrong header, the path is an ordinary 404.
 *
 * Scope, checked on every call: the user must be a member of the workspace named by TEST_SESSION_ORG_ID, and of no
 * other workspace unless it is that workspace's only member (multiws, 27 Oct 2026: a second workspace the test user
 * made itself, for checking workspace switching on live); none may be a demo. Each call removes the user's earlier test sessions, so at
 * most one is live; a session lasts 24 hours. Every mint writes an audit line. Runbook: docs/runbooks/deploy.md.
 */
import { and, eq, ne } from "drizzle-orm";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import { members, organizations, sessions, users } from "../db/schema";
import { randomToken, safeEqual, toB64, toHex, randomBytes } from "../lib/crypto";
import { audit } from "../services/audit";
import { inIds } from "../lib/sql-chunks";
import { testSessionEnv, boundTestSessionEnv } from "../test-session-env-r45";
export { testSessionEnv, type TestSessionEnv } from "../test-session-env-r45";

export const TEST_SESSION_HOURS = 24;
export const TEST_SESSION_METHOD = "test-session";
const notFound = (c: Context<AppEnv>) => c.json({ error: { code: "not_found", message: "Not found." } }, 404);

/** Signs a session token the way the sign in library signs its cookie (HMAC SHA-256, base64). */
export async function signSessionToken(secret: string, token: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token));
  return `${token}.${toB64(sig)}`;
}

export async function mintTestSession(c: Context<AppEnv>) {
  // The Worker hands the app no env (worker.ts passes undefined); it binds the settings at boot instead.
  const cfg = testSessionEnv(c.env) ?? boundTestSessionEnv();
  if (!cfg) return notFound(c);
  if (!safeEqual(c.req.header("x-test-session") ?? "", cfg.token)) return notFound(c);
  const { deps } = c.var;
  const db = deps.db;
  const user = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, cfg.userId)).get();
  const rows = await db.select({ orgId: members.organizationId, isDemo: organizations.isDemo })
    .from(members).innerJoin(organizations, eq(organizations.id, members.organizationId)).where(eq(members.userId, cfg.userId)).all();
  // Multiws: the test user may also be alone in further workspaces it made itself (to check switching on live).
  // Any other workspace with even one other member, or any demo, and the mint refuses.
  const others = rows.filter((r) => r.orgId !== cfg.orgId).map((r) => r.orgId);
  const crowded = others.length
    ? await db.select({ orgId: members.organizationId }).from(members).where(and(inIds(members.organizationId, others), ne(members.userId, cfg.userId))).limit(1).all()
    : [];
  if (!user || !rows.some((r) => r.orgId === cfg.orgId) || rows.some((r) => r.isDemo) || crowded.length) {
    return c.json({ error: { code: "test_session_scope", message: "The test user must belong to the test workspace, and only to workspaces where it is the only member, none of them a demo." } }, 409);
  }
  const now = new Date(deps.now());
  const expiresAt = new Date(now.getTime() + TEST_SESSION_HOURS * 3600_000);
  const token = randomToken(24);
  await db.delete(sessions).where(and(eq(sessions.userId, cfg.userId), eq(sessions.loginMethod, TEST_SESSION_METHOD)));
  await db.insert(sessions).values({ id: `ses_${toHex(randomBytes(8))}`, token, userId: cfg.userId, expiresAt, userAgent: "test-session", activeOrganizationId: cfg.orgId, loginMethod: TEST_SESSION_METHOD, createdAt: now, updatedAt: now });
  await audit(db, { orgId: cfg.orgId, actorUserId: cfg.userId, actorEmail: user.email, action: "session.test_minted", metadata: { hours: TEST_SESSION_HOURS }, ip: c.var.ip }).catch(() => undefined);
  const value = encodeURIComponent(await signSessionToken(deps.config.appSecret, token));
  const name = "__Secure-mymail.session_token";
  c.header("cache-control", "no-store");
  return c.json({ ok: true, cookie: { name, value }, orgId: cfg.orgId, expiresAt: expiresAt.toISOString() });
}
