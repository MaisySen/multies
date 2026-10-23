import { Hono } from "hono";
import { and, eq, gte, sql } from "drizzle-orm";
import type { AppEnv } from "../context";
import { requireAuth } from "../middleware";
import { deliveries, domains, mailboxes } from "../db/schema";
import { getPlan, usage } from "../services/plans";
import { listAudit } from "../services/audit";
import { sentToday } from "../services/mail/delivery";

export function dashboardRoutes() {
  return new Hono<AppEnv>().use("*", requireAuth).get("/", async (c) => {
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
      sentToday: today, series, recent,
    });
  });
}
