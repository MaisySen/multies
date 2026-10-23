import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { organizations } from "../db/schema";
import { notFound, tooMany } from "../lib/errors";
import { RateLimiter } from "../lib/rate-limit";
import { audit } from "../services/audit";
import { createDemoWorkspace } from "../services/demo";
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
    .use("*", requireAuth)
    .get("/me", async (c) => {
      const { auth } = c.var;
      const org = await c.var.deps.db.select().from(organizations).where(eq(organizations.id, auth.orgId)).get();
      return c.json({
        user: { id: auth.userId, email: auth.email, name: auth.name, emailVerified: !!auth.emailVerified, twoFactor: !!auth.twoFactor, platformAdmin: auth.platformRole === "admin" },
        organization: org ? { id: org.id, name: org.name, plan: org.plan, isDemo: org.isDemo, role: auth.role, timezone: org.timezone, country: org.country } : null,
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
    .delete("/workspace", async (c) => {
      const { auth, deps } = c.var;
      const { password } = await parseBody(c, z.object({ password: z.string().max(200).optional() }));
      const { remaining } = await deleteWorkspace(deps, auth, c.req.raw.headers, password);
      return c.json({ ok: true, remaining });
    });
}
