import { Hono } from "hono";
import { z } from "zod";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AppEnv } from "../context";
import { parseBody, requireAuth, requirePlatformAdmin } from "../middleware";
import { abuseEvents, deliveries, domains, mailboxes, members, organizations, users } from "../db/schema";
import { audit } from "../services/audit";
import { listJobs, queueStats, replayJobs } from "../services/jobs";
import { getOrg } from "../services/plans";

/** Operator console API. Platform admins only (Better Auth admin role). */
export function adminRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth, requirePlatformAdmin)
    .get("/overview", async (c) => {
      const { db, config } = c.var.deps;
      const [u, o, d, m, sent] = await Promise.all([
        db.select({ n: count() }).from(users).get(),
        db.select({ n: count() }).from(organizations).where(eq(organizations.isDemo, false)).get(),
        db.select({ n: count() }).from(domains).get(),
        db.select({ n: count() }).from(mailboxes).get(),
        db.select({ n: count() }).from(deliveries).where(sql`${deliveries.createdAt} > ${Date.now() - 24 * 3600_000}`).get(),
      ]);
      const tenants = await db.select({
        id: organizations.id, name: organizations.name, plan: organizations.plan, isDemo: organizations.isDemo, createdAt: organizations.createdAt,
        suspendedAt: organizations.suspendedAt, suspendedReason: organizations.suspendedReason, sendCapDaily: organizations.sendCapDaily,
        pastDueSince: organizations.pastDueSince,
        members: sql<number>`(select count(*) from ${members} where ${members.organizationId} = ${organizations.id})`,
        domains: sql<number>`(select count(*) from ${domains} where ${domains.orgId} = ${organizations.id})`,
      }).from(organizations).orderBy(desc(organizations.createdAt)).limit(100);
      return c.json({
        totals: { users: u?.n ?? 0, workspaces: o?.n ?? 0, domains: d?.n ?? 0, mailboxes: m?.n ?? 0, deliveries24h: sent?.n ?? 0 },
        tenants,
        integrations: {
          sentryApi: !!config.sentry.dsnApi, sentryWeb: !!config.sentry.dsnWeb,
          outbound: c.var.deps.outbound.name, billing: config.billing.enabled, billingTestMode: config.billing.testMode,
          auth0: !!config.auth.auth0, google: !!config.auth.social.google, github: !!config.auth.social.github,
        },
      });
    })
    // Abuse controls: open signals, suspensions and send caps. Every action is audited on the workspace.
    .get("/abuse", async (c) => {
      const { db } = c.var.deps;
      const events = await db.select({
        id: abuseEvents.id, orgId: abuseEvents.orgId, workspace: organizations.name, kind: abuseEvents.kind, score: abuseEvents.score,
        detail: abuseEvents.detail, createdAt: abuseEvents.createdAt,
      }).from(abuseEvents).innerJoin(organizations, eq(organizations.id, abuseEvents.orgId))
        .where(isNull(abuseEvents.resolvedAt)).orderBy(desc(abuseEvents.createdAt)).limit(100);
      return c.json({ events });
    })
    .post("/abuse/resolve", async (c) => {
      const { ids } = await parseBody(c, z.object({ ids: z.array(z.string().max(64)).min(1).max(500) }));
      await c.var.deps.db.update(abuseEvents).set({ resolvedAt: c.var.deps.now() }).where(and(inArray(abuseEvents.id, ids), isNull(abuseEvents.resolvedAt)));
      return c.json({ ok: true });
    })
    .post("/workspaces/:id/suspend", async (c) => {
      const { reason } = await parseBody(c, z.object({ reason: z.string().trim().min(3, "Give a reason; the workspace sees it.").max(300) }));
      const { deps, auth } = c.var;
      const org = await getOrg(deps.db, c.req.param("id"));
      await deps.db.update(organizations).set({ suspendedAt: deps.now(), suspendedReason: reason }).where(eq(organizations.id, org.id));
      await audit(deps.db, { orgId: org.id, actorUserId: auth.userId, actorEmail: auth.email, action: "workspace.suspended", metadata: { reason, by: "operator" }, ip: c.var.ip });
      return c.json({ ok: true });
    })
    .post("/workspaces/:id/unsuspend", async (c) => {
      const { deps, auth } = c.var;
      const org = await getOrg(deps.db, c.req.param("id"));
      await deps.db.update(organizations).set({ suspendedAt: null, suspendedReason: null }).where(eq(organizations.id, org.id));
      await deps.db.update(abuseEvents).set({ resolvedAt: deps.now() }).where(and(eq(abuseEvents.orgId, org.id), isNull(abuseEvents.resolvedAt)));
      await audit(deps.db, { orgId: org.id, actorUserId: auth.userId, actorEmail: auth.email, action: "workspace.unsuspended", metadata: { by: "operator" }, ip: c.var.ip });
      return c.json({ ok: true });
    })
    .put("/workspaces/:id/send-cap", async (c) => {
      const { cap } = await parseBody(c, z.object({ cap: z.number().int().min(0).max(1_000_000).nullable() }));
      const { deps, auth } = c.var;
      const org = await getOrg(deps.db, c.req.param("id"));
      await deps.db.update(organizations).set({ sendCapDaily: cap }).where(eq(organizations.id, org.id));
      await audit(deps.db, { orgId: org.id, actorUserId: auth.userId, actorEmail: auth.email, action: "workspace.send_cap_changed", metadata: { cap, by: "operator" }, ip: c.var.ip });
      return c.json({ ok: true, sendCapDaily: cap });
    })
    // Job queue: backlog, dead letters and replay.
    .get("/jobs", async (c) => {
      const { deps } = c.var;
      const [stats, dead] = await Promise.all([queueStats(deps), listJobs(deps, "dead", 50)]);
      return c.json({ stats, dead: dead.map((j) => ({ id: j.id, type: j.type, orgId: j.orgId, attempts: j.attempts, lastError: j.lastError, updatedAt: j.updatedAt })) });
    })
    .post("/jobs/replay", async (c) => {
      const { ids } = await parseBody(c, z.object({ ids: z.array(z.string().max(64)).min(1).max(500) }));
      return c.json({ replayed: await replayJobs(c.var.deps, ids) });
    })
    /** Sends one test error to Sentry, to check error tracking end to end. */
    .post("/sentry-test", (c) => {
      const { deps } = c.var;
      if (!deps.config.sentry.dsnApi || !deps.reportError) return c.json({ configured: false, eventId: null });
      const eventId = deps.reportError(new Error(`MyMail API test event (${new Date().toISOString()})`), { test: true, by: c.var.auth.email });
      return c.json({ configured: true, eventId: eventId ?? null });
    });
}
