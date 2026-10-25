/**
 * Round 22 (R22.2): internal notes on a mail thread, with @mentions that notify. Team only: a note
 * is never part of an outgoing message, a reply quote, an agent's thread read or anything sent to
 * the sender. The only way to read notes is to ask for them (this service, its routes and tools).
 *
 * Access follows the shared inbox: the caller must be able to open at least one message of the
 * thread (same workspace, a mailbox in their scope), else 404. Mentions only reach people who can
 * open the thread's mailbox. D1 cost: 1 row plus 1 index entry per note, plus one notification row
 * per mentioned person (never the author).
 */
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { agents, members, messages, threadComments, users } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { assertWritable, scopeOf, sortableId, type SuiteActor } from "../suite/common";
import { notify } from "../suite/notify";
import { usersWhoCanOpen } from "../team";

export const COMMENT_MAX = 4000;
const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

type Row = typeof threadComments.$inferSelect;
export interface Mentionable { userId: string; name: string; email: string | null }

/** The thread as this actor may see it: its mailboxes in scope and its subject. 404 when they can't open it. */
async function openThread(deps: Deps, a: SuiteActor, threadId: string) {
  if (!threadId || threadId.length > 200) throw notFound("Thread");
  const scope = await scopeOf(deps, a);
  const rows = await deps.db.select({ mailboxId: messages.mailboxId, subject: messages.subject }).from(messages)
    .where(and(eq(messages.orgId, a.orgId), eq(messages.threadId, threadId), sql`${messages.folder} <> 'drafts'`, scope ? inArray(messages.mailboxId, scope.length ? scope : ["-"]) : undefined))
    .orderBy(asc(messages.date)).limit(50);
  if (!rows.length) throw notFound("Thread");
  return { mailboxId: rows[0].mailboxId, mailboxIds: [...new Set(rows.map((r) => r.mailboxId))], subject: rows[0].subject || "(no subject)" };
}

/** People who can open this thread's mailbox and so may be mentioned. Agent members are left out. */
export async function mentionable(deps: Deps, orgId: string, mailboxIds: string[]): Promise<Mentionable[]> {
  const ids = new Set<string>();
  for (const id of mailboxIds) for (const u of await usersWhoCanOpen(deps.db, orgId, id)) ids.add(u);
  if (!ids.size) return [];
  const rows = await deps.db.select({ userId: users.id, name: users.name, email: users.email, kind: members.kind }).from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.organizationId, orgId), inArray(members.userId, [...ids]), ne(members.kind, "agent")));
  return rows.map((r) => ({ userId: r.userId, name: r.name || r.email, email: r.email })).sort((x, y) => x.name.localeCompare(y.name));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The people a note mentions: "@Full Name" or "@email" in the text (names with spaces work, longest
 * name first, case does not matter), plus any explicit user ids or emails. Anyone who can't open the
 * thread, and unknown names, are ignored.
 */
export function parseMentions(body: string, people: Mentionable[], explicit: string[] = []): string[] {
  const out = new Set<string>();
  // Longest token first, and each match is blanked out, so "@Max Member" never also counts as "@Max".
  const tokens = people.flatMap((p) => [p.name, p.email].filter((x): x is string => !!x).map((t) => ({ t, userId: p.userId })))
    .sort((x, y) => y.t.length - x.t.length);
  let rest = body;
  for (const { t, userId } of tokens) {
    const re = new RegExp(`(^|[^\\w@])@${escapeRe(t)}(?![\\w-]|@|\\.\\w)`, "gi");
    if (re.test(rest)) {
      out.add(userId);
      rest = rest.replace(re, (m, lead: string) => lead + " ".repeat(m.length - lead.length));
    }
  }
  for (const e of explicit) {
    const v = e.trim().toLowerCase();
    const hit = people.find((p) => p.userId === e.trim() || (p.email && p.email.toLowerCase() === v));
    if (hit) out.add(hit.userId);
  }
  return [...out];
}

async function authorNames(deps: Deps, orgId: string, rows: Row[]) {
  const memberIds = [...new Set(rows.filter((r) => r.authorType === "member").map((r) => r.authorId).concat(rows.flatMap((r) => JSON.parse(r.mentions) as string[])))];
  const agentIds = [...new Set(rows.filter((r) => r.authorType === "agent").map((r) => r.authorId))];
  const [people, bots] = await Promise.all([
    memberIds.length ? deps.db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, memberIds)) : [],
    agentIds.length ? deps.db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.orgId, orgId), inArray(agents.id, agentIds))) : [],
  ]);
  return { people: new Map(people.map((p) => [p.id, p.name || p.email])), bots: new Map(bots.map((b) => [b.id, b.name])) };
}

function present(r: Row, names: Awaited<ReturnType<typeof authorNames>>, a: SuiteActor) {
  const mine = isAuthor(r, a);
  return {
    id: r.id,
    threadId: r.threadId,
    mailboxId: r.mailboxId,
    author: { type: r.authorType, id: r.authorId, name: (r.authorType === "agent" ? names.bots.get(r.authorId) : names.people.get(r.authorId)) ?? (r.authorType === "agent" ? "Agent" : "Former member") },
    body: r.body,
    mentions: (JSON.parse(r.mentions) as string[]).map((userId) => ({ userId, name: names.people.get(userId) ?? "Former member" })),
    editedAt: r.editedAt ? r.editedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    canEdit: mine,
    canDelete: mine || isLead(a),
  };
}
export type ThreadComment = ReturnType<typeof present>;

const authorOf = (a: SuiteActor) => (a.agentId ? { authorType: "agent" as const, authorId: a.agentId } : { authorType: "member" as const, authorId: a.userId });
const isAuthor = (r: Row, a: SuiteActor) => { const me = authorOf(a); return r.authorType === me.authorType && r.authorId === me.authorId; };
const isLead = (a: SuiteActor) => !a.agentId && (a.role === "owner" || a.role === "admin");

function cleanBody(body: string) {
  const b = (body ?? "").replace(/\r\n/g, "\n").trim();
  if (!b) throw new HttpError(422, "validation_failed", "Write a note first.", { fields: { body: "Write a note first." } });
  if (b.length > COMMENT_MAX) throw new HttpError(422, "validation_failed", `Notes can be up to ${COMMENT_MAX} characters.`, { fields: { body: "Too long." } });
  return b;
}

async function notifyMentions(deps: Deps, a: SuiteActor, threadId: string, subject: string, userIds: string[], authorName: string) {
  const me = a.agentId ? null : a.userId;
  const targets = userIds.filter((u) => u !== me);
  if (!targets.length) return;
  // Round 23: phones open a mail thread by one of its messages, so the push carries the newest one's id.
  const newest = await deps.db.select({ id: messages.id }).from(messages)
    .where(and(eq(messages.orgId, a.orgId), eq(messages.threadId, threadId), ne(messages.folder, "drafts"))).orderBy(desc(messages.date)).limit(1).get();
  for (const userId of targets) {
    await notify(deps, a.orgId, userId, { type: "thread_mention", entityType: "thread", entityId: threadId, title: `${authorName} mentioned you on: ${subject}`, actorName: authorName, pushMessageId: newest?.id ?? null });
  }
}

async function actorName(deps: Deps, a: SuiteActor) {
  if (a.agentId) return (await deps.db.select({ name: agents.name }).from(agents).where(and(eq(agents.id, a.agentId), eq(agents.orgId, a.orgId))).get())?.name ?? "An agent";
  return a.name || a.email || "Someone";
}

/** Notes on a thread, oldest first, with the people who may be mentioned. */
export async function listComments(deps: Deps, a: SuiteActor, threadId: string) {
  const t = await openThread(deps, a, threadId);
  const rows = await deps.db.select().from(threadComments)
    .where(and(eq(threadComments.orgId, a.orgId), eq(threadComments.threadId, threadId))).orderBy(asc(threadComments.createdAt), asc(threadComments.id)).limit(500);
  const names = await authorNames(deps, a.orgId, rows);
  return { threadId, comments: rows.map((r) => present(r, names, a)), mentionable: await mentionable(deps, a.orgId, t.mailboxIds) };
}

export async function addComment(deps: Deps, a: SuiteActor, threadId: string, input: { body: string; mentions?: string[] }) {
  assertWritable(a);
  const t = await openThread(deps, a, threadId);
  const body = cleanBody(input.body);
  const people = await mentionable(deps, a.orgId, t.mailboxIds);
  const mentioned = parseMentions(body, people, input.mentions ?? []);
  const now = deps.now();
  const row: Row = { id: sortableId("tcm", now.getTime()), orgId: a.orgId, threadId, mailboxId: t.mailboxId, ...authorOf(a), body, mentions: JSON.stringify(mentioned), editedAt: null, createdAt: now };
  if (!row.authorId) throw new HttpError(403, "forbidden", "Only a person or an agent can write a note.");
  await deps.db.insert(threadComments).values(row);
  await notifyMentions(deps, a, threadId, t.subject, mentioned, await actorName(deps, a));
  return present(row, await authorNames(deps, a.orgId, [row]), a);
}

async function ownComment(deps: Deps, a: SuiteActor, threadId: string, commentId: string) {
  await openThread(deps, a, threadId);
  const r = await deps.db.select().from(threadComments)
    .where(and(eq(threadComments.id, commentId), eq(threadComments.orgId, a.orgId), eq(threadComments.threadId, threadId))).get();
  if (!r) throw notFound("Note");
  return r;
}

/** The author can edit a note for 24 hours. New mentions notify; people already mentioned are not told again. */
export async function editComment(deps: Deps, a: SuiteActor, threadId: string, commentId: string, input: { body: string; mentions?: string[] }) {
  assertWritable(a);
  const r = await ownComment(deps, a, threadId, commentId);
  if (!isAuthor(r, a)) throw new HttpError(403, "forbidden", "Only the person who wrote a note can edit it.");
  if (deps.now().getTime() - r.createdAt.getTime() > EDIT_WINDOW_MS) throw new HttpError(409, "conflict", "Notes can be edited for 24 hours. Add a new note instead.");
  const body = cleanBody(input.body);
  const t = await openThread(deps, a, threadId);
  const people = await mentionable(deps, a.orgId, t.mailboxIds);
  const before = JSON.parse(r.mentions) as string[];
  const mentioned = parseMentions(body, people, input.mentions ?? []);
  const editedAt = deps.now();
  await deps.db.update(threadComments).set({ body, mentions: JSON.stringify(mentioned), editedAt }).where(eq(threadComments.id, r.id));
  await notifyMentions(deps, a, threadId, t.subject, mentioned.filter((u) => !before.includes(u)), await actorName(deps, a));
  const next = { ...r, body, mentions: JSON.stringify(mentioned), editedAt };
  return present(next, await authorNames(deps, a.orgId, [next]), a);
}

/** The author, or a workspace owner or admin, can delete a note. */
export async function deleteComment(deps: Deps, a: SuiteActor, threadId: string, commentId: string) {
  assertWritable(a);
  const r = await ownComment(deps, a, threadId, commentId);
  if (!isAuthor(r, a) && !isLead(a)) throw new HttpError(403, "forbidden", "Only the person who wrote a note, or an admin, can delete it.");
  await deps.db.delete(threadComments).where(eq(threadComments.id, r.id));
  return { ok: true, id: r.id };
}

/** How many notes each of these threads has, in one grouped read. Threads the caller can't open count 0. */
export async function commentCounts(deps: Deps, a: SuiteActor, threadIds: string[]) {
  const ids = [...new Set(threadIds)].slice(0, 100);
  if (!ids.length) return {} as Record<string, number>;
  const scope = await scopeOf(deps, a);
  const rows = await deps.db.select({ threadId: threadComments.threadId, n: sql<number>`count(*)` }).from(threadComments)
    .where(and(eq(threadComments.orgId, a.orgId), inArray(threadComments.threadId, ids), scope ? inArray(threadComments.mailboxId, scope.length ? scope : ["-"]) : undefined))
    .groupBy(threadComments.threadId);
  return Object.fromEntries(rows.map((r) => [r.threadId, Number(r.n)]));
}
