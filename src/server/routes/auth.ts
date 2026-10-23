import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { changePasswordSchema, deleteAccountSchema, loginSchema, signupSchema } from "@/shared/schemas";
import { authenticate, changePassword, createSession, createUserWithOrg, deleteAccount, destroySession, signOutOtherSessions, SESSION_COOKIE, SESSION_TTL_MS } from "../services/auth";
import { audit } from "../services/audit";
import { RateLimiter } from "../lib/rate-limit";
import { HttpError, tooMany } from "../lib/errors";
import { organizations } from "../db/schema";
import { createDemoWorkspace } from "../services/demo";
import { notFound } from "../lib/errors";
import { z } from "zod";
import { createWorkspace, deleteWorkspace, listWorkspaces, switchWorkspace } from "../services/team";


function setSessionCookie(c: Context<AppEnv>, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: c.var.deps.config.mode === "production",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function authRoutes() {
  const loginLimiter = new RateLimiter(10, 60_000);
  const signupLimiter = new RateLimiter(5, 60_000);
  return new Hono<AppEnv>()
  .post("/signup", async (c) => {
    if (!signupLimiter.take(c.var.ip)) throw tooMany();
    const input = await parseBody(c, signupSchema);
    const { db, now } = c.var.deps;
    const { userId, orgId } = await createUserWithOrg(db, input);
    const { token } = await createSession(db, userId, { ip: c.var.ip, userAgent: c.req.header("user-agent"), now: now() });
    await audit(db, { orgId, actorUserId: userId, actorEmail: input.email, action: "account.created", ip: c.var.ip });
    setSessionCookie(c, token);
    return c.json({ ok: true }, 201);
  })
  .post("/login", async (c) => {
    const input = await parseBody(c, loginSchema);
    if (!loginLimiter.take(`${c.var.ip}:${input.email}`)) throw tooMany();
    const { db, now } = c.var.deps;
    const user = await authenticate(db, input.email, input.password);
    if (!user) throw new HttpError(401, "invalid_credentials", "That email and password don't match.");
    const { token } = await createSession(db, user.id, { ip: c.var.ip, userAgent: c.req.header("user-agent"), now: now() });
    const auth = await db.query.memberships.findFirst({ where: (m, { eq }) => eq(m.userId, user.id) });
    if (auth) await audit(db, { orgId: auth.orgId, actorUserId: user.id, actorEmail: user.email, action: "auth.login", ip: c.var.ip });
    setSessionCookie(c, token);
    return c.json({ ok: true });
  })
  /** Opens a sandbox workspace with sample data. Only when DEMO_MODE is on. */
  .post("/demo", async (c) => {
    const { db, now, config } = c.var.deps;
    if (!config.demoEnabled) throw notFound("Demo");
    if (!signupLimiter.take(c.var.ip)) throw tooMany();
    const { userId } = await createDemoWorkspace(c.var.deps);
    const { token } = await createSession(db, userId, { ip: c.var.ip, userAgent: c.req.header("user-agent"), now: now() });
    setSessionCookie(c, token);
    return c.json({ ok: true }, 201);
  })
  .post("/logout", requireAuth, async (c) => {
    const { auth } = c.var;
    await destroySession(c.var.deps.db, auth.sessionId);
    await audit(c.var.deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "auth.logout", ip: c.var.ip });
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  })
  .post("/password", requireAuth, async (c) => {
    const { auth, deps } = c.var;
    if (!loginLimiter.take(`pw:${auth.userId}`)) throw tooMany();
    const { currentPassword, newPassword } = await parseBody(c, changePasswordSchema);
    await changePassword(deps.db, auth.userId, auth.sessionId, currentPassword, newPassword);
    await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "auth.password_changed", ip: c.var.ip });
    return c.json({ ok: true });
  })
  .post("/sessions/revoke-others", requireAuth, async (c) => {
    const { auth, deps } = c.var;
    await signOutOtherSessions(deps.db, auth.userId, auth.sessionId);
    await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "auth.sessions_revoked", ip: c.var.ip });
    return c.json({ ok: true });
  })
  .delete("/account", requireAuth, async (c) => {
    const { auth, deps } = c.var;
    if (!loginLimiter.take(`del:${auth.userId}`)) throw tooMany();
    const { password } = await parseBody(c, deleteAccountSchema);
    await deleteAccount(deps.db, auth.userId, password);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  })
  .get("/workspaces", requireAuth, async (c) => {
    return c.json({ workspaces: await listWorkspaces(c.var.deps.db, c.var.auth.userId), currentId: c.var.auth.orgId });
  })
  .post("/workspaces", requireAuth, async (c) => {
    const { name } = await parseBody(c, z.object({ name: z.string().trim().min(1, "Give the workspace a name.").max(100) }));
    const { auth, deps } = c.var;
    const id = await createWorkspace(deps.db, auth, name);
    await audit(deps.db, { orgId: id, actorUserId: auth.userId, actorEmail: auth.email, action: "workspace.created", metadata: { name }, ip: c.var.ip });
    return c.json({ id }, 201);
  })
  .post("/workspaces/:id/switch", requireAuth, async (c) => {
    await switchWorkspace(c.var.deps.db, c.var.auth, c.req.param("id"));
    return c.json({ ok: true });
  })
  .delete("/workspace", requireAuth, async (c) => {
    const { auth, deps } = c.var;
    const { password } = await parseBody(c, deleteAccountSchema);
    await deleteWorkspace(deps.db, auth, password);
    const left = await deps.db.query.memberships.findFirst({ where: (m, { eq }) => eq(m.userId, auth.userId) });
    if (!left) { await destroySession(deps.db, auth.sessionId); deleteCookie(c, SESSION_COOKIE, { path: "/" }); }
    return c.json({ ok: true, signedOut: !left });
  })
  .get("/me", requireAuth, async (c) => {
    const { auth } = c.var;
    const org = await c.var.deps.db.select().from(organizations).where(eq(organizations.id, auth.orgId)).get();
    return c.json({
      user: { id: auth.userId, email: auth.email, name: auth.name },
      organization: org ? { id: org.id, name: org.name, plan: org.plan, isDemo: org.isDemo, role: auth.role } : null,
    });
  });
}

export { setSessionCookie };
