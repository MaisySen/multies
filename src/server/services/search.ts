/**
 * Search everything (round 20): one query across mail, tasks, docs, chat, contacts and deals,
 * and the "My Work" home (my tasks due today and overdue, mentions, threads on my tasks,
 * approvals waiting, today's meetings, snoozed mail coming back).
 *
 * Reads only. No full text index: an FTS table writes several rows per message and the account
 * has 100,000 D1 row writes a day. Each group is an indexed, org scoped LIKE query with its own
 * small LIMIT, newest first, and the whole search answers inside a time budget (groups that are
 * still running when it runs out are left out and the answer says partial).
 *
 * Permissions follow what the caller can already open:
 * - mail: only the mailboxes in the caller's scope (members their granted mailboxes, agent keys
 *   the agent's own inboxes);
 * - chat: public channels, plus private channels and DMs the person belongs to (API and agent
 *   keys see public channels only, as in the chat API);
 * - tasks, docs, contacts, deals: the caller's workspace, as in the suite API;
 * - a project guest: that project's tasks and docs, and its guest channels. Nothing else.
 */
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import type { Deps } from "../context";
import {
  chatChannels, chatMembers, chatMessages, contacts, deals, docs, messages, notifications, projects, sendApprovals, agents as agentsTable, tasks, users, organizations,
} from "../db/schema";
import { HttpError } from "../lib/errors";
import { scopeOf, type SuiteActor } from "./suite/common";
import { plainText } from "./suite/chat";
import { linkFor } from "./suite/notify";
import { dateFormat, dayInZone } from "../lib/intl-cache";
import { inIds } from "../lib/sql-chunks";

export const SEARCH_TYPES = ["mail", "tasks", "docs", "chat", "contacts", "deals"] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];
export const SEARCH_LABELS: Record<SearchType, string> = { mail: "Mail", tasks: "Tasks", docs: "Docs", chat: "Chat", contacts: "Contacts", deals: "Deals" };
export const SEARCH_MIN_CHARS = 2;
export const SEARCH_MAX_CHARS = 100;
export const SEARCH_DEFAULT_LIMIT = 5;
export const SEARCH_BUDGET_MS = 1_500;

export interface SearchItem {
  type: SearchType;
  id: string;
  title: string;
  /** A short second line: sender, task key and status, channel name, company... */
  subtitle: string;
  /** Text around the match, when the match is in a body. */
  snippet: string;
  /** Where the web app opens it. */
  url: string;
  at: string | null;
}
export interface SearchGroup { type: SearchType; label: string; items: SearchItem[] }
export interface SearchResult { query: string; groups: SearchGroup[]; tookMs: number; partial: boolean }

/** Who is searching: a person or a key (SuiteActor), or a project guest. */
export type SearchViewer = { kind: "actor"; actor: SuiteActor } | { kind: "guest"; orgId: string; projectId: string };

/** Escapes LIKE wildcards with "!" (used with ESCAPE '!'), so "50%" and "a_b" match literally. */
export function escapeLike(s: string) {
  return s.replace(/[!%_]/g, (ch) => `!${ch}`);
}

/** Cleans a query: trims, folds case, collapses spaces. Null when it is too short to search. */
export function normaliseQuery(q: string | null | undefined): string | null {
  const s = (q ?? "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, SEARCH_MAX_CHARS);
  return s.length >= SEARCH_MIN_CHARS ? s : null;
}

const contains = (term: string) => `%${escapeLike(term)}%`;
const likeAny = (cols: SQL[], pattern: string) => or(...cols.map((c) => sql`lower(${c}) like ${pattern} escape '!'`))!;
const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const isKey = (a: SuiteActor) => !!(a.agentId || a.apiKeyId);

/** About `width` characters of text around the first match, on word boundaries where it can. */
export function excerpt(text: string, term: string, width = 140) {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  const i = t.toLowerCase().indexOf(term);
  if (i < 0 || t.length <= width) return t.slice(0, width);
  let start = Math.max(0, i - Math.floor(width / 3));
  if (start > 0) { const sp = t.indexOf(" ", start); if (sp > 0 && sp < i) start = sp + 1; }
  const end = Math.min(t.length, start + width);
  return `${start > 0 ? "..." : ""}${t.slice(start, end)}${end < t.length ? "..." : ""}`;
}

/** A task key such as OPS-12. */
const TASK_KEY = /^([a-z0-9]{1,6})-(\d+)$/i;

// ---------------------------------------------------------------- sources

async function searchMail(deps: Deps, actor: SuiteActor, term: string, limit: number): Promise<SearchItem[]> {
  const scope = await scopeOf(deps, actor);
  if (scope && !scope.length) return [];
  const pattern = contains(term);
  const rows = await deps.db.select({
    id: messages.id, threadId: messages.threadId, mailboxId: messages.mailboxId, folder: messages.folder, subject: messages.subject,
    fromName: messages.fromName, fromAddress: messages.fromAddress, snippet: messages.snippet, date: messages.date,
  }).from(messages)
    .where(and(eq(messages.orgId, actor.orgId), scope ? inIds(messages.mailboxId, scope) : undefined, ne(messages.folder, "trash"),
      likeAny([sql`${messages.subject}`, sql`${messages.fromName}`, sql`${messages.fromAddress}`, sql`${messages.snippet}`], pattern)))
    .orderBy(desc(messages.date)).limit(limit * 3);
  // One result per thread: the newest message that matched.
  const seen = new Set<string>();
  const out: SearchItem[] = [];
  for (const m of rows) {
    if (seen.has(m.threadId)) continue;
    seen.add(m.threadId);
    out.push({
      type: "mail", id: m.id, title: m.subject || "(no subject)", subtitle: m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress,
      snippet: m.snippet.slice(0, 160), url: `/app/mail?mailbox=${encodeURIComponent(m.mailboxId)}&folder=${encodeURIComponent(m.folder)}&m=${encodeURIComponent(m.id)}`, at: iso(m.date),
    });
    if (out.length >= limit) break;
  }
  return out;
}

const STATUS_LABEL = { todo: "To do", doing: "In progress", done: "Done" } as const;

async function searchTasks(deps: Deps, orgId: string, term: string, limit: number, projectId?: string): Promise<SearchItem[]> {
  const key = TASK_KEY.exec(term);
  const cols = { id: tasks.id, title: tasks.title, notes: tasks.notes, number: tasks.number, status: tasks.status, projectId: tasks.projectId, updatedAt: tasks.updatedAt, key: projects.key, projectName: projects.name };
  const base = and(eq(tasks.orgId, orgId), isNull(tasks.deletedAt), isNull(tasks.triageState), projectId ? eq(tasks.projectId, projectId) : undefined);
  const exact = key
    ? await deps.db.select(cols).from(tasks).innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(and(base, eq(projects.orgId, orgId), sql`upper(${projects.key}) = ${key[1].toUpperCase()}`, eq(tasks.number, Number(key[2])))).limit(1)
    : [];
  const pattern = contains(term);
  const rows = await deps.db.select(cols).from(tasks).innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(base, likeAny([sql`${tasks.title}`, sql`${tasks.notes}`], pattern)))
    .orderBy(desc(tasks.updatedAt)).limit(limit);
  const all = [...exact, ...rows.filter((r) => !exact.some((e) => e.id === r.id))].slice(0, limit);
  return all.map((t) => ({
    type: "tasks" as const, id: t.id, title: t.title, subtitle: `${t.key}-${t.number} · ${STATUS_LABEL[t.status]} · ${t.projectName}`,
    snippet: t.title.toLowerCase().includes(term) ? "" : excerpt(t.notes, term), url: `/app/tasks?project=${encodeURIComponent(t.projectId)}&task=${encodeURIComponent(t.id)}`, at: iso(t.updatedAt),
  }));
}

async function searchDocs(deps: Deps, orgId: string, term: string, limit: number, projectId?: string): Promise<SearchItem[]> {
  const pattern = contains(term);
  const rows = await deps.db.select({ id: docs.id, title: docs.title, plainText: docs.plainText, updatedAt: docs.updatedAt }).from(docs)
    .where(and(eq(docs.orgId, orgId), isNull(docs.deletedAt), projectId ? eq(docs.projectId, projectId) : undefined, likeAny([sql`${docs.title}`, sql`${docs.plainText}`], pattern)))
    .orderBy(desc(docs.updatedAt)).limit(limit);
  return rows.map((d) => ({
    type: "docs" as const, id: d.id, title: d.title || "Untitled", subtitle: "Doc", snippet: excerpt(d.plainText, term), url: `/app/docs/${encodeURIComponent(d.id)}`, at: iso(d.updatedAt),
  }));
}

/** The channels this viewer can read: public ones, plus private channels and DMs a person belongs to. Keys: public only. */
export async function readableChannels(deps: Deps, v: SearchViewer) {
  if (v.kind === "guest") {
    return deps.db.select({ id: chatChannels.id, name: chatChannels.name, kind: chatChannels.kind }).from(chatChannels)
      .where(and(eq(chatChannels.orgId, v.orgId), eq(chatChannels.projectId, v.projectId), eq(chatChannels.guestAccess, true), eq(chatChannels.isPrivate, false), eq(chatChannels.kind, "channel"), isNull(chatChannels.deletedAt)));
  }
  const a = v.actor;
  const viewer = isKey(a) || !a.userId ? null : a.userId;
  const mine = viewer ? (await deps.db.select({ id: chatMembers.channelId }).from(chatMembers).where(and(eq(chatMembers.userId, viewer), eq(chatMembers.orgId, a.orgId)))).map((r) => r.id) : [];
  const visible = or(and(eq(chatChannels.kind, "channel"), eq(chatChannels.isPrivate, false)), mine.length ? inIds(chatChannels.id, mine) : sql`0`);
  return deps.db.select({ id: chatChannels.id, name: chatChannels.name, kind: chatChannels.kind }).from(chatChannels)
    .where(and(eq(chatChannels.orgId, a.orgId), isNull(chatChannels.deletedAt), visible));
}

async function searchChat(deps: Deps, v: SearchViewer, term: string, limit: number): Promise<SearchItem[]> {
  const channels = await readableChannels(deps, v);
  if (!channels.length) return [];
  const byId = new Map(channels.map((c) => [c.id, c]));
  const orgId = v.kind === "guest" ? v.orgId : v.actor.orgId;
  const rows = await deps.db.select({
    id: chatMessages.id, channelId: chatMessages.channelId, parentId: chatMessages.parentId, authorName: chatMessages.authorName, body: chatMessages.body,
    mentions: chatMessages.mentions, links: chatMessages.links, createdAt: chatMessages.createdAt,
  }).from(chatMessages)
    .where(and(eq(chatMessages.orgId, orgId), inIds(chatMessages.channelId, [...byId.keys()]), isNull(chatMessages.deletedAt), likeAny([sql`${chatMessages.body}`], contains(term))))
    .orderBy(desc(chatMessages.createdAt)).limit(limit);
  return rows.map((m) => {
    const c = byId.get(m.channelId)!;
    let text = m.body;
    try { text = plainText(m.body, JSON.parse(m.mentions), JSON.parse(m.links)); } catch { /* raw body */ }
    const where = c.kind === "dm" ? "Direct message" : `#${c.name}`;
    const url = v.kind === "guest" ? `/guest?channel=${encodeURIComponent(c.id)}` : `/app/chat/${encodeURIComponent(c.id)}?thread=${encodeURIComponent(m.parentId ?? m.id)}`;
    return { type: "chat" as const, id: m.id, title: excerpt(text, term, 120), subtitle: `${m.authorName || "Someone"} in ${where}`, snippet: "", url, at: iso(m.createdAt) };
  });
}

async function searchContacts(deps: Deps, orgId: string, term: string, limit: number): Promise<SearchItem[]> {
  const pattern = contains(term);
  const rows = await deps.db.select({ id: contacts.id, name: contacts.name, email: contacts.email, title: contacts.title, lastContactAt: contacts.lastContactAt, updatedAt: contacts.updatedAt }).from(contacts)
    .where(and(eq(contacts.orgId, orgId), isNull(contacts.deletedAt), likeAny([sql`${contacts.name}`, sql`${contacts.email}`], pattern)))
    .orderBy(sql`coalesce(${contacts.lastContactAt}, ${contacts.updatedAt}) desc`).limit(limit);
  return rows.map((c) => ({
    type: "contacts" as const, id: c.id, title: c.name || c.email, subtitle: [c.name ? c.email : "", c.title ?? ""].filter(Boolean).join(" · "), snippet: "",
    url: `/app/contacts/${encodeURIComponent(c.id)}`, at: iso(c.lastContactAt ?? c.updatedAt),
  }));
}

const STAGE_LABEL = { lead: "Lead", qualified: "Qualified", proposal: "Proposal", won: "Won", lost: "Lost" } as const;

async function searchDeals(deps: Deps, orgId: string, term: string, limit: number): Promise<SearchItem[]> {
  const rows = await deps.db.select({ id: deals.id, title: deals.title, stage: deals.stage, valueCents: deals.valueCents, updatedAt: deals.updatedAt }).from(deals)
    .where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt), likeAny([sql`${deals.title}`], contains(term))))
    .orderBy(desc(deals.updatedAt)).limit(limit);
  return rows.map((d) => ({
    type: "deals" as const, id: d.id, title: d.title, subtitle: `${STAGE_LABEL[d.stage]} · ${(d.valueCents / 100).toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 })}`,
    snippet: "", url: `/app/deals?deal=${encodeURIComponent(d.id)}`, at: iso(d.updatedAt),
  }));
}

/** Parses a "types" list ("tasks,docs"). Unknown names are a 422; empty means every type. */
export function parseTypes(raw: string | string[] | null | undefined): SearchType[] {
  const list = (Array.isArray(raw) ? raw : (raw ?? "").split(",")).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return [...SEARCH_TYPES];
  const bad = list.filter((t) => !(SEARCH_TYPES as readonly string[]).includes(t));
  if (bad.length) throw new HttpError(422, "validation_failed", `Unknown type: ${bad.join(", ")}. Use ${SEARCH_TYPES.join(", ")}.`);
  return [...new Set(list)] as SearchType[];
}

/**
 * Searches every source the viewer can open, in parallel, each with its own LIMIT. Answers within
 * `budgetMs`: sources still running then are left out and `partial` is true. A source that fails
 * (a table this database does not have yet) is skipped, so one bad source never empties the rest.
 */
export async function searchEverything(deps: Deps, v: SearchViewer, rawQuery: string, opts: { types?: SearchType[]; limit?: number; budgetMs?: number } = {}): Promise<SearchResult> {
  const started = Date.now();
  const term = normaliseQuery(rawQuery);
  if (!term) throw new HttpError(422, "validation_failed", `Type at least ${SEARCH_MIN_CHARS} characters to search.`);
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? SEARCH_DEFAULT_LIMIT), 1), 20);
  // Groups always come back in the same order (mail, tasks, docs, chat, contacts, deals).
  let types = opts.types?.length ? SEARCH_TYPES.filter((t) => opts.types!.includes(t)) : [...SEARCH_TYPES];
  // A guest sees one project's tasks, docs and guest channels. Nothing else.
  if (v.kind === "guest") types = types.filter((t) => t === "tasks" || t === "docs" || t === "chat");
  const run = (t: SearchType): Promise<SearchItem[]> => {
    if (v.kind === "guest") {
      if (t === "tasks") return searchTasks(deps, v.orgId, term, limit, v.projectId);
      if (t === "docs") return searchDocs(deps, v.orgId, term, limit, v.projectId);
      return searchChat(deps, v, term, limit);
    }
    const a = v.actor;
    switch (t) {
      case "mail": return searchMail(deps, a, term, limit);
      case "tasks": return searchTasks(deps, a.orgId, term, limit);
      case "docs": return searchDocs(deps, a.orgId, term, limit);
      case "chat": return searchChat(deps, v, term, limit);
      case "contacts": return searchContacts(deps, a.orgId, term, limit);
      case "deals": return searchDeals(deps, a.orgId, term, limit);
    }
  };
  const done = new Map<SearchType, SearchItem[]>();
  const all = Promise.all(types.map((t) => run(t).then((items) => { done.set(t, items); }, (err) => { deps.reportError?.(err, { where: "search", type: t }); done.set(t, []); })));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), opts.budgetMs ?? SEARCH_BUDGET_MS); });
  const outcome = await Promise.race([all.then(() => "done" as const), timeout]);
  if (timer) clearTimeout(timer);
  const groups = types.filter((t) => done.has(t)).map((t) => ({ type: t, label: SEARCH_LABELS[t], items: done.get(t)! })).filter((g) => g.items.length > 0);
  return { query: term, groups, tookMs: Date.now() - started, partial: outcome === "timeout" };
}

// ---------------------------------------------------------------- My Work

export interface MyWorkItem { id: string; title: string; subtitle: string; url: string; at: string | null }
export interface MyWork {
  date: string;
  timeZone: string;
  overdue: MyWorkItem[];
  dueToday: MyWorkItem[];
  mentions: MyWorkItem[];
  threads: MyWorkItem[];
  /** Round 22: open shared inbox threads assigned to me, newest first, at most 20. */
  assignedThreads: MyWorkItem[];
  approvals: MyWorkItem[];
  meetings: MyWorkItem[];
  /** Snoozed mail coming back today. Null when this server has no snooze source (the page hides the section). */
  snoozed: MyWorkItem[] | null;
  tookMs: number;
}

/**
 * Where snoozed mail comes from. Snooze lands in a parallel build (a mail_schedules table); until it
 * is wired in, there is no provider and My Work leaves the section out. A provider that throws (the
 * table is not there yet) is treated the same way.
 */
export type SnoozedProvider = (deps: Deps, actor: SuiteActor, window: { from: Date; to: Date }) => Promise<MyWorkItem[]>;
let snoozedProvider: SnoozedProvider | null = null;
export function setSnoozedProvider(p: SnoozedProvider | null) { snoozedProvider = p; }

/** True when the database has this table (D1 and SQLite both keep sqlite_master). */
export async function tableExists(deps: Deps, name: string) {
  const row = await deps.db.get<{ n: number }>(sql`select count(*) as n from sqlite_master where type = 'table' and name = ${name}`);
  return Number(row?.n ?? 0) > 0;
}

/** The calendar day (YYYY-MM-DD) of a moment in a time zone. */
export function dayIn(d: Date, timeZone: string) {
  return dayInZone(d, timeZone); // R25: one cached formatter per zone
}
/** A due date stored as a plain date is midnight UTC: its day is the UTC date, whatever the zone. */
const dueDay = (d: Date, timeZone: string) => (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 ? d.toISOString().slice(0, 10) : dayIn(d, timeZone));

function validZone(tz: string | null | undefined) {
  if (!tz) return null;
  try { dateFormat("en", { timeZone: tz }); return tz; } catch { return null; }
}

async function zoneOf(deps: Deps, actor: SuiteActor, tz?: string | null) {
  const given = validZone(tz);
  if (given) return given;
  const [u, o] = await Promise.all([
    actor.userId ? deps.db.select({ tz: users.timezone }).from(users).where(eq(users.id, actor.userId)).get() : Promise.resolve(undefined),
    deps.db.select({ tz: organizations.timezone }).from(organizations).where(eq(organizations.id, actor.orgId)).get(),
  ]);
  return validZone(u?.tz) ?? validZone(o?.tz) ?? "UTC";
}

/**
 * Everything waiting on this person today. For an agent key, "me" is the agent: its tasks and its
 * own approvals. Keys never see mentions (they can carry private channel names).
 */
export async function myWork(deps: Deps, actor: SuiteActor, opts: { timeZone?: string | null; snoozed?: SnoozedProvider | null } = {}): Promise<MyWork> {
  const started = Date.now();
  const now = deps.now();
  const timeZone = await zoneOf(deps, actor, opts.timeZone);
  const today = dayIn(now, timeZone);
  const me = actor.agentId ? { type: "agent" as const, id: actor.agentId } : actor.userId ? { type: "member" as const, id: actor.userId } : null;
  // Wide enough to hold the end of today in any zone; the exact day is checked per task below.
  const horizon = new Date(now.getTime() + 2 * 86_400_000);

  const dueTasks = async () => {
    if (!me) return [];
    return deps.db.select({ id: tasks.id, title: tasks.title, number: tasks.number, dueAt: tasks.dueAt, projectId: tasks.projectId, key: projects.key, priority: tasks.priority, threadId: tasks.threadId })
      .from(tasks).innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(and(eq(tasks.orgId, actor.orgId), isNotNull(tasks.dueAt), lt(tasks.dueAt, horizon), ne(tasks.status, "done"), isNull(tasks.deletedAt), isNull(tasks.triageState),
        eq(tasks.assigneeType, me.type), eq(tasks.assigneeId, me.id)))
      .orderBy(asc(tasks.dueAt)).limit(200);
  };

  const threadTasks = async () => {
    if (!me) return [];
    const scope = await scopeOf(deps, actor);
    const rows = await deps.db.select({ id: tasks.id, title: tasks.title, threadId: tasks.threadId, messageId: tasks.messageId, sourceFrom: tasks.sourceFrom, sourceSubject: tasks.sourceSubject, updatedAt: tasks.updatedAt })
      .from(tasks).where(and(eq(tasks.orgId, actor.orgId), isNotNull(tasks.threadId), ne(tasks.status, "done"), isNull(tasks.deletedAt), isNull(tasks.triageState), eq(tasks.assigneeType, me.type), eq(tasks.assigneeId, me.id)))
      .orderBy(desc(tasks.updatedAt)).limit(20);
    if (!rows.length) return [];
    // Only threads in mailboxes this person can open; the link opens the newest message.
    const msgs = await deps.db.select({ id: messages.id, threadId: messages.threadId, mailboxId: messages.mailboxId, folder: messages.folder, date: messages.date }).from(messages)
      .where(and(eq(messages.orgId, actor.orgId), inIds(messages.threadId, rows.map((r) => r.threadId!)), scope ? inIds(messages.mailboxId, scope) : undefined))
      .orderBy(desc(messages.date)).limit(200);
    const newest = new Map<string, (typeof msgs)[number]>();
    for (const m of msgs) if (!newest.has(m.threadId)) newest.set(m.threadId, m);
    return rows.filter((r) => newest.has(r.threadId!)).slice(0, 10).map((r) => {
      const m = newest.get(r.threadId!)!;
      return { id: r.threadId!, title: r.sourceSubject || r.title, subtitle: r.sourceFrom ? `From ${r.sourceFrom}` : "On your task", url: `/app/mail?mailbox=${encodeURIComponent(m.mailboxId)}&folder=${encodeURIComponent(m.folder)}&m=${encodeURIComponent(m.id)}`, at: iso(m.date) };
    });
  };

  const mentions = async (): Promise<MyWorkItem[]> => {
    if (!actor.userId || isKey(actor)) return [];
    const since = new Date(now.getTime() - 14 * 86_400_000);
    const rows = await deps.db.select().from(notifications)
      .where(and(eq(notifications.userId, actor.userId), eq(notifications.orgId, actor.orgId), inArray(notifications.type, ["chat.mention", "task.mentioned"]), gte(notifications.createdAt, since)))
      .orderBy(desc(notifications.createdAt)).limit(10);
    const chatIds = rows.filter((r) => r.entityType === "chat_message").map((r) => r.entityId);
    const channelOf = new Map<string, string>();
    if (chatIds.length) {
      const ms = await deps.db.select({ id: chatMessages.id, channelId: chatMessages.channelId }).from(chatMessages).where(and(eq(chatMessages.orgId, actor.orgId), inIds(chatMessages.id, chatIds)));
      for (const m of ms) channelOf.set(m.id, m.channelId);
    }
    return rows.map((r) => ({ id: r.id, title: r.title, subtitle: r.readAt ? "Read" : "Unread", url: linkFor(r, channelOf.get(r.entityId)), at: iso(r.createdAt) }));
  };

  const approvals = async (): Promise<MyWorkItem[]> => {
    const scope = await scopeOf(deps, actor);
    if (scope && !scope.length && !actor.agentId) return [];
    const rows = await deps.db.select({ a: sendApprovals, agentName: agentsTable.name }).from(sendApprovals).leftJoin(agentsTable, eq(agentsTable.id, sendApprovals.agentId))
      .where(and(eq(sendApprovals.orgId, actor.orgId), eq(sendApprovals.status, "pending"), gt(sendApprovals.expiresAt, now),
        actor.agentId ? eq(sendApprovals.agentId, actor.agentId) : scope ? inIds(sendApprovals.mailboxId, scope) : undefined))
      .orderBy(desc(sendApprovals.createdAt)).limit(10);
    return rows.map(({ a, agentName }) => {
      let subject = "";
      let to: string[] = [];
      try { const p = JSON.parse(a.payload) as { subject?: string; to?: string[] }; subject = p.subject ?? ""; to = p.to ?? []; } catch { /* keep blanks */ }
      return { id: a.id, title: subject || "(no subject)", subtitle: `${agentName ?? "An agent"} wants to send to ${to.slice(0, 2).join(", ") || "someone"}${to.length > 2 ? ` and ${to.length - 2} more` : ""}`, url: "/app/approvals", at: iso(a.createdAt) };
    });
  };

  const meetingsToday = async (): Promise<MyWorkItem[]> => {
    const { listMeetings } = await import("./suite/meetings");
    const list = await listMeetings(deps, actor, { upcoming: true, limit: 200 });
    return list.filter((m) => m.status !== "cancelled" && dayIn(new Date(m.startsAt), timeZone) === today)
      .sort((x, y) => x.startsAt.localeCompare(y.startsAt))
      .slice(0, 20)
      .map((m) => {
        const time = dateFormat("en-AU", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(m.startsAt));
        return { id: m.id, title: m.title, subtitle: `${time}, ${m.durationMin} min`, url: `/app/meetings/${encodeURIComponent(m.id.split(":")[0])}`, at: m.startsAt };
      });
  };

  const snoozed = async (): Promise<MyWorkItem[] | null> => {
    const provider = opts.snoozed === undefined ? snoozedProvider : opts.snoozed;
    if (!provider) return null;
    const from = new Date(now.getTime() - 86_400_000);
    try { return await provider(deps, actor, { from, to: horizon }); } catch (err) {
      deps.reportError?.(err, { where: "my_work.snoozed" });
      return null;
    }
  };

  const assignedP = import("./mail/thread-state").then((m) => m.myAssignedThreads(deps, actor));
  const [due, threads, ment, appr, meets, snz] = await Promise.all([dueTasks(), threadTasks(), mentions(), approvals(), meetingsToday(), snoozed()]);
  const assignedThreads = await assignedP;
  const asItem = (t: (typeof due)[number]): MyWorkItem => ({
    id: t.id, title: t.title, subtitle: `${t.key}-${t.number}${t.priority !== "none" ? ` · ${t.priority[0].toUpperCase()}${t.priority.slice(1)} priority` : ""}`,
    url: `/app/tasks?project=${encodeURIComponent(t.projectId)}&task=${encodeURIComponent(t.id)}`, at: iso(t.dueAt),
  });
  const overdue = due.filter((t) => dueDay(t.dueAt!, timeZone) < today).map(asItem);
  const dueToday = due.filter((t) => dueDay(t.dueAt!, timeZone) === today).map(asItem);
  return { date: today, timeZone, overdue, dueToday, mentions: ment, threads, assignedThreads, approvals: appr, meetings: meets, snoozed: snz, tookMs: Date.now() - started };
}
