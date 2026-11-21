/**
 * OPS1: the data layer for the console's "Moderation and abuse" section. Reads only, plus thin wrappers that return
 * { before, after } for the platform audit row (the route runs them inside operatorAction). No HTTP here.
 *
 * - Reports: the R35 queue (services/suite/reports-r35.ts) with filters and keyset paging. Items keep the shape the
 *   existing GET /api/admin/reports answers (the message snapshot exactly as that endpoint returns it, nothing more),
 *   plus orgId and the workspace name. Acting on a report goes through actOnReport, unchanged.
 * - Abuse signals: abuse_events (services/abuse.ts) with filters and paging past the old 100 row cap, and a per
 *   workspace summary of open signals.
 * - Suspended workspaces: organizations.suspended_at, with who suspended from the platform audit log when there is a row.
 *
 * Paging contract (shared by every console data layer): a list takes
 *   page: { limit, cursor: { v, id } | null, sort: { field, dir } }
 * where sort.field is checked against the list's exported whitelist, and answers { items, next: { v, id } | null },
 * keyset on (sort field, id). Date sort values travel as epoch milliseconds. The route layer encodes the cursor.
 */
import { and, asc, count, desc, eq, gt, isNotNull, isNull, lt, max, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { Deps } from "../../context";
import { abuseEvents, contentReports, organizations, platformAuditLogs } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { containsAny } from "../../lib/like-search";
import { inIds } from "../../lib/sql-chunks";
import { getOrg } from "../plans";
import { actOnReport, REPORT_REASONS, type ReportAction, type ReportReason } from "../suite/reports-r35";

// ---------------------------------------------------------------- paging (the fixed console data-layer contract)

export type SortDir = "asc" | "desc";
export interface PageCursor { v: string | number; id: string }
export interface PageRequest<F extends string = string> {
  limit: number;
  cursor: PageCursor | null;
  sort: { field: F; dir: SortDir };
}
export interface Paged<T> { items: T[]; next: PageCursor | null }

export const PAGE_MAX_LIMIT = 200;

type SortKind = "date" | "number" | "string";
interface SortSpec { col: SQLWrapper; kind: SortKind }

function badSort(field: string, allowed: readonly string[]) {
  return new HttpError(400, "bad_sort", `You can't sort this list by "${field}". Use one of: ${allowed.join(", ")}.`);
}

function cursorValue(kind: SortKind, v: string | number): Date | number | string {
  if (kind === "date") {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) throw new HttpError(400, "bad_cursor", "That page link is out of date. Start the list again.");
    return new Date(n);
  }
  if (kind === "number") {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) throw new HttpError(400, "bad_cursor", "That page link is out of date. Start the list again.");
    return n;
  }
  return String(v);
}

/** Keyset conditions and order for one page; `key` turns a row's sort value into the cursor's v. */
function keyset<F extends string>(specs: Record<F, SortSpec>, idCol: SQLWrapper, page: PageRequest) {
  const allowed = Object.keys(specs);
  if (!Object.prototype.hasOwnProperty.call(specs, page.sort.field)) throw badSort(page.sort.field, allowed);
  const spec = specs[page.sort.field as F];
  const dir: SortDir = page.sort.dir === "asc" ? "asc" : "desc";
  const limit = Math.max(1, Math.min(Math.floor(page.limit) || 50, PAGE_MAX_LIMIT));
  let where: SQL | undefined;
  if (page.cursor) {
    if (typeof page.cursor.id !== "string" || !page.cursor.id) throw new HttpError(400, "bad_cursor", "That page link is out of date. Start the list again.");
    const v = cursorValue(spec.kind, page.cursor.v);
    const past = dir === "desc" ? lt : gt;
    // The column's own encoder maps the Date to its stored milliseconds.
    where = or(past(spec.col as never, v), and(eq(spec.col as never, v), past(idCol as never, page.cursor.id)));
  }
  const by = dir === "desc" ? desc : asc;
  return {
    where, limit, take: limit + 1, orderBy: [by(spec.col), by(idCol)],
    page<T>(rows: T[], key: (row: T) => { v: Date | number | string; id: string }): Paged<T> {
      const items = rows.slice(0, limit);
      const last = items[items.length - 1];
      if (rows.length <= limit || !last) return { items, next: null };
      const k = key(last);
      return { items, next: { v: k.v instanceof Date ? k.v.getTime() : k.v, id: k.id } };
    },
  };
}

// ---------------------------------------------------------------- reports queue

export const REPORT_SORT_FIELDS = ["createdAt"] as const;
export type ReportSortField = (typeof REPORT_SORT_FIELDS)[number];
export type ReportStatusFilter = "open" | "resolved" | "dismissed" | "all";

export interface ListReportsInput {
  status: ReportStatusFilter;
  reason?: ReportReason;
  orgId?: string;
  /** Matches the report id, the reporter's note, the reporter's and the reported person's name or email, and the workspace name. */
  q?: string;
  page: PageRequest<ReportSortField>;
}

/** One report, as GET /api/admin/reports answers it, plus orgId and the workspace name. */
export interface ConsoleReport {
  id: string;
  status: "open" | "resolved" | "dismissed";
  action: "none" | "message_removed" | "user_suspended" | "warned";
  targetType: "message" | "user";
  context: "chat" | "meeting" | "dm" | null;
  reason: ReportReason;
  note: string | null;
  workspaceId: string | null;
  orgId: string | null;
  workspaceName: string | null;
  messageId: string | null;
  snapshotText: string | null;
  snapshotAuthorId: string | null;
  reporter: { id: string; name: string | null; email: string | null };
  target: { id: string; name: string | null; email: string | null; suspended: boolean } | null;
  createdAt: string;
  ageHours: number;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
}

const reporterName = sql<string | null>`(select u."name" from "users" u where u."id" = "content_reports"."reporter_user_id")`;
const reporterEmail = sql<string | null>`(select u."email" from "users" u where u."id" = "content_reports"."reporter_user_id")`;
const targetName = sql<string | null>`(select u."name" from "users" u where u."id" = "content_reports"."target_user_id")`;
const targetEmail = sql<string | null>`(select u."email" from "users" u where u."id" = "content_reports"."target_user_id")`;
const targetBanned = sql<number | null>`(select u."banned" from "users" u where u."id" = "content_reports"."target_user_id")`;
const reportOrgName = sql<string | null>`(select o."name" from "organizations" o where o."id" = "content_reports"."org_id")`;

const REPORT_SORTS: Record<ReportSortField, SortSpec> = { createdAt: { col: contentReports.createdAt, kind: "date" } };

/** One page of the reports queue (the existing listReports is unchanged and keeps its 200 row cap). */
export async function listReports(deps: Deps, input: ListReportsInput): Promise<Paged<ConsoleReport>> {
  const k = keyset(REPORT_SORTS, contentReports.id, input.page);
  if (input.reason && !(REPORT_REASONS as readonly string[]).includes(input.reason)) throw new HttpError(400, "bad_filter", "Unknown report reason.");
  const q = (input.q ?? "").trim().slice(0, 100);
  const where = and(
    input.status === "all" ? undefined : eq(contentReports.status, input.status),
    input.reason ? eq(contentReports.reason, input.reason) : undefined,
    input.orgId ? eq(contentReports.orgId, input.orgId) : undefined,
    q ? containsAny([contentReports.id, contentReports.note, reporterName, reporterEmail, targetName, targetEmail, reportOrgName], q) : undefined,
    k.where,
  );
  const rows = await deps.db.select({
    r: contentReports, reporterName, reporterEmail, targetName, targetEmail, targetBanned, workspaceName: reportOrgName,
  }).from(contentReports).where(where).orderBy(...k.orderBy).limit(k.take);
  const page = k.page(rows, (x) => ({ v: x.r.createdAt, id: x.r.id }));
  const now = deps.now().getTime();
  return {
    next: page.next,
    items: page.items.map(({ r, ...x }) => ({
      id: r.id, status: r.status, action: r.action, targetType: r.targetType, context: r.context, reason: r.reason, note: r.note,
      workspaceId: r.orgId, orgId: r.orgId, workspaceName: x.workspaceName,
      messageId: r.messageId, snapshotText: r.snapshotText, snapshotAuthorId: r.snapshotAuthorId,
      reporter: { id: r.reporterUserId, name: x.reporterName, email: x.reporterEmail },
      target: r.targetUserId ? { id: r.targetUserId, name: x.targetName, email: x.targetEmail, suspended: !!x.targetBanned } : null,
      createdAt: r.createdAt.toISOString(), ageHours: Math.floor((now - r.createdAt.getTime()) / 3600_000),
      resolvedAt: r.resolvedAt?.toISOString() ?? null, resolvedBy: r.resolvedBy, resolutionNote: r.resolutionNote,
    })),
  };
}

export interface ReportCounts {
  open: number;
  /** Open reports filed more than 12 hours ago. */
  olderThan12h: number;
  /** Open reports filed more than 24 hours ago (Apple's limit for acting on a report). */
  olderThan24h: number;
  oldestAt: string | null;
}

/** Open reports and how many are past 12 and 24 hours. One read. */
export async function reportCounts(deps: Deps): Promise<ReportCounts> {
  const now = deps.now().getTime();
  const h12 = now - 12 * 3600_000;
  const h24 = now - 24 * 3600_000;
  const row = await deps.db.select({
    open: count(),
    older12: sql<number | null>`sum(case when ${contentReports.createdAt} < ${h12} then 1 else 0 end)`,
    older24: sql<number | null>`sum(case when ${contentReports.createdAt} < ${h24} then 1 else 0 end)`,
    oldest: sql<number | null>`min(${contentReports.createdAt})`,
  }).from(contentReports).where(eq(contentReports.status, "open")).get();
  return {
    open: row?.open ?? 0,
    olderThan12h: Number(row?.older12 ?? 0),
    olderThan24h: Number(row?.older24 ?? 0),
    oldestAt: row?.oldest ? new Date(Number(row.oldest)).toISOString() : null,
  };
}

export interface ReportActionResult {
  before: { status: ConsoleReport["status"]; action: ConsoleReport["action"]; targetUserId: string | null; workspaceId: string | null };
  after: { status: ConsoleReport["status"]; action: ConsoleReport["action"]; targetUserId: string | null; workspaceId: string | null };
  /** The report as the existing endpoint answers it after the action. */
  report: Awaited<ReturnType<typeof actOnReport>>;
}

/** Acts on a report through the existing actOnReport (dismiss, resolve, remove_message, suspend_user). */
export async function actOnReportForConsole(deps: Deps, operator: { userId: string }, id: string, input: { action: ReportAction; note?: string }): Promise<ReportActionResult> {
  const r = await deps.db.select({ status: contentReports.status, action: contentReports.action, targetUserId: contentReports.targetUserId, orgId: contentReports.orgId })
    .from(contentReports).where(eq(contentReports.id, id)).get();
  if (!r) throw new HttpError(404, "not_found", "Report not found.");
  const report = await actOnReport(deps, operator, id, input);
  return {
    before: { status: r.status, action: r.action, targetUserId: r.targetUserId, workspaceId: r.orgId },
    after: { status: report.status, action: report.action, targetUserId: report.target?.id ?? null, workspaceId: report.workspaceId },
    report,
  };
}

// ---------------------------------------------------------------- abuse signals

export const ABUSE_SORT_FIELDS = ["createdAt", "score"] as const;
export type AbuseSortField = (typeof ABUSE_SORT_FIELDS)[number];

export interface ListAbuseEventsInput {
  /** true: resolved only; false: open only; left out: both. */
  resolved?: boolean;
  kind?: string;
  orgId?: string;
  page: PageRequest<AbuseSortField>;
}

export interface ConsoleAbuseEvent {
  id: string;
  orgId: string;
  workspaceName: string;
  kind: string;
  score: number;
  detail: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

const ABUSE_SORTS: Record<AbuseSortField, SortSpec> = {
  createdAt: { col: abuseEvents.createdAt, kind: "date" },
  score: { col: abuseEvents.score, kind: "number" },
};

/** One page of abuse signals, any age (the old endpoint stops at the newest 100 open ones). */
export async function listAbuseEvents(deps: Deps, input: ListAbuseEventsInput): Promise<Paged<ConsoleAbuseEvent>> {
  const k = keyset(ABUSE_SORTS, abuseEvents.id, input.page);
  const kind = input.kind?.trim().slice(0, 64);
  const rows = await deps.db.select({
    id: abuseEvents.id, orgId: abuseEvents.orgId, workspaceName: organizations.name, kind: abuseEvents.kind, score: abuseEvents.score,
    detail: abuseEvents.detail, createdAt: abuseEvents.createdAt, resolvedAt: abuseEvents.resolvedAt,
  }).from(abuseEvents).innerJoin(organizations, eq(organizations.id, abuseEvents.orgId))
    .where(and(
      input.resolved === undefined ? undefined : input.resolved ? isNotNull(abuseEvents.resolvedAt) : isNull(abuseEvents.resolvedAt),
      kind ? eq(abuseEvents.kind, kind) : undefined,
      input.orgId ? eq(abuseEvents.orgId, input.orgId) : undefined,
      k.where,
    )).orderBy(...k.orderBy).limit(k.take);
  const sortField = input.page.sort.field;
  const page = k.page(rows, (r) => ({ v: sortField === "score" ? r.score : r.createdAt, id: r.id }));
  return {
    next: page.next,
    items: page.items.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), resolvedAt: r.resolvedAt?.toISOString() ?? null })),
  };
}

export interface AbuseWorkspaceSummary {
  orgId: string;
  workspaceName: string;
  openEvents: number;
  topScore: number;
  lastEventAt: string;
  suspended: boolean;
}

/** Workspaces with open abuse signals: how many and the highest score, highest score first. */
export async function abuseSummaryByWorkspace(deps: Deps, opts: { limit?: number } = {}): Promise<AbuseWorkspaceSummary[]> {
  const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 50) || 50, PAGE_MAX_LIMIT));
  const top = max(abuseEvents.score);
  const rows = await deps.db.select({
    orgId: abuseEvents.orgId, workspaceName: organizations.name, suspendedAt: organizations.suspendedAt,
    openEvents: count(), topScore: top, lastAt: sql<number>`max(${abuseEvents.createdAt})`,
  }).from(abuseEvents).innerJoin(organizations, eq(organizations.id, abuseEvents.orgId))
    .where(isNull(abuseEvents.resolvedAt))
    .groupBy(abuseEvents.orgId, organizations.name, organizations.suspendedAt)
    .orderBy(desc(top), desc(count()), asc(abuseEvents.orgId)).limit(limit);
  return rows.map((r) => ({
    orgId: r.orgId, workspaceName: r.workspaceName, openEvents: r.openEvents, topScore: Number(r.topScore ?? 0),
    lastEventAt: new Date(Number(r.lastAt)).toISOString(), suspended: !!r.suspendedAt,
  }));
}

export type ResolveAbuseTarget = { ids: string[] } | { orgId: string };
export interface ResolveAbuseResult {
  /** The events that were open (ids capped at 100 for the audit row). */
  before: { resolvedAt: null; count: number; ids: string[]; orgIds: string[] };
  after: { resolvedAt: string | null; count: number };
}

/** Marks open abuse signals resolved, by id (any number: one bound list) or every open one of a workspace. */
export async function resolveAbuseEvents(deps: Deps, target: ResolveAbuseTarget): Promise<ResolveAbuseResult> {
  const now = deps.now();
  const match = "ids" in target ? inIds(abuseEvents.id, target.ids) : eq(abuseEvents.orgId, target.orgId);
  const done = await deps.db.update(abuseEvents).set({ resolvedAt: now })
    .where(and(match, isNull(abuseEvents.resolvedAt))).returning({ id: abuseEvents.id, orgId: abuseEvents.orgId });
  return {
    before: { resolvedAt: null, count: done.length, ids: done.slice(0, 100).map((r) => r.id), orgIds: [...new Set(done.map((r) => r.orgId))].slice(0, 100) },
    after: { resolvedAt: done.length ? now.toISOString() : null, count: done.length },
  };
}

// ---------------------------------------------------------------- suspended workspaces

export const SUSPENDED_SORT_FIELDS = ["suspendedAt", "name"] as const;
export type SuspendedSortField = (typeof SUSPENDED_SORT_FIELDS)[number];

export interface SuspendedWorkspace {
  orgId: string;
  workspaceName: string;
  suspendedAt: string;
  reason: string | null;
  /** The spam filter suspended it (services/abuse.ts maybeAutoSuspend), not an operator. */
  automatic: boolean;
  /** The operator, from the platform audit log; null when automatic or suspended before the log existed. */
  suspendedBy: { userId: string | null; email: string | null } | null;
  openAbuseEvents: number;
}

const SUSPENDED_SORTS: Record<SuspendedSortField, SortSpec> = {
  suspendedAt: { col: organizations.suspendedAt, kind: "date" },
  name: { col: organizations.name, kind: "string" },
};

const AUTO_PREFIX = "Automatic:";

/** One page of suspended workspaces with the reason, when, and who (from the audit trail when there is a row). */
export async function listSuspendedWorkspaces(deps: Deps, page: PageRequest<SuspendedSortField>): Promise<Paged<SuspendedWorkspace>> {
  const k = keyset(SUSPENDED_SORTS, organizations.id, page);
  const rows = await deps.db.select({
    id: organizations.id, name: organizations.name, suspendedAt: organizations.suspendedAt, reason: organizations.suspendedReason,
    openAbuse: sql<number>`(select count(*) from "abuse_events" a where a."org_id" = "organizations"."id" and a."resolved_at" is null)`,
  }).from(organizations).where(and(isNotNull(organizations.suspendedAt), k.where)).orderBy(...k.orderBy).limit(k.take);
  const p = k.page(rows, (r) => ({ v: page.sort.field === "name" ? r.name : r.suspendedAt!, id: r.id }));
  // The suspension's audit row: the newest "workspace.suspended" on the workspace written at or after suspended_at.
  const ids = p.items.map((r) => r.id);
  const audits = ids.length ? await deps.db.select({
    orgId: platformAuditLogs.targetId, actorUserId: platformAuditLogs.actorUserId, actorEmail: platformAuditLogs.actorEmail, at: platformAuditLogs.createdAt,
  }).from(platformAuditLogs).where(and(eq(platformAuditLogs.action, "workspace.suspended"), eq(platformAuditLogs.targetType, "workspace"), inIds(platformAuditLogs.targetId, ids)))
    .orderBy(desc(platformAuditLogs.createdAt)) : [];
  return {
    next: p.next,
    items: p.items.map((r) => {
      const at = r.suspendedAt!;
      const automatic = (r.reason ?? "").startsWith(AUTO_PREFIX);
      const row = automatic ? undefined : audits.find((a) => a.orgId === r.id && a.at.getTime() >= at.getTime());
      return {
        orgId: r.id, workspaceName: r.name, suspendedAt: at.toISOString(), reason: r.reason, automatic,
        suspendedBy: row ? { userId: row.actorUserId, email: row.actorEmail } : null, openAbuseEvents: Number(r.openAbuse ?? 0),
      };
    }),
  };
}

export interface SuspensionState { suspendedAt: string | null; suspendedReason: string | null }
export interface SuspendResult { orgId: string; before: SuspensionState; after: SuspensionState }
export interface UnsuspendResult extends SuspendResult { resolvedAbuseEvents: number }

const state = (o: { suspendedAt: Date | null; suspendedReason: string | null }): SuspensionState => ({ suspendedAt: o.suspendedAt?.toISOString() ?? null, suspendedReason: o.suspendedReason });

/**
 * Suspends a workspace: the same change as POST /api/admin/workspaces/:id/suspend (suspended_at now, the reason the
 * workspace sees). The route validates the reason and audits. 404 for an unknown workspace.
 */
export async function suspendWorkspace(deps: Deps, orgId: string, reason: string): Promise<SuspendResult> {
  const org = await getOrg(deps.db, orgId);
  const now = deps.now();
  await deps.db.update(organizations).set({ suspendedAt: now, suspendedReason: reason }).where(eq(organizations.id, org.id));
  return { orgId: org.id, before: state(org), after: state({ suspendedAt: now, suspendedReason: reason }) };
}

/**
 * Lifts a suspension: the same change as POST /api/admin/workspaces/:id/unsuspend (clears the suspension and resolves
 * the workspace's open abuse signals through resolveAbuseEvents).
 */
export async function unsuspendWorkspace(deps: Deps, orgId: string): Promise<UnsuspendResult> {
  const org = await getOrg(deps.db, orgId);
  await deps.db.update(organizations).set({ suspendedAt: null, suspendedReason: null }).where(eq(organizations.id, org.id));
  const resolved = await resolveAbuseEvents(deps, { orgId: org.id });
  return { orgId: org.id, before: state(org), after: state({ suspendedAt: null, suspendedReason: null }), resolvedAbuseEvents: resolved.after.count };
}
