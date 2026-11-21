/**
 * OPS1 Phase 1: the operator console's read model for workspaces. Pure data functions, no routes and no guards: the
 * route layer (routes/console/workspaces.ts) adds requireOperator, the reason prompt and the platform audit.
 *
 * Rules every function here keeps:
 * - Lists use keyset paging on (sort field, id) with a whitelisted sort field, and answer `{ items, next }`.
 * - Every statement binds well under D1's 100 variable limit (no IN lists from user input; counts are scalar
 *   subqueries in one statement, never a query per row).
 * - Nothing secret leaves: no key hashes, webhook signing secrets, DKIM private keys, OAuth code or refresh hashes,
 *   and no mail or doc content. Webhook URLs are shown masked (a Slack or Discord URL is itself a credential).
 * - Times are ISO strings (what the JSON answer carries), so these types are the wire types the console UI uses.
 */
import { and, asc, desc, eq, isNotNull, isNull, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { Deps } from "../../context";
import {
  agents, apiKeys, auditLogs, domains, mailboxes, members, oauthClients, oauthGrants, organizations, users, webhookEndpoints,
} from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { containsAny, containsText, normalizeQuery } from "../../lib/like-search";
import { auditFilterCond, redactAuditRow, type AuditFilter } from "../audit";
import { effectivePlanId, getOrg, getPlan, periodOf, usage } from "../plans";
import { workspaceUsage, type WorkspaceBudgetLevel } from "../workspace-budget";
import type { AddonQuantities, PlanId, PlanLimits } from "@/shared/plans";

// ---- paging (shared with users.ts) ------------------------------------------------------------------------------

export type SortDir = "asc" | "desc";
export interface PageCursor { v: string | number; id: string }
export interface PageRequest { limit: number; cursor: PageCursor | null; sort: { field: string; dir: SortDir } }
export interface Paged<T> { items: T[]; next: PageCursor | null }
export const MAX_PAGE_LIMIT = 100;
export const DEFAULT_PAGE_LIMIT = 50;

/** A sortable column: `time` columns page on epoch milliseconds, `text` columns on the string. */
export interface SortColumn { col: SQLWrapper; type: "text" | "time" }

const badPage = (message: string) => new HttpError(400, "bad_page", message);

/**
 * Checks a page request against `sorts` and builds the keyset condition and order for it. The sort field must be a
 * key of `sorts` (anything else is a 400 `bad_sort`); the cursor is the last row's (sort value, id) pair.
 */
export function keysetPage(page: PageRequest, sorts: Readonly<Record<string, SortColumn>>, idCol: SQLWrapper) {
  const field = page?.sort?.field;
  if (typeof field !== "string" || !Object.hasOwn(sorts, field)) {
    throw new HttpError(400, "bad_sort", `Sort by one of: ${Object.keys(sorts).join(", ")}.`);
  }
  const dir = page.sort.dir;
  if (dir !== "asc" && dir !== "desc") throw new HttpError(400, "bad_sort", "Sort direction is asc or desc.");
  const spec = sorts[field]!;
  const n = Math.floor(Number(page.limit));
  const limit = Number.isFinite(n) && n > 0 ? Math.min(n, MAX_PAGE_LIMIT) : DEFAULT_PAGE_LIMIT;
  let where: SQL | undefined;
  if (page.cursor) {
    const { id } = page.cursor;
    if (typeof id !== "string" || !id || id.length > 200) throw badPage("That page link is not valid.");
    let v: string | number;
    if (spec.type === "time") {
      v = Number(page.cursor.v);
      if (!Number.isFinite(v)) throw badPage("That page link is not valid.");
    } else {
      if (typeof page.cursor.v !== "string" && typeof page.cursor.v !== "number") throw badPage("That page link is not valid.");
      v = String(page.cursor.v);
    }
    const op = dir === "asc" ? sql.raw(">") : sql.raw("<");
    where = sql`(${spec.col} ${op} ${v} or (${spec.col} = ${v} and ${idCol} ${op} ${id}))`;
  }
  const orderBy = dir === "asc" ? [asc(spec.col), asc(idCol)] : [desc(spec.col), desc(idCol)];
  return { field, dir, limit, where, orderBy };
}

/** The page answer from `limit + 1` raw rows: the cursor comes from the last kept row's raw sort value and id. */
export function pageOut<R extends { id: string }, T>(rows: R[], limit: number, field: string, map: (r: R) => T): Paged<T> {
  const kept = rows.slice(0, limit);
  const last = kept[kept.length - 1];
  let next: PageCursor | null = null;
  if (rows.length > limit && last) {
    const raw = (last as unknown as Record<string, unknown>)[field];
    next = { v: raw instanceof Date ? raw.getTime() : typeof raw === "number" ? raw : String(raw ?? ""), id: last.id };
  }
  return { items: kept.map(map), next };
}

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const num = (v: unknown) => Number(v ?? 0);
const searchText = (q: string | undefined) => normalizeQuery(q ?? "").slice(0, 100);

/** At most this many rows in the unpaged per-workspace lists (domains, mailboxes, agents, keys, endpoints, grants). */
export const DETAIL_LIST_CAP = 500;

// ---- workspaces list -------------------------------------------------------------------------------------------

export const WORKSPACE_SORTS = ["createdAt", "name", "plan"] as const;
export type WorkspaceSort = (typeof WORKSPACE_SORTS)[number];
const WORKSPACE_SORT_COLUMNS: Record<WorkspaceSort, SortColumn> = {
  createdAt: { col: organizations.createdAt, type: "time" },
  name: { col: organizations.name, type: "text" },
  plan: { col: organizations.plan, type: "text" },
};

export interface WorkspaceFilters {
  /** The plan column (what billing set). A comp workspace is matched by `comp`, whatever this says. */
  plan?: PlanId;
  comp?: boolean;
  suspended?: boolean;
  /** In dunning: a failed payment run started (past_due_since) or Stripe says past_due. */
  pastDue?: boolean;
  demo?: boolean;
}
export interface ListWorkspacesInput { q?: string; filters?: WorkspaceFilters; page: PageRequest }

export interface WorkspaceListItem {
  id: string;
  name: string;
  slug: string | null;
  plan: PlanId;
  /** The plan limits come from (Business for a comp workspace). */
  effectivePlan: PlanId;
  compPlan: boolean;
  isDemo: boolean;
  subscriptionStatus: string | null;
  pastDueSince: string | null;
  graceEndsAt: string | null;
  suspendedAt: string | null;
  suspendedReason: string | null;
  sendCapDaily: number | null;
  createdAt: string;
  /** The first owner's address (null when the workspace has no owner row). */
  ownerEmail: string | null;
  /** The same owner's user id, so the console can link to them (null when there is no owner row). */
  ownerUserId: string | null;
  /** People (human members). */
  members: number;
  /** AI agent members. */
  agentMembers: number;
  domains: number;
}

// Hand qualified: Drizzle renders columns unqualified in a one table select, which would bind to the inner table.
const OWNER_EMAIL = sql<string | null>`(select u."email" from "members" m join "users" u on u."id" = m."user_id" where m."organization_id" = "organizations"."id" and m."role" = 'owner' order by m."created_at", m."id" limit 1)`;
const OWNER_USER_ID = sql<string | null>`(select m."user_id" from "members" m where m."organization_id" = "organizations"."id" and m."role" = 'owner' order by m."created_at", m."id" limit 1)`;

/** Workspaces matching a search (name, id, slug, an owner's address, a domain) and filters, one page at a time. */
export async function listWorkspaces(deps: Pick<Deps, "db">, input: ListWorkspacesInput): Promise<Paged<WorkspaceListItem>> {
  const p = keysetPage(input.page, WORKSPACE_SORT_COLUMNS, organizations.id);
  const q = searchText(input.q);
  const f = input.filters ?? {};
  const conds: (SQL | undefined)[] = [p.where];
  if (q) {
    conds.push(sql`(${containsAny([organizations.name, organizations.id, organizations.slug], q)}
      or exists (select 1 from "members" m join "users" u on u."id" = m."user_id" where m."organization_id" = "organizations"."id" and m."role" = 'owner' and ${containsText(sql`u."email"`, q)})
      or exists (select 1 from "domains" d where d."org_id" = "organizations"."id" and ${containsText(sql`d."name"`, q)}))`);
  }
  if (f.plan) conds.push(eq(organizations.plan, f.plan));
  if (f.comp !== undefined) conds.push(eq(organizations.compPlan, f.comp));
  if (f.demo !== undefined) conds.push(eq(organizations.isDemo, f.demo));
  if (f.suspended !== undefined) conds.push(f.suspended ? isNotNull(organizations.suspendedAt) : isNull(organizations.suspendedAt));
  if (f.pastDue !== undefined) {
    const pd = sql`(${organizations.pastDueSince} is not null or coalesce(${organizations.subscriptionStatus}, '') = 'past_due')`;
    conds.push(f.pastDue ? pd : sql`not ${pd}`);
  }
  const rows = await deps.db.select({
    id: organizations.id, name: organizations.name, slug: organizations.slug, plan: organizations.plan, compPlan: organizations.compPlan,
    isDemo: organizations.isDemo, subscriptionStatus: organizations.subscriptionStatus, pastDueSince: organizations.pastDueSince,
    graceEndsAt: organizations.graceEndsAt, suspendedAt: organizations.suspendedAt, suspendedReason: organizations.suspendedReason,
    sendCapDaily: organizations.sendCapDaily, createdAt: organizations.createdAt,
    ownerEmail: OWNER_EMAIL,
    ownerUserId: OWNER_USER_ID,
    members: sql<number>`(select count(*) from "members" m where m."organization_id" = "organizations"."id" and m."kind" = 'human')`,
    agentMembers: sql<number>`(select count(*) from "members" m where m."organization_id" = "organizations"."id" and m."kind" = 'agent')`,
    domains: sql<number>`(select count(*) from "domains" d where d."org_id" = "organizations"."id")`,
  }).from(organizations).where(and(...conds)).orderBy(...p.orderBy).limit(p.limit + 1);
  return pageOut(rows, p.limit, p.field, (r) => ({
    id: r.id, name: r.name, slug: r.slug, plan: r.plan, effectivePlan: effectivePlanId(r), compPlan: !!r.compPlan, isDemo: !!r.isDemo,
    subscriptionStatus: r.subscriptionStatus, pastDueSince: iso(r.pastDueSince), graceEndsAt: iso(r.graceEndsAt),
    suspendedAt: iso(r.suspendedAt), suspendedReason: r.suspendedReason, sendCapDaily: r.sendCapDaily, createdAt: iso(r.createdAt)!,
    ownerEmail: r.ownerEmail ?? null, ownerUserId: r.ownerUserId ?? null, members: num(r.members), agentMembers: num(r.agentMembers), domains: num(r.domains),
  }));
}

// ---- workspace overview ----------------------------------------------------------------------------------------

export type WorkspaceUsageTotals = Awaited<ReturnType<typeof usage>>;

export interface WorkspaceOverview {
  org: {
    id: string; name: string; slug: string | null; plan: PlanId; effectivePlan: PlanId; compPlan: boolean; isDemo: boolean;
    timezone: string; country: string; createdAt: string;
    stripeCustomerId: string | null; stripeSubscriptionId: string | null; subscriptionStatus: string | null;
    billingInterval: "month" | "year" | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean;
    pastDueSince: string | null; graceEndsAt: string | null; requireSso: boolean;
    suspendedAt: string | null; suspendedReason: string | null; sendCapDaily: number | null; meetingMinutesCap: number | null;
    channelsEnabled: boolean; legacyStorageMb: number | null;
  };
  /** The first owner (the person the console header links to), null when the workspace has no owner row. */
  owner: { userId: string; email: string; name: string } | null;
  limits: PlanLimits;
  addons: AddonQuantities;
  usage: WorkspaceUsageTotals;
  counts: {
    members: number; agentMembers: number; pendingInvites: number; agents: number; apiKeys: number;
    webhookEndpoints: number; webhookEndpointsDisabled: number; activeOauthGrants: number;
    /** Outbound deliveries since midnight UTC. */
    sendsToday: number;
    /** Call participant minutes this month. */
    meetingMinutesThisMonth: number;
  };
  /** Rows written today against the workspace's daily write budget. */
  writeBudget: { used: number; budget: number; level: WorkspaceBudgetLevel; resetAt: string };
}

/** One workspace's state, limits, counts and today's write budget. 404 when it does not exist. */
export async function getWorkspaceOverview(deps: Deps, orgId: string): Promise<WorkspaceOverview> {
  const org = await getOrg(deps.db, orgId);
  const now = deps.now();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const period = periodOf(now);
  const [plan, used, budget, c, ownerRow] = await Promise.all([
    getPlan(deps.db, orgId),
    usage(deps.db, orgId, now),
    workspaceUsage(deps, orgId),
    deps.db.select({
      members: sql<number>`(select count(*) from "members" m where m."organization_id" = ${orgId} and m."kind" = 'human')`,
      agentMembers: sql<number>`(select count(*) from "members" m where m."organization_id" = ${orgId} and m."kind" = 'agent')`,
      pendingInvites: sql<number>`(select count(*) from "invitations" i where i."organization_id" = ${orgId} and i."status" = 'pending')`,
      agents: sql<number>`(select count(*) from "agents" a where a."org_id" = ${orgId})`,
      apiKeys: sql<number>`(select count(*) from "api_keys" k where k."org_id" = ${orgId})`,
      hooks: sql<number>`(select count(*) from "webhook_endpoints" w where w."org_id" = ${orgId})`,
      hooksOff: sql<number>`(select count(*) from "webhook_endpoints" w where w."org_id" = ${orgId} and w."enabled" = 0)`,
      grants: sql<number>`(select count(*) from "oauth_grants" g where g."org_id" = ${orgId} and g."revoked_at" is null)`,
      sends: sql<number>`(select count(*) from "deliveries" d where d."org_id" = ${orgId} and d."direction" = 'outbound' and d."created_at" >= ${midnight})`,
      meeting: sql<number>`(select coalesce(sum(u."count"), 0) from "usage_counters" u where u."org_id" = ${orgId} and u."period" = ${period} and u."metric" = 'meeting_participant_minutes')`,
    }).from(sql`(select 1)`).get(),
    deps.db.select({ userId: users.id, email: users.email, name: users.name }).from(members).innerJoin(users, eq(users.id, members.userId))
      .where(and(eq(members.organizationId, orgId), eq(members.role, "owner"))).orderBy(asc(members.createdAt), asc(members.id)).limit(1).get(),
  ]);
  return {
    org: {
      id: org.id, name: org.name, slug: org.slug, plan: org.plan, effectivePlan: effectivePlanId(org), compPlan: !!org.compPlan, isDemo: !!org.isDemo,
      timezone: org.timezone, country: org.country, createdAt: iso(org.createdAt)!,
      stripeCustomerId: org.stripeCustomerId, stripeSubscriptionId: org.stripeSubscriptionId, subscriptionStatus: org.subscriptionStatus,
      billingInterval: org.billingInterval ?? null, currentPeriodEnd: iso(org.currentPeriodEnd), cancelAtPeriodEnd: !!org.cancelAtPeriodEnd,
      pastDueSince: iso(org.pastDueSince), graceEndsAt: iso(org.graceEndsAt), requireSso: !!org.requireSso,
      suspendedAt: iso(org.suspendedAt), suspendedReason: org.suspendedReason, sendCapDaily: org.sendCapDaily, meetingMinutesCap: org.meetingMinutesCap,
      channelsEnabled: !!org.channelsEnabled, legacyStorageMb: org.legacyStorageMb,
    },
    owner: ownerRow ? { userId: ownerRow.userId, email: ownerRow.email, name: ownerRow.name ?? "" } : null,
    limits: plan.limits,
    addons: plan.addons,
    usage: used,
    counts: {
      members: num(c?.members), agentMembers: num(c?.agentMembers), pendingInvites: num(c?.pendingInvites), agents: num(c?.agents),
      apiKeys: num(c?.apiKeys), webhookEndpoints: num(c?.hooks), webhookEndpointsDisabled: num(c?.hooksOff), activeOauthGrants: num(c?.grants),
      sendsToday: num(c?.sends), meetingMinutesThisMonth: num(c?.meeting),
    },
    writeBudget: { used: budget.used, budget: budget.budget, level: budget.level, resetAt: budget.resetAt },
  };
}

// ---- members ---------------------------------------------------------------------------------------------------

export const MEMBER_SORTS = ["createdAt", "email", "name"] as const;
export type MemberSort = (typeof MEMBER_SORTS)[number];
const MEMBER_SORT_COLUMNS: Record<MemberSort, SortColumn> = {
  createdAt: { col: members.createdAt, type: "time" },
  email: { col: users.email, type: "text" },
  name: { col: users.name, type: "text" },
};

export interface WorkspaceMember {
  /** The member row id (the page cursor's id). */
  id: string;
  userId: string;
  email: string;
  name: string;
  role: "owner" | "admin" | "member";
  kind: "human" | "agent";
  title: string | null;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  banned: boolean;
  lastLoginMethod: string | null;
  /** An agent member paused by an admin. */
  disabledAt: string | null;
  joinedAt: string;
}
export interface ListMembersInput { q?: string; kind?: "human" | "agent"; page: PageRequest }

/** A workspace's members (people and agent members), searchable by address or name, one page at a time. */
export async function listWorkspaceMembers(deps: Pick<Deps, "db">, orgId: string, input: ListMembersInput): Promise<Paged<WorkspaceMember>> {
  const p = keysetPage(input.page, MEMBER_SORT_COLUMNS, members.id);
  const q = searchText(input.q);
  const rows = await deps.db.select({
    id: members.id, userId: members.userId, email: users.email, name: users.name, role: members.role, kind: members.kind, title: members.title,
    emailVerified: users.emailVerified, twoFactorEnabled: users.twoFactorEnabled, banned: users.banned, lastLoginMethod: users.lastLoginMethod,
    disabledAt: members.disabledAt, createdAt: members.createdAt,
  }).from(members).innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.organizationId, orgId), input.kind ? eq(members.kind, input.kind) : undefined, q ? containsAny([users.email, users.name], q) : undefined, p.where))
    .orderBy(...p.orderBy).limit(p.limit + 1);
  return pageOut(rows, p.limit, p.field, (r) => ({
    id: r.id, userId: r.userId, email: r.email, name: r.name, role: r.role, kind: r.kind, title: r.title, emailVerified: !!r.emailVerified,
    twoFactorEnabled: !!r.twoFactorEnabled, banned: !!r.banned, lastLoginMethod: r.lastLoginMethod, disabledAt: iso(r.disabledAt), joinedAt: iso(r.createdAt)!,
  }));
}

// ---- usage -----------------------------------------------------------------------------------------------------

export interface UsageDay {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  aiUnits: number;
  aiCalls: number;
  /** Outbound deliveries, any status. */
  outbound: number;
  /** Outbound deliveries that failed, bounced, were rejected or drew a complaint. */
  outboundFailed: number;
  inbound: number;
  /** Daily usage_counters metrics for the day (d1_rows and any other day keyed metric). */
  counters: Record<string, number>;
}
export interface WorkspaceUsage {
  totals: WorkspaceUsageTotals;
  limits: PlanLimits;
  /** This month's usage_counters (period YYYY-MM): metric to count. */
  month: { period: string; counters: Record<string, number> };
  range: { from: string; to: string; days: number };
  /** One entry per day, oldest first, zeros where nothing happened. */
  daily: UsageDay[];
}

export const USAGE_MAX_DAYS = 90;
const FAILED_STATUSES = sql.raw(`('failed', 'bounced', 'rejected', 'complained')`);

/** Current totals against limits, this month's counters and a per-day series for the last `days` days (1 to 90). */
export async function getWorkspaceUsage(deps: Deps, orgId: string, opts: { days?: number } = {}): Promise<WorkspaceUsage> {
  await getOrg(deps.db, orgId);
  const days = Math.min(USAGE_MAX_DAYS, Math.max(1, Math.floor(Number(opts.days ?? 30)) || 30));
  const now = deps.now();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = today - (days - 1) * 86_400_000;
  const fromDay = new Date(start).toISOString().slice(0, 10);
  const toDay = new Date(today).toISOString().slice(0, 10);
  const period = periodOf(now);
  const [totals, plan, monthRows, ai, sends, dailyCounters] = await Promise.all([
    usage(deps.db, orgId, now),
    getPlan(deps.db, orgId),
    deps.db.all<{ metric: string; count: number }>(sql`select "metric", "count" from "usage_counters" where "org_id" = ${orgId} and "period" = ${period}`),
    deps.db.all<{ day: string; units: number; calls: number }>(sql`select "day", "units", "calls" from "ai_usage_daily" where "org_id" = ${orgId} and "day" >= ${fromDay} and "day" <= ${toDay}`),
    deps.db.all<{ day: string; direction: string; n: number; failed: number }>(sql`
      select strftime('%Y-%m-%d', "created_at" / 1000, 'unixepoch') as day, "direction" as direction, count(*) as n,
        sum(case when "status" in ${FAILED_STATUSES} then 1 else 0 end) as failed
      from "deliveries" where "org_id" = ${orgId} and "created_at" >= ${start}
      group by 1, 2`),
    deps.db.all<{ day: string; metric: string; count: number }>(sql`select "period" as day, "metric", "count" from "usage_counters"
      where "org_id" = ${orgId} and length("period") = 10 and "period" >= ${fromDay} and "period" <= ${toDay}`),
  ]);
  const byDay = new Map<string, UsageDay>();
  for (let t = start; t <= today; t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    byDay.set(day, { day, aiUnits: 0, aiCalls: 0, outbound: 0, outboundFailed: 0, inbound: 0, counters: {} });
  }
  for (const r of ai) { const d = byDay.get(r.day); if (d) { d.aiUnits += num(r.units); d.aiCalls += num(r.calls); } }
  for (const r of sends) {
    const d = byDay.get(r.day);
    if (!d) continue;
    if (r.direction === "outbound") { d.outbound += num(r.n); d.outboundFailed += num(r.failed); } else d.inbound += num(r.n);
  }
  for (const r of dailyCounters) { const d = byDay.get(r.day); if (d) d.counters[r.metric] = num(r.count); }
  return {
    totals,
    limits: plan.limits,
    month: { period, counters: Object.fromEntries(monthRows.map((r) => [r.metric, num(r.count)])) },
    range: { from: fromDay, to: toDay, days },
    daily: [...byDay.values()],
  };
}

// ---- domains and mailboxes -------------------------------------------------------------------------------------

export interface WorkspaceDomain {
  id: string; name: string; status: "pending" | "verified" | "failed"; providerStatus: string | null;
  verifiedAt: string | null; lastCheckedAt: string | null; catchAllMailboxId: string | null; createdAt: string;
  mailboxes: number;
}
export interface WorkspaceMailbox {
  id: string; domainId: string; address: string; displayName: string; kind: "person" | "agent"; status: "active" | "suspended";
  personal: boolean; ownerUserId: string | null; quotaMb: number; usedBytes: number; createdAt: string;
}
export interface WorkspaceDomainsAndMailboxes {
  domains: WorkspaceDomain[];
  mailboxes: WorkspaceMailbox[];
  /** True when a list hit DETAIL_LIST_CAP and more rows exist. */
  truncated: { domains: boolean; mailboxes: boolean };
}

/** A workspace's domains (no DKIM keys or verification tokens) and mailboxes (no content), newest first. */
export async function listWorkspaceDomainsAndMailboxes(deps: Pick<Deps, "db">, orgId: string): Promise<WorkspaceDomainsAndMailboxes> {
  const [d, m] = await Promise.all([
    deps.db.select({
      id: domains.id, name: domains.name, status: domains.status, providerStatus: domains.providerStatus, verifiedAt: domains.verifiedAt,
      lastCheckedAt: domains.lastCheckedAt, catchAllMailboxId: domains.catchAllMailboxId, createdAt: domains.createdAt,
      mailboxes: sql<number>`(select count(*) from "mailboxes" mb where mb."domain_id" = "domains"."id")`,
    }).from(domains).where(eq(domains.orgId, orgId)).orderBy(desc(domains.createdAt), desc(domains.id)).limit(DETAIL_LIST_CAP + 1),
    deps.db.select({
      id: mailboxes.id, domainId: mailboxes.domainId, address: mailboxes.address, displayName: mailboxes.displayName, kind: mailboxes.kind,
      status: mailboxes.status, personal: mailboxes.personal, ownerUserId: mailboxes.ownerUserId, quotaMb: mailboxes.quotaMb,
      usedBytes: mailboxes.usedBytes, createdAt: mailboxes.createdAt,
    }).from(mailboxes).where(eq(mailboxes.orgId, orgId)).orderBy(desc(mailboxes.createdAt), desc(mailboxes.id)).limit(DETAIL_LIST_CAP + 1),
  ]);
  return {
    domains: d.slice(0, DETAIL_LIST_CAP).map((r) => ({
      id: r.id, name: r.name, status: r.status, providerStatus: r.providerStatus, verifiedAt: iso(r.verifiedAt), lastCheckedAt: iso(r.lastCheckedAt),
      catchAllMailboxId: r.catchAllMailboxId, createdAt: iso(r.createdAt)!, mailboxes: num(r.mailboxes),
    })),
    mailboxes: m.slice(0, DETAIL_LIST_CAP).map((r) => ({
      id: r.id, domainId: r.domainId, address: r.address, displayName: r.displayName, kind: r.kind, status: r.status, personal: !!r.personal,
      ownerUserId: r.ownerUserId, quotaMb: r.quotaMb, usedBytes: r.usedBytes, createdAt: iso(r.createdAt)!,
    })),
    truncated: { domains: d.length > DETAIL_LIST_CAP, mailboxes: m.length > DETAIL_LIST_CAP },
  };
}

// ---- agents ----------------------------------------------------------------------------------------------------

export interface WorkspaceAgent {
  id: string; name: string; description: string | null; mailboxId: string; address: string | null;
  approvalMode: "always" | "external" | "never"; sendCapDaily: number; status: "active" | "paused";
  /** Addresses or "@domain" entries it may send to; null means anyone. */
  allowedRecipients: string[] | null;
  apiKeys: number; createdByUserId: string | null; createdAt: string;
}
export interface WorkspaceAgentMember {
  /** The member row id. */
  id: string; userId: string; name: string; title: string | null; disabledAt: string | null; linkedAgentId: string | null; createdAt: string;
}
export interface WorkspaceAgents {
  agents: WorkspaceAgent[];
  agentMembers: WorkspaceAgentMember[];
  truncated: { agents: boolean; agentMembers: boolean };
}

function parseList(raw: string | null): string[] | null {
  if (raw == null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
  } catch { return null; }
}

/** A workspace's agent inboxes and agent members. */
export async function listWorkspaceAgents(deps: Pick<Deps, "db">, orgId: string): Promise<WorkspaceAgents> {
  const [a, m] = await Promise.all([
    deps.db.select({
      id: agents.id, name: agents.name, description: agents.description, mailboxId: agents.mailboxId, address: mailboxes.address,
      approvalMode: agents.approvalMode, sendCapDaily: agents.sendCapDaily, status: agents.status, allowedRecipients: agents.allowedRecipients,
      apiKeys: sql<number>`(select count(*) from "api_keys" k where k."agent_id" = "agents"."id")`,
      createdByUserId: agents.createdByUserId, createdAt: agents.createdAt,
    }).from(agents).leftJoin(mailboxes, eq(mailboxes.id, agents.mailboxId)).where(eq(agents.orgId, orgId))
      .orderBy(desc(agents.createdAt), desc(agents.id)).limit(DETAIL_LIST_CAP + 1),
    deps.db.select({
      id: members.id, userId: members.userId, name: users.name, title: members.title, disabledAt: members.disabledAt,
      linkedAgentId: members.linkedAgentId, createdAt: members.createdAt,
    }).from(members).innerJoin(users, eq(users.id, members.userId)).where(and(eq(members.organizationId, orgId), eq(members.kind, "agent")))
      .orderBy(desc(members.createdAt), desc(members.id)).limit(DETAIL_LIST_CAP + 1),
  ]);
  return {
    agents: a.slice(0, DETAIL_LIST_CAP).map((r) => ({
      id: r.id, name: r.name, description: r.description, mailboxId: r.mailboxId, address: r.address ?? null, approvalMode: r.approvalMode,
      sendCapDaily: r.sendCapDaily, status: r.status, allowedRecipients: parseList(r.allowedRecipients), apiKeys: num(r.apiKeys),
      createdByUserId: r.createdByUserId, createdAt: iso(r.createdAt)!,
    })),
    agentMembers: m.slice(0, DETAIL_LIST_CAP).map((r) => ({
      id: r.id, userId: r.userId, name: r.name, title: r.title, disabledAt: iso(r.disabledAt), linkedAgentId: r.linkedAgentId, createdAt: iso(r.createdAt)!,
    })),
    truncated: { agents: a.length > DETAIL_LIST_CAP, agentMembers: m.length > DETAIL_LIST_CAP },
  };
}

// ---- developer -------------------------------------------------------------------------------------------------

export interface WorkspaceApiKey {
  id: string; name: string;
  /** The public prefix shown in lists (e.g. mm_live_3kf9); never the key or its hash. */
  prefix: string;
  scope: string; agentId: string | null; createdByUserId: string | null; createdByEmail: string | null;
  lastUsedAt: string | null; createdAt: string;
}
export interface WorkspaceWebhookEndpoint {
  id: string;
  /** Scheme, host and the first path segment; the rest (often a token, as in Slack or Discord URLs) is masked. */
  url: string;
  host: string;
  description: string | null; events: string[]; enabled: boolean; consecutiveDead: number; disabledReason: string | null;
  format: "json" | "slack" | "discord" | "teams"; connector: string | null; createdAt: string;
}
export interface WorkspaceOauthGrant {
  id: string; clientId: string; clientName: string | null; userId: string; userEmail: string | null; scope: "full" | "read";
  lastUsedAt: string | null; revokedAt: string | null; createdAt: string;
}
export interface WorkspaceDeveloper {
  apiKeys: WorkspaceApiKey[];
  webhookEndpoints: WorkspaceWebhookEndpoint[];
  oauthGrants: WorkspaceOauthGrant[];
  truncated: { apiKeys: boolean; webhookEndpoints: boolean; oauthGrants: boolean };
}

/** A webhook URL for operators: scheme, host and first path segment, the rest and any query masked. */
export function maskWebhookUrl(raw: string): { url: string; host: string } {
  try {
    const u = new URL(raw);
    const parts = u.pathname.split("/").filter(Boolean);
    const shown = parts.length ? `/${parts[0]}` : "";
    const masked = parts.length > 1 || u.search || u.hash ? "/…" : "";
    return { url: `${u.protocol}//${u.host}${shown}${masked}`, host: u.host };
  } catch {
    return { url: "(invalid URL)", host: "" };
  }
}

/** A workspace's API keys (no secrets or hashes), webhook endpoints (no signing secrets, URLs masked) and OAuth grants (no hashes). */
export async function listWorkspaceDeveloper(deps: Pick<Deps, "db">, orgId: string): Promise<WorkspaceDeveloper> {
  const [k, w, g] = await Promise.all([
    deps.db.select({
      id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, scope: apiKeys.scope, agentId: apiKeys.agentId,
      createdByUserId: apiKeys.createdByUserId, createdByEmail: users.email, lastUsedAt: apiKeys.lastUsedAt, createdAt: apiKeys.createdAt,
    }).from(apiKeys).leftJoin(users, eq(users.id, apiKeys.createdByUserId)).where(eq(apiKeys.orgId, orgId))
      .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id)).limit(DETAIL_LIST_CAP + 1),
    deps.db.select({
      id: webhookEndpoints.id, url: webhookEndpoints.url, description: webhookEndpoints.description, events: webhookEndpoints.events,
      enabled: webhookEndpoints.enabled, consecutiveDead: webhookEndpoints.consecutiveDead, disabledReason: webhookEndpoints.disabledReason,
      format: webhookEndpoints.format, connector: webhookEndpoints.connector, createdAt: webhookEndpoints.createdAt,
    }).from(webhookEndpoints).where(eq(webhookEndpoints.orgId, orgId))
      .orderBy(desc(webhookEndpoints.createdAt), desc(webhookEndpoints.id)).limit(DETAIL_LIST_CAP + 1),
    deps.db.select({
      id: oauthGrants.id, clientId: oauthGrants.clientId, clientName: oauthClients.name, userId: oauthGrants.userId, userEmail: users.email,
      scope: oauthGrants.scope, lastUsedAt: oauthGrants.lastUsedAt, revokedAt: oauthGrants.revokedAt, createdAt: oauthGrants.createdAt,
    }).from(oauthGrants).leftJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId)).leftJoin(users, eq(users.id, oauthGrants.userId))
      .where(eq(oauthGrants.orgId, orgId)).orderBy(desc(oauthGrants.createdAt), desc(oauthGrants.id)).limit(DETAIL_LIST_CAP + 1),
  ]);
  return {
    apiKeys: k.slice(0, DETAIL_LIST_CAP).map((r) => ({
      id: r.id, name: r.name, prefix: r.prefix, scope: r.scope, agentId: r.agentId, createdByUserId: r.createdByUserId,
      createdByEmail: r.createdByEmail ?? null, lastUsedAt: iso(r.lastUsedAt), createdAt: iso(r.createdAt)!,
    })),
    webhookEndpoints: w.slice(0, DETAIL_LIST_CAP).map((r) => ({
      id: r.id, ...maskWebhookUrl(r.url), description: r.description, events: parseList(r.events) ?? [], enabled: !!r.enabled,
      consecutiveDead: r.consecutiveDead, disabledReason: r.disabledReason, format: r.format, connector: r.connector, createdAt: iso(r.createdAt)!,
    })),
    oauthGrants: g.slice(0, DETAIL_LIST_CAP).map((r) => ({
      id: r.id, clientId: r.clientId, clientName: r.clientName ?? null, userId: r.userId, userEmail: r.userEmail ?? null, scope: r.scope,
      lastUsedAt: iso(r.lastUsedAt), revokedAt: iso(r.revokedAt), createdAt: iso(r.createdAt)!,
    })),
    truncated: { apiKeys: k.length > DETAIL_LIST_CAP, webhookEndpoints: w.length > DETAIL_LIST_CAP, oauthGrants: g.length > DETAIL_LIST_CAP },
  };
}

// ---- audit -----------------------------------------------------------------------------------------------------

export const WORKSPACE_AUDIT_SORTS = ["createdAt"] as const;
const AUDIT_SORT_COLUMNS: Record<(typeof WORKSPACE_AUDIT_SORTS)[number], SortColumn> = { createdAt: { col: auditLogs.createdAt, type: "time" } };

export interface WorkspaceAuditEntry {
  id: string; action: string; actorUserId: string | null; actorEmail: string | null; targetType: string | null; targetId: string | null;
  metadata: Record<string, unknown> | null; ip: string | null; agentId: string | null; createdAt: string;
}

/**
 * The workspace's own audit log (what its admins see in Activity), with the same filters and invite masking as
 * services/audit.ts listAudit. Pages on (createdAt, id) rather than listAudit's `before` time alone, so rows written
 * in the same millisecond are never skipped at a page edge.
 */
export async function listWorkspaceAudit(deps: Pick<Deps, "db">, orgId: string, input: { filter?: AuditFilter; page: PageRequest }): Promise<Paged<WorkspaceAuditEntry>> {
  const p = keysetPage(input.page, AUDIT_SORT_COLUMNS, auditLogs.id);
  const rows = await deps.db.select().from(auditLogs)
    .where(and(eq(auditLogs.orgId, orgId), auditFilterCond(input.filter), p.where)).orderBy(...p.orderBy).limit(p.limit + 1);
  return pageOut(rows, p.limit, p.field, (r) => {
    let metadata: Record<string, unknown> | null = null;
    if (r.metadata) { try { metadata = JSON.parse(r.metadata) as Record<string, unknown>; } catch { metadata = { raw: r.metadata }; } }
    const red = redactAuditRow({ targetType: r.targetType, targetId: r.targetId, metadata });
    return {
      id: r.id, action: r.action, actorUserId: r.actorUserId, actorEmail: r.actorEmail, targetType: red.targetType, targetId: red.targetId,
      metadata: red.metadata, ip: r.ip, agentId: r.agentId, createdAt: iso(r.createdAt)!,
    };
  });
}

// ---- limits ----------------------------------------------------------------------------------------------------

export interface WorkspaceCapResult { orgId: string; before: { cap: number | null }; after: { cap: number | null } }

/**
 * A workspace's daily send cap, the same write `PUT /api/admin/workspaces/:id/send-cap` makes: a number of outside
 * sends a day, or null to go back to the plan's cap (0 is the sending switch turned off). 404 for an unknown workspace.
 */
export async function setWorkspaceSendCap(deps: Pick<Deps, "db">, orgId: string, cap: number | null): Promise<WorkspaceCapResult> {
  const org = await getOrg(deps.db, orgId);
  await deps.db.update(organizations).set({ sendCapDaily: cap }).where(eq(organizations.id, org.id));
  return { orgId: org.id, before: { cap: org.sendCapDaily }, after: { cap } };
}

/**
 * A workspace's call minutes a month, the same write `PUT /api/admin/workspaces/:id/meeting-cap` makes: null goes
 * back to the plan's rule, 0 blocks new calls. 404 for an unknown workspace.
 */
export async function setWorkspaceMeetingCap(deps: Pick<Deps, "db">, orgId: string, cap: number | null): Promise<WorkspaceCapResult> {
  const org = await getOrg(deps.db, orgId);
  await deps.db.update(organizations).set({ meetingMinutesCap: cap }).where(eq(organizations.id, org.id));
  return { orgId: org.id, before: { cap: org.meetingMinutesCap }, after: { cap } };
}
