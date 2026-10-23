import { Hono } from "hono";
import { and, eq, gte, sql } from "drizzle-orm";
import type { AppEnv } from "../context";
import { requireAuth } from "../middleware";
import { deliveries, domains, invitations, mailboxes, members, organizations } from "../db/schema";
import { getPlan, usage } from "../services/plans";
import { listAudit } from "../services/audit";
import { sentToday } from "../services/mail/delivery";

type OnboardingMeta = { onboardingDismissedAt?: string };
const readMeta = (raw: string | null): OnboardingMeta & Record<string, unknown> => { try { return raw ? JSON.parse(raw) : {}; } catch { return {}; } };

export function dashboardRoutes() {
  return new Hono<AppEnv>().use("*", requireAuth)
  .post("/onboarding/dismiss", async (c) => {
    const { db, now } = c.var.deps;
    const org = await db.select({ metadata: organizations.metadata }).from(organizations).where(eq(organizations.id, c.var.auth.orgId)).get();
    const meta = { ...readMeta(org?.metadata ?? null), onboardingDismissedAt: now().toISOString() };
    await db.update(organizations).set({ metadata: JSON.stringify(meta) }).where(eq(organizations.id, c.var.auth.orgId));
    return c.json({ ok: true });
  })
  .get("/", async (c) => {
    const { db, now } = c.var.deps;
    const orgId = c.var.auth.orgId;
    const since = new Date(now().getTime() - 13 * 86400_000);
    since.setUTCHours(0, 0, 0, 0);
    const [plan, used, doms, storage, daily, recent, today] = await Promise.all([
      getPlan(db, orgId),
      usage(db, orgId),
      db.select({ id: domains.id, name: domains.name, status: domains.status, lastCheckedAt: domains.lastCheckedAt }).from(domains).where(eq(domains.orgId, orgId)),
      db.select({ used: sql<number>`coalesce(sum(${mailboxes.usedBytes}), 0)` }).from(mailboxes).where(eq(mailboxes.orgId, orgId)).get(),
      db.select({
        day: sql<string>`strftime('%Y-%m-%d', ${deliveries.createdAt} / 1000, 'unixepoch')`,
        direction: deliveries.direction,
        n: sql<number>`count(*)`,
      }).from(deliveries).where(and(eq(deliveries.orgId, orgId), gte(deliveries.createdAt, since)))
        .groupBy(sql`1`, deliveries.direction),
      listAudit(db, orgId, { limit: 8 }),
      sentToday(db, orgId, now()),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle returns sync or async results depending on the driver
    const count = async (q: any) => Number(((await q) as { n: number } | undefined)?.n ?? 0);
    const [inboundCount, outboundCount, memberCount, inviteCount, org] = await Promise.all([
      count(db.select({ n: sql<number>`count(*)` }).from(deliveries).where(and(eq(deliveries.orgId, orgId), eq(deliveries.direction, "inbound"))).get()),
      count(db.select({ n: sql<number>`count(*)` }).from(deliveries).where(and(eq(deliveries.orgId, orgId), eq(deliveries.direction, "outbound"))).get()),
      count(db.select({ n: sql<number>`count(*)` }).from(members).where(eq(members.organizationId, orgId)).get()),
      count(db.select({ n: sql<number>`count(*)` }).from(invitations).where(eq(invitations.organizationId, orgId)).get()),
      db.select({ metadata: organizations.metadata }).from(organizations).where(eq(organizations.id, orgId)).get(),
    ]);
    const onboarding = {
      dismissed: !!readMeta(org?.metadata ?? null).onboardingDismissedAt,
      steps: {
        domainAdded: used.domains > 0,
        domainVerified: doms.some((d) => d.status === "verified"),
        mailboxCreated: used.mailboxes > 0,
        inboundConnected: inboundCount > 0,
        firstSend: outboundCount > 0,
        teamInvited: memberCount > 1 || inviteCount > 0,
      },
    };
    const series: { day: string; inbound: number; outbound: number }[] = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(since.getTime() + i * 86400_000).toISOString().slice(0, 10);
      series.push({
        day: d,
        inbound: Number(daily.find((r) => r.day === d && r.direction === "inbound")?.n ?? 0),
        outbound: Number(daily.find((r) => r.day === d && r.direction === "outbound")?.n ?? 0),
      });
    }
    return c.json({
      plan, usage: used, domains: doms, storageBytes: Number(storage?.used ?? 0),
      sentToday: today, series, recent, onboarding,
    });
  });
}
