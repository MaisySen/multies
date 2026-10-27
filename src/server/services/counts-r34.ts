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
import { and, count, eq, gte, isNull, lt, ne, sql } from "drizzle-orm";
import type { Deps } from "../context";
import { messages, notifications, tasks } from "../db/schema";
import { inIds } from "../lib/sql-chunks";
import { snoozeHiddenCond } from "./mail/schedules";
import { splitTabs } from "./mail/splits";
import { unreadSummary } from "./suite/chat";
import type { SuiteActor } from "./suite/common";
import { DEFAULT_SNOOZE_ZONE, inboxWhere } from "./suite/notify-triage";
import { triageCount } from "./suite/triage";
import { mailboxScope } from "./team";

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

/** A valid IANA zone, or the default (UTC+10). */
export function zoneOr(tz: string | undefined | null): string {
  if (!tz) return DEFAULT_SNOOZE_ZONE;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return DEFAULT_SNOOZE_ZONE; }
}

/** The instant the person's local day (in `tz`) started and the instant it ends. */
export function localDay(now: Date, tz: string): { start: Date; end: Date } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(now).filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)]));
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  const offset = asUtc - Math.floor(now.getTime() / 1000) * 1000; // local minus UTC
  const start = Date.UTC(parts.year, parts.month - 1, parts.day) - offset;
  return { start: new Date(start), end: new Date(start + 86_400_000) };
}

/** Every count for the caller. An agent key has no inbox, chat or notifications: those parts are 0. */
export async function getCounts(deps: Deps, a: SuiteActor, opts: { tz?: string | null } = {}): Promise<Counts> {
  const now = deps.now();
  const out = EMPTY_COUNTS(now);
  const person = !a.agentId && !!a.userId;
  const day = localDay(now, zoneOr(opts.tz));
  const mine = a.agentId ? and(eq(tasks.assigneeType, "agent"), eq(tasks.assigneeId, a.agentId)) : and(eq(tasks.assigneeType, "member"), eq(tasks.assigneeId, a.userId));
  const open = and(eq(tasks.orgId, a.orgId), mine, isNull(tasks.deletedAt), ne(tasks.status, "done"), isNull(tasks.triageState));

  const [dueToday, overdue, triage] = await Promise.all([
    deps.db.select({ n: count() }).from(tasks).where(and(open, gte(tasks.dueAt, now), lt(tasks.dueAt, day.end))).get(),
    deps.db.select({ n: count() }).from(tasks).where(and(open, lt(tasks.dueAt, now))).get(),
    triageCount(deps, a),
  ]);
  out.tasks = { dueToday: Number(dueToday?.n ?? 0), overdue: Number(overdue?.n ?? 0) };
  out.triage = triage;
  if (!person) return out;

  const scope = await mailboxScope(deps.db, { orgId: a.orgId, userId: a.userId, role: a.role ?? "member" });
  const [inbox, tabs, chat, notes] = await Promise.all([
    scope && !scope.length ? Promise.resolve({ n: 0 }) : deps.db.select({ n: sql<number>`count(*)` }).from(messages).where(and(
      eq(messages.orgId, a.orgId), scope ? inIds(messages.mailboxId, scope) : undefined, eq(messages.folder, "inbox"), eq(messages.isRead, false), snoozeHiddenCond(now),
    )).get(),
    scope && !scope.length ? Promise.resolve([]) : splitTabs(deps, { orgId: a.orgId, userId: a.userId }, { scope }),
    unreadSummary(deps, a),
    deps.db.select({ n: count() }).from(notifications).where(and(eq(notifications.orgId, a.orgId), eq(notifications.userId, a.userId), isNull(notifications.readAt), inboxWhere(now))).get(),
  ]);
  const tab = (id: string) => Number(tabs.find((t) => t.id === id)?.unread ?? 0);
  out.mail = { inbox: Number(inbox?.n ?? 0), important: tab("important"), other: tab("other") };
  out.chat = { unread: chat.total, mentions: chat.mentions };
  out.notifications = { unread: Number(notes?.n ?? 0) };
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
