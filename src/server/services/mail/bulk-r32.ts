/**
 * R32: bulk mail actions in one place, for the app (routes/mail.ts), the public API (v1-r32-mail.ts) and MCP
 * (mail_bulk_action). Up to 500 ids. Every id list reaches SQL through inIds (one bound variable past 20 ids),
 * so a 500 id selection stays inside D1's 100 variable limit; snooze rows are written in chunks of 10 rows.
 *
 * Actions: read, unread, star, unstar, archive, inbox, spam, trash, delete (forever), move (to a connected
 * mailbox's folder), snooze (until a time) and unsnooze (the inverse, used by Undo).
 */
import { and, eq } from "drizzle-orm";
import type { Deps } from "../../context";
import { mailSchedules, messages } from "../../db/schema";
import { newId } from "../../lib/crypto";
import { badRequest, HttpError } from "../../lib/errors";
import { chunkIds, inIds } from "../../lib/sql-chunks";
import { queueRemoteChange, type RemoteAction } from "../connect";
import { localFolderFor } from "../connect/sync";
import { mailboxScope } from "../team";
import { deleteMessagesPermanently } from "./mailbox-view";
import { assertNotHeld } from "./archive-r111";
import { resolveWhen, type ScheduleActor, type WhenInput } from "./schedules";

export const BULK_MAIL_ACTIONS = ["read", "unread", "star", "unstar", "archive", "inbox", "spam", "trash", "delete", "move", "snooze", "unsnooze"] as const;
export type BulkMailAction = (typeof BULK_MAIL_ACTIONS)[number];
export const BULK_MAIL_MAX = 500;

export interface BulkMailInput extends WhenInput { ids: string[]; action: BulkMailAction; to?: string }
type Row = typeof messages.$inferSelect;
export type QueueFn = (rows: Row[], action: RemoteAction, opts?: { dest?: string }) => Promise<number>;

/** What a bulk action means at a connected mailbox's provider (services/connect, applied on the next sync). */
export const BULK_REMOTE: Partial<Record<BulkMailAction, RemoteAction>> = { read: "seen", unread: "unseen", star: "flag", unstar: "unflag", archive: "archive", trash: "trash", spam: "spam", inbox: "inbox" };

const SET: Partial<Record<BulkMailAction, Partial<typeof messages.$inferInsert>>> = {
  read: { isRead: true }, unread: { isRead: false }, star: { isStarred: true }, unstar: { isStarred: false },
  archive: { folder: "archive" }, inbox: { folder: "inbox" }, spam: { folder: "spam" }, trash: { folder: "trash" },
};

/** Rows of the ids the actor can open (the rest are skipped, not refused, like the app always did). */
async function ownRows(deps: Deps, actor: ScheduleActor, ids: string[]) {
  let scope: string[] | null;
  if (actor.agentId) {
    const { scopeFor } = await import("../agents");
    scope = await scopeFor(deps, actor as never);
  } else scope = await mailboxScope(deps.db, actor);
  const rows = await deps.db.select().from(messages).where(and(eq(messages.orgId, actor.orgId), inIds(messages.id, ids)));
  return rows.filter((r) => !scope || scope.includes(r.mailboxId));
}

/** One snooze per thread: the selection's threads (deduped), their old snooze dropped, a new one written. */
async function snoozeRows(deps: Deps, actor: ScheduleActor, rows: Row[], when: WhenInput) {
  const dueAt = await resolveWhen(deps, actor, when);
  const heads = new Map<string, Row>();
  for (const r of rows) {
    if (r.folder === "drafts") continue;
    const key = `${r.mailboxId}\u0000${r.threadId}`;
    const prev = heads.get(key);
    if (!prev || prev.date < r.date) heads.set(key, r);
  }
  const list = [...heads.values()];
  if (!list.length) return { updated: 0, dueAt: dueAt.toISOString() };
  await unsnoozeRows(deps, actor, list);
  const now = deps.now();
  for (const part of chunkIds(list, 10)) {
    await deps.db.insert(mailSchedules).values(part.map((h) => ({
      id: newId("msch"), orgId: actor.orgId, mailboxId: h.mailboxId, userId: actor.userId || null, kind: "snooze" as const, threadId: h.threadId, messageId: h.id, dueAt, createdAt: now,
    })));
  }
  return { updated: list.length, dueAt: dueAt.toISOString() };
}

/** Drops pending snoozes on the selection's threads (Undo of a bulk snooze, or "unsnooze" on purpose). */
async function unsnoozeRows(deps: Deps, actor: ScheduleActor, rows: Row[]) {
  const threads = [...new Set(rows.map((r) => r.threadId))];
  const boxes = [...new Set(rows.map((r) => r.mailboxId))];
  if (!threads.length) return 0;
  const gone = await deps.db.delete(mailSchedules).where(and(
    eq(mailSchedules.orgId, actor.orgId), eq(mailSchedules.kind, "snooze"), inIds(mailSchedules.threadId, threads), inIds(mailSchedules.mailboxId, boxes),
  )).returning({ id: mailSchedules.id });
  return gone.length;
}

/** Runs one bulk action. `queue` tells a connected mailbox's provider (the app also pushes moves at once). */
export async function runBulkMail(deps: Deps, actor: ScheduleActor, input: BulkMailInput, queue?: QueueFn): Promise<{ updated: number; dueAt?: string }> {
  if (actor.scope === "read") throw new HttpError(403, "read_only_key", "This API key can only read.");
  const { action, to } = input;
  const ids = [...new Set(input.ids)];
  if (!ids.length) throw badRequest("Pick at least one message.");
  if (ids.length > BULK_MAIL_MAX) throw badRequest(`Up to ${BULK_MAIL_MAX} messages at a time.`);
  if (action === "move" && !to) throw badRequest("Say which folder to move to.");
  const send: QueueFn = queue ?? ((rows, a, o) => queueRemoteChange(deps, rows, a, o));
  const rows = await ownRows(deps, actor, ids);
  if (!rows.length) return { updated: 0 };
  const own = rows.map((r) => r.id);
  if (action === "snooze") return snoozeRows(deps, actor, rows, input);
  if (action === "unsnooze") return { updated: await unsnoozeRows(deps, actor, rows) };
  if (action === "move") {
    // Only synced mail of connected mailboxes moves to a provider folder; the rest stays put.
    const movable = rows.filter((r) => r.remoteBox && r.remoteUid && r.folder !== "sent" && r.folder !== "drafts");
    if (movable.length) await deps.db.update(messages).set({ folder: localFolderFor(to!) }).where(inIds(messages.id, movable.map((r) => r.id)));
    const queued = await send(movable, "move", { dest: to });
    if (!queued) {
      // Put them back: the folder isn't one this mailbox syncs.
      for (const r of movable) await deps.db.update(messages).set({ folder: r.folder }).where(eq(messages.id, r.id));
      throw badRequest("That folder isn't one of this mailbox's synced folders.");
    }
    return { updated: queued };
  }
  if (action === "delete") { await assertNotHeld(deps, actor.orgId, rows); await deleteMessagesPermanently(deps.db, rows); } // R111: a legal hold blocks it
  else await deps.db.update(messages).set(SET[action]!).where(inIds(messages.id, own));
  const remote = BULK_REMOTE[action];
  if (remote) await send(rows.filter((r) => r.folder !== "sent" && r.folder !== "drafts"), remote);
  return { updated: own.length };
}

