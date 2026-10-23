import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../context";
import { parseBody, requireAdmin, requireAuth } from "../middleware";
import { organizations } from "../db/schema";
import { audit, listAudit } from "../services/audit";
import { getOrg, usage } from "../services/plans";
import { PLANS, isPlanId, PLAN_ORDER } from "@/shared/plans";
import { badRequest } from "../lib/errors";

export function orgRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => {
      const { db } = c.var.deps;
      const org = await getOrg(db, c.var.auth.orgId);
      return c.json({ organization: { ...org, role: c.var.auth.role }, plan: PLANS[org.plan], usage: await usage(db, org.id) });
    })
    .patch("/", requireAdmin, async (c) => {
      const { name } = await parseBody(c, z.object({ name: z.string().trim().min(1).max(100) }));
      const { auth, deps } = c.var;
      await deps.db.update(organizations).set({ name }).where(eq(organizations.id, auth.orgId));
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "workspace.renamed", metadata: { name }, ip: c.var.ip });
      return c.json({ ok: true });
    })
    /**
     * Plan changes. Billing is not wired yet (no payment provider), so this only
     * switches limits; downgrades are refused while usage exceeds the target plan.
     */
    .post("/plan", requireAdmin, async (c) => {
      const { plan } = await parseBody(c, z.object({ plan: z.string() }));
      if (!isPlanId(plan)) throw badRequest("Unknown plan.");
      const { auth, deps } = c.var;
      const org = await getOrg(deps.db, auth.orgId);
      const used = await usage(deps.db, auth.orgId);
      const target = PLANS[plan];
      const over = (Object.keys(used) as (keyof typeof used)[]).filter((k) => used[k] > target.limits[k]);
      if (over.length) throw badRequest(`Remove some ${over.join(" and ")} before moving to ${target.name}.`);
      await deps.db.update(organizations).set({ plan }).where(eq(organizations.id, auth.orgId));
      const direction = PLAN_ORDER.indexOf(plan) > PLAN_ORDER.indexOf(org.plan) ? "upgraded" : "downgraded";
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: `plan.${direction}`, metadata: { from: org.plan, to: plan }, ip: c.var.ip });
      return c.json({ ok: true, plan: target });
    })
    .get("/audit", async (c) => {
      const before = c.req.query("before");
      const entries = await listAudit(c.var.deps.db, c.var.auth.orgId, { limit: Number(c.req.query("limit") ?? 50), before: before ? new Date(before) : undefined });
      return c.json({ entries });
    });
}
