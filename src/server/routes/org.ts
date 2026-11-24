import { auditExport, toCsv } from "../services/privacy";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../context";
import { pageQuery, parseBody, parseQuery, requireAdmin, requireAuth } from "../middleware";
import { organizations } from "../db/schema";
import { audit, listAudit, type AuditFilter } from "../services/audit";
import { AUDIT_AREAS } from "@/shared/mail-archive";
import { getAddons, getOrg, getOrgCached, getPlanCached, overLimits, usage } from "../services/plans";
import { PLANS, effectiveLimits, isPlanId, PLAN_ORDER } from "@/shared/plans";
import { badRequest, forbidden, HttpError, nothingToChange } from "../lib/errors";
import { isCountry, isTimeZone } from "@/shared/locale";

// R52: query schemas built once per isolate, not on every request (zod schema construction is real CPU on a warm request).
const Q_ORG_1 = z.object({ format: z.enum(["csv", "json"]).default("csv"), from: z.coerce.date().optional(), to: z.coerce.date().optional() });

export function orgRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => {
      const { db } = c.var.deps;
      // R40 deploy 3: the workspace row and plan come from the short per isolate copy (services/plans.ts), and the
      // usage read runs beside them: one D1 query on a warm isolate instead of four in a row.
      const orgId = c.var.auth.orgId;
      const [org, plan, used] = await Promise.all([getOrgCached(db, orgId), getPlanCached(db, orgId), usage(db, orgId, c.var.deps.now())]);
      return c.json({ organization: { ...org, role: c.var.auth.role }, plan, usage: used });
    })
    .patch("/", requireAdmin, async (c) => {
      const input = await parseBody(c, z.object({
        name: z.string().trim().min(1).max(100).optional(),
        timezone: z.string().refine(isTimeZone, "Unknown time zone.").optional(),
        country: z.string().refine(isCountry, "Pick a country from the list.").optional(),
      }));
      // MB-368: an empty body (or one with only unknown fields) used to reach the database as an empty update: a 500.
      if (!Object.values(input).some((v) => v !== undefined)) throw nothingToChange();
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
    // Team SSO enforcement (every plan): members must sign in through SSO; the owner is exempt as break glass.
    .put("/sso", async (c) => {
      const { required } = await parseBody(c, z.object({ required: z.boolean() }));
      const { auth, deps } = c.var;
      if (auth.role !== "owner") throw forbidden("Only the workspace owner can change single sign on enforcement.");
      if (required && !deps.config.auth.auth0 && !deps.config.auth.social.google) throw badRequest("No SSO provider is connected on this deployment yet.");
      await deps.db.update(organizations).set({ requireSso: required }).where(eq(organizations.id, auth.orgId));
      // PRIV1b (P41): apps signed in before enforcement (maybe from a password session) end; the owner's stay.
      if (required) await (await import("../services/developer/oauth")).revokeGrantsForSso(deps, auth.orgId);
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: required ? "workspace.sso_required" : "workspace.sso_optional", ip: c.var.ip });
      return c.json({ ok: true, requireSso: required });
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
      if (org.compPlan) throw new HttpError(409, "comp_plan", "This workspace is on an internal plan. Its plan doesn't change here.");
      if (deps.config.billing.enabled && !org.isDemo) {
        throw new HttpError(409, "use_billing", "Plans are changed through billing. Open Settings → Billing.");
      }
      const used = await usage(deps.db, auth.orgId, deps.now());
      const target = PLANS[plan];
      const over = overLimits(used, effectiveLimits(target, await getAddons(deps.db, auth.orgId), org));
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
      const q = parseQuery(c, Q_ORG_1);
      const f = auditFilterFrom(c);
      // B7: the range is applied in SQL and, past the export's size, the newest rows are kept and a header says so.
      const exported = await auditExport(deps, auth.orgId, q.from ?? f?.from, q.to ?? f?.to, { filter: f });
      const rows = exported.rows.filter((r) => auditRowMatches(r, f));
      const day = deps.now().toISOString().slice(0, 10);
      const body = q.format === "csv" ? toCsv(rows) : JSON.stringify(rows, null, 2);
      return new Response(body, {
        headers: {
          "content-type": q.format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="multies-audit-${day}.${q.format}"`, "cache-control": "no-store",
          ...(exported.truncated ? { "x-audit-truncated": "newest-kept" } : {}),
        },
      });
    })
    // R39 security hotfix: the audit log carries IPs, emails and invitation activity, so it is for owners and admins only.
    .get("/audit", requireAdmin, async (c) => {
      const { limit, before } = parseQuery(c, pageQuery);
      const entries = await listAudit(c.var.deps.db, c.var.auth.orgId, { limit, before, filter: auditFilterFrom(c) });
      return c.json({ entries });
    });
}

/** R111: the Audit log filters (area, person, from, to as yyyy-mm-dd UTC days), only while MAIL_ARCHIVE_R111 is on. */
function auditFilterFrom(c: Context<AppEnv>): AuditFilter | undefined {
  if (!c.var.deps.config.mailArchive) return undefined;
  const q = (k: string) => (c.req.query(k) ?? "").trim().slice(0, 254);
  const day = (v: string, add = 0) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(Date.parse(`${v}T00:00:00Z`) + add) : undefined);
  const area = AUDIT_AREAS.find((a) => a.id === q("area"));
  const f: AuditFilter = { prefixes: area?.prefixes, actor: q("actor") || undefined, from: day(q("since")), to: day(q("until"), 86_400_000) };
  return f.prefixes || f.actor || f.from || f.to ? f : undefined;
}
function auditRowMatches(r: { action?: unknown; actor?: unknown }, f: AuditFilter | undefined) {
  if (!f) return true;
  if (f.prefixes && !f.prefixes.some((p) => String(r.action ?? "").startsWith(p))) return false;
  if (f.actor && !String(r.actor ?? "").toLowerCase().includes(f.actor.toLowerCase())) return false;
  return true;
}
