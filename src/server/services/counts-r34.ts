/**
 * R34: one cheap read of every unread count the person sees (web sidebar and tab badges, the document title, the
 * phone app's badge). Read-only: zero writes. Each part is one indexed count (see the EXPLAIN QUERY PLAN test in
 * tests/counts-r34.test.ts), so the whole answer is six small reads. The routes add a short private cache and an
 * ETag over the body so a poll that changed nothing is a 304 with no body.
 *
 * Shape (stable; the phone app reads it):
 *   { mail: { inbox, important, other }, chat: { unread, mentions }, notifications: { unread }, triage,
 *     tasks: { dueToday, overdue }, at }
 */
import { and, count, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import type { Deps } from "../context";
import { mailboxAccess, messages, notifications, tasks } from "../db/schema";
import { IsolateCache } from "../lib/isolate-cache";
import { snoozeHiddenCond } from "./mail/schedules";
import { listSplits, splitCountParts } from "./mail/splits";
import { unreadQuery } from "./suite/chat";
import type { SuiteActor } from "./suite/common";
import { DEFAULT_SNOOZE_ZONE, inboxWhere } from "./suite/notify-triage";
import { triageCountQuery } from "./suite/triage";
import type { MailSplit } from "@/shared/mail-splits";

export interface Counts {
  mail: { inbox: number; important: number; other: number };
  chat: { unread: number; mentions: number };
  notifications: { unread: number };
  triage: number;
  tasks: { dueToday: number; overdue: number };
  at: string;
}

export const EMPTY_COUNTS = (at: Date): Counts => ({
  mail: { inbox: 0, important: 0, other: 0 }, chat: { unread: 0, mentions: 0 }, notifications: { unread: 0 }, triage: 0,
  tasks: { dueToday: 0, overdue: 0 }, at: at.toISOString(),
});

// R40 (MB-199): an Intl.DateTimeFormat costs real CPU to build, and counts are polled every 15 s, so each zone's
// formatter is built once per isolate (a zone that fails to build is remembered as invalid).
const dayFormats = new Map<string, Intl.DateTimeFormat | null>();
function dayFormat(tz: string): Intl.DateTimeFormat | null {
  let f = dayFormats.get(tz);
  if (f === undefined) {
    try { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); } catch { f = null; }
    if (dayFormats.size >= 500) dayFormats.clear();
    dayFormats.set(tz, f);
  }
  return f;
}

/** A valid IANA zone, or the default (UTC+10). */
export function zoneOr(tz: string | undefined | null): string {
  if (!tz) return DEFAULT_SNOOZE_ZONE;
  return dayFormat(tz) ? tz : DEFAULT_SNOOZE_ZONE;
}

/** The instant the person's local day (in `tz`) started and the instant it ends. */
export function localDay(now: Date, tz: string): { start: Date; end: Date } {
  const parts = Object.fromEntries((dayFormat(tz) ?? (dayFormat(DEFAULT_SNOOZE_ZONE) as Intl.DateTimeFormat))
    .formatToParts(now).filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)]));
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  const offset = asUtc - Math.floor(now.getTime() / 1000) * 1000; // local minus UTC
  const start = Date.UTC(parts.year, parts.month - 1, parts.day) - offset;
  return { start: new Date(start), end: new Date(start + 86_400_000) };
}

/*
 * R41 (MB-199 CPU): every count in ONE statement. Each D1 query costs the Worker about 1 to 2 ms of its 10 ms CPU
 * budget (the round trip itself is free), and this route is polled by every open tab, so the parts that used to be
 * six to eight queries are scalar subqueries of one aggregate over the person's unread inbox mail. A member's
 * mailbox scope is a subquery too. Only the person's own mail tabs (their split rules) are read first, from a
 * short per isolate copy.
 */
const splitsCopy = new IsolateCache<MailSplit[]>(60_000);

/** Every count for the caller. An agent key has no inbox, chat or notifications: those parts are 0. */
export async function getCounts(deps: Deps, a: SuiteActor, opts: { tz?: string | null } = {}): Promise<Counts> {
  const now = deps.now();
  const out = EMPTY_COUNTS(now);
  const person = !a.agentId && !!a.userId;
  const day = localDay(now, zoneOr(opts.tz));
  const mine = a.agentId ? and(eq(tasks.assigneeType, "agent"), eq(tasks.assigneeId, a.agentId)) : and(eq(tasks.assigneeType, "member"), eq(tasks.assigneeId, a.userId));
  const open = and(eq(tasks.orgId, a.orgId), mine, isNull(tasks.deletedAt), ne(tasks.status, "done"), isNull(tasks.triageState), lt(tasks.dueAt, day.end));
  const nowParam = sql.param(now, tasks.dueAt);
  const dueToday = deps.db.select({ n: sql<number>`count(*)` }).from(tasks).where(and(open, sql`${tasks.dueAt} >= ${nowParam}`));
  const overdue = deps.db.select({ n: sql<number>`count(*)` }).from(tasks).where(and(open, sql`${tasks.dueAt} < ${nowParam}`));
  const triage = triageCountQuery(deps, a);

  if (!person) {
    const r = await deps.db.get<{ due_today: number; overdue: number; triage: number }>(
      sql`select (${dueToday}) as due_today, (${overdue}) as overdue, (${triage}) as triage`);
    out.tasks = { dueToday: Number(r?.due_today ?? 0), overdue: Number(r?.overdue ?? 0) };
    out.triage = Number(r?.triage ?? 0);
    return out;
  }

  // R61a kill switch (MAIL_SPLIT_COUNTS=off): Important and Other read 0 and their rule is not evaluated at all.
  const splitsOn = deps.config.mailSplitCounts;
  const list = splitsOn ? await splitsCopy.getOr(`${a.userId}:${a.orgId}`, () => listSplits(deps, { orgId: a.orgId, userId: a.userId })) : [];
  // R59 hotfix: the Important rule is evaluated once per row; Other is "not claimed" minus Important.
  const { important, notClaimed } = splitCountParts(a.orgId, list);
  // Owners and admins see every mailbox; a member only the ones granted (a subquery, not a separate read).
  const scope = (a.role ?? "member") === "member"
    ? inArray(messages.mailboxId, deps.db.select({ id: mailboxAccess.mailboxId }).from(mailboxAccess).where(and(eq(mailboxAccess.userId, a.userId), eq(mailboxAccess.orgId, a.orgId)))) // D1: a subquery, not a bound list
    : undefined;
  const unread = unreadQuery(deps, a.orgId, a.userId).as("u");
  const chatTotal = deps.db.select({ n: sql<number>`coalesce(sum(${unread.unread}), 0)` }).from(unread);
  const chatMentions = deps.db.select({ n: sql<number>`coalesce(sum(${unread.mentions}), 0)` }).from(unread);
  const notes = deps.db.select({ n: count() }).from(notifications).where(and(eq(notifications.orgId, a.orgId), eq(notifications.userId, a.userId), isNull(notifications.readAt), inboxWhere(now)));
  const r = await deps.db.select({
    inbox: sql<number>`count(*)`,
    important: splitsOn ? sql<number>`coalesce(sum(case when ${important} then 1 else 0 end), 0)` : sql<number>`0`,
    notClaimed: !splitsOn ? sql<number>`0` : notClaimed ? sql<number>`coalesce(sum(case when ${notClaimed} then 1 else 0 end), 0)` : sql<number>`count(*)`,
    dueToday: sql<number>`(${dueToday})`,
    overdue: sql<number>`(${overdue})`,
    triage: sql<number>`(${triage})`,
    chat: sql<number>`(${chatTotal})`,
    mentions: sql<number>`(${chatMentions})`,
    notes: sql<number>`(${notes})`,
  }).from(messages).where(and(
    eq(messages.orgId, a.orgId), scope, eq(messages.folder, "inbox"), eq(messages.isRead, false), snoozeHiddenCond(now),
  )).get();
  out.tasks = { dueToday: Number(r?.dueToday ?? 0), overdue: Number(r?.overdue ?? 0) };
  out.triage = Number(r?.triage ?? 0);
  const importantN = Number(r?.important ?? 0);
  out.mail = { inbox: Number(r?.inbox ?? 0), important: importantN, other: Math.max(0, Number(r?.notClaimed ?? 0) - importantN) };
  out.chat = { unread: Number(r?.chat ?? 0), mentions: Number(r?.mentions ?? 0) };
  out.notifications = { unread: Number(r?.notes ?? 0) };
  return out;
}

/** A weak ETag over the counts without `at`, so the same numbers answer 304 however often they are read. */
export async function countsEtag(c: Counts): Promise<string> {
  const { at: _at, ...rest } = c;
  const bytes = new TextEncoder().encode(JSON.stringify(rest));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `W/"c-${Array.from(hash.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("")}"`;
}

/** Cache header for a counts answer: private (per person), 15 s, then revalidate with the ETag. */
export const COUNTS_CACHE = "private, max-age=15, must-revalidate";
