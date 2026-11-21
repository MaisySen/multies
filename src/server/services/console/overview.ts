/**
 * OPS1: the operator overview. platformOverview is the older /api/admin/overview answer (totals, the newest 100
 * workspaces, integrations), moved here unchanged so both routes share it. attentionList is what needs an operator now,
 * shown first on the console's Overview. Reads only; a handful of counts.
 */
import { and, count, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { abuseEvents, contentReports, deliveries, domains, jobs, mailboxes, organizations, usageCounters, users } from "../../db/schema";
import { WORKSPACE_ROWS_METRIC } from "../workspace-budget";

export async function platformOverview(deps: Deps) {
  const { db, config } = deps;
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
    meetingMinutesCap: organizations.meetingMinutesCap,
    // R34 (MB-171): this month's call participant-minutes (usage_counters, one row per workspace per month).
    meetingMinutes: sql<number>`(select coalesce(sum(u."count"), 0) from "usage_counters" u where u."org_id" = "organizations"."id" and u."metric" = 'meeting_participant_minutes' and u."period" = ${new Date().toISOString().slice(0, 7)})`,
    pastDueSince: organizations.pastDueSince,
    // Qualified by hand: Drizzle renders columns unqualified in a one-table select, which bound "id" to the inner table.
    members: sql<number>`(select count(*) from "members" m where m."organization_id" = "organizations"."id" and m."kind" = 'human')`,
    agents: sql<number>`(select count(*) from "members" m where m."organization_id" = "organizations"."id" and m."kind" = 'agent')`,
    domains: sql<number>`(select count(*) from "domains" d where d."org_id" = "organizations"."id")`,
  }).from(organizations).orderBy(desc(organizations.createdAt)).limit(100);
  return {
    totals: { users: u?.n ?? 0, workspaces: o?.n ?? 0, domains: d?.n ?? 0, mailboxes: m?.n ?? 0, deliveries24h: sent?.n ?? 0 },
    tenants,
    integrations: {
      sentryApi: !!config.sentry.dsnApi, sentryWeb: !!config.sentry.dsnWeb,
      outbound: deps.outbound.name, billing: config.billing.enabled, billingTestMode: config.billing.testMode,
      auth0: !!config.auth.auth0, google: !!config.auth.social.google, github: !!config.auth.social.github,
    },
  };
}

export interface AttentionItem {
  id: "past_due" | "abuse" | "dead_jobs" | "reports" | "suspended" | "over_budget";
  label: string;
  count: number;
  /** bad: act now; warn: look today. */
  tone: "bad" | "warn";
  /** The console page that deals with it. */
  to: string;
}

/** What needs an operator now, most urgent first. Items with nothing waiting are left out. */
export async function attentionList(deps: Deps): Promise<AttentionItem[]> {
  const { db } = deps;
  const today = deps.now().toISOString().slice(0, 10);
  const daily = deps.config.workspaceBudget.daily;
  const [pastDue, abuse, dead, reports, suspended, over] = await Promise.all([
    db.select({ n: count() }).from(organizations).where(isNotNull(organizations.pastDueSince)).get(),
    db.select({ n: count() }).from(abuseEvents).where(isNull(abuseEvents.resolvedAt)).get(),
    db.select({ n: count() }).from(jobs).where(eq(jobs.status, "dead")).get(),
    db.select({ n: count() }).from(contentReports).where(eq(contentReports.status, "open")).get(),
    db.select({ n: count() }).from(organizations).where(isNotNull(organizations.suspendedAt)).get(),
    daily
      ? db.select({ n: count() }).from(usageCounters).where(and(eq(usageCounters.period, today), eq(usageCounters.metric, WORKSPACE_ROWS_METRIC), gte(usageCounters.count, daily))).get()
      : Promise.resolve({ n: 0 }),
  ]);
  const items: AttentionItem[] = [
    { id: "reports", label: "Reports to review", count: reports?.n ?? 0, tone: "bad", to: "/console/moderation" },
    { id: "abuse", label: "Abuse signals to review", count: abuse?.n ?? 0, tone: "bad", to: "/console/moderation" },
    { id: "dead_jobs", label: "Jobs that ran out of retries", count: dead?.n ?? 0, tone: "bad", to: "/console/jobs" },
    { id: "past_due", label: "Workspaces with a failed payment", count: pastDue?.n ?? 0, tone: "warn", to: "/console/billing" },
    { id: "over_budget", label: "Workspaces over today's write limit", count: over?.n ?? 0, tone: "warn", to: "/console/system" },
    { id: "suspended", label: "Suspended workspaces", count: suspended?.n ?? 0, tone: "warn", to: "/console/workspaces?status=suspended" },
  ];
  return items.filter((i) => i.count > 0);
}
