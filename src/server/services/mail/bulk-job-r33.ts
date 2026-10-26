/**
 * R33: "select all" in mail as ONE server job. The client sends the scope it was looking at (a folder, a provider
 * folder, a search, an Inbox tab), the ids it unticked, the newest arrival it had seen (max_received_at) and its own
 * job id. The server works through every matching message in chunks of SQL_IN_CHUNK (90, D1's 100 variable limit),
 * keyset ordered like the list, and leaves alone any message that arrived after max_received_at, so mail landing
 * mid job is never touched. A repeated request with the same client job id continues the job (idempotent); each
 * request does at most STEP_CHUNKS chunks and answers { done, total, status } so the bar can say "Archiving 1,240 of
 * 3,100". Undo puts back exactly what the job changed (its stored undo plan), in the same steps.
 *
 * Writes: the message updates are the user's own action (essential); the job row is one insert and one update per
 * step (essential, it is the job's state). Nothing here is deferrable.
 */
import { and, desc, eq, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Deps } from "../../context";
import { mailBulkJobs, messages } from "../../db/schema";
import { newId } from "../../lib/crypto";
import { badRequest, HttpError, notFound } from "../../lib/errors";
import { SQL_IN_CHUNK, notInIds } from "../../lib/sql-chunks";
import { mailboxScope } from "../team";
import { runBulkMail, type BulkMailAction, type QueueFn } from "./bulk-r32";
import { resolveWhen, snoozeHiddenCond, type ScheduleActor, type WhenInput } from "./schedules";
import { splitCond } from "./splits";

/** Actions a job can run: the ones with a clear meaning over thousands of messages. */
// R34: snooze (until one time for every thread) and move (to a connected mailbox's folder) run as a job too.
export const BULK_JOB_ACTIONS = ["read", "unread", "star", "unstar", "archive", "inbox", "spam", "trash", "snooze", "move"] as const;
export type BulkJobAction = (typeof BULK_JOB_ACTIONS)[number];
/** The request body, the same for the app, v1 and MCP. */
export const BulkJobBody = z.object({
  client_job_id: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
  action: z.enum(BULK_JOB_ACTIONS),
  scope: z.object({
    mailboxId: z.string().min(1).max(64),
    folder: z.enum(["inbox", "archive", "spam", "trash", "starred"]).optional(),
    remote: z.string().max(520).regex(/^f:/).optional(),
    q: z.string().max(200).optional(),
    split: z.string().max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  }),
  // R34: the unticked ids are kept on the job row (JSON) and reach SQL through notInIds (one bound variable), so the
  // cap is the job's own ceiling, not the old 5,000.
  exclude_ids: z.array(z.string().min(1).max(64)).max(20000).optional(),
  /** R34: move only: the folder key ("archive", "f:Projects", ...). */
  to: z.string().min(1).max(520).optional(),
  /** R34: snooze only: when the threads come back (resolved once, so every chunk gets the same time). */
  when: z.object({ preset: z.enum(["later_today", "tomorrow", "next_week"]).optional(), at: z.string().max(40).optional(), local: z.string().max(40).optional() }).optional(),
  max_received_at: z.union([z.string().max(40), z.number()]),
});
export type BulkJobBodyT = z.infer<typeof BulkJobBody>;
export const bodyToInput = (b: BulkJobBodyT): BulkJobInput => ({ clientJobId: b.client_job_id, action: b.action, scope: b.scope, excludeIds: b.exclude_ids, maxReceivedAt: b.max_received_at, to: b.to, when: b.when });
/** The most messages one job takes. */
export const BULK_JOB_MAX = 20000;
/** Chunks per request: 10 x 90 = 900 messages, well inside a Worker request. */
export const STEP_CHUNKS = 10;

export interface BulkJobScope { mailboxId: string; folder?: string; remote?: string; q?: string; split?: string }
export interface BulkJobInput {
  clientJobId: string; action: BulkJobAction; scope: BulkJobScope;
  excludeIds?: string[]; maxReceivedAt: string | number | Date;
  /** R34: move destination and snooze time. */
  to?: string; when?: WhenInput;
}
export type JobStatus = "running" | "done" | "reverting" | "reverted" | "failed";
export interface JobView { id: string; clientJobId: string; action: string; status: JobStatus; done: number; total: number; undoable: boolean; undoDone: number; undoTotal: number }
type Job = typeof mailBulkJobs.$inferSelect;
type Row = typeof messages.$inferSelect;
interface Params { scope: BulkJobScope; excludeIds: string[]; to?: string; dueAt?: string }
interface UndoCall { action: BulkMailAction; ids: string[] }

const undoTotal = (plan: UndoCall[]) => plan.reduce((n, c) => n + c.ids.length, 0);
function view(j: Job): JobView {
  const plan = JSON.parse(j.undoPlan) as UndoCall[];
  return {
    id: j.id, clientJobId: j.clientJobId, action: j.action, status: j.status as JobStatus, done: j.done, total: j.total,
    undoable: undoTotal(plan) > 0 && (j.status === "running" || j.status === "done"), undoDone: j.undoDone, undoTotal: undoTotal(plan),
  };
}

/** The same conditions the mail list uses for this scope, plus the arrival ceiling and the unticked ids. */
async function scopeConds(deps: Deps, actor: ScheduleActor, job: { params: Params; maxReceivedAt: Date }): Promise<SQL[]> {
  const { scope, excludeIds } = job.params;
  const conds: SQL[] = [eq(messages.orgId, actor.orgId), eq(messages.mailboxId, scope.mailboxId), lte(messages.createdAt, job.maxReceivedAt)];
  let allowed: string[] | null;
  if (actor.agentId) {
    const { scopeFor } = await import("../agents");
    allowed = await scopeFor(deps, actor as never);
  } else allowed = await mailboxScope(deps.db, actor);
  if (allowed && !allowed.includes(scope.mailboxId)) throw notFound("Mailbox");
  if (scope.remote) conds.push(eq(messages.folder, "archive"), eq(messages.remoteBox, scope.remote));
  else if (scope.folder === "starred") conds.push(eq(messages.isStarred, true));
  else if (scope.folder) conds.push(eq(messages.folder, scope.folder as Row["folder"]));
  if (scope.q?.trim()) {
    const term = `%${scope.q.trim().toLowerCase().replace(/[!%_]/g, (ch) => `!${ch}`)}%`;
    const fields = [messages.subject, messages.fromAddress, messages.fromName, messages.text, messages.to];
    conds.push(or(...fields.map((f) => sql`lower(${f}) like ${term} escape '!'`))!);
    if (!scope.folder) conds.push(sql`${messages.folder} <> 'trash'`);
  }
  if (scope.folder === "inbox" && !scope.q && !scope.remote) {
    conds.push(snoozeHiddenCond(deps.now()));
    if (scope.split) conds.push(await splitCond(deps, actor as never, scope.split));
  }
  // Drafts and sent mail never move with a select all (the bar never offered it for them either).
  conds.push(sql`${messages.folder} not in ('drafts', 'sent')`);
  const ex = notInIds(messages.id, excludeIds);
  if (ex) conds.push(ex);
  return conds;
}

/** What puts these rows back, from the rows as they were (only what the action changes). */
export function undoFor(action: BulkJobAction, rows: Pick<Row, "id" | "folder" | "isRead" | "isStarred">[]): UndoCall[] {
  const only = (pred: (r: (typeof rows)[number]) => boolean, a: BulkMailAction): UndoCall[] => {
    const ids = rows.filter(pred).map((r) => r.id);
    return ids.length ? [{ action: a, ids }] : [];
  };
  switch (action) {
    case "read": return only((r) => !r.isRead, "unread");
    case "unread": return only((r) => r.isRead, "read");
    case "star": return only((r) => !r.isStarred, "unstar");
    case "unstar": return only((r) => r.isStarred, "star");
    // R34: Undo of a snooze clears the snooze on those threads (they show in the Inbox again).
    case "snooze": return only((r) => r.folder !== "drafts", "unsnooze");
    // R34: a move to a provider folder is handed to the provider at once and the message gets a new id there, so
    // (like a single move) it has no Undo; the toast and the confirm say so.
    case "move": return [];
    default: {
      const groups = new Map<string, string[]>();
      for (const r of rows) if (r.folder !== action) groups.set(r.folder, [...(groups.get(r.folder) ?? []), r.id]);
      return [...groups].map(([folder, ids]) => ({ action: folder as BulkMailAction, ids }));
    }
  }
}

/** Joins plans so the stored plan has one entry per inverse action. */
function mergePlan(a: UndoCall[], b: UndoCall[]): UndoCall[] {
  const m = new Map<string, string[]>();
  for (const c of [...a, ...b]) m.set(c.action, [...(m.get(c.action) ?? []), ...c.ids]);
  return [...m].map(([action, ids]) => ({ action: action as BulkMailAction, ids }));
}

async function load(deps: Deps, orgId: string, id: string) {
  const j = await deps.db.select().from(mailBulkJobs).where(and(eq(mailBulkJobs.orgId, orgId), or(eq(mailBulkJobs.id, id), eq(mailBulkJobs.clientJobId, id)))).get();
  if (!j) throw notFound("Bulk job");
  return j;
}

/** One step forward: up to STEP_CHUNKS chunks of matching messages after the job's cursor. */
async function stepForward(deps: Deps, actor: ScheduleActor, j: Job, queue?: QueueFn): Promise<Job> {
  const params = JSON.parse(j.params) as Params;
  const conds = await scopeConds(deps, actor, { params, maxReceivedAt: j.maxReceivedAt });
  let cursor = j.cursor;
  let done = j.done;
  let plan = JSON.parse(j.undoPlan) as UndoCall[];
  let finished = false;
  for (let i = 0; i < STEP_CHUNKS; i++) {
    const at = cursor ? [cursorCond(cursor)] : [];
    const rows = await deps.db.select().from(messages).where(and(...conds, ...at)).orderBy(desc(messages.date), desc(messages.id)).limit(SQL_IN_CHUNK);
    if (!rows.length) { finished = true; break; }
    const last = rows[rows.length - 1];
    cursor = `${last.date.getTime()}.${last.id}`;
    // Essential write: the user's own action on these messages (one UPDATE per chunk; snooze writes one schedule
    // row per thread in chunks of 10).
    await runChunk(deps, actor, j.action as BulkJobAction, params, rows, queue);
    plan = mergePlan(plan, undoFor(j.action as BulkJobAction, rows));
    done += rows.length;
    if (rows.length < SQL_IN_CHUNK) { finished = true; break; }
  }
  // Essential write: the job's own state, once per step.
  const set = { cursor, done, total: Math.max(j.total, done), undoPlan: JSON.stringify(plan), status: finished ? "done" : "running", updatedAt: deps.now() };
  await deps.db.update(mailBulkJobs).set(set).where(eq(mailBulkJobs.id, j.id));
  return { ...j, ...set };
}

/** One chunk of the job's action. Snooze uses the time fixed when the job began; move skips rows it can't move. */
async function runChunk(deps: Deps, actor: ScheduleActor, action: BulkJobAction, params: Params, rows: Row[], queue?: QueueFn) {
  if (action === "snooze") return runBulkMail(deps, actor, { ids: rows.map((r) => r.id), action, at: params.dueAt }, queue);
  if (action === "move") {
    const movable = rows.filter((r) => r.remoteBox && r.remoteUid && r.remoteBox !== params.to);
    if (!movable.length) return { updated: 0 };
    return runBulkMail(deps, actor, { ids: movable.map((r) => r.id), action, to: params.to }, queue);
  }
  return runBulkMail(deps, actor, { ids: rows.map((r) => r.id), action }, queue);
}

function cursorCond(cursor: string): SQL {
  const dot = cursor.indexOf(".");
  const t = new Date(Number(cursor.slice(0, dot)));
  const id = cursor.slice(dot + 1);
  return or(lt(messages.date, t), and(eq(messages.date, t), lt(messages.id, id)))!;
}

/** One step back: up to STEP_CHUNKS chunks of the stored undo plan, in order. */
async function stepUndo(deps: Deps, actor: ScheduleActor, j: Job, queue?: QueueFn): Promise<Job> {
  const plan = JSON.parse(j.undoPlan) as UndoCall[];
  const flat = plan.flatMap((c) => c.ids.map((id) => ({ action: c.action, id })));
  let pos = j.undoDone;
  for (let i = 0; i < STEP_CHUNKS && pos < flat.length; i++) {
    const part = flat.slice(pos, pos + SQL_IN_CHUNK);
    // A chunk may cross from one inverse to the next; run each action's ids on their own.
    const byAction = new Map<BulkMailAction, string[]>();
    for (const p of part) byAction.set(p.action, [...(byAction.get(p.action) ?? []), p.id]);
    for (const [action, ids] of byAction) await runBulkMail(deps, actor, { ids, action }, queue);
    pos += part.length;
  }
  const set = { undoDone: pos, status: pos >= flat.length ? "reverted" : "reverting", updatedAt: deps.now() };
  await deps.db.update(mailBulkJobs).set(set).where(eq(mailBulkJobs.id, j.id));
  return { ...j, ...set };
}

/**
 * Starts the job, or continues it when a job with this client id already exists (a retry, or the next step).
 * Answers the job's state after this request's step.
 */
export async function runBulkJob(deps: Deps, actor: ScheduleActor, input: BulkJobInput, queue?: QueueFn): Promise<JobView> {
  if (actor.scope === "read") throw new HttpError(403, "read_only_key", "This API key can only read.");
  if (!(BULK_JOB_ACTIONS as readonly string[]).includes(input.action)) throw badRequest("That action can't run on everything at once.");
  const existing = await deps.db.select().from(mailBulkJobs).where(and(eq(mailBulkJobs.orgId, actor.orgId), eq(mailBulkJobs.clientJobId, input.clientJobId))).get();
  if (existing) {
    if (existing.status !== "running") return view(existing);
    return view(await stepForward(deps, actor, existing, queue));
  }
  const maxReceivedAt = new Date(input.maxReceivedAt);
  if (Number.isNaN(maxReceivedAt.getTime())) throw badRequest("max_received_at isn't a time.");
  const params: Params = { scope: input.scope, excludeIds: [...new Set(input.excludeIds ?? [])] };
  if (input.action === "move") {
    if (!input.to) throw badRequest("Say which folder to move to.");
    params.to = input.to;
  }
  if (input.action === "snooze") params.dueAt = (await resolveWhen(deps, actor, input.when ?? {})).toISOString();
  const conds = await scopeConds(deps, actor, { params, maxReceivedAt });
  const total = Number((await deps.db.select({ n: sql<number>`count(*)` }).from(messages).where(and(...conds)).get())?.n ?? 0);
  if (total > BULK_JOB_MAX) throw badRequest(`Up to ${BULK_JOB_MAX.toLocaleString("en-US")} messages at a time. Narrow it with a search or a folder.`);
  const now = deps.now();
  const job: Job = {
    id: newId("mbj"), orgId: actor.orgId, userId: actor.userId || null, clientJobId: input.clientJobId, action: input.action,
    params: JSON.stringify(params), maxReceivedAt, status: "running", total, done: 0, cursor: null, undoPlan: "[]", undoDone: 0, error: null, createdAt: now, updatedAt: now,
  };
  // Essential write: the job row (one per select all).
  await deps.db.insert(mailBulkJobs).values(job);
  return view(await stepForward(deps, actor, job, queue));
}

/** Continues a running job (or a running undo) by its id or client id. */
export async function stepBulkJob(deps: Deps, actor: ScheduleActor, id: string, queue?: QueueFn): Promise<JobView> {
  if (actor.scope === "read") throw new HttpError(403, "read_only_key", "This API key can only read.");
  const j = await load(deps, actor.orgId, id);
  if (j.status === "running") return view(await stepForward(deps, actor, j, queue));
  if (j.status === "reverting") return view(await stepUndo(deps, actor, j, queue));
  return view(j);
}

/**
 * Undo: stops the job where it is (no further steps run) and puts back exactly what it changed, one step per
 * request. Repeat with the same id until status is "reverted".
 */
export async function undoBulkJob(deps: Deps, actor: ScheduleActor, id: string, queue?: QueueFn): Promise<JobView> {
  if (actor.scope === "read") throw new HttpError(403, "read_only_key", "This API key can only read.");
  const j = await load(deps, actor.orgId, id);
  if (j.status === "reverted") return view(j);
  if (j.status !== "running" && j.status !== "done" && j.status !== "reverting") throw badRequest("This job can't be undone.");
  return view(await stepUndo(deps, actor, { ...j, status: "reverting" }, queue));
}

export async function getBulkJob(deps: Deps, actor: ScheduleActor, id: string): Promise<JobView> {
  return view(await load(deps, actor.orgId, id));
}
