/**
 * R96: chat plus. Topics inside channels (unread by topic, rename and merge, move, resolve with a tick),
 * announcements with seen by receipts, and votes: polls, decision votes with an outcome, live Q&A with upvotes
 * and word clouds, in channels and during meetings. Members only; guests read results where a channel lets them in.
 */
import { and, asc, count, desc, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import {
  chatAnnouncementReads, chatAnnouncements, chatChannels, chatMembers, chatMessages, chatPollItems, chatPollVotes, chatPolls, chatTopicReads, chatTopics,
  meetings, members as orgMembers, users,
} from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { inIds } from "../../lib/sql-chunks";
import { publishChat } from "../../realtime/publish";
import { assertWritable, sortableId, type SuiteActor } from "./common";
import { guestChannel, pinMessage, postMessage, present, visibleChannel, type GuestViewer } from "./chat";
import {
  CHAT_PLUS_LIMITS as L, DECISION_RESULT_LABEL, DECISION_STANCES, POLL_KIND_LABEL, STANCE_LABEL, cleanOptions, cleanTopicName, cloudWords, decisionOutcome,
  isOpenPoll, pollMessageBody, pollWinners, tallyCloud, topicKey, type PollKind, type Stance,
} from "../../../shared/chat-plus";

const notFound = (what: string) => new HttpError(404, "not_found", `${what} not found.`);
const invalid = (msg: string) => new HttpError(422, "validation_failed", msg);
const isAdmin = (a: SuiteActor) => a.role === "owner" || a.role === "admin";

/** People only: API keys and agents cannot vote, resolve or post announcements. */
function person(a: SuiteActor): string {
  if (a.agentId || a.apiKeyId || !a.userId || a.system) throw new HttpError(403, "members_only", "Only people in the workspace can do this.");
  return a.userId;
}
const displayName = (a: SuiteActor) => (a.name || a.email || "Someone").slice(0, 120);

async function writableChannel(deps: Deps, a: SuiteActor, channelId: string) {
  assertWritable(a);
  const c = await visibleChannel(deps, a, channelId);
  if (c.archived) throw new HttpError(409, "archived", "This channel is archived. Unarchive it first.");
  return c;
}

async function touchMessage(deps: Deps, orgId: string, messageId: string | null) {
  if (!messageId) return;
  const now = deps.now();
  await deps.db.update(chatMessages).set({ updatedAt: now }).where(and(eq(chatMessages.orgId, orgId), eq(chatMessages.id, messageId)));
  const row = await deps.db.select().from(chatMessages).where(eq(chatMessages.id, messageId)).get();
  if (!row || row.deletedAt) return;
  const c = await deps.db.select().from(chatChannels).where(eq(chatChannels.id, row.channelId)).get();
  if (!c) return;
  const [m] = await present(deps, [row]);
  const members = (await deps.db.select({ userId: chatMembers.userId }).from(chatMembers).where(eq(chatMembers.channelId, c.id))).map((r) => r.userId);
  await publishChat(deps, c, { t: "message", op: "updated", channelId: c.id, message: m } as never, { members });
}

// ---------------------------------------------------------------- topics

type TopicRow = typeof chatTopics.$inferSelect;
function presentTopic(t: TopicRow, extra: { total?: number; unread?: number } = {}) {
  return {
    id: t.id, channelId: t.channelId, name: t.name, resolved: !!t.resolvedAt, resolvedAt: t.resolvedAt?.toISOString() ?? null, resolvedBy: t.resolvedBy ?? null,
    lastMessageAt: t.lastMessageAt?.toISOString() ?? null, total: extra.total ?? 0, unread: extra.unread ?? 0,
  };
}

async function topicRow(deps: Deps, orgId: string, id: string) {
  const t = await deps.db.select().from(chatTopics).where(and(eq(chatTopics.orgId, orgId), eq(chatTopics.id, id))).get();
  if (!t) throw notFound("Topic");
  return t;
}

/** Used by postMessage: the topic must be in the same channel. */
export async function topicForPost(deps: Deps, orgId: string, channelId: string, topicId: string) {
  const t = await deps.db.select({ id: chatTopics.id }).from(chatTopics).where(and(eq(chatTopics.orgId, orgId), eq(chatTopics.id, topicId), eq(chatTopics.channelId, channelId))).get();
  if (!t) throw notFound("Topic");
  return t.id;
}

export async function listTopics(deps: Deps, a: SuiteActor, channelId: string) {
  const c = await visibleChannel(deps, a, channelId);
  const viewer = a.agentId || a.apiKeyId ? null : a.userId ?? null;
  const rows = await deps.db.select().from(chatTopics).where(and(eq(chatTopics.orgId, c.orgId), eq(chatTopics.channelId, c.id)))
    .orderBy(sql`${chatTopics.resolvedAt} is not null`, desc(sql`coalesce(${chatTopics.lastMessageAt}, ${chatTopics.createdAt})`)).limit(L.topicsPerChannel);
  if (!rows.length) return { topics: [] };
  const live = and(eq(chatMessages.channelId, c.id), isNull(chatMessages.parentId), isNull(chatMessages.deletedAt));
  const totals = new Map((await deps.db.select({ id: chatMessages.topicId, n: count() }).from(chatMessages).where(and(live, inIds(chatMessages.topicId, rows.map((r) => r.id)))).groupBy(chatMessages.topicId)).map((r) => [r.id, r.n]));
  const unread = new Map<string, number>();
  const member = viewer ? await deps.db.select({ at: chatMembers.lastReadAt }).from(chatMembers).where(and(eq(chatMembers.channelId, c.id), eq(chatMembers.userId, viewer))).get() : null;
  if (viewer && member) {
    // Unread by topic: messages after the later of the channel read mark and the topic's own read mark.
    const since = new Map(rows.map((r) => [r.id, member.at?.getTime() ?? 0]));
    for (const r of await deps.db.select().from(chatTopicReads).where(and(eq(chatTopicReads.userId, viewer), inIds(chatTopicReads.topicId, rows.map((t) => t.id))))) {
      since.set(r.topicId, Math.max(since.get(r.topicId) ?? 0, r.lastReadAt.getTime()));
    }
    const floor = Math.min(...since.values());
    const recent = await deps.db.select({ topicId: chatMessages.topicId, at: chatMessages.createdAt }).from(chatMessages)
      .where(and(live, inIds(chatMessages.topicId, rows.map((r) => r.id)), gt(chatMessages.createdAt, new Date(floor)), sql`coalesce(${chatMessages.authorId}, '') <> ${viewer}`)).limit(5000);
    for (const m of recent) if (m.topicId && m.at.getTime() > (since.get(m.topicId) ?? 0)) unread.set(m.topicId, (unread.get(m.topicId) ?? 0) + 1);
  }
  return { topics: rows.map((t) => presentTopic(t, { total: totals.get(t.id) ?? 0, unread: unread.get(t.id) ?? 0 })) };
}

export async function createTopic(deps: Deps, a: SuiteActor, channelId: string, rawName: string) {
  const userId = person(a);
  const c = await writableChannel(deps, a, channelId);
  if (c.kind !== "channel") throw invalid("Topics are for channels.");
  const name = cleanTopicName(rawName);
  if (!name) throw invalid("Give the topic a name.");
  const existing = await deps.db.select().from(chatTopics).where(and(eq(chatTopics.channelId, c.id), eq(chatTopics.nameKey, topicKey(name)))).get();
  if (existing) return { topic: presentTopic(existing), created: false };
  const n = await deps.db.select({ n: count() }).from(chatTopics).where(eq(chatTopics.channelId, c.id)).get();
  if ((n?.n ?? 0) >= L.topicsPerChannel) throw new HttpError(422, "too_many_topics", `A channel holds up to ${L.topicsPerChannel} topics. Rename or merge some first.`);
  const now = deps.now();
  const id = sortableId("ctp", now.getTime());
  await deps.db.insert(chatTopics).values({ id, orgId: c.orgId, channelId: c.id, name, nameKey: topicKey(name), createdBy: userId, createdAt: now, updatedAt: now }).onConflictDoNothing();
  const row = await deps.db.select().from(chatTopics).where(and(eq(chatTopics.channelId, c.id), eq(chatTopics.nameKey, topicKey(name)))).get();
  return { topic: presentTopic(row!), created: row!.id === id };
}

/** Rename (and merge into a topic that already has the new name, when asked), or resolve and reopen. */
export async function updateTopic(deps: Deps, a: SuiteActor, id: string, patch: { name?: string; merge?: boolean; resolved?: boolean }) {
  const userId = person(a);
  const t = await topicRow(deps, a.orgId, id);
  const c = await writableChannel(deps, a, t.channelId);
  const now = deps.now();
  let out = t;
  if (patch.name !== undefined) {
    if (t.createdBy !== userId && !isAdmin(a)) throw new HttpError(403, "forbidden", "Only the person who started a topic or an admin can rename it.");
    const name = cleanTopicName(patch.name);
    if (!name) throw invalid("Give the topic a name.");
    const other = await deps.db.select().from(chatTopics).where(and(eq(chatTopics.channelId, c.id), eq(chatTopics.nameKey, topicKey(name)), ne(chatTopics.id, t.id))).get();
    if (other) {
      if (!patch.merge) throw new HttpError(409, "topic_exists", `There is already a topic called ${other.name}. Merge them?`);
      await deps.db.update(chatMessages).set({ topicId: other.id, updatedAt: now }).where(and(eq(chatMessages.channelId, c.id), eq(chatMessages.topicId, t.id)));
      const last = [other.lastMessageAt, t.lastMessageAt].filter(Boolean).sort((x, y) => y!.getTime() - x!.getTime())[0] ?? null;
      await deps.db.update(chatTopics).set({ lastMessageAt: last, updatedAt: now }).where(eq(chatTopics.id, other.id));
      await deps.db.delete(chatTopics).where(eq(chatTopics.id, t.id));
      return { topic: presentTopic((await topicRow(deps, a.orgId, other.id))), merged: true };
    }
    await deps.db.update(chatTopics).set({ name, nameKey: topicKey(name), updatedAt: now }).where(eq(chatTopics.id, t.id));
    out = await topicRow(deps, a.orgId, t.id);
  }
  if (patch.resolved !== undefined && patch.resolved !== !!out.resolvedAt) {
    await deps.db.update(chatTopics).set(patch.resolved ? { resolvedAt: now, resolvedBy: displayName(a), updatedAt: now } : { resolvedAt: null, resolvedBy: null, updatedAt: now }).where(eq(chatTopics.id, t.id));
    await postMessage(deps, a, c.id, { body: patch.resolved ? "✓ Marked this topic as resolved." : "Reopened this topic.", topicId: t.id });
    out = await topicRow(deps, a.orgId, t.id);
  }
  return { topic: presentTopic(out), merged: false };
}

export async function markTopicRead(deps: Deps, a: SuiteActor, id: string) {
  const userId = person(a);
  const t = await topicRow(deps, a.orgId, id);
  await visibleChannel(deps, a, t.channelId);
  const now = deps.now();
  await deps.db.insert(chatTopicReads).values({ topicId: t.id, userId, orgId: t.orgId, lastReadAt: now })
    .onConflictDoUpdate({ target: [chatTopicReads.topicId, chatTopicReads.userId], set: { lastReadAt: now } });
  return { ok: true };
}

/** Moves a top level message (and its thread) into a topic of the same channel, or out of any topic. */
export async function moveMessage(deps: Deps, a: SuiteActor, messageId: string, topicId: string | null) {
  const userId = person(a);
  const m = await deps.db.select().from(chatMessages).where(and(eq(chatMessages.orgId, a.orgId), eq(chatMessages.id, messageId))).get();
  if (!m || m.deletedAt) throw notFound("Message");
  const c = await writableChannel(deps, a, m.channelId);
  if (m.parentId) throw invalid("Move the thread's first message; its replies move with it.");
  if (m.authorId !== userId && !isAdmin(a)) throw new HttpError(403, "forbidden", "Only the author or an admin can move a message.");
  const target = topicId ? await topicForPost(deps, a.orgId, c.id, topicId) : null;
  const now = deps.now();
  await deps.db.update(chatMessages).set({ topicId: target, updatedAt: now }).where(and(eq(chatMessages.channelId, c.id), or(eq(chatMessages.id, m.id), eq(chatMessages.parentId, m.id))));
  if (target) await deps.db.update(chatTopics).set({ lastMessageAt: sql`max(coalesce(${chatTopics.lastMessageAt}, 0), ${m.createdAt.getTime()})` as never, updatedAt: now }).where(eq(chatTopics.id, target));
  await touchMessage(deps, a.orgId, m.id);
  return { ok: true, topicId: target };
}

// ---------------------------------------------------------------- announcements

async function audienceSize(deps: Deps, c: typeof chatChannels.$inferSelect) {
  if (c.isPrivate || c.kind === "dm") return (await deps.db.select({ n: count() }).from(chatMembers).where(eq(chatMembers.channelId, c.id)).get())?.n ?? 0;
  return (await deps.db.select({ n: count() }).from(orgMembers).where(and(eq(orgMembers.organizationId, c.orgId), ne(orgMembers.kind, "agent"))).get())?.n ?? 0;
}

export async function postAnnouncement(deps: Deps, a: SuiteActor, channelId: string, input: { body: string; topicId?: string | null }) {
  const userId = person(a);
  const c = await writableChannel(deps, a, channelId);
  if (c.kind !== "channel") throw invalid("Announcements go in a channel.");
  if (!isAdmin(a)) throw new HttpError(403, "forbidden", "Only admins can post announcements.");
  if (!input.body.trim()) throw invalid("Write the announcement first.");
  const m = await postMessage(deps, a, c.id, { body: input.body, topicId: input.topicId ?? null });
  await deps.db.insert(chatAnnouncements).values({ messageId: m.id, orgId: c.orgId, channelId: c.id, postedBy: userId, createdAt: deps.now() }).onConflictDoNothing();
  await deps.db.insert(chatAnnouncementReads).values({ messageId: m.id, userId, orgId: c.orgId, readAt: deps.now() }).onConflictDoNothing();
  try { await pinMessage(deps, a, m.id, true); } catch { /* a channel at its pin limit still gets the announcement */ }
  await touchMessage(deps, c.orgId, m.id);
  return { message: (await present(deps, [(await deps.db.select().from(chatMessages).where(eq(chatMessages.id, m.id)).get())!]))[0] };
}

/** The announcements feed: every announcement in the channels this person can see, newest first, with seen by counts. */
export async function announcementFeed(deps: Deps, a: SuiteActor, q: { limit?: number } = {}) {
  const userId = person(a);
  const limit = Math.min(Math.max(q.limit ?? 30, 1), 100);
  const mine = (await deps.db.select({ id: chatMembers.channelId }).from(chatMembers).where(and(eq(chatMembers.userId, userId), eq(chatMembers.orgId, a.orgId)))).map((r) => r.id);
  const visible = and(eq(chatChannels.kind, "channel"), isNull(chatChannels.deletedAt), or(eq(chatChannels.isPrivate, false), mine.length ? inIds(chatChannels.id, mine) : sql`0`));
  const rows = await deps.db.select({ m: chatMessages, c: chatChannels }).from(chatAnnouncements)
    .innerJoin(chatMessages, eq(chatMessages.id, chatAnnouncements.messageId))
    .innerJoin(chatChannels, eq(chatChannels.id, chatAnnouncements.channelId))
    .where(and(eq(chatAnnouncements.orgId, a.orgId), isNull(chatMessages.deletedAt), visible))
    .orderBy(desc(chatAnnouncements.createdAt)).limit(limit);
  const ids = rows.map((r) => r.m.id);
  const seen = ids.length ? await deps.db.select({ id: chatAnnouncementReads.messageId, n: count() }).from(chatAnnouncementReads).where(inIds(chatAnnouncementReads.messageId, ids)).groupBy(chatAnnouncementReads.messageId) : [];
  const seenMap = new Map(seen.map((r) => [r.id, r.n]));
  const mineSeen = new Set(ids.length ? (await deps.db.select({ id: chatAnnouncementReads.messageId }).from(chatAnnouncementReads).where(and(eq(chatAnnouncementReads.userId, userId), inIds(chatAnnouncementReads.messageId, ids)))).map((r) => r.id) : []);
  const presented = await present(deps, rows.map((r) => r.m));
  const sizes = new Map<string, number>();
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const c = rows[i].c;
    if (!sizes.has(c.id)) sizes.set(c.id, await audienceSize(deps, c));
    out.push({ message: presented[i], channel: { id: c.id, name: c.name, private: c.isPrivate }, seenCount: seenMap.get(rows[i].m.id) ?? 0, audience: sizes.get(c.id) ?? 0, seenByMe: mineSeen.has(rows[i].m.id) });
  }
  return { announcements: out, unseen: out.filter((x) => !x.seenByMe).length, canPost: isAdmin(a) };
}

async function visibleAnnouncement(deps: Deps, a: SuiteActor, messageId: string) {
  const ann = await deps.db.select().from(chatAnnouncements).where(and(eq(chatAnnouncements.orgId, a.orgId), eq(chatAnnouncements.messageId, messageId))).get();
  if (!ann) throw notFound("Announcement");
  const c = await visibleChannel(deps, a, ann.channelId);
  return { ann, c };
}

export async function markAnnouncementsSeen(deps: Deps, a: SuiteActor, messageIds: string[]) {
  const userId = person(a);
  const now = deps.now();
  let marked = 0;
  for (const id of [...new Set(messageIds)].slice(0, 100)) {
    try { await visibleAnnouncement(deps, a, id); } catch { continue; }
    await deps.db.insert(chatAnnouncementReads).values({ messageId: id, userId, orgId: a.orgId, readAt: now }).onConflictDoNothing();
    marked++;
  }
  return { marked };
}

/** Who has seen an announcement. Names for the poster and admins; everyone else gets the counts. */
export async function announcementReceipts(deps: Deps, a: SuiteActor, messageId: string) {
  const userId = person(a);
  const { ann, c } = await visibleAnnouncement(deps, a, messageId);
  const rows = await deps.db.select({ userId: chatAnnouncementReads.userId, readAt: chatAnnouncementReads.readAt, name: users.name, email: users.email })
    .from(chatAnnouncementReads).leftJoin(users, eq(users.id, chatAnnouncementReads.userId))
    .where(eq(chatAnnouncementReads.messageId, ann.messageId)).orderBy(asc(chatAnnouncementReads.readAt));
  const audience = await audienceSize(deps, c);
  const names = ann.postedBy === userId || isAdmin(a);
  return { seenCount: rows.length, audience, seen: names ? rows.map((r) => ({ name: r.name || r.email || "Someone", readAt: r.readAt.toISOString() })) : null };
}

// ---------------------------------------------------------------- polls, decisions, Q&A, word clouds

type PollRow = typeof chatPolls.$inferSelect;

async function pollRow(deps: Deps, orgId: string, id: string) {
  const p = await deps.db.select().from(chatPolls).where(and(eq(chatPolls.orgId, orgId), eq(chatPolls.id, id))).get();
  if (!p) throw notFound("Poll");
  return p;
}

/** The channel (when there is one) after checking this person may see the poll. Meeting polls are for anyone in the workspace. */
async function pollAccess(deps: Deps, a: SuiteActor, p: PollRow, write: boolean) {
  if (p.channelId) return write ? writableChannel(deps, a, p.channelId) : visibleChannel(deps, a, p.channelId);
  if (write) assertWritable(a);
  return null;
}

export type CreatePollInput = {
  kind: PollKind; question: string; options?: string[]; multi?: boolean; anonymous?: boolean; closesAt?: string | null;
  channelId?: string | null; topicId?: string | null; meetingId?: string | null;
};

export async function createPoll(deps: Deps, a: SuiteActor, input: CreatePollInput) {
  const userId = person(a);
  const question = input.question.replace(/\s+/g, " ").trim().slice(0, L.question);
  if (!question) throw invalid(input.kind === "decision" ? "Write the proposal first." : "Write the question first.");
  if (!input.channelId && !input.meetingId) throw invalid("Pick a channel or a meeting.");
  let options: string[] = [];
  if (input.kind === "poll") {
    const r = cleanOptions(input.options ?? []);
    if ("error" in r) throw invalid(r.error);
    options = r.options;
  } else if (input.kind === "decision") options = [...DECISION_STANCES];
  const now = deps.now();
  let closesAt: Date | null = input.closesAt ? new Date(input.closesAt) : null;
  if (closesAt && Number.isNaN(closesAt.getTime())) throw invalid("That end time is not a date.");
  if (!closesAt && input.kind === "decision") closesAt = new Date(now.getTime() + L.decisionDefaultHours * 3_600_000);
  if (closesAt && closesAt.getTime() <= now.getTime() + 60_000) throw invalid("Pick an end time in the future.");
  if (closesAt && closesAt.getTime() > now.getTime() + L.maxDays * 86_400_000) throw invalid(`Pick an end time within ${L.maxDays} days.`);
  let meetingId: string | null = null;
  if (input.meetingId) {
    const mt = await deps.db.select({ id: meetings.id }).from(meetings).where(and(eq(meetings.orgId, a.orgId), eq(meetings.id, input.meetingId))).get();
    if (!mt) throw notFound("Meeting");
    meetingId = mt.id;
  }
  const c = input.channelId ? await writableChannel(deps, a, input.channelId) : null;
  const id = sortableId("cpl", now.getTime());
  const messageId = c ? sortableId("chm", now.getTime()) : null;
  await deps.db.insert(chatPolls).values({
    id, orgId: a.orgId, channelId: c?.id ?? null, messageId, meetingId, kind: input.kind, question, options: JSON.stringify(options),
    multi: input.kind === "poll" && !!input.multi, anonymous: input.kind === "poll" && !!input.anonymous, closesAt,
    createdBy: userId, createdByName: displayName(a), createdAt: now, updatedAt: now,
  });
  if (c) {
    try {
      await postMessage(deps, a, c.id, { body: pollMessageBody(input.kind, question), topicId: input.topicId ?? null }, { id: messageId! });
    } catch (e) {
      await deps.db.delete(chatPolls).where(eq(chatPolls.id, id));
      throw e;
    }
  }
  return getPoll(deps, a, id);
}

async function closeIfDue(deps: Deps, p: PollRow): Promise<PollRow> {
  if (p.closedAt || !p.closesAt || p.closesAt.getTime() > deps.now().getTime()) return p;
  return finishPoll(deps, p, null);
}

/** Closes a poll once (the first caller wins), writes the outcome and posts it in the card's thread. */
async function finishPoll(deps: Deps, p: PollRow, by: SuiteActor | null): Promise<PollRow> {
  const now = deps.now();
  const votes = await deps.db.select().from(chatPollVotes).where(eq(chatPollVotes.pollId, p.id));
  const options = JSON.parse(p.options) as string[];
  let outcome: Record<string, unknown> = { voters: new Set(votes.map((v) => v.voter)).size };
  let line: string;
  if (p.kind === "decision") {
    const counts: Partial<Record<Stance, number>> = {};
    for (const v of votes) counts[v.choice as Stance] = (counts[v.choice as Stance] ?? 0) + 1;
    const r = decisionOutcome(counts);
    outcome = { ...outcome, ...r, counts };
    line = `Outcome: ${r.summary}`;
  } else if (p.kind === "poll") {
    const counts = options.map((_, i) => votes.filter((v) => v.choice === String(i)).length);
    const winners = pollWinners(options, counts);
    outcome = { ...outcome, counts, winners };
    line = winners.length ? `Poll closed. ${winners.length > 1 ? "Tied" : "Top choice"}: ${winners.join(", ")} (${Math.max(...counts)} of ${outcome.voters}).` : "Poll closed. No one voted.";
  } else if (p.kind === "cloud") {
    const top = tallyCloud(votes.map((v) => v.choice), 5);
    outcome = { ...outcome, top };
    line = top.length ? `Word cloud closed. Top words: ${top.map((t) => t.word).join(", ")}.` : "Word cloud closed. No words yet.";
  } else {
    const n = (await deps.db.select({ n: count() }).from(chatPollItems).where(eq(chatPollItems.pollId, p.id)).get())?.n ?? 0;
    outcome = { ...outcome, questions: n };
    line = `Questions closed with ${n} ${n === 1 ? "question" : "questions"}.`;
  }
  const res = await deps.db.update(chatPolls).set({ closedAt: now, outcome: JSON.stringify(outcome), updatedAt: now }).where(and(eq(chatPolls.id, p.id), isNull(chatPolls.closedAt))).returning({ id: chatPolls.id });
  if (res.length && p.messageId && p.channelId) {
    const poster: SuiteActor = by ?? ({ orgId: p.orgId, userId: p.createdBy ?? "", email: "", name: POLL_KIND_LABEL[p.kind as PollKind], system: true } as SuiteActor);
    try { await postMessage(deps, poster, p.channelId, { body: line, parentId: p.messageId }); } catch { /* the outcome stays on the card */ }
    await touchMessage(deps, p.orgId, p.messageId);
  }
  return pollRow(deps, p.orgId, p.id);
}

function present_(p: PollRow, viewer: string | null, votes: (typeof chatPollVotes.$inferSelect)[], items: (typeof chatPollItems.$inferSelect)[], now: Date, canManage: boolean, readOnly: boolean) {
  const options = JSON.parse(p.options) as string[];
  const voters = new Set(votes.map((v) => v.voter));
  const mine = viewer ? votes.filter((v) => v.voter === viewer).map((v) => v.choice) : [];
  const open = isOpenPoll(p, now);
  const base = {
    id: p.id, kind: p.kind as PollKind, question: p.question, options, multi: p.multi, anonymous: p.anonymous,
    channelId: p.channelId, messageId: p.messageId, meetingId: p.meetingId, createdByName: p.createdByName,
    closesAt: p.closesAt?.toISOString() ?? null, closedAt: p.closedAt?.toISOString() ?? null, open, outcome: p.outcome ? JSON.parse(p.outcome) : null,
    voters: voters.size, mine, canVote: open && !readOnly, canManage: canManage && !readOnly,
  };
  if (p.kind === "poll" || p.kind === "decision") {
    const choices = p.kind === "decision" ? options.map((s) => ({ key: s, label: STANCE_LABEL[s as Stance] })) : options.map((o, i) => ({ key: String(i), label: o }));
    const tally = choices.map((ch) => {
      const vs = votes.filter((v) => v.choice === ch.key);
      return { ...ch, count: vs.length, names: p.anonymous ? [] : vs.map((v) => v.voterName) };
    });
    const reasons = p.kind === "decision" ? votes.filter((v) => v.reason).map((v) => ({ name: v.voterName, stance: v.choice as Stance, reason: v.reason })) : [];
    const myReason = p.kind === "decision" && viewer ? votes.find((v) => v.voter === viewer)?.reason ?? "" : "";
    const live = p.kind === "decision" ? decisionOutcome(Object.fromEntries(tally.map((t) => [t.key, t.count]))) : null;
    return { ...base, tally, reasons, myReason, standing: live ? { result: live.result, label: DECISION_RESULT_LABEL[live.result] } : null };
  }
  if (p.kind === "cloud") return { ...base, cloud: tallyCloud(votes.map((v) => v.choice)) };
  const up = new Map<string, number>();
  for (const v of votes) up.set(v.choice, (up.get(v.choice) ?? 0) + 1);
  const questions = items.map((it) => ({
    id: it.id, body: it.body, authorName: it.authorName, votes: up.get(it.id) ?? 0, upvoted: mine.includes(it.id), mineQuestion: !!viewer && it.authorId === viewer,
    answered: !!it.answeredAt, createdAt: it.createdAt.toISOString(),
    /** R114: a webinar host hid it from attendees, or typed an answer. */
    hidden: !!it.hiddenAt, answer: it.answer ?? null,
  })).sort((x, y) => Number(x.answered) - Number(y.answered) || y.votes - x.votes || x.createdAt.localeCompare(y.createdAt));
  return { ...base, voters: new Set(items.map((i) => i.authorId)).size, questions };
}
export type PollView = ReturnType<typeof present_>;

async function presentPoll(deps: Deps, p: PollRow, viewer: string | null, canManage: boolean, readOnly: boolean) {
  const votes = await deps.db.select().from(chatPollVotes).where(eq(chatPollVotes.pollId, p.id));
  const items = p.kind === "qa" ? await deps.db.select().from(chatPollItems).where(eq(chatPollItems.pollId, p.id)).limit(L.items) : [];
  return present_(p, viewer, votes, items, deps.now(), canManage, readOnly);
}

export async function getPoll(deps: Deps, a: SuiteActor, id: string) {
  let p = await pollRow(deps, a.orgId, id);
  await pollAccess(deps, a, p, false);
  p = await closeIfDue(deps, p);
  const viewer = a.agentId || a.apiKeyId ? null : a.userId ?? null;
  return { poll: await presentPoll(deps, p, viewer, !!viewer && (p.createdBy === viewer || isAdmin(a)), !viewer) };
}

/** A guest sees results in a channel shared with them, read only. */
export async function guestPoll(deps: Deps, g: GuestViewer, id: string) {
  let p = await pollRow(deps, g.orgId, id);
  if (!p.channelId) throw notFound("Poll");
  await guestChannel(deps, g, p.channelId);
  p = await closeIfDue(deps, p);
  const view = await presentPoll(deps, p, null, false, true);
  return { poll: { ...view, ...("tally" in view ? { tally: view.tally.map((t) => ({ ...t, names: [] })), reasons: [] } : {}) } };
}

async function openForWrite(deps: Deps, a: SuiteActor, id: string) {
  let p = await pollRow(deps, a.orgId, id);
  await pollAccess(deps, a, p, true);
  p = await closeIfDue(deps, p);
  if (!isOpenPoll(p, deps.now())) throw new HttpError(409, "poll_closed", "This vote has closed.");
  return p;
}

/** Casts, changes or takes back a vote. An empty list takes it back. */
export async function vote(deps: Deps, a: SuiteActor, id: string, input: { choices: string[]; reason?: string }) {
  const userId = person(a);
  const p = await openForWrite(deps, a, id);
  const options = JSON.parse(p.options) as string[];
  let choices: string[];
  let reason = "";
  if (p.kind === "poll") {
    choices = [...new Set(input.choices)];
    if (choices.some((c) => !/^\d+$/.test(c) || Number(c) >= options.length)) throw invalid("Pick one of the poll's choices.");
    if (!p.multi && choices.length > 1) throw invalid("This poll takes one choice.");
  } else if (p.kind === "decision") {
    choices = [...new Set(input.choices)];
    if (choices.length > 1 || choices.some((c) => !(DECISION_STANCES as readonly string[]).includes(c))) throw invalid("Pick agree, abstain, disagree or block.");
    reason = (input.reason ?? "").trim().slice(0, L.reason);
    if (choices[0] === "block" && !reason) throw invalid("Say why you block, so the group can work it out.");
  } else if (p.kind === "cloud") {
    choices = cloudWords(input.choices);
    if (input.choices.join("").trim() && !choices.length) throw invalid("Use letters or numbers.");
  } else throw invalid("Add a question or upvote one instead.");
  const now = deps.now();
  await deps.db.delete(chatPollVotes).where(and(eq(chatPollVotes.pollId, p.id), eq(chatPollVotes.voter, userId)));
  if (choices.length) await deps.db.insert(chatPollVotes).values(choices.map((choice) => ({ pollId: p.id, voter: userId, choice, orgId: p.orgId, voterName: displayName(a), reason, createdAt: now })));
  await deps.db.update(chatPolls).set({ updatedAt: now }).where(eq(chatPolls.id, p.id));
  await touchMessage(deps, p.orgId, p.messageId);
  return getPoll(deps, a, p.id);
}

export async function addQuestion(deps: Deps, a: SuiteActor, id: string, body: string) {
  const userId = person(a);
  const p = await openForWrite(deps, a, id);
  if (p.kind !== "qa") throw invalid("Questions go in a Q&A.");
  const text = body.replace(/\s+/g, " ").trim().slice(0, L.item);
  if (!text) throw invalid("Write your question first.");
  const n = (await deps.db.select({ n: count() }).from(chatPollItems).where(eq(chatPollItems.pollId, p.id)).get())?.n ?? 0;
  if (n >= L.items) throw new HttpError(422, "too_many_questions", `This Q&A holds up to ${L.items} questions.`);
  const now = deps.now();
  await deps.db.insert(chatPollItems).values({ id: sortableId("cpq", now.getTime()), pollId: p.id, orgId: p.orgId, body: text, authorId: userId, authorName: displayName(a), createdAt: now });
  await touchMessage(deps, p.orgId, p.messageId);
  return getPoll(deps, a, p.id);
}

async function itemRow(deps: Deps, orgId: string, itemId: string) {
  const it = await deps.db.select().from(chatPollItems).where(and(eq(chatPollItems.orgId, orgId), eq(chatPollItems.id, itemId))).get();
  if (!it) throw notFound("Question");
  return it;
}

export async function toggleUpvote(deps: Deps, a: SuiteActor, itemId: string) {
  const userId = person(a);
  const it = await itemRow(deps, a.orgId, itemId);
  const p = await openForWrite(deps, a, it.pollId);
  if (it.authorId === userId) throw invalid("You can't upvote your own question.");
  if (it.answeredAt) throw new HttpError(409, "answered", "This question was answered.");
  const had = await deps.db.select({ v: chatPollVotes.voter }).from(chatPollVotes).where(and(eq(chatPollVotes.pollId, p.id), eq(chatPollVotes.voter, userId), eq(chatPollVotes.choice, it.id))).get();
  if (had) await deps.db.delete(chatPollVotes).where(and(eq(chatPollVotes.pollId, p.id), eq(chatPollVotes.voter, userId), eq(chatPollVotes.choice, it.id)));
  else await deps.db.insert(chatPollVotes).values({ pollId: p.id, voter: userId, choice: it.id, orgId: p.orgId, voterName: displayName(a), createdAt: deps.now() }).onConflictDoNothing();
  await touchMessage(deps, p.orgId, p.messageId);
  return getPoll(deps, a, p.id);
}

export async function markAnswered(deps: Deps, a: SuiteActor, itemId: string, answered: boolean) {
  const userId = person(a);
  const it = await itemRow(deps, a.orgId, itemId);
  const p = await pollRow(deps, a.orgId, it.pollId);
  await pollAccess(deps, a, p, true);
  if (p.createdBy !== userId && !isAdmin(a)) throw new HttpError(403, "forbidden", "Only the host of this Q&A or an admin can mark questions answered.");
  await deps.db.update(chatPollItems).set({ answeredAt: answered ? deps.now() : null }).where(eq(chatPollItems.id, it.id));
  await touchMessage(deps, p.orgId, p.messageId);
  return getPoll(deps, a, p.id);
}

export async function closePoll(deps: Deps, a: SuiteActor, id: string) {
  const userId = person(a);
  const p = await pollRow(deps, a.orgId, id);
  await pollAccess(deps, a, p, true);
  if (p.createdBy !== userId && !isAdmin(a)) throw new HttpError(403, "forbidden", "Only the person who started this or an admin can close it.");
  if (p.closedAt) return getPoll(deps, a, p.id);
  await finishPoll(deps, p, a);
  return getPoll(deps, a, p.id);
}

/** The polls and Q&A of a meeting, newest first, for the call panel. */
export async function meetingPolls(deps: Deps, a: SuiteActor, meetingId: string) {
  const viewer = person(a);
  const mt = await deps.db.select({ id: meetings.id }).from(meetings).where(and(eq(meetings.orgId, a.orgId), eq(meetings.id, meetingId))).get();
  if (!mt) throw notFound("Meeting");
  const rows = await deps.db.select().from(chatPolls).where(and(eq(chatPolls.orgId, a.orgId), eq(chatPolls.meetingId, mt.id))).orderBy(desc(chatPolls.createdAt)).limit(30);
  const out = [];
  for (let p of rows) {
    p = await closeIfDue(deps, p);
    out.push(await presentPoll(deps, p, viewer, p.createdBy === viewer || isAdmin(a), false));
  }
  return { polls: out };
}

