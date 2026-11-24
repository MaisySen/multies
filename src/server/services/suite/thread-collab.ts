/**
 * Round 22 (R22.3 and R22.4): live presence in a shared inbox thread and shared draft replies.
 *
 * Presence never writes D1: the access check reads, the room lives in memory (a Durable Object on
 * Workers, see collab/thread-presence.ts). A draft reply is a messages row in folder "drafts" with
 * the thread's id; sent_by_user_id says whose it is. Taking one over is one row update.
 */
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { messages, users } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { scopeFor, type Actor } from "../agents";
import { memoryPresence, presenceKey, type PresenceState, type PresenceStore, type PresenceView } from "../../collab/thread-presence";
import { notify } from "./notify";
import { inIds } from "../../lib/sql-chunks";

type Who = Pick<Actor, "orgId" | "userId" | "role" | "agentId">;

let local: PresenceStore | null = null;
/** The rooms: the Durable Object when the host has one, else this process's map. */
export const presenceStore = (deps: Deps): PresenceStore => deps.presence ?? (local ??= memoryPresence());

const scopeCond = (scope: string[] | null) => (scope ? inIds(messages.mailboxId, scope) : undefined);

/**
 * 404 unless at least one message of the thread is in a mailbox the caller can open (same org). Reads only.
 * PRIV1b (P15, review M1): with mailboxId, that copy only (the one the client has open); else the oldest copy in scope.
 */
export async function assertThreadAccess(deps: Deps, actor: Who, threadId: string, mailboxId?: string) {
  const scope = await scopeFor(deps, actor as Actor);
  if (mailboxId && scope && !scope.includes(mailboxId)) throw notFound("Thread");
  const hit = await deps.db.select({ id: messages.id, subject: messages.subject, mailboxId: messages.mailboxId }).from(messages)
    .where(and(eq(messages.orgId, actor.orgId), eq(messages.threadId, threadId), mailboxId ? eq(messages.mailboxId, mailboxId) : scopeCond(scope), sql`${messages.folder} <> 'trash'`)).orderBy(asc(messages.date)).limit(1).get();
  if (!hit) throw notFound("Thread");
  return { scope, subject: hit.subject, mailboxId: hit.mailboxId };
}

/** PRIV1b (P15): one room per mailbox copy of a thread, so only people who can open the same copy see each other. */
const roomKey = (orgId: string, threadId: string, mailboxId: string) => `${presenceKey(orgId, threadId)}:${mailboxId}`;

/** Beats, leaves or reads the thread's room. Never writes D1. */
export async function threadPresence(deps: Deps, actor: Who & { name?: string }, threadId: string, op: { op: "beat"; clientId: string; state: PresenceState } | { op: "leave"; clientId: string } | { op: "list" }, open?: { mailboxId?: string }): Promise<PresenceView> {
  const { mailboxId } = await assertThreadAccess(deps, actor, threadId, open?.mailboxId || undefined);
  const store = presenceStore(deps);
  const key = roomKey(actor.orgId, threadId, mailboxId);
  // Client ids are scoped to the person so one person can never end or overwrite another's entry.
  if (op.op === "beat") return store(key, { op: "beat", clientId: `${actor.userId}:${op.clientId}`, userId: actor.userId, name: actor.name || "Someone", state: op.state });
  if (op.op === "leave") return store(key, { op: "leave", clientId: `${actor.userId}:${op.clientId}` });
  return store(key, { op: "list" });
}

/** The view one person sees: everyone else, and only the notes meant for them. */
export function viewFor(view: PresenceView, userId: string) {
  return {
    people: view.people.filter((p) => p.userId !== userId),
    notes: view.notes.filter((n) => n.toUserId === userId).map((n) => ({ type: n.type, draftId: n.draftId, byName: n.byName, subject: n.subject, at: new Date(n.at).toISOString() })),
  };
}

export interface ThreadDraft {
  id: string; threadId: string; mailboxId: string; subject: string; snippet: string; to: string[];
  author: { userId: string; name: string } | null; mine: boolean; updatedAt: string;
}

async function names(deps: Deps, ids: string[]) {
  const rows = ids.length ? await deps.db.select({ id: users.id, name: users.name }).from(users).where(inIds(users.id, ids)) : [];
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Draft replies in a thread, in the mailboxes the caller can open. */
export async function listThreadDrafts(deps: Deps, actor: Who, threadId: string): Promise<ThreadDraft[]> {
  const { scope } = await assertThreadAccess(deps, actor, threadId);
  const rows = await deps.db.select().from(messages)
    .where(and(eq(messages.orgId, actor.orgId), eq(messages.threadId, threadId), eq(messages.folder, "drafts"), scopeCond(scope))).orderBy(asc(messages.date)).limit(50);
  const who = await names(deps, [...new Set(rows.map((r) => r.sentByUserId).filter((x): x is string => !!x))]);
  return rows.map((r) => ({
    id: r.id, threadId: r.threadId, mailboxId: r.mailboxId, subject: r.subject, snippet: r.text.slice(0, 280),
    to: (JSON.parse(r.to) as { address: string }[]).map((a) => a.address),
    author: r.sentByUserId ? { userId: r.sentByUserId, name: who.get(r.sentByUserId) ?? "Someone" } : null,
    mine: r.sentByUserId === actor.userId, updatedAt: r.date.toISOString(),
  }));
}

/** One draft the caller can open, with its body, for Compose. */
async function draftFor(deps: Deps, actor: Who, draftId: string) {
  const scope = await scopeFor(deps, actor as Actor);
  const d = await deps.db.select().from(messages)
    .where(and(eq(messages.id, draftId), eq(messages.orgId, actor.orgId), eq(messages.folder, "drafts"), scopeCond(scope))).get();
  if (!d) throw notFound("Draft");
  return d;
}

/**
 * Makes the caller the draft's owner: one row write (sent_by_user_id has no index). The update only
 * lands if nobody changed the owner since it was read, so two people taking over at once can't both win.
 * The previous author gets one notification, and their live view of the thread shows the change.
 */
export async function takeOverDraft(deps: Deps, actor: Who & { name?: string }, draftId: string) {
  if (actor.agentId) throw new HttpError(403, "agent_key_scope", "An agent key can't take over a person's draft.");
  const d = await draftFor(deps, actor, draftId);
  // PRIV1b (P11): taking over a draft reply needs Read and reply (403 share_level for a read share).
  const { assertOpen } = await import("../mail-access-priv1a");
  await assertOpen(deps.db, actor, d.mailboxId, "reply");
  const previous = d.sentByUserId;
  if (previous !== actor.userId) {
    const res = await deps.db.update(messages).set({ sentByUserId: actor.userId })
      .where(and(eq(messages.id, d.id), eq(messages.folder, "drafts"), previous ? eq(messages.sentByUserId, previous) : isNull(messages.sentByUserId)))
      .returning({ id: messages.id });
    if (!res.length) throw new HttpError(409, "draft_changed", "Someone else changed this draft just now. Open the thread again to see who has it.");
    const subject = d.subject || "(no subject)";
    const byName = actor.name || "Someone";
    if (previous) {
      await notify(deps, actor.orgId, previous, { type: "draft_taken_over", entityType: "thread", entityId: d.threadId, title: `${byName} took over your draft on ${subject}`, actorName: byName });
      // PRIV1b (P15): the note goes to the room of the draft's own mailbox copy.
      await presenceStore(deps)(roomKey(actor.orgId, d.threadId, d.mailboxId), { op: "note", note: { type: "draft_taken_over", draftId: d.id, toUserId: previous, byUserId: actor.userId, byName, subject } })
        .catch((err) => deps.reportError?.(err, { where: "presence note" }));
    }
  }
  // The message the draft answers, so Compose sends it as a reply in the same thread.
  const answers = d.inReplyTo ? await deps.db.select({ id: messages.id }).from(messages)
    .where(and(eq(messages.orgId, actor.orgId), eq(messages.threadId, d.threadId), eq(messages.messageIdHeader, d.inReplyTo), sql`${messages.folder} <> 'drafts'`)).limit(1).get() : undefined;
  return {
    draft: {
      id: d.id, threadId: d.threadId, mailboxId: d.mailboxId, subject: d.subject, text: d.text, inReplyTo: d.inReplyTo, inReplyToId: answers?.id ?? null,
      to: (JSON.parse(d.to) as { address: string }[]).map((a) => a.address),
      cc: (JSON.parse(d.cc) as { address: string }[]).map((a) => a.address),
      bcc: (JSON.parse(d.bcc) as { address: string }[]).map((a) => a.address),
    },
    previousAuthorId: previous && previous !== actor.userId ? previous : null,
  };
}

/**
 * Before Compose saves over an existing draft: 409 when somebody else took it over, or when the draft
 * is gone (saved again, sent or taken over in another window), instead of silently overwriting.
 */
export async function checkDraftSave(deps: Deps, actor: Who, draftId: string, mailboxId: string) {
  const d = await deps.db.select({ id: messages.id, sentByUserId: messages.sentByUserId, threadId: messages.threadId, inReplyTo: messages.inReplyTo, sizeBytes: messages.sizeBytes, date: messages.date }).from(messages)
    .where(and(eq(messages.id, draftId), eq(messages.orgId, actor.orgId), eq(messages.mailboxId, mailboxId), eq(messages.folder, "drafts"))).get();
  if (!d) throw new HttpError(409, "draft_changed", "This draft was saved, sent or taken over in another window. Copy your text and start a new reply.");
  if (d.sentByUserId && d.sentByUserId !== actor.userId) {
    const who = (await names(deps, [d.sentByUserId])).get(d.sentByUserId) ?? "A teammate";
    throw new HttpError(409, "draft_taken_over", `${who} took over this draft, so your changes were not saved. Copy your text before you close.`);
  }
  return d;
}

/** Where a draft reply belongs: the thread of the message it answers, when the caller can open it. */
export async function replyTarget(deps: Deps, actor: Who, inReplyToId: string | undefined) {
  if (!inReplyToId) return null;
  const scope = await scopeFor(deps, actor as Actor);
  const m = await deps.db.select({ threadId: messages.threadId, messageIdHeader: messages.messageIdHeader, references: messages.references }).from(messages)
    .where(and(eq(messages.id, inReplyToId), eq(messages.orgId, actor.orgId), scopeCond(scope))).get();
  return m ?? null;
}

export const ownedBy = (userId: string) => or(isNull(messages.sentByUserId), eq(messages.sentByUserId, userId));
