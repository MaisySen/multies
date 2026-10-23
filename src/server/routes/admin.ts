import { Hono } from "hono";
import { count, desc, eq, sql } from "drizzle-orm";
import type { AppEnv } from "../context";
import { requireAuth, requirePlatformAdmin } from "../middleware";
import { deliveries, domains, mailboxes, members, organizations, users } from "../db/schema";

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
    /** Sends one test error to Sentry, to check error tracking end to end. */
    .post("/sentry-test", (c) => {
      const { deps } = c.var;
      if (!deps.config.sentry.dsnApi || !deps.reportError) return c.json({ configured: false, eventId: null });
      const eventId = deps.reportError(new Error(`MyMail API test event (${new Date().toISOString()})`), { test: true, by: c.var.auth.email });
      return c.json({ configured: true, eventId: eventId ?? null });
    });
}
