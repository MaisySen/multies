/**
 * R26 (MB-77, found by Haajir): task comments can be read back, edited and deleted, through the
 * app, REST and MCP. Visibility follows the task (another workspace's ids are not found). Only the
 * author edits; the author, an owner or an admin deletes (a soft delete, as for tasks). A comment
 * carries editedAt once it has been edited (version above 1), so an edit is visible to readers.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Deps } from "../../context";
import { taskComments, tasks } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { actorOf, assertWritable, recordWrite, type SuiteActor } from "./common";
import { getTask } from "./tasks";

type Row = typeof taskComments.$inferSelect;

export const COMMENT_MAX = 20_000;

export function presentComment(c: Row) {
  return {
    id: c.id, taskId: c.taskId, body: c.body,
    author: { type: c.createdByType, id: c.createdById, name: c.authorName },
    editedAt: c.version > 1 ? c.updatedAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
  };
}

/** Every live comment on a task the actor can open, oldest first. */
export async function listTaskComments(deps: Deps, a: SuiteActor, idOrRef: string) {
  const t = await getTask(deps, a, idOrRef);
  const rows = await deps.db.select().from(taskComments)
    .where(and(eq(taskComments.orgId, a.orgId), eq(taskComments.taskId, t.id), isNull(taskComments.deletedAt)))
    .orderBy(asc(taskComments.createdAt)).limit(1000);
  return { taskId: t.id, comments: rows.map(presentComment) };
}

async function commentRow(deps: Deps, a: SuiteActor, id: string) {
  const c = await deps.db.select().from(taskComments).where(and(eq(taskComments.orgId, a.orgId), eq(taskComments.id, id), isNull(taskComments.deletedAt))).get();
  if (!c) throw notFound("Comment");
  // The task must still be there and open to this actor.
  const t = await getTask(deps, a, c.taskId);
  return { c, t };
}

export async function getTaskComment(deps: Deps, a: SuiteActor, id: string) {
  return presentComment((await commentRow(deps, a, id)).c);
}

function isAuthor(a: SuiteActor, c: Row) {
  const who = actorOf(a);
  return who.type === c.createdByType && !!who.id && who.id === c.createdById;
}

export async function editTaskComment(deps: Deps, a: SuiteActor, id: string, body: string) {
  assertWritable(a);
  const { c, t } = await commentRow(deps, a, id);
  if (!isAuthor(a, c)) throw new HttpError(403, "forbidden", "Only the author can edit a comment.");
  const text = (body ?? "").trim();
  if (!text) throw new HttpError(422, "validation_failed", "A comment can't be empty. Delete it instead.");
  const now = deps.now();
  await deps.db.update(taskComments).set({ body: text.slice(0, COMMENT_MAX), updatedAt: now, version: c.version + 1 }).where(eq(taskComments.id, c.id));
  await deps.db.update(tasks).set({ updatedAt: now }).where(eq(tasks.id, t.id));
  const out = presentComment({ ...c, body: text.slice(0, COMMENT_MAX), updatedAt: now, version: c.version + 1 });
  await recordWrite(deps, a, { entityType: "task", entityId: t.id, op: "update", version: t.version, verb: "edited a comment", data: { commentId: c.id, excerpt: text.slice(0, 140) },
    event: "comment.updated", eventData: { id: c.id, object: "comment", taskId: t.id, comment: out } }); // R51 (MB-239)
  return out;
}

export async function deleteTaskComment(deps: Deps, a: SuiteActor, id: string) {
  assertWritable(a);
  const { c, t } = await commentRow(deps, a, id);
  const admin = !a.agentId && (a.role === "owner" || a.role === "admin");
  if (!isAuthor(a, c) && !admin) throw new HttpError(403, "forbidden", "Only the author or an admin can delete a comment.");
  const now = deps.now();
  await deps.db.update(taskComments).set({ deletedAt: now, updatedAt: now }).where(eq(taskComments.id, c.id));
  await recordWrite(deps, a, { entityType: "task", entityId: t.id, op: "update", version: t.version, verb: "deleted a comment", data: { commentId: c.id },
    event: "comment.deleted", eventData: { id: c.id, object: "comment", taskId: t.id } }); // R51 (MB-239)
  return { ok: true };
}
