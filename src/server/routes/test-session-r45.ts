/**
 * R45: a production test session for the build team, so a UI change can be clicked through on live while the
 * public demo is paused. App side only: nothing at the identity provider.
 *
 * POST /api/_test-session with the header x-test-session equal to the TEST_SESSION_TOKEN secret (at least 32
 * characters) makes one session for the user named by TEST_SESSION_USER_ID, and answers its cookie. Without the
 * secret and both ids set (the normal state), or with a wrong header, the path is an ordinary 404.
 *
 * Scope, checked on every call: the user must be a member of exactly one workspace, that workspace must be the one
 * named by TEST_SESSION_ORG_ID, and it must not be a demo. Each call removes the user's earlier test sessions, so at
 * most one is live; a session lasts 24 hours. Every mint writes an audit line. Runbook: docs/runbooks/deploy.md.
 */
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import { members, organizations, sessions, users } from "../db/schema";
import { randomToken, safeEqual, toB64, toHex, randomBytes } from "../lib/crypto";
import { audit } from "../services/audit";

export const TEST_SESSION_HOURS = 24;
export const TEST_SESSION_METHOD = "test-session";
const notFound = (c: Context<AppEnv>) => c.json({ error: { code: "not_found", message: "Not found." } }, 404);

export interface TestSessionEnv { token: string; userId: string; orgId: string }

/** The three settings, or null when the feature is off (any of them missing or the token too short). */
export function testSessionEnv(env: unknown): TestSessionEnv | null {
  const e = (env ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof e[k] === "string" ? (e[k] as string) : "");
  const token = s("TEST_SESSION_TOKEN"), userId = s("TEST_SESSION_USER_ID"), orgId = s("TEST_SESSION_ORG_ID");
  if (token.length < 32 || !/^usr_[a-z0-9]+$/.test(userId) || !/^org_[a-z0-9]+$/.test(orgId)) return null;
  return { token, userId, orgId };
}

/** Signs a session token the way the sign in library signs its cookie (HMAC SHA-256, base64). */
export async function signSessionToken(secret: string, token: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token));
  return `${token}.${toB64(sig)}`;
}

export async function mintTestSession(c: Context<AppEnv>) {
  const cfg = testSessionEnv(c.env);
  if (!cfg) return notFound(c);
  if (!safeEqual(c.req.header("x-test-session") ?? "", cfg.token)) return notFound(c);
  const { deps } = c.var;
  const db = deps.db;
  const user = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, cfg.userId)).get();
  const rows = await db.select({ orgId: members.organizationId, isDemo: organizations.isDemo })
    .from(members).innerJoin(organizations, eq(organizations.id, members.organizationId)).where(eq(members.userId, cfg.userId)).all();
  if (!user || rows.length !== 1 || rows[0].orgId !== cfg.orgId || rows[0].isDemo) {
    return c.json({ error: { code: "test_session_scope", message: "The test user must belong to exactly the one test workspace, and it must not be a demo." } }, 409);
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
