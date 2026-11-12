/**
 * Round 21 (R21.3): Triage. New work from mail rules, public forms, incoming hooks and the API can wait
 * in a Triage queue before it becomes a normal task. A triage item is a task row with
 * triage_state = "pending": it keeps its number, but lists, boards, My Work, reports and counts leave it
 * out until someone accepts it. Accept clears the flag in the same write as any other change; decline
 * soft deletes the item (and can send the sender a short reply); merge folds it into an existing task.
 *
 * AIS1 (audit row 66): Triage is a human check. Accept, decline, merge (and restore, in triage-r32.ts) need a person
 * signed in to Multies; an API key or a connected AI app gets 403 person_only. Keys can still add items, read the
 * queue and snooze.
 *
 * AIS1 review: a key's or an AI app's subtasks wait with their parent (a copy, a template, an import). A decision on
 * the parent takes its direct subtasks with it: accept brings the waiting ones in, decline and merge remove them all
 * (as a delete does), and restore in triage-r32.ts puts them back.
 */
import { and, count, eq, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { organizations, taskComments, tasks } from "../../db/schema";
import { requirePerson } from "../../lib/actor-kind";
import { HttpError } from "../../lib/errors";
import { actorOf, assertWritable, createdBy, recordWrite, sortableId, type SuiteActor } from "./common";
import { emitEvent } from "../developer/webhooks";

/** Round 22: triage.* webhook events, beside the task.* events the same actions already send. */
async function emitTriage(deps: Deps, actor: SuiteActor, type: "triage.accepted" | "triage.declined" | "triage.merged", data: Record<string, unknown>) {
  const by = actorOf(actor);
  await emitEvent(deps, actor.orgId, type, { ...data, actor: { type: by.type, id: by.id, name: by.name } });
}
import { createTask, getTask, link, listTasks, updateTask, type Assignee, type Category, type Priority } from "./tasks";

export type TriageSource = "mail" | "form" | "api" | "chat" | "agent";
export const BULK_LIMIT = 100;

const notFound = () => new HttpError(404, "not_found", "Triage item not found.");

/** AIS1: what every Triage decision checks first: a write key's scope (read_only_key), then that a person decides. */
export function assertDecider(actor: SuiteActor, what = "Accepting, declining or merging a Triage item") {
  assertWritable(actor);
  requirePerson(actor, what);
}

async function pendingRow(deps: Deps, actor: SuiteActor, id: string) {
  if (typeof id !== "string" || !id) throw notFound();
  const t = await deps.db.select().from(tasks).where(and(eq(tasks.orgId, actor.orgId), eq(tasks.id, id), eq(tasks.triageState, "pending"), isNull(tasks.deletedAt))).get();
  if (!t) throw notFound();
  return t;
}

/** Items waiting in Triage, newest first. */
export async function listTriage(deps: Deps, actor: SuiteActor, q: { projectId?: string; limit?: number; view?: "pending" | "snoozed" } = {}) {
  const all = await listTasks(deps, actor, { triage: "pending", includeSubtasks: true, projectId: q.projectId, sort: "created", dir: "desc", limit: Math.min(q.limit ?? 200, 500) });
  // R32: snoozed items leave the queue until their time passes, then come back by themselves.
  const now = deps.now().getTime();
  const isSnoozed = (t: (typeof all)[number]) => !!t.triage?.snoozedUntil && Date.parse(t.triage.snoozedUntil) > now;
  const items = q.view === "snoozed" ? all.filter(isSnoozed) : all.filter((t) => !isSnoozed(t));
  return { items, count: await triageCount(deps, actor), ...(q.view === "snoozed" ? { view: "snoozed" as const } : {}) };
}

/** How many items wait in Triage (the nav badge). Reads the partial index only. */
export async function triageCount(deps: Deps, actor: SuiteActor) {
  const r = await triageCountQuery(deps, actor).get();
  return Number(r?.n ?? 0);
}

/** R41: the triage count as a query builder, also embedded as a subquery by the badge counts. */
export function triageCountQuery(deps: Deps, actor: SuiteActor) {
  return deps.db.select({ n: count() }).from(tasks).where(and(eq(tasks.orgId, actor.orgId), eq(tasks.triageState, "pending"), isNull(tasks.deletedAt),
    or(isNull(tasks.triageSnoozedUntil), lte(tasks.triageSnoozedUntil, deps.now()))));
}

export async function getTriageItem(deps: Deps, actor: SuiteActor, id: string) {
  const t = await pendingRow(deps, actor, id);
  return getTask(deps, actor, t.id);
}

export interface CreateTriageInput { title: string; notes?: string; source?: TriageSource; from?: string | null; projectId?: string }

/** Puts a new item straight into Triage (the API and MCP). Without a project it goes to the default one. */
export async function createTriageItem(deps: Deps, actor: SuiteActor, input: CreateTriageInput, opts: { id?: string; retry?: boolean } = {}) {
  assertWritable(actor);
  const from = input.from?.trim() || null;
  return createTask(deps, actor, {
    title: input.title, notes: input.notes, projectId: input.projectId,
    triage: { source: input.source ?? "api", when: "always", from: from ? from.slice(0, 300) : null },
  }, opts); // R53 (MB-239): same id on a retry
}

export interface AcceptInput { projectId?: string; assignee?: Assignee | null; statusId?: string; status?: Category; priority?: Priority; due?: string | null }

/**
 * AIS1 review: `cascaded` collects the subtasks a decision on their parent also decided, so a bulk call counts them
 * done. Accept leaves the ids in `leave` alone: a bulk accept gives each item it names the same options itself.
 */
export interface DecideOpts { cascaded?: Set<string>; leave?: Set<string> }

/** Live direct subtasks of an item; with `waiting`, only those still pending. One read on the parent index. */
function children(deps: Deps, actor: SuiteActor, parentId: string, waiting: boolean) {
  return deps.db.select({ id: tasks.id, snoozed: tasks.triageSnoozedUntil }).from(tasks)
    .where(and(eq(tasks.orgId, actor.orgId), eq(tasks.parentId, parentId), isNull(tasks.deletedAt), waiting ? eq(tasks.triageState, "pending") : undefined));
}

/**
 * Decline and merge remove the item's live direct subtasks that came through Triage with it, at the same time, so
 * restore finds them again. AIS1 second review: a subtask that never came through Triage (a person's own task that
 * was put under the item) is not part of what was declined, so it stays and only leaves the item (parentId null).
 */
async function removeChildren(deps: Deps, actor: SuiteActor, parentId: string, now: Date, opts: DecideOpts) {
  const rows = await deps.db.select({ id: tasks.id, src: tasks.triageSource, state: tasks.triageState }).from(tasks)
    .where(and(eq(tasks.orgId, actor.orgId), eq(tasks.parentId, parentId), isNull(tasks.deletedAt)));
  if (!rows.length) return;
  const viaTriage = (r: { src: string | null; state: string | null }) => !!r.src || r.state === "pending";
  const live = and(eq(tasks.orgId, actor.orgId), eq(tasks.parentId, parentId), isNull(tasks.deletedAt));
  const bump = { updatedAt: now, version: sql`${tasks.version} + 1` };
  if (rows.some(viaTriage)) await deps.db.update(tasks).set({ deletedAt: now, ...bump }).where(and(live, or(isNotNull(tasks.triageSource), eq(tasks.triageState, "pending"))));
  if (rows.some((r) => !viaTriage(r))) await deps.db.update(tasks).set({ parentId: null, ...bump }).where(and(live, isNull(tasks.triageSource), or(isNull(tasks.triageState), ne(tasks.triageState, "pending"))));
  for (const r of rows) if (viaTriage(r)) opts.cascaded?.add(r.id);
}

/** Makes the item a normal task. Every change rides the one task update that clears the flag. */
export async function acceptTriage(deps: Deps, actor: SuiteActor, id: string, input: AcceptInput = {}, opts: DecideOpts = {}) {
  assertDecider(actor);
  const t = await pendingRow(deps, actor, id);
  if (t.triageSnoozedUntil) await deps.db.update(tasks).set({ triageSnoozedUntil: null }).where(eq(tasks.id, t.id));
  const patch: Parameters<typeof updateTask>[3] = { triage: null };
  if (input.projectId !== undefined) patch.projectId = input.projectId;
  if (input.assignee !== undefined) patch.assignee = input.assignee;
  if (input.statusId !== undefined) patch.statusId = input.statusId;
  if (input.status !== undefined) patch.status = input.status;
  if (input.priority !== undefined) patch.priority = input.priority;
  if (input.due !== undefined) patch.due = input.due;
  const task = await updateTask(deps, actor, t.id, patch);
  // AIS1 review: its waiting subtasks come in with it (the options above, apart from the project, are for the item itself).
  for (const c of await children(deps, actor, t.id, true)) {
    if (opts.leave?.has(c.id)) continue;
    if (c.snoozed) await deps.db.update(tasks).set({ triageSnoozedUntil: null }).where(eq(tasks.id, c.id));
    // AIS1 second review: an accept into another project takes them there too, so they don't stay behind.
    await updateTask(deps, actor, c.id, { triage: null, ...(input.projectId ? { projectId: input.projectId } : {}) });
    opts.cascaded?.add(c.id);
  }
  await emitTriage(deps, actor, "triage.accepted", { task, source: t.triageSource ?? null });
  return task;
}

const NO_REPLY = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|postmaster|bounces?|notifications?)([-+_.].*)?@/i;

/** The bare address from "Name <a@b.c>" or "a@b.c", or null. */
export function replyAddress(from: string | null | undefined): string | null {
  if (!from) return null;
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(from) ?? /([^\s<>"]+@[^\s<>"]+\.[^\s<>"]+)/.exec(from);
  const a = m?.[1]?.toLowerCase() ?? null;
  return a && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a) ? a : null;
}

/** True for addresses nobody reads: no-reply, do-not-reply, mailer-daemon and the like. */
export function isNoReply(address: string) {
  return NO_REPLY.test(address) || /noreply|donotreply/i.test(address.split("@")[0] ?? "");
}

export interface DeclineInput { reason?: string; reply?: boolean; message?: string }

/** Declines an item: soft deletes it with the reason, and can send the sender a short polite reply (off unless asked). */
export async function declineTriage(deps: Deps, actor: SuiteActor, id: string, input: DeclineInput = {}, opts: DecideOpts = {}) {
  assertDecider(actor);
  const t = await pendingRow(deps, actor, id);
  const now = deps.now();
  const reason = (input.reason ?? "").trim().slice(0, 500);
  await deps.db.update(tasks).set({ deletedAt: now, triageState: null, triageSnoozedUntil: null, triageReason: reason || null, updatedAt: now, version: t.version + 1 }).where(eq(tasks.id, t.id));
  await removeChildren(deps, actor, t.id, now, opts); // AIS1 review: its subtasks go with it
  await recordWrite(deps, actor, {
    entityType: "task", entityId: t.id, op: "delete", version: t.version + 1, verb: "triage_declined",
    data: { title: t.title, ...(reason ? { reason } : {}) }, event: "task.deleted", eventData: { id: t.id },
  });
  let reply: { sent: boolean; attempted?: boolean; to?: string; skipped?: string; detail?: string } = { sent: false };
  if (input.reply) {
    const to = replyAddress(t.sourceFrom);
    if (!to) reply = { sent: false, skipped: "no_address" };
    else if (isNoReply(to)) reply = { sent: false, to, skipped: "no_reply_address" };
    else {
      const org = await deps.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, actor.orgId)).get();
      const team = org?.name || "the team";
      const subject = `Re: ${(t.sourceSubject || t.title).slice(0, 200)}`;
      const text = (input.message?.trim() || `Hello,\n\nThank you for getting in touch with ${team}. We have read your message, and we won't be taking it further this time.\n\nKind regards,\n${team}`).slice(0, 5000);
      const { sendSystemEmail } = await import("../system-mail");
      const r = await sendSystemEmail(deps, { to, subject, text, orgId: actor.orgId, template: "triage-declined" }).catch(() => ({ delivered: false, detail: "Failed to send." }));
      reply = { sent: r.delivered, attempted: true, to, ...(r.detail ? { detail: r.detail } : {}) };
    }
  }
  await emitTriage(deps, actor, "triage.declined", { id: t.id, title: t.title, number: t.number, source: t.triageSource ?? null, ...(reason ? { reason } : {}), replied: reply.sent });
  return { ok: true, id: t.id, reply };
}

/**
 * Folds the item into an existing task: its notes become a comment on the target, its mail thread
 * moves to the target (so replies show there) and the item is deleted.
 */
export async function mergeTriage(deps: Deps, actor: SuiteActor, id: string, targetId: string) {
  assertDecider(actor);
  const t = await pendingRow(deps, actor, id);
  if (!targetId || targetId === t.id) throw new HttpError(422, "validation_failed", "Pick another task to merge into.");
  const target = await getTask(deps, actor, targetId);
  if (target.triage) throw new HttpError(422, "validation_failed", "Accept that item first, or merge into a task that isn't in Triage.");
  const now = deps.now();
  const by = createdBy(actor);
  const fromLine = t.sourceFrom ? `From ${t.sourceFrom}` : "";
  const body = [`Merged from Triage: ${t.title}`, fromLine, t.notes.trim()].filter(Boolean).join("\n\n").slice(0, 20_000);
  const commentId = sortableId("cmt", now.getTime());
  await deps.db.insert(taskComments).values({ id: commentId, orgId: actor.orgId, taskId: target.id, authorName: actor.name || actor.email, body, ...by, createdAt: now, updatedAt: now });
  // One write on the target: the comment's touch, plus the thread when the target has none yet.
  const takeThread = !!t.threadId && !target.source?.threadId;
  await deps.db.update(tasks).set({
    updatedAt: now,
    ...(takeThread ? { threadId: t.threadId, messageId: t.messageId, sourceFrom: t.sourceFrom, sourceSubject: t.sourceSubject } : {}),
  }).where(eq(tasks.id, target.id));
  if (t.threadId && !takeThread) await link(deps, actor.orgId, { type: "task", id: target.id }, { type: "thread", id: t.threadId }, "merged");
  await deps.db.update(tasks).set({ deletedAt: now, triageState: null, triageSnoozedUntil: null, duplicateOf: target.id, updatedAt: now, version: t.version + 1 }).where(eq(tasks.id, t.id));
  await removeChildren(deps, actor, t.id, now, {}); // AIS1 review: its subtasks go with it
  await recordWrite(deps, actor, {
    entityType: "task", entityId: target.id, op: "update", version: target.version, verb: "triage_merged",
    data: { from: t.id, title: t.title, commentId, ...(takeThread ? { threadId: t.threadId } : {}) }, event: "task.commented",
    eventData: { taskId: target.id, comment: { id: commentId, taskId: target.id, body, author: { type: by.createdByType, id: by.createdById, name: actor.name || actor.email }, createdAt: now.toISOString() } },
  });
  await recordWrite(deps, actor, { entityType: "task", entityId: t.id, op: "delete", version: t.version + 1, verb: "triage_merged", data: { into: target.id, title: t.title }, event: "task.deleted", eventData: { id: t.id } });
  const merged = await getTask(deps, actor, target.id);
  await emitTriage(deps, actor, "triage.merged", { id: t.id, title: t.title, source: t.triageSource ?? null, into: merged });
  return { task: merged, merged: t.id };
}

export interface BulkInput { ids: string[]; action: "accept" | "decline"; accept?: AcceptInput; decline?: DeclineInput }

/** Accept or decline several items at once (at most 100). Each item reports on its own. */
export async function bulkTriage(deps: Deps, actor: SuiteActor, input: BulkInput) {
  // AIS1: a key is refused for the whole call (a 200 with every item failed reads as success to a script).
  assertDecider(actor);
  const ids = [...new Set(input.ids ?? [])];
  if (!ids.length) throw new HttpError(422, "validation_failed", "Pick at least one item.");
  if (ids.length > BULK_LIMIT) throw new HttpError(422, "validation_failed", `Pick at most ${BULK_LIMIT} items at a time.`);
  const results: { id: string; ok: boolean; error?: string }[] = [];
  // AIS1 review: a subtask its parent's decision already took counts as done, not as "not found".
  const cascaded = new Set<string>();
  const leave = new Set(ids);
  for (const id of ids) {
    try {
      if (cascaded.has(id)) { results.push({ id, ok: true }); continue; }
      if (input.action === "accept") await acceptTriage(deps, actor, id, input.accept ?? {}, { cascaded, leave });
      else await declineTriage(deps, actor, id, input.decline ?? {}, { cascaded });
      results.push({ id, ok: true });
    } catch (err) {
      results.push({ id, ok: false, error: err instanceof HttpError ? err.code : "failed" });
    }
  }
  return { results, done: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}
