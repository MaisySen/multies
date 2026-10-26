/**
 * R32: the rest of task Triage. Snooze a pending item until a time (it leaves the queue and its count,
 * then comes back by itself), undo the last accept, decline or snooze, and one action door
 * (accept, decline, snooze, unsnooze, duplicate, restore) that the app, the REST API and MCP share.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import type { Deps } from "../../context";
import { tasks } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { assertWritable, recordWrite, type SuiteActor } from "./common";
import { getTask } from "./tasks";
import { acceptTriage, declineTriage, mergeTriage, type AcceptInput, type DeclineInput } from "./triage";
import { checkTriageComment, insertTriageComment, oneLine, removeTriageComment } from "./triage-comment-r33";

export const TRIAGE_ACTIONS = ["accept", "decline", "snooze", "unsnooze", "duplicate", "restore"] as const;
export type TriageAction = (typeof TRIAGE_ACTIONS)[number];
/** A snooze can reach at most a year ahead. */
const MAX_SNOOZE_MS = 366 * 24 * 3600_000;

const notFound = () => new HttpError(404, "not_found", "That item isn't in Triage.");

async function pendingRow(deps: Deps, actor: SuiteActor, id: string) {
  const t = await deps.db.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.orgId, actor.orgId), eq(tasks.triageState, "pending"))).get();
  if (!t || t.deletedAt) throw notFound();
  return t;
}

/** Parses a snooze time: an ISO date or date-time in the future, at most a year out. */
export function parseSnoozeUntil(until: string | undefined, now: Date): Date {
  const raw = (until ?? "").trim();
  if (!raw) throw new HttpError(422, "validation_failed", "Pick a date to snooze until.");
  // A bare date means the start of that day in UTC, so "2026-11-02" snoozes until that morning.
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T08:00:00Z` : raw);
  if (Number.isNaN(d.getTime())) throw new HttpError(422, "validation_failed", "Snooze needs a date like 2026-11-02 or 2026-11-02T09:00:00Z.");
  if (d.getTime() <= now.getTime()) throw new HttpError(422, "validation_failed", "Pick a time in the future.");
  if (d.getTime() - now.getTime() > MAX_SNOOZE_MS) throw new HttpError(422, "validation_failed", "Snooze for at most a year.");
  return d;
}

/** Snoozes a pending item. It stays pending (hidden from boards and lists) but leaves the queue until then. */
export async function snoozeTriage(deps: Deps, actor: SuiteActor, id: string, until: string | undefined) {
  assertWritable(actor);
  const t = await pendingRow(deps, actor, id);
  const when = parseSnoozeUntil(until, deps.now());
  await deps.db.update(tasks).set({ triageSnoozedUntil: when, updatedAt: deps.now(), version: t.version + 1 }).where(eq(tasks.id, t.id));
  await recordWrite(deps, actor, { entityType: "task", entityId: t.id, op: "update", version: t.version + 1, verb: "triage_snoozed", data: { title: t.title, until: when.toISOString() } });
  return getTask(deps, actor, t.id);
}

/** Brings a snoozed item back to the queue now. */
export async function unsnoozeTriage(deps: Deps, actor: SuiteActor, id: string) {
  assertWritable(actor);
  const t = await pendingRow(deps, actor, id);
  if (!t.triageSnoozedUntil) return getTask(deps, actor, t.id);
  await deps.db.update(tasks).set({ triageSnoozedUntil: null, updatedAt: deps.now(), version: t.version + 1 }).where(eq(tasks.id, t.id));
  await recordWrite(deps, actor, { entityType: "task", entityId: t.id, op: "update", version: t.version + 1, verb: "triage_unsnoozed", data: { title: t.title } });
  return getTask(deps, actor, t.id);
}

/**
 * Undo: puts an item that came in through Triage back in the queue as pending. Works on an item that
 * was accepted (and is not done) or declined or merged (soft deleted), within a day of that change.
 */
export async function restoreTriage(deps: Deps, actor: SuiteActor, id: string) {
  assertWritable(actor);
  const t = await deps.db.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.orgId, actor.orgId), isNotNull(tasks.triageSource))).get();
  if (!t) throw notFound();
  if (t.triageState === "pending" && !t.deletedAt) return getTask(deps, actor, t.id);
  if (deps.now().getTime() - t.updatedAt.getTime() > 24 * 3600_000) throw new HttpError(409, "too_late", "That change is more than a day old. Make a new task instead.");
  if (!t.deletedAt && t.status === "done") throw new HttpError(409, "conflict", "That task is already done.");
  await deps.db.update(tasks).set({ triageState: "pending", deletedAt: null, triageSnoozedUntil: null, triageReason: null, duplicateOf: null, updatedAt: deps.now(), version: t.version + 1 }).where(eq(tasks.id, t.id));
  await recordWrite(deps, actor, { entityType: "task", entityId: t.id, op: "update", version: t.version + 1, verb: "triage_restored", data: { title: t.title, was: t.deletedAt ? "removed" : "accepted" } });
  return getTask(deps, actor, t.id);
}

export interface TriageActionInput {
  action: TriageAction;
  accept?: AcceptInput;
  decline?: DeclineInput;
  until?: string;
  duplicateOf?: string;
  /** R33: accept or decline with a one line comment (written with the action, removed by its undo). */
  comment?: string;
  /** R33: restore also removes this comment (the one the accept or decline wrote). */
  commentId?: string;
}

/** One door for every Triage action. Answers { action, task? , ... } with the item as it is now. */
export async function triageAction(deps: Deps, actor: SuiteActor, id: string, input: TriageActionInput) {
  const note = oneLine(input.comment);
  switch (input.action) {
    case "accept": {
      if (!note) return { action: input.action, task: await acceptTriage(deps, actor, id, input.accept ?? {}) };
      // R33: the status change and the comment in one request; the answer names the comment for Undo.
      const task = await acceptTriage(deps, actor, id, input.accept ?? {});
      return { action: input.action, task, comment: await insertTriageComment(deps, actor, task.id, note) };
    }
    case "decline": {
      if (!note) return { action: input.action, ...(await declineTriage(deps, actor, id, input.decline ?? {})) };
      // The comment is written first (the item is still readable), and taken back if the decline fails.
      await pendingRow(deps, actor, id);
      const comment = await insertTriageComment(deps, actor, id, note);
      try {
        const r = await declineTriage(deps, actor, id, { ...(input.decline ?? {}), reason: input.decline?.reason ?? note });
        return { action: input.action, ...r, comment };
      } catch (err) {
        await removeTriageComment(deps, actor, id, comment.id).catch(() => false);
        throw err;
      }
    }
    case "snooze": return { action: input.action, task: await snoozeTriage(deps, actor, id, input.until) };
    case "unsnooze": return { action: input.action, task: await unsnoozeTriage(deps, actor, id) };
    case "duplicate": {
      if (!input.duplicateOf) throw new HttpError(422, "validation_failed", "Pick the task this one duplicates (duplicateOf).");
      return { action: input.action, ...(await mergeTriage(deps, actor, id, input.duplicateOf)) };
    }
    case "restore": {
      // Checked first, so a refused comment undo changes nothing.
      if (input.commentId) await checkTriageComment(deps, actor, id, input.commentId);
      const task = await restoreTriage(deps, actor, id);
      // R33: one Undo takes back both halves: the item is pending again and its comment is gone.
      const commentRemoved = input.commentId ? await removeTriageComment(deps, actor, id, input.commentId) : false;
      return { action: input.action, task, ...(input.commentId ? { commentRemoved } : {}) };
    }
    default: throw new HttpError(422, "validation_failed", `Action is one of ${TRIAGE_ACTIONS.join(", ")}.`);
  }
}
