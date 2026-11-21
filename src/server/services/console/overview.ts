/**
 * OPS1: the operator overview. platformOverview is the older /api/admin/overview answer (totals, the newest 100
 * workspaces, integrations), kept for that route. The console's Overview reads consoleOverview: attentionList (what
 * needs an operator now, each with a link to the already filtered page), the totals and the five newest workspaces.
 * Reads only; every count uses an index or one small scan, and they run side by side.
 */
import { and, count, desc, eq, gte, isNull, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { migrationDriver, pendingMigrations } from "../../db";
import { abuseEvents, deliveries, domains, jobs, mailboxes, organizations, usageCounters, users } from "../../db/schema";
import { WORKSPACE_ROWS_METRIC } from "../workspace-budget";
import { writeBudget } from "../write-budget";
import { reportCounts } from "./moderation";

async function platformTotals(deps: Deps) {
  const { db } = deps;
  const [u, o, d, m, sent] = await Promise.all([
    db.select({ n: count() }).from(users).get(),
    db.select({ n: count() }).from(organizations).where(eq(organizations.isDemo, false)).get(),
    db.select({ n: count() }).from(domains).get(),
    db.select({ n: count() }).from(mailboxes).get(),
    db.select({ n: count() }).from(deliveries).where(sql`${deliveries.createdAt} > ${deps.now().getTime() - 24 * 3600_000}`).get(),
  ]);
  return { users: u?.n ?? 0, workspaces: o?.n ?? 0, domains: d?.n ?? 0, mailboxes: m?.n ?? 0, deliveries24h: sent?.n ?? 0 };
}

export async function platformOverview(deps: Deps) {
  const { db, config } = deps;
  const totals = await platformTotals(deps);
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
    totals,
    tenants,
    integrations: {
      sentryApi: !!config.sentry.dsnApi, sentryWeb: !!config.sentry.dsnWeb,
      outbound: deps.outbound.name, billing: config.billing.enabled, billingTestMode: config.billing.testMode,
      auth0: !!config.auth.auth0, google: !!config.auth.social.google, github: !!config.auth.social.github,
    },
  };
}

export interface AttentionItem {
  id: "reports" | "abuse" | "dead_jobs" | "migrations" | "write_budget" | "past_due" | "over_budget" | "suspended";
  label: string;
  count: number;
  /** Shown instead of the count when set ("85%" for the database budget). */
  value?: string;
  /** bad: act now; warn: look today. */
  tone: "bad" | "warn";
  /** The console page that deals with it, already filtered. */
  to: string;
}

/** Migration files not yet applied, or null when the list can't be read (the page then says nothing). */
async function pendingMigrationCount(deps: Deps): Promise<number> {
  try {
    const client = (deps.db as unknown as { $client: unknown }).$client;
    return (await pendingMigrations(migrationDriver(client))).length;
  } catch {
    return 0;
  }
}

/**
 * What needs an operator now, most urgent first; items with nothing waiting are left out. One request's worth of
 * cheap reads, run side by side: open reports (reportCounts, by status), open abuse signals (abuse_events_open_idx),
 * jobs that failed for good (jobs_due_idx on status), past due and suspended workspaces (one pass over organizations),
 * workspaces over today's write limit (usage_counters_period_metric_idx), the account's write budget (cached
 * Cloudflare reading, "off" without a token) and migrations waiting to run (the tracking table).
 */
export async function attentionList(deps: Deps): Promise<AttentionItem[]> {
  const { db } = deps;
  const today = deps.now().toISOString().slice(0, 10);
  const daily = deps.config.workspaceBudget.daily;
  const [reports, abuse, dead, orgs, over, budget, migrations] = await Promise.all([
    reportCounts(deps),
    db.select({ n: count() }).from(abuseEvents).where(isNull(abuseEvents.resolvedAt)).get(),
    db.select({ n: count() }).from(jobs).where(eq(jobs.status, "dead")).get(),
    db.select({
      pastDue: sql<number | null>`sum(case when ${organizations.pastDueSince} is not null then 1 else 0 end)`,
      suspended: sql<number | null>`sum(case when ${organizations.suspendedAt} is not null then 1 else 0 end)`,
    }).from(organizations).get(),
    daily
      ? db.select({ n: count() }).from(usageCounters).where(and(eq(usageCounters.period, today), eq(usageCounters.metric, WORKSPACE_ROWS_METRIC), gte(usageCounters.count, daily))).get()
      : Promise.resolve({ n: 0 }),
    writeBudget(deps).catch(() => null),
    pendingMigrationCount(deps),
  ]);
  const pct = budget && budget.budget > 0 ? Math.round((budget.rowsWritten / budget.budget) * 1000) / 10 : 0;
  const budgetOn = !!budget && (budget.level === "warn" || budget.level === "shed");
  const items: AttentionItem[] = [
    { id: "reports", label: reports.olderThan24h ? `Reports to review (${reports.olderThan24h} past 24 hours)` : "Reports to review", count: reports.open, tone: "bad", to: "/console/moderation" },
    { id: "abuse", label: "Open abuse signals", count: abuse?.n ?? 0, tone: "bad", to: "/console/moderation?tab=abuse" },
    { id: "dead_jobs", label: "Jobs that failed for good", count: dead?.n ?? 0, tone: "bad", to: "/console/jobs?status=dead" },
    { id: "migrations", label: "Database migrations waiting to run", count: migrations, tone: "bad", to: "/console/system" },
    {
      id: "write_budget", label: budget?.level === "shed" ? "Database writes over budget, saving writes" : "Database writes near today's budget",
      count: budgetOn ? 1 : 0, value: `${pct}%`, tone: budget?.level === "shed" ? "bad" : "warn", to: "/console/system",
    },
    { id: "past_due", label: "Past due workspaces", count: Number(orgs?.pastDue ?? 0), tone: "warn", to: "/console/billing" },
    { id: "over_budget", label: "Workspaces over today's write limit", count: over?.n ?? 0, tone: "warn", to: "/console/system" },
    { id: "suspended", label: "Suspended workspaces", count: Number(orgs?.suspended ?? 0), tone: "warn", to: "/console/workspaces?state=suspended" },
  ];
  return items.filter((i) => i.count > 0);
}

export interface NewestWorkspace {
  id: string; name: string; plan: string; isDemo: boolean; createdAt: string;
  suspendedAt: string | null; pastDueSince: string | null; ownerUserId: string | null; ownerEmail: string | null;
}

const OWNER = (col: "id" | "email") => sql<string | null>`(select u.${sql.raw(`"${col}"`)} from "members" m join "users" u on u."id" = m."user_id" where m."organization_id" = "organizations"."id" and m."role" = 'owner' order by m."created_at", m."id" limit 1)`;

/** The newest customer workspaces (demos left out) with their first owner. */
export async function newestWorkspaces(deps: Deps, limit = 5): Promise<NewestWorkspace[]> {
  const rows = await deps.db.select({
    id: organizations.id, name: organizations.name, plan: organizations.plan, isDemo: organizations.isDemo, createdAt: organizations.createdAt,
    suspendedAt: organizations.suspendedAt, pastDueSince: organizations.pastDueSince,
    ownerUserId: OWNER("id"), ownerEmail: OWNER("email"),
  }).from(organizations).where(eq(organizations.isDemo, false)).orderBy(desc(organizations.createdAt), desc(organizations.id)).limit(limit);
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return rows.map((r) => ({ ...r, createdAt: new Date(r.createdAt).toISOString(), suspendedAt: iso(r.suspendedAt), pastDueSince: iso(r.pastDueSince) }));
}

/** GET /api/console/overview: attention first, then the totals and the newest workspaces. */
export async function consoleOverview(deps: Deps) {
  const [attention, totals, newest] = await Promise.all([attentionList(deps), platformTotals(deps), newestWorkspaces(deps)]);
  return { attention, totals, newest };
}
