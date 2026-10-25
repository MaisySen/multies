/**
 * Round 21 (R21.3): Triage. New work from mail rules, public forms, incoming hooks and the API can wait
 * in a Triage queue before it becomes a normal task. A triage item is a task row with
 * triage_state = "pending": it keeps its number, but lists, boards, My Work, reports and counts leave it
 * out until someone accepts it. Accept clears the flag in the same write as any other change; decline
 * soft deletes the item (and can send the sender a short reply); merge folds it into an existing task.
 */
import { and, count, eq, isNull } from "drizzle-orm";
import type { Deps } from "../../context";
import { organizations, taskComments, tasks } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { assertWritable, createdBy, recordWrite, sortableId, type SuiteActor } from "./common";
import { createTask, getTask, link, listTasks, updateTask, type Assignee, type Category, type Priority } from "./tasks";

export type TriageSource = "mail" | "form" | "api" | "chat";
export const BULK_LIMIT = 100;

const notFound = () => new HttpError(404, "not_found", "Triage item not found.");

async function pendingRow(deps: Deps, actor: SuiteActor, id: string) {
  if (typeof id !== "string" || !id) throw notFound();
  const t = await deps.db.select().from(tasks).where(and(eq(tasks.orgId, actor.orgId), eq(tasks.id, id), eq(tasks.triageState, "pending"), isNull(tasks.deletedAt))).get();
  if (!t) throw notFound();
  return t;
}

/** Items waiting in Triage, newest first. */
export async function listTriage(deps: Deps, actor: SuiteActor, q: { projectId?: string; limit?: number } = {}) {
  const items = await listTasks(deps, actor, { triage: "pending", includeSubtasks: true, projectId: q.projectId, sort: "created", dir: "desc", limit: Math.min(q.limit ?? 200, 500) });
  return { items, count: await triageCount(deps, actor) };
}

/** How many items wait in Triage (the nav badge). Reads the partial index only. */
export async function triageCount(deps: Deps, actor: SuiteActor) {
  const r = await deps.db.select({ n: count() }).from(tasks).where(and(eq(tasks.orgId, actor.orgId), eq(tasks.triageState, "pending"), isNull(tasks.deletedAt))).get();
  return Number(r?.n ?? 0);
}

export async function getTriageItem(deps: Deps, actor: SuiteActor, id: string) {
  const t = await pendingRow(deps, actor, id);
  return getTask(deps, actor, t.id);
}

export interface CreateTriageInput { title: string; notes?: string; source?: TriageSource; from?: string | null; projectId?: string }

/** Puts a new item straight into Triage (the API and MCP). Without a project it goes to the default one. */
export async function createTriageItem(deps: Deps, actor: SuiteActor, input: CreateTriageInput) {
  assertWritable(actor);
  const from = input.from?.trim() || null;
  return createTask(deps, actor, {
    title: input.title, notes: input.notes, projectId: input.projectId,
    triage: { source: input.source ?? "api", when: "always", from: from ? from.slice(0, 300) : null },
  });
}

export interface AcceptInput { projectId?: string; assignee?: Assignee | null; statusId?: string; status?: Category; priority?: Priority; due?: string | null }

/** Makes the item a normal task. Every change rides the one task update that clears the flag. */
export async function acceptTriage(deps: Deps, actor: SuiteActor, id: string, input: AcceptInput = {}) {
  assertWritable(actor);
  const t = await pendingRow(deps, actor, id);
  const patch: Parameters<typeof updateTask>[3] = { triage: null };
  if (input.projectId !== undefined) patch.projectId = input.projectId;
  if (input.assignee !== undefined) patch.assignee = input.assignee;
  if (input.statusId !== undefined) patch.statusId = input.statusId;
  if (input.status !== undefined) patch.status = input.status;
  if (input.priority !== undefined) patch.priority = input.priority;
  if (input.due !== undefined) patch.due = input.due;
  return updateTask(deps, actor, t.id, patch);
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
export async function declineTriage(deps: Deps, actor: SuiteActor, id: string, input: DeclineInput = {}) {
  assertWritable(actor);
  const t = await pendingRow(deps, actor, id);
  const now = deps.now();
  const reason = (input.reason ?? "").trim().slice(0, 500);
  await deps.db.update(tasks).set({ deletedAt: now, triageState: null, updatedAt: now, version: t.version + 1 }).where(eq(tasks.id, t.id));
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
  return { ok: true, id: t.id, reply };
}

/**
 * Folds the item into an existing task: its notes become a comment on the target, its mail thread
 * moves to the target (so replies show there) and the item is deleted.
 */
export async function mergeTriage(deps: Deps, actor: SuiteActor, id: string, targetId: string) {
  assertWritable(actor);
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
  await deps.db.update(tasks).set({ deletedAt: now, triageState: null, updatedAt: now, version: t.version + 1 }).where(eq(tasks.id, t.id));
  await recordWrite(deps, actor, {
    entityType: "task", entityId: target.id, op: "update", version: target.version, verb: "triage_merged",
    data: { from: t.id, title: t.title, commentId, ...(takeThread ? { threadId: t.threadId } : {}) }, event: "task.commented",
    eventData: { taskId: target.id, comment: { id: commentId, taskId: target.id, body, author: { type: by.createdByType, id: by.createdById, name: actor.name || actor.email }, createdAt: now.toISOString() } },
  });
  await recordWrite(deps, actor, { entityType: "task", entityId: t.id, op: "delete", version: t.version + 1, verb: "triage_merged", data: { into: target.id, title: t.title }, event: "task.deleted", eventData: { id: t.id } });
  return { task: await getTask(deps, actor, target.id), merged: t.id };
}

export interface BulkInput { ids: string[]; action: "accept" | "decline"; accept?: AcceptInput; decline?: DeclineInput }

/** Accept or decline several items at once (at most 100). Each item reports on its own. */
export async function bulkTriage(deps: Deps, actor: SuiteActor, input: BulkInput) {
  assertWritable(actor);
  const ids = [...new Set(input.ids ?? [])];
  if (!ids.length) throw new HttpError(422, "validation_failed", "Pick at least one item.");
  if (ids.length > BULK_LIMIT) throw new HttpError(422, "validation_failed", `Pick at most ${BULK_LIMIT} items at a time.`);
  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const id of ids) {
    try {
      if (input.action === "accept") await acceptTriage(deps, actor, id, input.accept ?? {});
      else await declineTriage(deps, actor, id, input.decline ?? {});
      results.push({ id, ok: true });
    } catch (err) {
      results.push({ id, ok: false, error: err instanceof HttpError ? err.code : "failed" });
    }
  }
  return { results, done: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}
