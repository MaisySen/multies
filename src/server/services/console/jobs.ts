/**
 * OPS1 (operator console, "Jobs and maintenance"): the cross-workspace data layer over the durable job queue
 * (services/jobs.ts) and the data moves (imports and exports). Pure functions over Deps: no routes, no audit (the
 * route layer wraps every mutation in operatorAction with a reason).
 *
 * Paging contract shared by every console list in this area (agents.ts and system.ts import it from here):
 *   page: { limit, cursor: { v, id } | null, sort: { field, dir } }  ->  { items, next: { v, id } | null }
 * Keyset on (sort field, id); `sort.field` must be in the list's exported whitelist (else 422 invalid_sort). Dates
 * travel in a cursor as epoch milliseconds. Sort expressions are never null (NOT NULL columns or coalesce), because a
 * null breaks the keyset.
 *
 * D1 reads: every list here is bounded by an indexed filter or a time window; see the notes on each function.
 */
import { and, asc, desc, eq, gte, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { Deps } from "../../context";
import { dataMoves, jobs, organizations } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { replayJobs } from "../jobs";
import { withOwnerEmail } from "./owners";

// ------------------------------------------------------------------ paging (shared by the console data layer)

export type SortDir = "asc" | "desc";
export interface ConsoleCursor { v: string | number; id: string }
export interface ConsolePage<F extends string = string> { limit: number; cursor: ConsoleCursor | null; sort: { field: F | string; dir: SortDir } }
export interface ConsolePageResult<T> {
  items: T[]; next: ConsoleCursor | null;
  /** True when an unscoped list looked only at the newest rows (recent-rows.ts): older ones need a workspace filter. */
  recentOnly?: boolean;
}

export const CONSOLE_PAGE_MAX = 200;
export const CONSOLE_PAGE_DEFAULT = 50;

/** One whitelisted sort field: the SQL it orders by (never null) and the cursor value type it takes. */
export interface SortDef { expr: SQLWrapper; kind: "number" | "string" }

export interface PageParts<F extends string> {
  field: F; dir: SortDir; limit: number;
  /** limit + 1: the extra row says whether there is a next page. */
  take: number;
  /** The keyset condition (undefined on the first page). */
  after: SQL | undefined;
  orderBy: SQL[];
  /** Cuts the extra row and builds `next` from the last item kept. */
  finish<R, T>(rows: R[], key: (r: R) => ConsoleCursor, map: (r: R) => T): ConsolePageResult<T>;
}

const badSort = (msg: string) => new HttpError(422, "invalid_sort", msg);

/** Validates a page against a sort whitelist and builds the keyset parts. Throws 422 on a field or cursor that does not fit. */
export function pageParts<F extends string>(page: ConsolePage, defs: Record<F, SortDef>, idCol: SQLWrapper): PageParts<F> {
  const fields = Object.keys(defs) as F[];
  const field = page?.sort?.field as F;
  if (!fields.includes(field)) throw badSort(`Sort by one of: ${fields.join(", ")}.`);
  const dir = page.sort.dir;
  if (dir !== "asc" && dir !== "desc") throw badSort("Sort direction is asc or desc.");
  const n = Number(page.limit);
  const limit = Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), CONSOLE_PAGE_MAX) : CONSOLE_PAGE_DEFAULT;
  const def = defs[field];
  let after: SQL | undefined;
  const c = page.cursor;
  if (c) {
    if (typeof c.id !== "string" || !c.id || c.id.length > 320) throw new HttpError(400, "bad_cursor", "That page link is out of date. Start the list again.");
    if (def.kind === "number" ? typeof c.v !== "number" || !Number.isFinite(c.v) : typeof c.v !== "string") {
      throw new HttpError(400, "bad_cursor", "That page link is out of date. Start the list again.");
    }
    after = dir === "desc"
      ? sql`(${def.expr} < ${c.v} or (${def.expr} = ${c.v} and ${idCol} < ${c.id}))`
      : sql`(${def.expr} > ${c.v} or (${def.expr} = ${c.v} and ${idCol} > ${c.id}))`;
  }
  const by = dir === "desc" ? desc : asc;
  return {
    field, dir, limit, take: limit + 1, after,
    orderBy: [by(sql`${def.expr}`), by(sql`${idCol}`)],
    finish(rows, key, map) {
      const kept = rows.slice(0, limit);
      const next = rows.length > limit && kept.length ? key(kept[kept.length - 1]) : null;
      return { items: kept.map(map), next };
    },
  };
}

/** Epoch ms of a timestamp column value (Date from Drizzle, or a raw number from an aggregate). */
export const ms = (d: Date | number | null | undefined): number => (d instanceof Date ? d.getTime() : typeof d === "number" ? d : 0);
export const iso = (d: Date | number | null | undefined): string | null => (d === null || d === undefined ? null : new Date(ms(d)).toISOString());
export const DAY_MS = 86_400_000;

/** A time window in days, clamped to 1..90 (default `def`). */
export function windowStart(deps: Deps, days: number | undefined, def: number): Date {
  const d = Number.isFinite(days) ? Math.min(Math.max(Math.trunc(days as number), 1), 90) : def;
  return new Date(deps.now().getTime() - d * DAY_MS);
}

// ------------------------------------------------------------------ redaction

/**
 * The job payload preview is an allow-list, safe by construction: it shows the payload's structure (key names, and
 * each value as its type and size) and keeps a value only for operational fields that cannot carry customer content.
 */
const KEEP_KEYS = new Set(["id", "orgId", "type", "kind", "status", "attempt", "attempts"]);
/** A kept string must look like an id or an enum word (no spaces, no @, short), else it is shown as its type and size. */
const SAFE_VALUE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const PREVIEW_DEPTH = 3;
const PREVIEW_KEYS = 25;

/** Whether a key's value may be shown: `id`, the listed operational keys, and keys ending in `Id` or `_id`. */
export function keepValueKey(k: string): boolean {
  return KEEP_KEYS.has(k) || /[a-z0-9]Id$/.test(k) || /_id$/.test(k);
}

/** A key name as shown: names that look like data (an address, a long or odd string used as a map key) are hidden. */
function shownKey(k: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]{0,39}$/.test(k) ? k : `<key ${k.length}>`;
}

function shape(v: unknown, depth: number, keep: boolean): unknown {
  if (v === null) return null;
  if (typeof v === "boolean" || typeof v === "number") return v;
  if (typeof v === "string") return keep && SAFE_VALUE_RE.test(v) ? v : `<string ${v.length}>`;
  if (Array.isArray(v)) return `<array ${v.length}>`;
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (depth >= PREVIEW_DEPTH) return `<object ${entries.length}>`;
    const out: Record<string, unknown> = {};
    for (const [k, x] of entries.slice(0, PREVIEW_KEYS)) {
      let key = shownKey(k);
      while (key in out) key = `${key}'`;
      out[key] = shape(x, depth + 1, keepValueKey(k));
    }
    if (entries.length > PREVIEW_KEYS) out["<more>"] = `<keys ${entries.length - PREVIEW_KEYS}>`;
    return out;
  }
  return `<${typeof v}>`;
}

export const PAYLOAD_PREVIEW_MAX = 600;

/**
 * A job payload as an operator may see it: its structure only (key names, each value as `<string 42>`,
 * `<array 3>`, `<object 2>`), with numbers, booleans and the values of id and operational keys (keepValueKey) kept.
 * Every other string, whatever its key, is type and length only. At most PAYLOAD_PREVIEW_MAX characters. Never throws.
 */
export function redactPayload(payload: string | null | undefined, max = PAYLOAD_PREVIEW_MAX): string {
  if (!payload) return "";
  let parsed: unknown;
  try { parsed = JSON.parse(payload); } catch { return `[not JSON, ${payload.length} chars]`; }
  const s = JSON.stringify(shape(parsed, 0, false)) ?? "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const EMAIL_RE = /[^\s"'<>@]+@[^\s"'<>@]+\.[^\s"'<>@]+/g;

/** A free-text error with addresses and token-like strings taken out, capped. */
export function redactError(s: string | null | undefined, max = 300): string | null {
  if (!s) return null;
  const clean = s.replace(EMAIL_RE, "[email]")
    .replace(/\b(sk|pk|rk|whsec|mtw|mtk)[-_][A-Za-z0-9_-]{6,}/gi, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+/g, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, "[redacted]");
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

// ------------------------------------------------------------------ queue stats

export const JOB_STATUSES = ["pending", "running", "done", "dead"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobStatRow { status: JobStatus; type: string; count: number; oldestRunAt: string | null; newestUpdatedAt: string | null }
export interface JobStats {
  byStatus: Record<JobStatus, number>;
  byStatusAndType: JobStatRow[];
  /** How long the oldest due pending job has waited (0 when none). */
  oldestPendingAgeMs: number;
  at: string;
}

/**
 * Counts by status and type. D1: one grouped read over `jobs`; jobs_due_idx (status, run_at) does not cover type, so
 * this scans the table. It stays small because pruneJobs drops done jobs after 7 days and dead ones after 30.
 */
export async function jobStatsByStatusAndType(deps: Deps): Promise<JobStats> {
  const rows = (await deps.db.select({
    status: jobs.status, type: jobs.type, n: sql<number>`count(*)`,
    oldest: sql<number | null>`min(${jobs.runAt})`, newest: sql<number | null>`max(${jobs.updatedAt})`,
  }).from(jobs).groupBy(jobs.status, jobs.type)) as { status: JobStatus; type: string; n: number; oldest: number | null; newest: number | null }[];
  const byStatus: Record<JobStatus, number> = { pending: 0, running: 0, done: 0, dead: 0 };
  let oldestPending: number | null = null;
  const now = deps.now().getTime();
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + Number(r.n);
    if (r.status === "pending" && r.oldest !== null && Number(r.oldest) <= now) oldestPending = Math.min(oldestPending ?? Infinity, Number(r.oldest));
  }
  const byStatusAndType = rows.map((r) => ({ status: r.status, type: r.type, count: Number(r.n), oldestRunAt: r.oldest === null ? null : iso(Number(r.oldest)), newestUpdatedAt: r.newest === null ? null : iso(Number(r.newest)) }))
    .sort((a, b) => a.status.localeCompare(b.status) || b.count - a.count || a.type.localeCompare(b.type));
  return { byStatus, byStatusAndType, oldestPendingAgeMs: oldestPending === null ? 0 : Math.max(0, now - oldestPending), at: deps.now().toISOString() };
}

// ------------------------------------------------------------------ job list

export const JOB_SORT_FIELDS = ["updatedAt", "createdAt", "runAt", "attempts"] as const;
export type JobSortField = (typeof JOB_SORT_FIELDS)[number];
const JOB_SORTS: Record<JobSortField, SortDef> = {
  updatedAt: { expr: sql`coalesce(${jobs.updatedAt}, ${jobs.createdAt})`, kind: "number" },
  createdAt: { expr: jobs.createdAt, kind: "number" },
  runAt: { expr: jobs.runAt, kind: "number" },
  attempts: { expr: jobs.attempts, kind: "number" },
};

export interface JobFilters {
  /** Default "dead" (what an operator opens the page for). */
  status?: JobStatus;
  type?: string;
  orgId?: string;
}

export interface ConsoleJob {
  id: string; type: string; status: JobStatus;
  orgId: string | null; workspaceName: string | null;
  /** The workspace's first owner's email (withOwnerEmail), so two workspaces with one name can be told apart. */
  ownerEmail: string | null;
  attempts: number; maxAttempts: number;
  runAt: string; lockedUntil: string | null; createdAt: string; updatedAt: string;
  /** lastError with addresses and tokens taken out, at most 300 characters. */
  lastError: string | null;
  /** The payload's shape with secrets, addresses and content replaced (redactPayload). */
  payloadPreview: string;
}

/**
 * Jobs by status (default dead), type and workspace, keyset paged. D1: always filtered by status, so jobs_due_idx
 * (status, run_at) bounds the read; with a workspace, jobs_org_idx (org_id). No index has type, so a type filter
 * narrows inside the status range.
 */
export async function listJobsFiltered(deps: Deps, filters: JobFilters, page: ConsolePage<JobSortField>): Promise<ConsolePageResult<ConsoleJob>> {
  const status = filters.status ?? "dead";
  if (!JOB_STATUSES.includes(status)) throw new HttpError(422, "validation_failed", `status is one of ${JOB_STATUSES.join(", ")}.`);
  const p = pageParts(page, JOB_SORTS, jobs.id);
  const rows = await deps.db.select({
    id: jobs.id, type: jobs.type, status: jobs.status, orgId: jobs.orgId, workspaceName: organizations.name,
    attempts: jobs.attempts, maxAttempts: jobs.maxAttempts, runAt: jobs.runAt, lockedUntil: jobs.lockedUntil,
    createdAt: jobs.createdAt, updatedAt: jobs.updatedAt, lastError: jobs.lastError, payload: jobs.payload,
  }).from(jobs).leftJoin(organizations, eq(organizations.id, jobs.orgId))
    .where(and(eq(jobs.status, status), filters.type ? eq(jobs.type, filters.type.slice(0, 100)) : undefined, filters.orgId ? eq(jobs.orgId, filters.orgId) : undefined, p.after))
    .orderBy(...p.orderBy).limit(p.take);
  const value = (r: (typeof rows)[number]): number => {
    switch (p.field) {
      case "createdAt": return ms(r.createdAt);
      case "runAt": return ms(r.runAt);
      case "attempts": return r.attempts;
      default: return ms(r.updatedAt ?? r.createdAt);
    }
  };
  const out = p.finish(rows, (r) => ({ v: value(r), id: r.id }), (r) => ({
    id: r.id, type: r.type, status: r.status, orgId: r.orgId, workspaceName: r.workspaceName ?? null,
    attempts: r.attempts, maxAttempts: r.maxAttempts, runAt: iso(r.runAt)!, lockedUntil: iso(r.lockedUntil),
    createdAt: iso(r.createdAt)!, updatedAt: iso(r.updatedAt ?? r.createdAt)!,
    lastError: redactError(r.lastError), payloadPreview: redactPayload(r.payload),
  }));
  return { ...out, items: await withOwnerEmail(deps, out.items) };
}

// ------------------------------------------------------------------ job mutations

export const REPLAY_MAX = 500;

export interface ReplayResult { requested: number; replayed: number }

/** Replays one dead job (services/jobs.ts replayJobs: back to pending, fresh attempts, due now). 404 when no such job. */
export async function replayJob(deps: Deps, id: string): Promise<ReplayResult & { previousStatus: JobStatus }> {
  const row = await deps.db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, id)).get();
  if (!row) throw notFound("Job");
  if (row.status !== "dead") throw new HttpError(409, "job_not_dead", `Only dead jobs can be replayed; this one is ${row.status}.`);
  const replayed = await replayJobs(deps, [id]);
  return { requested: 1, replayed, previousStatus: row.status };
}

/**
 * Replays the selected dead jobs (at most REPLAY_MAX); ids that are not dead are left alone and not counted. One
 * statement: replayJobs binds the id list through inIds (json_each past 20 ids), so it stays under D1's 100 variables.
 */
export async function replayJobsByIds(deps: Deps, ids: readonly string[]): Promise<ReplayResult> {
  const list = [...new Set(ids.filter((x) => typeof x === "string" && x.length > 0 && x.length <= 64))];
  if (list.length > REPLAY_MAX) throw new HttpError(422, "validation_failed", `Replay at most ${REPLAY_MAX} jobs at a time.`);
  return { requested: list.length, replayed: await replayJobs(deps, list) };
}

/**
 * Replays every dead job, as POST /api/admin/jobs/replay does for a list (services/jobs.ts replayJobs), in batches of
 * REPLAY_MAX ids. D1: one read of dead ids over jobs_due_idx (status, run_at), then one update per batch; the dead set
 * stays small because pruneJobs drops dead jobs after 30 days.
 */
export async function replayAllDead(deps: Deps): Promise<ReplayResult> {
  const rows = await deps.db.select({ id: jobs.id }).from(jobs).where(eq(jobs.status, "dead"));
  const ids = rows.map((r) => r.id);
  let replayed = 0;
  for (let i = 0; i < ids.length; i += REPLAY_MAX) replayed += await replayJobs(deps, ids.slice(i, i + REPLAY_MAX));
  return { requested: ids.length, replayed };
}

/** What an operator change on one job needs before it runs: its workspace (for the audit rows) and state. Null when no such job. */
export async function jobTarget(deps: Deps, id: string): Promise<{ id: string; type: string; status: JobStatus; orgId: string | null; attempts: number } | null> {
  if (!id || id.length > 64) return null;
  const row = await deps.db.select({ id: jobs.id, type: jobs.type, status: jobs.status, orgId: jobs.orgId, attempts: jobs.attempts }).from(jobs).where(eq(jobs.id, id)).get();
  return row ?? null;
}

export const MARKED_DEAD_ERROR = "Stopped by a platform operator.";

/**
 * Moves a pending job (or a running one whose lease has run out) to dead so the runner stops retrying it. A running
 * job inside its lease is refused (409 job_running): its worker would overwrite the status when it finishes. The
 * dead-job handler (onDead) is not called: nothing ran. One conditional update.
 */
export async function markJobDead(deps: Deps, id: string): Promise<{ id: string; previousStatus: JobStatus; status: "dead" }> {
  const row = await deps.db.select({ status: jobs.status, lockedUntil: jobs.lockedUntil, lastError: jobs.lastError }).from(jobs).where(eq(jobs.id, id)).get();
  if (!row) throw notFound("Job");
  const now = deps.now();
  if (row.status === "dead") return { id, previousStatus: "dead", status: "dead" };
  if (row.status === "done") throw new HttpError(409, "job_done", "This job already finished.");
  const leaseLive = row.status === "running" && row.lockedUntil && row.lockedUntil.getTime() > now.getTime();
  if (leaseLive) throw new HttpError(409, "job_running", "This job is running now. Try again when its run ends.");
  const lastError = row.lastError ? `${MARKED_DEAD_ERROR} Last error: ${row.lastError}`.slice(0, 1000) : MARKED_DEAD_ERROR;
  const done = await deps.db.update(jobs).set({ status: "dead", lockedUntil: null, lastError, updatedAt: now })
    .where(and(eq(jobs.id, id), eq(jobs.status, row.status), row.status === "running" ? sql`(${jobs.lockedUntil} is null or ${jobs.lockedUntil} <= ${now.getTime()})` : undefined))
    .returning({ id: jobs.id });
  if (!done.length) throw new HttpError(409, "job_changed", "This job changed meanwhile. Reload and try again.");
  return { id, previousStatus: row.status, status: "dead" };
}

// ------------------------------------------------------------------ data moves

export const DATA_MOVE_STATUSES = ["running", "stopped", "done", "undone", "failed", "ready", "expired"] as const;
export type DataMoveStatus = (typeof DATA_MOVE_STATUSES)[number];
export const DATA_MOVE_SORT_FIELDS = ["createdAt", "updatedAt"] as const;
export type DataMoveSortField = (typeof DATA_MOVE_SORT_FIELDS)[number];
const DATA_MOVE_SORTS: Record<DataMoveSortField, SortDef> = {
  createdAt: { expr: dataMoves.createdAt, kind: "number" },
  updatedAt: { expr: dataMoves.updatedAt, kind: "number" },
};

export interface DataMoveFilters {
  status?: DataMoveStatus;
  kind?: "import" | "export";
  orgId?: string;
  /** Days back from now on created_at, 1..90 (default 30). */
  days?: number;
}

export interface ConsoleDataMove {
  id: string; orgId: string; workspaceName: string | null;
  /** The workspace's first owner's email (withOwnerEmail), so two workspaces with one name can be told apart. */
  ownerEmail: string | null;
  kind: "import" | "export"; source: string; status: DataMoveStatus;
  total: number; done: number;
  /** The error with addresses and tokens taken out. File names, download tokens and the creator's address are never returned. */
  error: string | null;
  createdByUserId: string | null;
  createdAt: string; updatedAt: string; finishedAt: string | null; lastStepAt: string | null; expiresAt: string | null;
}

/**
 * Imports and exports across workspaces, newest first by default, inside a created_at window. D1: with a workspace,
 * data_moves_org_idx (org_id, created_at) serves it; with a status, data_moves_status_step_idx (status, last_step_at)
 * narrows it. With neither, there is no index leading on created_at and the window is applied by scanning the table
 * (index missing: data_moves(created_at)).
 */
export async function listDataMoves(deps: Deps, filters: DataMoveFilters, page: ConsolePage<DataMoveSortField>): Promise<ConsolePageResult<ConsoleDataMove>> {
  if (filters.status && !DATA_MOVE_STATUSES.includes(filters.status)) throw new HttpError(422, "validation_failed", `status is one of ${DATA_MOVE_STATUSES.join(", ")}.`);
  if (filters.kind && filters.kind !== "import" && filters.kind !== "export") throw new HttpError(422, "validation_failed", "kind is import or export.");
  const p = pageParts(page, DATA_MOVE_SORTS, dataMoves.id);
  const since = windowStart(deps, filters.days, 30);
  const rows = await deps.db.select({
    id: dataMoves.id, orgId: dataMoves.orgId, workspaceName: organizations.name, kind: dataMoves.kind, source: dataMoves.source, status: dataMoves.status,
    total: dataMoves.total, done: dataMoves.done, error: dataMoves.error, createdByUserId: dataMoves.createdByUserId,
    createdAt: dataMoves.createdAt, updatedAt: dataMoves.updatedAt, finishedAt: dataMoves.finishedAt, lastStepAt: dataMoves.lastStepAt, expiresAt: dataMoves.expiresAt,
  }).from(dataMoves).leftJoin(organizations, eq(organizations.id, dataMoves.orgId))
    .where(and(
      gte(dataMoves.createdAt, since),
      filters.status ? eq(dataMoves.status, filters.status) : undefined,
      filters.kind ? eq(dataMoves.kind, filters.kind) : undefined,
      filters.orgId ? eq(dataMoves.orgId, filters.orgId) : undefined,
      p.after,
    )).orderBy(...p.orderBy).limit(p.take);
  const out = p.finish(rows, (r) => ({ v: p.field === "updatedAt" ? ms(r.updatedAt) : ms(r.createdAt), id: r.id }), (r) => ({
    id: r.id, orgId: r.orgId, workspaceName: r.workspaceName ?? null, kind: r.kind, source: r.source.slice(0, 40), status: r.status,
    total: r.total, done: r.done, error: redactError(r.error), createdByUserId: r.createdByUserId,
    createdAt: iso(r.createdAt)!, updatedAt: iso(r.updatedAt)!, finishedAt: iso(r.finishedAt), lastStepAt: iso(r.lastStepAt), expiresAt: iso(r.expiresAt),
  }));
  return { ...out, items: await withOwnerEmail(deps, out.items) };
}
