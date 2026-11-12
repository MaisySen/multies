import { Hono } from "hono";
import { and, eq, gte, sql } from "drizzle-orm";
import type { AppEnv } from "../context";
import { requireAuth } from "../middleware";
import { deliveries, domains, invitations, mailboxes, members, organizations } from "../db/schema";
import { getOrgCached, getPlanCached, usage } from "../services/plans";
import { listAudit } from "../services/audit";

type OnboardingMeta = { onboardingDismissedAt?: string };
const readMeta = (raw: string | null): OnboardingMeta & Record<string, unknown> => { try { return raw ? JSON.parse(raw) : {}; } catch { return {}; } };

// MB-367: "address", "destinations" and "replyTo" carried mailbox addresses (a personal Gmail someone connected, a
// personal mailbox's Reply-To) into the member's recent activity; they are private now too.
const PRIVATE_KEYS = /email|address|destination|recipient|replyTo|reply_to|^(to|cc|bcc|from)$|^ip$|ipAddress|userAgent|invit|token/i;
const EMAIL_IN = /[^\s@"<>]+@[^\s@"<>]+\.[a-z]{2,}/i;
/** What a plain member may see of an audit row: no IP, no addresses or invite details in its metadata (MB-367: no value that holds an address, whatever its key). */
export function memberSafeAudit<T extends { ip?: string | null; actorEmail?: string | null; metadata?: Record<string, unknown> | null }>(row: T): T {
  const metadata = row.metadata ? Object.fromEntries(Object.entries(row.metadata).filter(([k, v]) => !PRIVATE_KEYS.test(k) && !EMAIL_IN.test(typeof v === "string" ? v : JSON.stringify(v) ?? ""))) : row.metadata;
  return { ...row, ip: null, metadata };
}

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
    const dayStart = new Date(Date.UTC(now().getUTCFullYear(), now().getUTCMonth(), now().getUTCDate()));
    // R41 (MB-199 CPU): every count the page shows in ONE statement of scalar subqueries (it was seven queries;
    // each D1 query costs the Worker 1 to 2 ms of its 10 ms budget). The workspace row comes from the short per
    // isolate copy the plan already uses.
    const statsQ = db.select({
      storage: sql<number>`(select coalesce(sum(${mailboxes.usedBytes}), 0) from ${mailboxes} where ${mailboxes.orgId} = ${orgId})`,
      inbound: sql<number>`(select count(*) from ${deliveries} where ${deliveries.orgId} = ${orgId} and ${deliveries.direction} = 'inbound')`,
      outbound: sql<number>`(select count(*) from ${deliveries} where ${deliveries.orgId} = ${orgId} and ${deliveries.direction} = 'outbound')`,
      sentToday: sql<number>`(select count(*) from ${deliveries} where ${deliveries.orgId} = ${orgId} and ${deliveries.direction} = 'outbound' and ${deliveries.status} in ('sent', 'queued', 'delivered') and ${deliveries.createdAt} >= ${dayStart.getTime()})`,
      invites: sql<number>`(select count(*) from ${invitations} where ${invitations.organizationId} = ${orgId})`,
      humans: sql<number>`(select count(*) from ${members} where ${members.organizationId} = ${orgId} and ${members.kind} = 'human')`,
      agents: sql<number>`(select count(*) from ${members} where ${members.organizationId} = ${orgId} and ${members.kind} = 'agent')`,
    }).from(sql`(select 1)`).get();
    const [plan, org, used, doms, stats, daily, recent] = await Promise.all([
      getPlanCached(db, orgId), // R40 deploy 3: a short per isolate copy (services/plans.ts)
      getOrgCached(db, orgId),
      usage(db, orgId),
      db.select({ id: domains.id, name: domains.name, status: domains.status, lastCheckedAt: domains.lastCheckedAt }).from(domains).where(eq(domains.orgId, orgId)),
      statsQ,
      db.select({
        day: sql<string>`strftime('%Y-%m-%d', ${deliveries.createdAt} / 1000, 'unixepoch')`,
        direction: deliveries.direction,
        n: sql<number>`count(*)`,
      }).from(deliveries).where(and(eq(deliveries.orgId, orgId), gte(deliveries.createdAt, since)))
        .groupBy(sql`1`, deliveries.direction),
      // R39 security hotfix: members see the recent activity without IPs or the email addresses in it.
      listAudit(db, orgId, { limit: 8 }).then((rows) => c.var.auth.role === "member" ? rows.map(memberSafeAudit) : rows),
    ]);
    const storage = { used: Number(stats?.storage ?? 0) };
    const today = Number(stats?.sentToday ?? 0);
    const inboundCount = Number(stats?.inbound ?? 0);
    const outboundCount = Number(stats?.outbound ?? 0);
    const inviteCount = Number(stats?.invites ?? 0);
    const byKind = [{ kind: "human", n: Number(stats?.humans ?? 0) }, { kind: "agent", n: Number(stats?.agents ?? 0) }];
    const team = {
      members: Number(byKind.find((r) => r.kind === "human")?.n ?? 0),
      agents: Number(byKind.find((r) => r.kind === "agent")?.n ?? 0),
    };
    const memberCount = team.members;
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
      sentToday: today, series, recent, onboarding, team,
    });
  });
}
