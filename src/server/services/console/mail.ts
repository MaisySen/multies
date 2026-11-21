/**
 * OPS1: the operator console's "Mail and deliverability" data layer. Cross-workspace, read-mostly views over
 * deliveries, domains, suppressions, held sends, mail connections and imports, plus the data mutations the
 * route layer wraps with its permission guard, reason and platform audit row. No routes, no audit here.
 *
 * Every list takes the same page request (limit, keyset cursor on (sort field, id), whitelisted sort) and answers
 * `{ items, next }`. Lists are bounded by a time window or an indexed filter because these tables are large and D1
 * counts every row a query reads against a daily budget. Nothing here returns a secret, a hash, a DKIM key, a
 * message body or subject: content access is only through audited impersonation.
 *
 * The small keyset helpers below are shared with `./developer.ts`.
 */
import { and, asc, desc, eq, gte, inArray, lt, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { Deps } from "../../context";
import { deliveries, domains, importJobs, mailboxes, mailConnections, mailSchedules, organizations, suppressions } from "../../db/schema";
import { badRequest, notFound } from "../../lib/errors";
import { containsAny } from "../../lib/like-search";
import { inIds } from "../../lib/sql-chunks";
import { sendingState, verifyDomain } from "../domains";
import { unsuppress } from "../deliverability/suppressions";
import { sendQueuedAnyway } from "../mail/send-queue-r34";
import type { SendPayload } from "../mail/schedules";
import type { DnsCheckReport } from "@/shared/dns";

// ---------------------------------------------------------------- paging (shared with developer.ts)

export type SortDir = "asc" | "desc";
/** A keyset position: the sort field's value (epoch ms for times, a string for text) and the row id. */
export interface PageCursor { v: string | number; id: string }
export interface PageRequest<F extends string = string> { limit: number; cursor: PageCursor | null; sort: { field: F; dir: SortDir } }
export interface Page<T> { items: T[]; next: PageCursor | null }
/** A time range [from, to). Missing ends default per list (usually the last 7 days). */
export interface TimeWindow { from?: Date | null; to?: Date | null }

export const PAGE_MAX = 100;
/** The widest window any console list accepts, so a single query never scans a table's whole history. */
export const WINDOW_MAX_DAYS = 90;
const DAY = 86_400_000;

/** How one whitelisted sort field is read: the SQL it orders by and the JS type its cursor value has. */
export interface SortSpec { expr: SQL; kind: "number" | "text" }

/** The sort spec for `field`, or a 400 when the field is not on the list's whitelist. */
export function sortSpec<F extends string>(specs: Record<F, SortSpec>, field: string): SortSpec {
  if (!Object.hasOwn(specs, field)) throw badRequest(`You can't sort by "${field}". Sort by one of: ${Object.keys(specs).join(", ")}.`);
  return specs[field as F];
}

export function clampLimit(n: number): number {
  if (!Number.isFinite(n)) return 50;
  return Math.max(1, Math.min(PAGE_MAX, Math.floor(n)));
}

/** A nullable time column as a sortable number (null sorts as 0, the oldest). */
export const timeKey = (col: SQLWrapper): SQL => sql`coalesce(${col}, 0)`;

/** The condition that starts a page after `cursor`, in the page's order. */
export function keysetAfter(spec: SortSpec, idCol: SQLWrapper, dir: SortDir, cursor: PageCursor | null): SQL | undefined {
  if (!cursor) return undefined;
  if (typeof cursor.id !== "string" || !cursor.id) throw badRequest("That page link is not valid. Start from the first page.");
  const ok = spec.kind === "number" ? typeof cursor.v === "number" && Number.isFinite(cursor.v) : typeof cursor.v === "string";
  if (!ok) throw badRequest("That page link is not valid. Start from the first page.");
  const v = cursor.v;
  return dir === "desc"
    ? sql`(${spec.expr} < ${v} or (${spec.expr} = ${v} and ${idCol} < ${cursor.id}))`
    : sql`(${spec.expr} > ${v} or (${spec.expr} = ${v} and ${idCol} > ${cursor.id}))`;
}

export function keysetOrder(spec: SortSpec, idCol: SQLWrapper, dir: SortDir): SQL[] {
  return dir === "desc" ? [desc(spec.expr), desc(idCol)] : [asc(spec.expr), asc(idCol)];
}

/** Rows were read with limit + 1: trims the extra one and builds the next cursor from the last item kept. */
export function pageOf<R, T>(rows: R[], limit: number, present: (r: R) => T, cursorOf: (r: R) => PageCursor): Page<T> {
  const more = rows.length > limit;
  const kept = more ? rows.slice(0, limit) : rows;
  return { items: kept.map(present), next: more && kept.length ? cursorOf(kept[kept.length - 1]!) : null };
}

/** [from, to) with defaults, refusing an inverted or over-wide range. */
export function resolveWindow(deps: Deps, w: TimeWindow | undefined, defaultDays = 7): { from: Date; to: Date } {
  // An open end includes this millisecond, so a row written just now is in the window.
  const to = w?.to ?? new Date(deps.now().getTime() + 1);
  const from = w?.from ?? new Date(to.getTime() - defaultDays * DAY);
  if (!(from.getTime() < to.getTime())) throw badRequest("The start of the time range must be before its end.");
  if (to.getTime() - from.getTime() > WINDOW_MAX_DAYS * DAY) throw badRequest(`Pick a time range of ${WINDOW_MAX_DAYS} days or less.`);
  return { from, to };
}

export const ms = (d: Date | null | undefined): number => (d ? d.getTime() : 0);
/** A short single-line excerpt of operator-safe text (provider errors, bounce details). */
export const clip = (s: string | null | undefined, n = 300): string | null => (s == null ? null : s.replace(/\s+/g, " ").trim().slice(0, n));

/** The row, or a 404 naming what was missing. */
export function found<T>(row: T | undefined, what: string): T {
  if (!row) throw notFound(what);
  return row;
}

// ---------------------------------------------------------------- deliveries

export type DeliveryStatus = (typeof deliveries.$inferSelect)["status"];
export const DELIVERY_STATUSES = ["received", "delivered", "forwarded", "queued", "sent", "failed", "rejected", "bounced", "complained", "delayed", "suppressed"] as const satisfies readonly DeliveryStatus[];
/** What counts as a failed delivery in the console (lists default to these, and the failure rate counts them). */
export const DELIVERY_FAILURE_STATUSES = ["failed", "rejected", "bounced", "complained"] as const satisfies readonly DeliveryStatus[];

export const DELIVERY_SORT_FIELDS = ["createdAt"] as const;
export type DeliverySortField = (typeof DELIVERY_SORT_FIELDS)[number];
const deliverySorts: Record<DeliverySortField, SortSpec> = { createdAt: { expr: sql`${deliveries.createdAt}`, kind: "number" } };

export interface DeliveryFilters {
  /** Defaults to DELIVERY_FAILURE_STATUSES. */
  status?: DeliveryStatus[];
  orgId?: string;
  direction?: "inbound" | "outbound";
  /** Matches the from or to address. */
  q?: string;
  /** Defaults to the last 7 days. */
  window?: TimeWindow;
}

/** One delivery attempt. No subject and no message content. */
export interface ConsoleDelivery {
  id: string; orgId: string; orgName: string | null; direction: "inbound" | "outbound"; status: DeliveryStatus;
  fromAddress: string; toAddress: string; provider: string; providerMessageId: string | null; messageId: string | null;
  /** The provider's or our reason, clipped to 300 characters. */
  detail: string | null; createdAt: Date;
}

/**
 * Index: with `orgId`, `deliveries_org_idx (org_id, created_at)` serves the window and order. Without it there is no
 * index that leads with created_at or status, so the window is applied over a scan (see the report on OPS1 indexes).
 */
export async function listDeliveries(deps: Deps, filters: DeliveryFilters, page: PageRequest): Promise<Page<ConsoleDelivery>> {
  const spec = sortSpec(deliverySorts, page.sort.field);
  const limit = clampLimit(page.limit);
  const { from, to } = resolveWindow(deps, filters.window);
  const statuses = filters.status?.length ? filters.status : [...DELIVERY_FAILURE_STATUSES];
  for (const s of statuses) if (!(DELIVERY_STATUSES as readonly string[]).includes(s)) throw badRequest(`Unknown delivery status "${s}".`);
  const q = filters.q?.trim();
  const rows = await deps.db.select({ d: deliveries, orgName: organizations.name }).from(deliveries)
    .leftJoin(organizations, eq(organizations.id, deliveries.orgId))
    .where(and(
      filters.orgId ? eq(deliveries.orgId, filters.orgId) : undefined,
      gte(deliveries.createdAt, from), lt(deliveries.createdAt, to),
      inIds(deliveries.status, statuses),
      filters.direction ? eq(deliveries.direction, filters.direction) : undefined,
      q ? containsAny([deliveries.toAddress, deliveries.fromAddress], q) : undefined,
      keysetAfter(spec, deliveries.id, page.sort.dir, page.cursor),
    ))
    .orderBy(...keysetOrder(spec, deliveries.id, page.sort.dir)).limit(limit + 1);
  return pageOf(rows, limit, ({ d, orgName }) => ({
    id: d.id, orgId: d.orgId, orgName, direction: d.direction, status: d.status, fromAddress: d.fromAddress, toAddress: d.toAddress,
    provider: d.provider, providerMessageId: d.providerMessageId, messageId: d.messageId, detail: clip(d.detail), createdAt: d.createdAt,
  }), ({ d }) => ({ v: ms(d.createdAt), id: d.id }));
}

export interface WorkspaceFailureRate {
  orgId: string; orgName: string | null;
  /** Outbound delivery rows in the window. */
  total: number; failed: number; bounced: number; complained: number;
  /** failed / total, 0 to 1. */
  failureRate: number;
}

/**
 * The workspaces with the highest outbound failure rate in the window (default last 7 days), worst first. A
 * workspace needs `minTotal` outbound rows (default 10) to be ranked, so two sends with one bounce don't top the list.
 * Index: none leads with created_at, so this is one aggregate over the window (see the report on OPS1 indexes).
 */
export async function deliveryFailureRateByWorkspace(deps: Deps, opts: { window?: TimeWindow; limit?: number; minTotal?: number } = {}): Promise<WorkspaceFailureRate[]> {
  const { from, to } = resolveWindow(deps, opts.window);
  const limit = clampLimit(opts.limit ?? 20);
  const minTotal = Math.max(1, Math.floor(opts.minTotal ?? 10));
  const failedCase = sql<number>`sum(case when ${inIds(deliveries.status, [...DELIVERY_FAILURE_STATUSES])} then 1 else 0 end)`;
  const total = sql<number>`count(*)`;
  const rows = await deps.db.select({
    orgId: deliveries.orgId, total, failed: failedCase,
    bounced: sql<number>`sum(case when ${deliveries.status} = 'bounced' then 1 else 0 end)`,
    complained: sql<number>`sum(case when ${deliveries.status} = 'complained' then 1 else 0 end)`,
  }).from(deliveries)
    .where(and(eq(deliveries.direction, "outbound"), gte(deliveries.createdAt, from), lt(deliveries.createdAt, to)))
    .groupBy(deliveries.orgId)
    .having(and(sql`${total} >= ${minTotal}`, sql`${failedCase} > 0`))
    .orderBy(sql`(${failedCase} * 1.0 / ${total}) desc`, sql`${failedCase} desc`, asc(deliveries.orgId))
    .limit(limit);
  const names = await orgNames(deps, rows.map((r) => r.orgId));
  return rows.map((r) => ({
    orgId: r.orgId, orgName: names.get(r.orgId) ?? null, total: Number(r.total), failed: Number(r.failed),
    bounced: Number(r.bounced), complained: Number(r.complained), failureRate: Number(r.total) ? Number(r.failed) / Number(r.total) : 0,
  }));
}

/** Workspace names for a set of ids, one statement (inIds binds one variable past 20 ids). */
export async function orgNames(deps: Deps, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await deps.db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(inIds(organizations.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ---------------------------------------------------------------- domains

export type DomainStatus = (typeof domains.$inferSelect)["status"];
export const DOMAIN_SORT_FIELDS = ["createdAt", "name", "lastCheckedAt"] as const;
export type DomainSortField = (typeof DOMAIN_SORT_FIELDS)[number];
const domainSorts: Record<DomainSortField, SortSpec> = {
  createdAt: { expr: sql`${domains.createdAt}`, kind: "number" },
  name: { expr: sql`${domains.name}`, kind: "text" },
  lastCheckedAt: { expr: timeKey(domains.lastCheckedAt), kind: "number" },
};

export interface DomainFilters { status?: DomainStatus[]; orgId?: string; q?: string }

/** A domain's state. Never the DKIM keys or the verification token. */
export interface ConsoleDomain {
  id: string; orgId: string; orgName: string | null; name: string; status: DomainStatus;
  /** Sending through the outbound provider: null when the domain was never registered there. */
  sending: { status: "queued" | "error" | "verified" | "pending"; detail: string | null } | null;
  /** DNS record ids that did not pass on the last check. */
  failingRecords: string[];
  createdAt: Date; verifiedAt: Date | null; lastCheckedAt: Date | null;
}

/** Index: `domains_org_idx (org_id)` with `orgId`; otherwise a scan of `domains` (one or a few rows per workspace). */
export async function listDomains(deps: Deps, filters: DomainFilters, page: PageRequest): Promise<Page<ConsoleDomain>> {
  const spec = sortSpec(domainSorts, page.sort.field);
  const limit = clampLimit(page.limit);
  const q = filters.q?.trim();
  const rows = await deps.db.select({
    id: domains.id, orgId: domains.orgId, name: domains.name, status: domains.status, providerStatus: domains.providerStatus,
    lastCheck: domains.lastCheck, createdAt: domains.createdAt, verifiedAt: domains.verifiedAt, lastCheckedAt: domains.lastCheckedAt, orgName: organizations.name,
  }).from(domains)
    .leftJoin(organizations, eq(organizations.id, domains.orgId))
    .where(and(
      filters.orgId ? eq(domains.orgId, filters.orgId) : undefined,
      filters.status?.length ? inArray(domains.status, filters.status) : undefined,
      q ? containsAny([domains.name], q) : undefined,
      keysetAfter(spec, domains.id, page.sort.dir, page.cursor),
    ))
    .orderBy(...keysetOrder(spec, domains.id, page.sort.dir)).limit(limit + 1);
  return pageOf(rows, limit, (d) => ({
    id: d.id, orgId: d.orgId, orgName: d.orgName, name: d.name, status: d.status,
    sending: d.providerStatus ? sendingState(d.providerStatus) : null,
    failingRecords: failing(d.lastCheck), createdAt: d.createdAt, verifiedAt: d.verifiedAt, lastCheckedAt: d.lastCheckedAt,
  }), (d) => ({ v: page.sort.field === "name" ? d.name : ms(page.sort.field === "lastCheckedAt" ? d.lastCheckedAt : d.createdAt), id: d.id }));
}

function failing(lastCheck: string | null): string[] {
  if (!lastCheck) return [];
  try {
    const r = JSON.parse(lastCheck) as DnsCheckReport;
    return (r.records ?? []).filter((x) => x.status === "fail" || x.status === "error").map((x) => x.id);
  } catch { return []; }
}

/** A domain's id, workspace, name and state (never its keys or token), or a 404. */
export async function getDomainRef(deps: Deps, id: string): Promise<{ id: string; orgId: string; name: string; status: DomainStatus }> {
  return found(await deps.db.select({ id: domains.id, orgId: domains.orgId, name: domains.name, status: domains.status }).from(domains).where(eq(domains.id, id)).get(), "Domain");
}

export interface RecheckDomainResult { id: string; orgId: string; name: string; before: DomainStatus; status: DomainStatus; changed: boolean; verified: boolean; failingRecords: string[] }

/** Runs the same live DNS check the workspace's "Check DNS" button runs (services/domains.ts verifyDomain). */
export async function recheckDomain(deps: Deps, domainId: string): Promise<RecheckDomainResult> {
  const d = found(await deps.db.select().from(domains).where(eq(domains.id, domainId)).get(), "Domain");
  const { report, status, changed } = await verifyDomain(deps, d);
  return {
    id: d.id, orgId: d.orgId, name: d.name, before: d.status, status, changed, verified: report.verified,
    failingRecords: report.records.filter((x) => x.status === "fail" || x.status === "error").map((x) => x.id),
  };
}

// ---------------------------------------------------------------- suppressions

export type SuppressionReason = (typeof suppressions.$inferSelect)["reason"];
export const SUPPRESSION_SORT_FIELDS = ["createdAt", "address"] as const;
export type SuppressionSortField = (typeof SUPPRESSION_SORT_FIELDS)[number];
const suppressionSorts: Record<SuppressionSortField, SortSpec> = {
  createdAt: { expr: sql`${suppressions.createdAt}`, kind: "number" },
  address: { expr: sql`${suppressions.address}`, kind: "text" },
};

export interface SuppressionFilters {
  orgId?: string; reason?: SuppressionReason[];
  /** Part of the address. */
  q?: string;
  /** Applied only without `orgId` (then it defaults to the last 30 days); a workspace's list is bounded by its index. */
  window?: TimeWindow;
}

export interface ConsoleSuppression { id: string; orgId: string; orgName: string | null; address: string; reason: SuppressionReason; detail: string | null; createdAt: Date }

/**
 * Index: `suppressions_org_address_uq (org_id, address)` with `orgId`. Without it the list is limited to a created_at
 * window, but no index leads with created_at (see the report on OPS1 indexes).
 */
export async function listSuppressions(deps: Deps, filters: SuppressionFilters, page: PageRequest): Promise<Page<ConsoleSuppression>> {
  const spec = sortSpec(suppressionSorts, page.sort.field);
  const limit = clampLimit(page.limit);
  const w = filters.orgId && !filters.window ? null : resolveWindow(deps, filters.window, 30);
  const q = filters.q?.trim();
  const rows = await deps.db.select({ s: suppressions, orgName: organizations.name }).from(suppressions)
    .leftJoin(organizations, eq(organizations.id, suppressions.orgId))
    .where(and(
      filters.orgId ? eq(suppressions.orgId, filters.orgId) : undefined,
      w ? and(gte(suppressions.createdAt, w.from), lt(suppressions.createdAt, w.to)) : undefined,
      filters.reason?.length ? inArray(suppressions.reason, filters.reason) : undefined,
      q ? containsAny([suppressions.address], q) : undefined,
      keysetAfter(spec, suppressions.id, page.sort.dir, page.cursor),
    ))
    .orderBy(...keysetOrder(spec, suppressions.id, page.sort.dir)).limit(limit + 1);
  return pageOf(rows, limit, ({ s, orgName }) => ({ id: s.id, orgId: s.orgId, orgName, address: s.address, reason: s.reason, detail: clip(s.detail, 200), createdAt: s.createdAt }),
    ({ s }) => ({ v: page.sort.field === "address" ? s.address : ms(s.createdAt), id: s.id }));
}

export interface RemovedSuppression { id: string; orgId: string; address: string; reason: SuppressionReason }

/** One suppression by id (the route needs its workspace for the audit row before it changes anything), or a 404. */
export async function getSuppression(deps: Deps, id: string): Promise<RemovedSuppression> {
  return found(await deps.db.select({ id: suppressions.id, orgId: suppressions.orgId, address: suppressions.address, reason: suppressions.reason })
    .from(suppressions).where(eq(suppressions.id, id)).get(), "Suppressed address");
}

/** Lets mail go to the address again (the workspace's own unsuppress). */
export async function removeSuppression(deps: Deps, id: string): Promise<RemovedSuppression> {
  const s = await getSuppression(deps, id);
  const row = await unsuppress(deps.db, s.orgId, id);
  return { id: row.id, orgId: row.orgId, address: row.address, reason: row.reason };
}

// ---------------------------------------------------------------- queued (held) sends

export const QUEUED_SEND_SORT_FIELDS = ["dueAt", "createdAt"] as const;
export type QueuedSendSortField = (typeof QUEUED_SEND_SORT_FIELDS)[number];
const queuedSorts: Record<QueuedSendSortField, SortSpec> = {
  dueAt: { expr: sql`${mailSchedules.dueAt}`, kind: "number" },
  createdAt: { expr: sql`${mailSchedules.createdAt}`, kind: "number" },
};

export interface QueuedSendFilters {
  orgId?: string;
  /** On due_at. Held sends are due at the next UTC midnight, so the default is 7 days back to 2 days ahead. */
  window?: TimeWindow;
}

/** A message a sending limit queued until tomorrow. No subject, no body, no recipient addresses. */
export interface ConsoleQueuedSend {
  id: string; orgId: string; orgName: string | null; mailboxId: string; mailboxAddress: string | null;
  /** Why the limit held it (our own copy, e.g. "New workspaces send to 20 outside recipients a day"). */
  reason: string; recipients: number; forced: boolean; dueAt: Date; createdAt: Date;
}

/** Index: `mail_schedules_due_idx (status, due_at)` serves status = 'pending' and the due_at window. */
export async function listQueuedSendsAll(deps: Deps, filters: QueuedSendFilters, page: PageRequest): Promise<Page<ConsoleQueuedSend>> {
  const spec = sortSpec(queuedSorts, page.sort.field);
  const limit = clampLimit(page.limit);
  const now = deps.now().getTime();
  const { from, to } = resolveWindow(deps, { from: filters.window?.from ?? new Date(now - 7 * DAY), to: filters.window?.to ?? new Date(now + 2 * DAY) });
  const rows = await deps.db.select({ r: mailSchedules, orgName: organizations.name, address: mailboxes.address }).from(mailSchedules)
    .leftJoin(organizations, eq(organizations.id, mailSchedules.orgId))
    .leftJoin(mailboxes, eq(mailboxes.id, mailSchedules.mailboxId))
    .where(and(
      eq(mailSchedules.status, "pending"), gte(mailSchedules.dueAt, from), lt(mailSchedules.dueAt, to),
      eq(mailSchedules.kind, "send"), sql`json_extract(${mailSchedules.payload}, '$.held') is not null`,
      filters.orgId ? eq(mailSchedules.orgId, filters.orgId) : undefined,
      keysetAfter(spec, mailSchedules.id, page.sort.dir, page.cursor),
    ))
    .orderBy(...keysetOrder(spec, mailSchedules.id, page.sort.dir)).limit(limit + 1);
  return pageOf(rows, limit, ({ r, orgName, address }) => {
    let p: Partial<SendPayload> = {};
    try { p = JSON.parse(r.payload ?? "{}") as SendPayload; } catch { /* a broken payload still lists */ }
    const i = p.input;
    return {
      id: r.id, orgId: r.orgId, orgName, mailboxId: r.mailboxId, mailboxAddress: address, reason: clip(p.held ?? "", 200) ?? "",
      recipients: i ? (i.to?.length ?? 0) + (i.cc?.length ?? 0) + (i.bcc?.length ?? 0) : 0, forced: !!p.force, dueAt: r.dueAt, createdAt: r.createdAt,
    };
  }, ({ r }) => ({ v: ms(page.sort.field === "createdAt" ? r.createdAt : r.dueAt), id: r.id }));
}

/** A queued send's id, workspace and state (no payload), or a 404. */
export async function getQueuedSendRef(deps: Deps, id: string): Promise<{ id: string; orgId: string; status: string; dueAt: Date }> {
  return found(await deps.db.select({ id: mailSchedules.id, orgId: mailSchedules.orgId, status: mailSchedules.status, dueAt: mailSchedules.dueAt })
    .from(mailSchedules).where(and(eq(mailSchedules.id, id), eq(mailSchedules.kind, "send"))).get(), "Queued message");
}

/** "Send anyway": the existing operator action (services/mail/send-queue-r34.ts). Sends past limits, never past the kill switch. */
export async function forceQueuedSend(deps: Deps, orgId: string, scheduleId: string): Promise<{ ok: boolean; id: string; dueAt: string }> {
  return sendQueuedAnyway(deps, orgId, scheduleId);
}

export interface WorkspaceSendingResult { orgId: string; sending: boolean; sendCapDaily: number | null; before: { sendCapDaily: number | null } }

/**
 * The per-workspace sending kill switch (R34, MB-169), the same write `PUT /api/admin/workspaces/:id/sending` makes
 * inline: off sets send_cap_daily to 0 (sends are refused with a clear message), on clears it back to the plan's cap.
 */
export async function setWorkspaceSending(deps: Deps, orgId: string, enabled: boolean): Promise<WorkspaceSendingResult> {
  const org = await deps.db.select({ id: organizations.id, sendCapDaily: organizations.sendCapDaily }).from(organizations).where(eq(organizations.id, orgId)).get();
  if (!org) throw notFound("Workspace");
  const cap = enabled ? null : 0;
  await deps.db.update(organizations).set({ sendCapDaily: cap }).where(eq(organizations.id, org.id));
  return { orgId: org.id, sending: enabled, sendCapDaily: cap, before: { sendCapDaily: org.sendCapDaily } };
}

// ---------------------------------------------------------------- mail connections

export type MailConnectionStatus = (typeof mailConnections.$inferSelect)["status"];
export const MAIL_CONNECTION_SORT_FIELDS = ["createdAt", "lastSyncAt", "email"] as const;
export type MailConnectionSortField = (typeof MAIL_CONNECTION_SORT_FIELDS)[number];
const connectionSorts: Record<MailConnectionSortField, SortSpec> = {
  createdAt: { expr: sql`${mailConnections.createdAt}`, kind: "number" },
  lastSyncAt: { expr: timeKey(mailConnections.lastSyncAt), kind: "number" },
  email: { expr: sql`${mailConnections.email}`, kind: "text" },
};

export interface MailConnectionFilters { status?: MailConnectionStatus[]; orgId?: string; q?: string }

/** A connected outside mailbox. Never the password or OAuth token, nor the sync state. */
export interface ConsoleMailConnection {
  id: string; orgId: string; orgName: string | null; mailboxId: string; provider: string; email: string;
  imapHost: string; smtpHost: string; authKind: "password" | "oauth"; status: MailConnectionStatus; lastError: string | null;
  initialDone: boolean; messagesSynced: number; lastSyncAt: Date | null; nextSyncAt: Date | null; createdAt: Date;
}

/**
 * Index: `mail_connections_due_idx (status, next_sync_at)` with `status`, `mail_connections_org_idx (org_id)` with
 * `orgId`; otherwise a scan of `mail_connections` (one row per connected mailbox).
 */
export async function listMailConnections(deps: Deps, filters: MailConnectionFilters, page: PageRequest): Promise<Page<ConsoleMailConnection>> {
  const spec = sortSpec(connectionSorts, page.sort.field);
  const limit = clampLimit(page.limit);
  const q = filters.q?.trim();
  const c = mailConnections;
  const rows = await deps.db.select({
    id: c.id, orgId: c.orgId, mailboxId: c.mailboxId, provider: c.provider, email: c.email, imapHost: c.imapHost, smtpHost: c.smtpHost,
    authKind: c.authKind, status: c.status, lastError: c.lastError, initialDone: c.initialDone, messagesSynced: c.messagesSynced,
    lastSyncAt: c.lastSyncAt, nextSyncAt: c.nextSyncAt, createdAt: c.createdAt, orgName: organizations.name,
  }).from(c)
    .leftJoin(organizations, eq(organizations.id, c.orgId))
    .where(and(
      filters.status?.length ? inArray(c.status, filters.status) : undefined,
      filters.orgId ? eq(c.orgId, filters.orgId) : undefined,
      q ? containsAny([c.email], q) : undefined,
      keysetAfter(spec, c.id, page.sort.dir, page.cursor),
    ))
    .orderBy(...keysetOrder(spec, c.id, page.sort.dir)).limit(limit + 1);
  return pageOf(rows, limit, (r) => ({ ...r, lastError: clip(r.lastError) }),
    (r) => ({ v: page.sort.field === "email" ? r.email : ms(page.sort.field === "lastSyncAt" ? r.lastSyncAt : r.createdAt), id: r.id }));
}

// ---------------------------------------------------------------- import jobs

export type ImportJobStatus = (typeof importJobs.$inferSelect)["status"];
export const IMPORT_JOB_SORT_FIELDS = ["createdAt"] as const;
export type ImportJobSortField = (typeof IMPORT_JOB_SORT_FIELDS)[number];
const importSorts: Record<ImportJobSortField, SortSpec> = { createdAt: { expr: sql`${importJobs.createdAt}`, kind: "number" } };

export interface ImportJobFilters {
  status?: ImportJobStatus[]; orgId?: string;
  /** Applied when neither `status` nor `orgId` narrows the list; then it defaults to the last 30 days. */
  window?: TimeWindow;
}

/** A mail import. Never the source app password. */
export interface ConsoleImportJob {
  id: string; orgId: string; orgName: string | null; mailboxId: string; provider: "gmail" | "outlook" | "imap"; sourceHost: string;
  status: ImportJobStatus; messagesDone: number; messagesTotal: number | null; error: string | null;
  claimedAt: Date | null; heartbeatAt: Date | null; finishedAt: Date | null; createdAt: Date;
}

/** Index: `import_jobs_status_idx (status)` with `status`, `import_jobs_org_idx (org_id)` with `orgId`. */
export async function listImportJobs(deps: Deps, filters: ImportJobFilters, page: PageRequest): Promise<Page<ConsoleImportJob>> {
  const spec = sortSpec(importSorts, page.sort.field);
  const limit = clampLimit(page.limit);
  const narrowed = !!filters.status?.length || !!filters.orgId;
  const w = narrowed && !filters.window ? null : resolveWindow(deps, filters.window, 30);
  const j = importJobs;
  const rows = await deps.db.select({
    id: j.id, orgId: j.orgId, mailboxId: j.mailboxId, provider: j.provider, sourceHost: j.sourceHost, status: j.status,
    messagesDone: j.messagesDone, messagesTotal: j.messagesTotal, error: j.error, claimedAt: j.claimedAt, heartbeatAt: j.heartbeatAt,
    finishedAt: j.finishedAt, createdAt: j.createdAt, orgName: organizations.name,
  }).from(j)
    .leftJoin(organizations, eq(organizations.id, j.orgId))
    .where(and(
      filters.status?.length ? inArray(j.status, filters.status) : undefined,
      filters.orgId ? eq(j.orgId, filters.orgId) : undefined,
      w ? and(gte(j.createdAt, w.from), lt(j.createdAt, w.to)) : undefined,
      keysetAfter(spec, j.id, page.sort.dir, page.cursor),
    ))
    .orderBy(...keysetOrder(spec, j.id, page.sort.dir)).limit(limit + 1);
  return pageOf(rows, limit, (r) => ({ ...r, error: clip(r.error) }), (r) => ({ v: ms(r.createdAt), id: r.id }));
}
