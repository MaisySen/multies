import { exportWorkspace, personalData } from "../services/privacy";
import { Hono } from "hono";
import { z } from "zod";
import { and, eq, ne } from "drizzle-orm";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { accounts, members, organizations, users } from "../db/schema";
import { beforeUserDelete } from "../services/privacy";
import { HttpError, notFound, tooMany } from "../lib/errors";
import { authFor } from "../auth";
import { verifyPassword } from "../lib/crypto";
import { RateLimiter } from "../lib/rate-limit";
import { audit } from "../services/audit";
import { createDemoWorkspace } from "../services/demo";
import { runDueJobs } from "../services/jobs";
import { createWorkspace, deleteWorkspace, listWorkspaces, switchWorkspace } from "../services/team";

/**
 * Product-level account endpoints. Sign-up, sign-in, sessions, 2FA, password reset
 * and email verification are Better Auth's, served under /api/auth.
 */
export function accountRoutes() {
  const demoLimiter = new RateLimiter(5, 60 * 60_000);
  return new Hono<AppEnv>()
    .get("/providers", (c) => {
      const { auth } = c.var.deps.config;
      return c.json({ google: !!auth.social.google, github: !!auth.social.github, auth0: !!auth.auth0 });
    })
    /** Opens a sandbox workspace with sample data. Only when DEMO_MODE is on. */
    .post("/demo", async (c) => {
      if (!c.var.deps.config.demoEnabled) throw notFound("Demo");
      if (!demoLimiter.take(c.var.ip)) throw tooMany();
      const { headers } = await createDemoWorkspace(c.var.deps);
      for (const cookie of headers.getSetCookie()) c.header("set-cookie", cookie, { append: true });
      return c.json({ ok: true }, 201);
    })
    /**
     * Seeds the demo's sample tasks, docs and deals. The app calls it straight after opening a
     * demo. It runs in its own request because the seed and the workspace together make more
     * queries than one Workers invocation may.
     */
    .post("/demo/seed", requireAuth, async (c) => {
      const org = await c.var.deps.db.select({ isDemo: organizations.isDemo }).from(organizations).where(eq(organizations.id, c.var.auth.orgId)).get();
      if (!org?.isDemo) throw notFound("Demo");
      const r = await runDueJobs(c.var.deps, 1, { types: ["demo.seed_suite"], orgId: c.var.auth.orgId });
      return c.json({ ok: true, ran: r.ran });
    })
    .use("*", requireAuth)
    .get("/me", async (c) => {
      const { auth } = c.var;
      const org = await c.var.deps.db.select().from(organizations).where(eq(organizations.id, auth.orgId)).get();
      return c.json({
        user: { id: auth.userId, email: auth.email, name: auth.name, emailVerified: !!auth.emailVerified, twoFactor: !!auth.twoFactor, platformAdmin: auth.platformRole === "admin" },
        organization: org ? { id: org.id, name: org.name, plan: org.plan, isDemo: org.isDemo, role: auth.role, timezone: org.timezone, country: org.country, requireSso: org.requireSso } : null,
        session: { loginMethod: auth.loginMethod ?? "email", ssoBlocked: !!auth.ssoBlocked },
      });
    })
    .get("/workspaces", async (c) => {
      return c.json({ workspaces: await listWorkspaces(c.var.deps.db, c.var.auth.userId), currentId: c.var.auth.orgId });
    })
    .post("/workspaces", async (c) => {
      const { name } = await parseBody(c, z.object({ name: z.string().trim().min(1, "Give the workspace a name.").max(100) }));
      const { auth, deps } = c.var;
      const id = await createWorkspace(deps, auth, c.req.raw.headers, name);
      await audit(deps.db, { orgId: id, actorUserId: auth.userId, actorEmail: auth.email, action: "workspace.created", metadata: { name }, ip: c.var.ip });
      return c.json({ id }, 201);
    })
    .post("/workspaces/:id/switch", async (c) => {
      await switchWorkspace(c.var.deps, c.var.auth, c.req.raw.headers, c.req.param("id"));
      return c.json({ ok: true });
    })
    // Privacy: a copy of everything held about the signed-in person (JSON download).
    .get("/export", async (c) => {
      const data = await personalData(c.var.deps, c.var.auth.userId);
      return new Response(JSON.stringify(data, null, 2), {
        headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="mymail-account-${data.exportedAt.slice(0, 10)}.json"`, "cache-control": "no-store" },
      });
    })
    // Privacy: the whole workspace as a streamed ZIP (owners and admins).
    .get("/workspace/export", async (c) => {
      const stream = exportWorkspace(c.var.deps, c.var.auth);
      const day = c.var.deps.now().toISOString().slice(0, 10);
      return new Response(stream, {
        headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="mymail-workspace-${day}.zip"`, "cache-control": "no-store" },
      });
    })
    /**
     * Deletes the signed-in person's account (App Store and Google Play require an in-app
     * path; the phone app and the /delete-account page call this). Workspaces where they are
     * the only member go with them, mail included. Body: { confirm: "DELETE", password? }.
     */
    .delete("/", async (c) => {
      const { auth, deps } = c.var;
      const body = await parseBody(c, z.object({ confirm: z.string().max(20).optional(), password: z.string().max(200).optional() }));
      if (body.confirm !== "DELETE") throw new HttpError(400, "confirm_required", "Type DELETE to confirm.");
      const cred = await deps.db.select({ password: accounts.password }).from(accounts)
        .where(and(eq(accounts.userId, auth.userId), eq(accounts.providerId, "credential"))).get();
      // A demo visitor never chose a password (the demo flow sets a random one) and cannot
      // sign in again, so their sandbox goes on the confirm word alone.
      const orgs = await deps.db.select({ isDemo: organizations.isDemo }).from(members)
        .innerJoin(organizations, eq(organizations.id, members.organizationId)).where(eq(members.userId, auth.userId));
      const demoOnly = orgs.length > 0 && orgs.every((o) => o.isDemo);
      if (cred?.password && !demoOnly) {
        if (!body.password) throw new HttpError(400, "password_required", "Enter your password to confirm.");
        if (!(await verifyPassword(body.password, cred.password))) throw new HttpError(403, "wrong_password", "That password is incorrect.");
      }
      const mine = await deps.db.select({ orgId: members.organizationId, role: members.role }).from(members).where(eq(members.userId, auth.userId));
      const blocking: string[] = [];
      let alone = 0;
      for (const m of mine) {
        const others = await deps.db.select({ role: members.role }).from(members)
          .where(and(eq(members.organizationId, m.orgId), ne(members.userId, auth.userId)));
        if (!others.length) alone++;
        else if (m.role === "owner" && !others.some((o) => o.role === "owner")) {
          const org = await deps.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, m.orgId)).get();
          blocking.push(org?.name ?? m.orgId);
        }
      }
      if (blocking.length) {
        return c.json({ error: { code: "transfer_ownership_first", message: `You are the only owner of ${blocking.join(", ")}, which has other members. Make someone else an owner first.` }, workspaces: blocking }, 409);
      }
      if (demoOnly) {
        const out = await authFor(deps).api.signOut({ headers: c.req.raw.headers, asResponse: true });
        await beforeUserDelete(deps, auth.userId);
        await deps.db.delete(users).where(eq(users.id, auth.userId));
        for (const cookie of out.headers.getSetCookie()) c.header("set-cookie", cookie, { append: true });
        return c.json({ ok: true, deletedWorkspaces: alone });
      }
      const res = await authFor(deps).api.deleteUser({ headers: c.req.raw.headers, body: cred?.password ? { password: body.password } : {}, asResponse: true });
      if (!res.ok) {
        if (res.status === 401 || res.status === 400) throw new HttpError(403, "reauth_required", "Sign in again to confirm it's you, then retry.");
        throw new HttpError(500, "delete_failed", "Your account could not be deleted. Try again, or contact support.");
      }
      for (const cookie of res.headers.getSetCookie()) c.header("set-cookie", cookie, { append: true });
      return c.json({ ok: true, deletedWorkspaces: alone });
    })
    .delete("/workspace", async (c) => {
      const { auth, deps } = c.var;
      const { password } = await parseBody(c, z.object({ password: z.string().max(200).optional() }));
      const { remaining } = await deleteWorkspace(deps, auth, c.req.raw.headers, password);
      return c.json({ ok: true, remaining });
    });
}
