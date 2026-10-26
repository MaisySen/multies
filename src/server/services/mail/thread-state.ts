/**
 * Round 22 (R22.1 and R22.5): who owns a shared inbox thread, whether it is done, and reply times.
 * A thread is messages.thread_id within an org. Every call checks the caller can open the thread (at
 * least one of its messages is in a mailbox in their scope), else 404. Only threads someone touched get
 * a mail_thread_state row: an assign or a status change writes 1 row (WITHOUT ROWID) plus 1 entry in the
 * partial assignee index when the row is assigned. Reading views, My Work and stats writes nothing.
 */
import { and, desc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import type { Deps } from "../../context";
import { mailboxAccess, mailThreadState, members, messages, users } from "../../db/schema";
import { badRequest, notFound } from "../../lib/errors";
import { assertWritable, scopeOf, type SuiteActor } from "../suite/common";
import { notify } from "../suite/notify";

export const THREAD_STATUSES = ["open", "waiting", "done"] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];
export const THREAD_VIEWS = ["all", "open", "mine", "unassigned", "assigned", "waiting", "done"] as const;
export type ThreadView = (typeof THREAD_VIEWS)[number];

/** At most this many threads are scanned for one stats request; the answer says "sampled" when cut. */
export const STATS_THREAD_CAP = 2000;
export const STATS_MAX_DAYS = 90;
const DAY = 86_400_000;

export interface ThreadState {
  threadId: string;
  status: ThreadStatus;
  assignee: { id: string; name: string } | null;
  assignedAt: string | null;
  doneAt: string | null;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
/** The person behind the actor; agent inbox keys have none ("mine" is empty for them). */
export const viewerOf = (a: SuiteActor) => (a.agentId ? null : a.userId || null);

/** The thread's mailboxes and subject, after checking the caller can open it. */
async function openThread(deps: Deps, actor: SuiteActor, threadId: string) {
  const rows = await deps.db.select({ mailboxId: messages.mailboxId, subject: messages.subject, date: messages.date }).from(messages)
    .where(and(eq(messages.orgId, actor.orgId), eq(messages.threadId, threadId), sql`${messages.folder} not in ('trash', 'drafts')`))
    .orderBy(desc(messages.date)).limit(200);
  if (!rows.length) throw notFound("Thread");
  const scope = await scopeOf(deps, actor);
  const mailboxIds = [...new Set(rows.map((r) => r.mailboxId))];
  if (scope && !mailboxIds.some((m) => scope.includes(m))) throw notFound("Thread");
  return { mailboxIds, newestMailboxId: rows[0].mailboxId, subject: rows[rows.length - 1].subject };
}

async function stateRow(deps: Deps, orgId: string, threadId: string) {
  return deps.db.select().from(mailThreadState).where(and(eq(mailThreadState.orgId, orgId), eq(mailThreadState.threadId, threadId))).get();
}

async function present(deps: Deps, orgId: string, threadId: string): Promise<ThreadState> {
  return (await listThreadStates(deps, orgId, [threadId])).get(threadId) ?? { threadId, status: "open", assignee: null, assignedAt: null, doneAt: null };
}

/** States for a set of threads in one query (threads without a row are open and unassigned). */
export async function listThreadStates(deps: Deps, orgId: string, threadIds: string[]): Promise<Map<string, ThreadState>> {
  const out = new Map<string, ThreadState>();
  const ids = [...new Set(threadIds)];
  if (!ids.length) return out;
  // D1 binds at most 100 values a statement; a page of threads is 100 at most, but chunk to be safe.
  for (let i = 0; i < ids.length; i += 90) {
    const rows = await deps.db.select({ s: mailThreadState, name: users.name }).from(mailThreadState).leftJoin(users, eq(users.id, mailThreadState.assigneeUserId))
      .where(and(eq(mailThreadState.orgId, orgId), inArray(mailThreadState.threadId, ids.slice(i, i + 90))));
    for (const { s, name } of rows) {
      out.set(s.threadId, { threadId: s.threadId, status: s.status, assignee: s.assigneeUserId ? { id: s.assigneeUserId, name: name ?? "" } : null, assignedAt: iso(s.assignedAt), doneAt: iso(s.doneAt) });
    }
  }
  return out;
}

export async function getThreadState(deps: Deps, actor: SuiteActor, threadId: string) {
  await openThread(deps, actor, threadId);
  return present(deps, actor.orgId, threadId);
}

/** Can this workspace member open one of these mailboxes? Owners and admins open every mailbox. */
async function assertAssignable(deps: Deps, orgId: string, userId: string, mailboxIds: string[]) {
  const m = await deps.db.select({ role: members.role }).from(members).where(and(eq(members.organizationId, orgId), eq(members.userId, userId))).get();
  if (!m) throw badRequest("That person isn't in this workspace.");
  if (m.role !== "member") return;
  const grant = await deps.db.select({ id: mailboxAccess.mailboxId }).from(mailboxAccess)
    .where(and(eq(mailboxAccess.orgId, orgId), eq(mailboxAccess.userId, userId), inArray(mailboxAccess.mailboxId, mailboxIds))).limit(1).get();
  if (!grant) throw badRequest("That person can't open this thread's mailbox. Give them access to it first.");
}

/** People who can open the thread, for the Assign menu. */
export async function assignableMembers(deps: Deps, actor: SuiteActor, threadId: string) {
  const t = await openThread(deps, actor, threadId);
  const rows = await deps.db.select({ id: users.id, name: users.name, email: users.email, role: members.role, kind: members.kind }).from(members).innerJoin(users, eq(users.id, members.userId))
    .where(eq(members.organizationId, actor.orgId));
  const granted = new Set((await deps.db.select({ userId: mailboxAccess.userId }).from(mailboxAccess)
    .where(and(eq(mailboxAccess.orgId, actor.orgId), inArray(mailboxAccess.mailboxId, t.mailboxIds)))).map((r) => r.userId));
  return rows.filter((r) => r.role !== "member" || granted.has(r.id)).map((r) => ({ id: r.id, name: r.name, email: r.email, agent: r.kind === "agent" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Assigns a thread to a workspace member who can open it, or unassigns it (userId null). The assignee
 * hears about it through notify() unless they assigned themselves. Nothing is written when nothing changes.
 */
export async function assignThread(deps: Deps, actor: SuiteActor, threadId: string, userId: string | null) {
  assertWritable(actor);
  const t = await openThread(deps, actor, threadId);
  const cur = await stateRow(deps, actor.orgId, threadId);
  if ((cur?.assigneeUserId ?? null) === userId) return present(deps, actor.orgId, threadId);
  if (userId) await assertAssignable(deps, actor.orgId, userId, t.mailboxIds);
  const now = deps.now();
  const by = actor.agentId ? `agent:${actor.agentId}` : actor.userId || null;
  const set = { assigneeUserId: userId, assignedBy: userId ? by : null, assignedAt: userId ? now : null, updatedAt: now };
  if (cur) await deps.db.update(mailThreadState).set(set).where(and(eq(mailThreadState.orgId, actor.orgId), eq(mailThreadState.threadId, threadId)));
  else await deps.db.insert(mailThreadState).values({ orgId: actor.orgId, threadId, mailboxId: t.newestMailboxId, status: "open", ...set });
  if (userId && userId !== viewerOf(actor)) {
    await notify(deps, actor.orgId, userId, { type: "thread_assigned", entityType: "thread", entityId: threadId, title: `Assigned to you: ${t.subject || "(no subject)"}`, actorName: actor.name || null });
  }
  return present(deps, actor.orgId, threadId);
}

/**
 * Marks a thread done, waiting (we replied, the customer has the ball) or reopens it. Done and waiting
 * threads leave Mine, Unassigned and the open list; new inbound mail puts them back to open (thread-rules.ts).
 */
export async function setThreadStatus(deps: Deps, actor: SuiteActor, threadId: string, status: ThreadStatus) {
  assertWritable(actor);
  if (!(THREAD_STATUSES as readonly string[]).includes(status)) throw badRequest("Status is open, waiting or done.");
  const t = await openThread(deps, actor, threadId);
  const cur = await stateRow(deps, actor.orgId, threadId);
  if ((cur?.status ?? "open") === status) return present(deps, actor.orgId, threadId);
  const now = deps.now();
  const set = { status, doneAt: status === "done" ? now : null, updatedAt: now };
  if (cur) await deps.db.update(mailThreadState).set(set).where(and(eq(mailThreadState.orgId, actor.orgId), eq(mailThreadState.threadId, threadId)));
  else await deps.db.insert(mailThreadState).values({ orgId: actor.orgId, threadId, mailboxId: t.newestMailboxId, ...set });
  return present(deps, actor.orgId, threadId);
}

/**
 * The WHERE for a thread list view, against the thread id column of the grouped list. "all" and no view
 * filter nothing; open, mine, unassigned and assigned leave done and waiting threads out; done and waiting
 * show only their own status (waiting takes assignee too).
 */
export function threadViewCond(threadIdCol: SQL | unknown, orgId: string, view: ThreadView | undefined, viewer: string | null, assignee?: string | null): SQL | undefined {
  if (!view || view === "all") return undefined;
  const s = (extra: SQL) => sql`exists (select 1 from ${mailThreadState} s where s.org_id = ${orgId} and s.thread_id = ${threadIdCol} and ${extra})`;
  switch (view) {
    case "open": return sql`not ${s(sql`s.status in ('done', 'waiting')`)}`;
    case "waiting": return assignee ? s(sql`s.status = 'waiting' and s.assignee_user_id = ${assignee}`) : s(sql`s.status = 'waiting'`);
    case "done": return assignee ? s(sql`s.status = 'done' and s.assignee_user_id = ${assignee}`) : s(sql`s.status = 'done'`);
    case "mine": return viewer ? s(sql`s.status = 'open' and s.assignee_user_id = ${viewer}`) : sql`0`;
    case "assigned": return assignee ? s(sql`s.status = 'open' and s.assignee_user_id = ${assignee}`) : s(sql`s.status = 'open' and s.assignee_user_id is not null`);
    case "unassigned": return sql`not ${s(sql`(s.status in ('done', 'waiting') or s.assignee_user_id is not null)`)}`;
  }
}

/** My Work: open threads assigned to me that I can still open, newest message first, at most 20. Reads only. */
export async function myAssignedThreads(deps: Deps, actor: SuiteActor) {
  const me = viewerOf(actor);
  if (!me) return [];
  const rows = await deps.db.select({ threadId: mailThreadState.threadId }).from(mailThreadState)
    .where(and(eq(mailThreadState.orgId, actor.orgId), eq(mailThreadState.assigneeUserId, me), eq(mailThreadState.status, "open"), isNotNull(mailThreadState.assigneeUserId)))
    .orderBy(desc(mailThreadState.updatedAt)).limit(60);
  if (!rows.length) return [];
  const scope = await scopeOf(deps, actor);
  const msgs = await deps.db.select({ threadId: messages.threadId, subject: messages.subject, fromName: messages.fromName, fromAddress: messages.fromAddress, folder: messages.folder, date: messages.date }).from(messages)
    .where(and(eq(messages.orgId, actor.orgId), inArray(messages.threadId, rows.map((r) => r.threadId)), sql`${messages.folder} not in ('trash', 'drafts')`, scope ? inArray(messages.mailboxId, scope.length ? scope : ["-"]) : undefined))
    .orderBy(desc(messages.date)).limit(1000);
  const byThread = new Map<string, typeof msgs>();
  for (const m of msgs) byThread.set(m.threadId, [...(byThread.get(m.threadId) ?? []), m]);
  return [...byThread.entries()]
    .map(([id, ms]) => {
      const newest = ms[0];
      const first = ms[ms.length - 1];
      const other = ms.find((m) => m.folder !== "sent") ?? newest;
      return { id, title: first.subject || "(no subject)", subtitle: `From ${other.fromName || other.fromAddress}`, url: `/app/inbox?thread=${encodeURIComponent(id)}`, at: newest.date.toISOString() };
    })
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 20);
}

// ---------------------------------------------------------------- reply times (R22.5)

export interface ReplyStatsRow { key: string; label: string | null; type: "mailbox" | "person" | "agent" | "nobody"; threads: number; replied: number; medianFirstResponseMs: number | null; averageFirstResponseMs: number | null; resolved: number; medianResolutionMs: number | null; averageResolutionMs: number | null }

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}
const average = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

/**
 * Reply times, worked out on read. A thread counts when its first inbound message falls in the range.
 * First response: the first message we sent in the thread after that, credited to the person
 * (messages.sent_by_user_id) or the agent who wrote it. Resolution: the first inbound message to the
 * thread's done_at. Calendar hours, not business hours. At most STATS_THREAD_CAP threads, newest first.
 */
export async function replyStats(deps: Deps, actor: SuiteActor, q: { mailboxId?: string; from?: string | Date; to?: string | Date; groupBy?: "mailbox" | "person"; cap?: number }) {
  const to = q.to ? new Date(q.to) : deps.now();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * DAY);
  if (Number.isNaN(to.getTime()) || Number.isNaN(from.getTime())) throw badRequest("from and to are dates, like 2026-10-01.");
  if (from > to) throw badRequest("from comes before to.");
  if (to.getTime() - from.getTime() > STATS_MAX_DAYS * DAY + 1000) throw badRequest(`Pick a range of ${STATS_MAX_DAYS} days or less.`);
  const scope = await scopeOf(deps, actor);
  if (q.mailboxId && scope && !scope.includes(q.mailboxId)) throw notFound("Mailbox");
  const groupBy = q.groupBy ?? "mailbox";
  const cap = Math.min(Math.max(q.cap ?? STATS_THREAD_CAP, 1), STATS_THREAD_CAP);
  const empty = { from: from.toISOString(), to: to.toISOString(), groupBy, hours: "calendar" as const, sampled: false, threadsScanned: 0, rows: [] as ReplyStatsRow[], total: null as ReplyStatsRow | null };
  if (scope && !scope.length) return empty;
  const boxCond = q.mailboxId ? sql`and m.mailbox_id = ${q.mailboxId}` : scope ? sql`and m.mailbox_id in (${sql.join(scope.map((s) => sql`${s}`), sql`, `)})` : sql``;
  const rows = await deps.db.all<{ thread_id: string; mailbox_id: string; first_in: number; first_out: number | null; out_user: string | null; out_agent: string | null; done_at: number | null; status: string | null }>(sql`
    with firsts as (
      select m.thread_id, m.mailbox_id, min(m.date) as first_in from ${messages} m
      where m.org_id = ${actor.orgId} and m.folder not in ('sent', 'drafts', 'trash') and m.date <= ${to.getTime()} ${boxCond}
      group by m.thread_id having min(m.date) >= ${from.getTime()}
      order by first_in desc limit ${cap + 1}
    ), outs as (
      select f.thread_id, (select o.id from ${messages} o where o.org_id = ${actor.orgId} and o.thread_id = f.thread_id and o.folder = 'sent' and o.date >= f.first_in order by o.date asc limit 1) as out_id
      from firsts f
    )
    select f.thread_id, f.mailbox_id, f.first_in, o.date as first_out, o.sent_by_user_id as out_user, o.sent_by_agent_id as out_agent, s.done_at, s.status
    from firsts f join outs x on x.thread_id = f.thread_id
    left join ${messages} o on o.id = x.out_id
    left join ${mailThreadState} s on s.org_id = ${actor.orgId} and s.thread_id = f.thread_id
    order by f.first_in desc`);
  const sampled = rows.length > cap;
  const list = rows.slice(0, cap);
  const groups = new Map<string, { type: ReplyStatsRow["type"]; threads: number; firsts: number[]; resolutions: number[] }>();
  const all = { type: "mailbox" as ReplyStatsRow["type"], threads: 0, firsts: [] as number[], resolutions: [] as number[] };
  for (const r of list) {
    const firstMs = r.first_out != null ? Number(r.first_out) - Number(r.first_in) : null;
    const resMs = r.status === "done" && r.done_at != null ? Math.max(0, Number(r.done_at) - Number(r.first_in)) : null;
    // By person, a thread belongs to whoever replied first; unanswered threads go under "nobody yet".
    const key = groupBy === "mailbox" ? r.mailbox_id : r.out_user ? `person:${r.out_user}` : r.out_agent ? `agent:${r.out_agent}` : r.first_out != null ? "person:" : "nobody";
    const type: ReplyStatsRow["type"] = groupBy === "mailbox" ? "mailbox" : key.startsWith("agent:") ? "agent" : key === "nobody" ? "nobody" : "person";
    const g = groups.get(key) ?? { type, threads: 0, firsts: [], resolutions: [] };
    g.threads++; all.threads++;
    if (firstMs != null) { g.firsts.push(firstMs); all.firsts.push(firstMs); }
    if (resMs != null) { g.resolutions.push(resMs); all.resolutions.push(resMs); }
    groups.set(key, g);
  }
  const labels = await statLabels(deps, actor.orgId, [...groups.keys()], groupBy);
  const shape = (key: string, g: typeof all, label: string | null): ReplyStatsRow => ({
    key, label, type: g.type, threads: g.threads, replied: g.firsts.length, medianFirstResponseMs: median(g.firsts), averageFirstResponseMs: average(g.firsts),
    resolved: g.resolutions.length, medianResolutionMs: median(g.resolutions), averageResolutionMs: average(g.resolutions),
  });
  return {
    ...empty, sampled, threadsScanned: list.length,
    rows: [...groups.entries()].map(([k, g]) => shape(k, g, labels.get(k) ?? null)).sort((a, b) => b.threads - a.threads || (a.label ?? "").localeCompare(b.label ?? "")),
    total: list.length ? shape("all", all, "All") : null,
  };
}

async function statLabels(deps: Deps, orgId: string, keys: string[], groupBy: "mailbox" | "person") {
  const out = new Map<string, string>();
  const { agents, mailboxes } = await import("../../db/schema");
  if (groupBy === "mailbox") {
    for (let i = 0; i < keys.length; i += 90) {
      const rows = await deps.db.select({ id: mailboxes.id, address: mailboxes.address }).from(mailboxes).where(and(eq(mailboxes.orgId, orgId), inArray(mailboxes.id, keys.slice(i, i + 90))));
      for (const r of rows) out.set(r.id, r.address);
    }
    return out;
  }
  const people = keys.filter((k) => k.startsWith("person:") && k.length > 7).map((k) => k.slice(7));
  const bots = keys.filter((k) => k.startsWith("agent:")).map((k) => k.slice(6));
  if (people.length) for (const r of await deps.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, people.slice(0, 90)))) out.set(`person:${r.id}`, r.name);
  if (bots.length) for (const r of await deps.db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.orgId, orgId), inArray(agents.id, bots.slice(0, 90))))) out.set(`agent:${r.id}`, r.name);
  out.set("person:", "Team");
  out.set("nobody", "Not answered yet");
  return out;
}
