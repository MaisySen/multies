/**
 * R31: notification triage. A notification is in the Inbox until it is marked done; a snooze moves it to Later until
 * a time, then it comes back to the top of the Inbox as unread. The unread badge counts the Inbox only.
 * Same service for the app (/api/notifications), the public API (/api/v1/notifications) and MCP.
 */
import { and, desc, eq, gt, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { Deps } from "../../context";
import { notifications, users } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { inChunks, inIds } from "../../lib/sql-chunks";

export const TRIAGE_VIEWS = ["inbox", "later", "done"] as const;
export type TriageView = (typeof TRIAGE_VIEWS)[number];
export const SNOOZE_PRESETS = ["later_today", "tomorrow", "next_week"] as const;
export type SnoozePreset = (typeof SNOOZE_PRESETS)[number];
/** A snooze can be up to 90 days ahead. */
export const SNOOZE_MAX_MS = 90 * 24 * 60 * 60 * 1000;
/** Without a time zone on the person, presets use UTC+10 (no daylight saving). */
export const DEFAULT_SNOOZE_ZONE = "Australia/Brisbane";

/** Not done, and not snoozed (or the snooze has passed). */
export const inboxWhere = (now: Date): SQL => and(isNull(notifications.doneAt), or(isNull(notifications.snoozedUntil), lte(notifications.snoozedUntil, now)))!;
export const laterWhere = (now: Date): SQL => and(isNull(notifications.doneAt), gt(notifications.snoozedUntil, now))!;
export const doneWhere = (): SQL => isNotNull(notifications.doneAt);

/** The filter for a view. On a later Inbox page (`before`), items back from a snooze are left out: page one shows them. */
export function viewWhere(view: TriageView, now: Date, paging = false): SQL {
  if (view === "later") return laterWhere(now);
  if (view === "done") return doneWhere();
  return paging ? and(inboxWhere(now), isNull(notifications.snoozedUntil))! : inboxWhere(now);
}

/** Inbox: newest arrival first, where an item back from a snooze arrived when the snooze ended. Later: soonest back first. Done: last done first. */
export const VIEW_ORDER: Record<TriageView, SQL[]> = {
  inbox: [sql`max(${notifications.createdAt}, coalesce(${notifications.snoozedUntil}, 0)) desc`, desc(notifications.id)],
  later: [sql`${notifications.snoozedUntil} asc`, desc(notifications.id)],
  done: [desc(notifications.doneAt), desc(notifications.id)],
};

export async function viewCountsFor(deps: Deps, orgId: string, userId: string, now: Date) {
  const t = now.getTime();
  const row = await deps.db.select({
    inbox: sql<number>`sum(case when ${notifications.doneAt} is null and (${notifications.snoozedUntil} is null or ${notifications.snoozedUntil} <= ${t}) then 1 else 0 end)`,
    later: sql<number>`sum(case when ${notifications.doneAt} is null and ${notifications.snoozedUntil} > ${t} then 1 else 0 end)`,
    done: sql<number>`sum(case when ${notifications.doneAt} is not null then 1 else 0 end)`,
  }).from(notifications).where(and(eq(notifications.orgId, orgId), eq(notifications.userId, userId))).get();
  return { inbox: Number(row?.inbox ?? 0), later: Number(row?.later ?? 0), done: Number(row?.done ?? 0) };
}

const mine = (orgId: string, userId: string) => and(eq(notifications.orgId, orgId), eq(notifications.userId, userId));

function present(r: typeof notifications.$inferSelect, now: Date) {
  return {
    id: r.id, read: !!r.readAt, doneAt: r.doneAt ? r.doneAt.toISOString() : null,
    snoozedUntil: r.snoozedUntil && r.snoozedUntil > now ? r.snoozedUntil.toISOString() : null,
  };
}

async function one(deps: Deps, orgId: string, userId: string, id: string) {
  const r = await deps.db.select().from(notifications).where(and(mine(orgId, userId), eq(notifications.id, id))).get();
  if (!r) throw new HttpError(404, "not_found", "Notification not found.");
  return r;
}

/** Marks one notification done (and read). Idempotent: a done item keeps its first done time. */
export async function markDone(deps: Deps, orgId: string, userId: string, id: string) {
  const r = await one(deps, orgId, userId, id);
  const now = deps.now();
  if (r.doneAt) return { ok: true, notification: present(r, now) };
  const [u] = await deps.db.update(notifications).set({ doneAt: now, snoozedUntil: null, readAt: r.readAt ?? now })
    .where(and(mine(orgId, userId), eq(notifications.id, id))).returning();
  return { ok: true, notification: present(u, now) };
}

/** Back to the Inbox: clears done and any snooze. Read state is kept. */
export async function markUndone(deps: Deps, orgId: string, userId: string, id: string) {
  const r = await one(deps, orgId, userId, id);
  const now = deps.now();
  if (!r.doneAt && !r.snoozedUntil) return { ok: true, notification: present(r, now) };
  const [u] = await deps.db.update(notifications).set({ doneAt: null, snoozedUntil: null })
    .where(and(mine(orgId, userId), eq(notifications.id, id))).returning();
  return { ok: true, notification: present(u, now) };
}

/** Bulk done for up to 500 ids, written in chunks of 90. Unknown or someone else's ids are skipped. */
export async function markManyDone(deps: Deps, orgId: string, userId: string, ids: string[]) {
  const now = deps.now();
  const list = [...new Set(ids)];
  const done = await inChunks(list, (chunk) => deps.db.update(notifications)
    .set({ doneAt: now, snoozedUntil: null, readAt: sql`coalesce(${notifications.readAt}, ${now.getTime()})` })
    .where(and(mine(orgId, userId), isNull(notifications.doneAt), inIds(notifications.id, chunk))).returning({ id: notifications.id }));
  return { ok: true, updated: done.length, ids: done.map((d) => d.id) };
}

// ---------------------------------------------------------------- snooze times

/** Offset of `zone` from UTC at `at`, in minutes (Sydney in summer: 660). */
export function zoneOffsetMinutes(zone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

/** The local wall clock of `at` in `zone`. */
function localParts(zone: string, at: Date) {
  const shifted = new Date(at.getTime() + zoneOffsetMinutes(zone, at) * 60000);
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth(), d: shifted.getUTCDate(), h: shifted.getUTCHours(), dow: shifted.getUTCDay() };
}

/** The instant of local y-m-d h:00 in `zone` (two passes settle a daylight saving edge). */
export function zonedInstant(zone: string, y: number, m: number, d: number, h: number): Date {
  const guess = Date.UTC(y, m, d, h, 0, 0);
  let t = guess - zoneOffsetMinutes(zone, new Date(guess)) * 60000;
  t = guess - zoneOffsetMinutes(zone, new Date(t)) * 60000;
  return new Date(t);
}

export function validZone(zone: string | null | undefined): string {
  if (!zone) return DEFAULT_SNOOZE_ZONE;
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return zone; } catch { return DEFAULT_SNOOZE_ZONE; }
}

/**
 * Later today: 6 pm local, or three hours from now once it is past 3 pm. Tomorrow: 9 am local the next day.
 * Next week: 9 am local next Monday.
 */
export function presetTime(preset: SnoozePreset, now: Date, zone: string): Date {
  const z = validZone(zone);
  const l = localParts(z, now);
  if (preset === "later_today") return l.h < 15 ? zonedInstant(z, l.y, l.m, l.d, 18) : new Date(now.getTime() + 3 * 3600_000);
  if (preset === "tomorrow") return zonedInstant(z, l.y, l.m, l.d + 1, 9);
  const ahead = ((8 - l.dow) % 7) || 7;
  return zonedInstant(z, l.y, l.m, l.d + ahead, 9);
}

/** Snoozes one notification until a time (ISO) or a preset. It comes back unread. */
export async function snooze(deps: Deps, orgId: string, userId: string, id: string, input: { until?: string; preset?: SnoozePreset }) {
  const r = await one(deps, orgId, userId, id);
  const now = deps.now();
  let until: Date;
  if (input.preset) {
    const u = await deps.db.select({ timezone: users.timezone }).from(users).where(eq(users.id, userId)).get();
    until = presetTime(input.preset, now, validZone(u?.timezone));
  } else if (input.until) {
    until = new Date(input.until);
    if (Number.isNaN(until.getTime())) throw new HttpError(422, "validation_failed", "until must be an ISO date and time.");
  } else throw new HttpError(422, "validation_failed", "Send until (an ISO date and time) or a preset: later_today, tomorrow or next_week.");
  if (until.getTime() <= now.getTime()) throw new HttpError(422, "validation_failed", "Pick a time in the future.");
  if (until.getTime() - now.getTime() > SNOOZE_MAX_MS) throw new HttpError(422, "validation_failed", "A snooze can be up to 90 days.");
  void r;
  const [u] = await deps.db.update(notifications).set({ snoozedUntil: until, doneAt: null, readAt: null })
    .where(and(mine(orgId, userId), eq(notifications.id, id))).returning();
  return { ok: true, notification: present(u, now), until: until.toISOString() };
}
