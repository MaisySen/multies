/**
 * Round 33: accept or decline a Triage item with a one line comment, as one action with one undo.
 *
 * The comment and the status change travel in one request (the app's A or D, POST
 * /api/v1/tasks/{id}/triage, MCP task_triage_action). Undo (restore) with the comment's id puts the
 * item back in the queue AND removes that comment, again in one request, so an undo leaves
 * nothing behind. The comment is a plain task comment (it shows in the task's thread); it sends no
 * mention or watcher notifications, because it explains a queue decision rather than starting a
 * conversation. Writes: one comment row (essential), nothing deferrable.
 */
import { and, eq } from "drizzle-orm";
import type { Deps } from "../../context";
import { taskComments } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { createdBy, sortableId, type SuiteActor } from "./common";

/** A triage comment is one line: newlines and runs of spaces fold to single spaces, at most 280 characters. */
export const TRIAGE_COMMENT_MAX = 280;
export function oneLine(text: string | undefined | null) {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, TRIAGE_COMMENT_MAX);
}

export interface TriageComment { id: string; taskId: string; body: string; createdAt: string }

/** Writes the comment row. Essential write. */
export async function insertTriageComment(deps: Deps, actor: SuiteActor, taskId: string, body: string): Promise<TriageComment> {
  const now = deps.now();
  const id = sortableId("cmt", now.getTime());
  await deps.db.insert(taskComments).values({ id, orgId: actor.orgId, taskId, authorName: actor.name || actor.email || "Someone", body, ...createdBy(actor), createdAt: now, updatedAt: now });
  return { id, taskId, body, createdAt: now.toISOString() };
}

/**
 * Checks that this person may take this comment back (they wrote it, on this task, in the last day).
 * Returns its id, or null when there is no such comment. Throws before anything is changed.
 */
export async function checkTriageComment(deps: Deps, actor: SuiteActor, taskId: string, commentId: string) {
  const row = await deps.db.select().from(taskComments).where(and(eq(taskComments.id, commentId), eq(taskComments.taskId, taskId), eq(taskComments.orgId, actor.orgId))).get();
  if (!row) return null;
  const by = createdBy(actor);
  if (row.createdByType !== by.createdByType || (row.createdById ?? null) !== (by.createdById ?? null)) throw new HttpError(403, "forbidden", "Only the person who wrote that comment can undo it.");
  if (deps.now().getTime() - row.createdAt.getTime() > 24 * 3600_000) throw new HttpError(409, "too_late", "That change is more than a day old.");
  return row.id;
}

/** Removes a comment this person wrote on this task in the last day (the undo half). False when there is none. */
export async function removeTriageComment(deps: Deps, actor: SuiteActor, taskId: string, commentId: string) {
  const id = await checkTriageComment(deps, actor, taskId, commentId);
  if (!id) return false;
  await deps.db.delete(taskComments).where(eq(taskComments.id, id));
  return true;
}
