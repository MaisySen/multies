import { auditRows, toCsv } from "../services/privacy";
import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../context";
import { pageQuery, parseBody, parseQuery, requireAdmin, requireAuth } from "../middleware";
import { organizations } from "../db/schema";
import { audit, listAudit } from "../services/audit";
import { getOrg, usage } from "../services/plans";
import { PLANS, isPlanId, PLAN_ORDER } from "@/shared/plans";
import { badRequest, forbidden, HttpError } from "../lib/errors";
import { COUNTRIES, isTimeZone } from "@/shared/locale";

export function orgRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => {
      const { db } = c.var.deps;
      const org = await getOrg(db, c.var.auth.orgId);
      return c.json({ organization: { ...org, role: c.var.auth.role }, plan: PLANS[org.plan], usage: await usage(db, org.id) });
    })
    .patch("/", requireAdmin, async (c) => {
      const input = await parseBody(c, z.object({
        name: z.string().trim().min(1).max(100).optional(),
        timezone: z.string().refine(isTimeZone, "Unknown time zone.").optional(),
        country: z.enum(COUNTRIES).optional(),
      }));
      const { auth, deps } = c.var;
      const before = await getOrg(deps.db, auth.orgId);
      await deps.db.update(organizations).set(input).where(eq(organizations.id, auth.orgId));
      if (input.name && input.name !== before.name) {
        await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "workspace.renamed", metadata: { name: input.name }, ip: c.var.ip });
      }
      if ((input.timezone && input.timezone !== before.timezone) || (input.country && input.country !== before.country)) {
        await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "workspace.region_changed", metadata: { timezone: input.timezone ?? before.timezone, country: input.country ?? before.country }, ip: c.var.ip });
      }
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
      if (deps.config.billing.enabled && !org.isDemo) {
        throw new HttpError(409, "use_billing", "Plans are changed through billing. Open Settings → Billing.");
      }
      const used = await usage(deps.db, auth.orgId);
      const target = PLANS[plan];
      const over = (Object.keys(used) as (keyof typeof used)[]).filter((k) => used[k] > target.limits[k]);
      if (over.length) throw badRequest(`Remove some ${over.join(" and ")} before moving to ${target.name}.`);
      await deps.db.update(organizations).set({ plan }).where(eq(organizations.id, auth.orgId));
      const direction = PLAN_ORDER.indexOf(plan) > PLAN_ORDER.indexOf(org.plan) ? "upgraded" : "downgraded";
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: `plan.${direction}`, metadata: { from: org.plan, to: plan }, ip: c.var.ip });
      return c.json({ ok: true, plan: target });
    })
    // Audit log export for compliance reviews: CSV (default) or JSON, optional date range.
    .get("/audit/export", async (c) => {
      const { auth, deps } = c.var;
      if (auth.role !== "owner" && auth.role !== "admin") throw forbidden("Only workspace owners and admins can export the audit log.");
      const q = parseQuery(c, z.object({ format: z.enum(["csv", "json"]).default("csv"), from: z.coerce.date().optional(), to: z.coerce.date().optional() }));
      const rows = await auditRows(deps, auth.orgId, q.from, q.to);
      const day = deps.now().toISOString().slice(0, 10);
      const body = q.format === "csv" ? toCsv(rows) : JSON.stringify(rows, null, 2);
      return new Response(body, {
        headers: {
          "content-type": q.format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="mymail-audit-${day}.${q.format}"`, "cache-control": "no-store",
        },
      });
    })
    .get("/audit", async (c) => {
      const { limit, before } = parseQuery(c, pageQuery);
      const entries = await listAudit(c.var.deps.db, c.var.auth.orgId, { limit, before });
      return c.json({ entries });
    });
}
