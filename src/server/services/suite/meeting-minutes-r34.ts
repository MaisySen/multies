/**
 * R34 (MB-171, reviewer 6): a monthly cap on call minutes for free workspaces, so a long call can't create a bill.
 *
 * What is counted: participant-minutes (two people for 30 minutes = 60), the way video providers bill.
 * Where it comes from: the participant lists the call status already reads (services/suite/calls.ts): each
 * person's join time and the last time they were seen in the room. Nothing is written while a call runs; at
 * the call's end (markEnded, already one write) ONE counter upsert adds the call's minutes to usage_counters
 * (metric meeting_participant_minutes, period YYYY-MM). That is the only extra write per call.
 *
 * The cap: the free plan (starter) gets FREE_MEETING_MINUTES a month; paid plans have none. An operator can set
 * any workspace's cap (organizations.meeting_minutes_cap, 0077; 0 blocks calls, null means the plan's rule).
 * In a call the status carries `minutes` so the call shows a warning at 80% and when 5 minutes remain; a new
 * call (an empty room) is refused once the month is used up. A call already running is never cut off.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { organizations, usageCounters } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { effectivePlanId } from "../plans";

export const MEETING_MINUTES_METRIC = "meeting_participant_minutes";
export const FREE_MEETING_MINUTES = 1000;
/** The last few minutes get their own warning. */
export const LAST_MINUTES_WARNING = 5;

export const minutesPeriod = (d: Date) => d.toISOString().slice(0, 7);

export type MinutesWarn = null | "eighty" | "last_minutes" | "used_up";
export interface MinutesState { used: number; cap: number; remaining: number; percent: number; warn: MinutesWarn; period: string; resetsOn: string }

/** The first day of next month (UTC), when the allowance starts again. */
export function resetsOn(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

/** Pure: where a workspace stands against its cap. */
export function minutesState(used: number, cap: number, now: Date): MinutesState {
  const u = Math.max(0, Math.round(used));
  const remaining = Math.max(0, cap - u);
  const percent = cap > 0 ? Math.min(100, Math.round((u / cap) * 100)) : 100;
  const warn: MinutesWarn = remaining <= 0 ? "used_up" : remaining <= LAST_MINUTES_WARNING ? "last_minutes" : u >= cap * 0.8 ? "eighty" : null;
  return { used: u, cap, remaining, percent, warn, period: minutesPeriod(now), resetsOn: resetsOn(now) };
}

/** Pure: the cap that applies. An operator override wins; else free workspaces get FREE_MEETING_MINUTES and paid ones none. */
export function capFor(plan: string, override: number | null | undefined): number | null {
  if (override !== null && override !== undefined) return override;
  return plan === "starter" ? FREE_MEETING_MINUTES : null;
}

export interface SeenPerson { first: number; last: number }

/** Pure: participant-minutes for one call from each person's first and last sighting. Anyone seen counts at least one minute. */
export function participantMinutes(people: Iterable<SeenPerson>): number {
  let total = 0;
  for (const p of people) total += Math.max(1, Math.ceil(Math.max(0, p.last - p.first) / 60_000));
  return total;
}

/** Pure: minutes the people in a running call have used so far (not yet in the counter). */
export function liveMinutes(joinedAt: (number | null)[], now: number): number {
  return joinedAt.reduce<number>((n, j) => n + (j ? Math.max(0, (now - j) / 60_000) : 0), 0);
}

const cache = new Map<string, { at: number; value: { cap: number | null; used: number } }>();
const CACHE_MS = 30_000;

/** The cap and this month's counted minutes. One or two reads, cached 30 s per isolate (status polls are frequent). */
export async function meetingMinutes(deps: Deps, orgId: string, fresh = false): Promise<{ cap: number | null; used: number }> {
  const hit = cache.get(orgId);
  const now = deps.now().getTime();
  if (!fresh && hit && now - hit.at < CACHE_MS) return hit.value;
  const org = await deps.db.select({ plan: organizations.plan, compPlan: organizations.compPlan, override: organizations.meetingMinutesCap }).from(organizations).where(eq(organizations.id, orgId)).get();
  const cap = capFor(effectivePlanId(org), org?.override); // PRIV1b (P19): a comp workspace gets Business minutes
  const row = await deps.db.select({ count: usageCounters.count }).from(usageCounters)
    .where(and(eq(usageCounters.orgId, orgId), eq(usageCounters.period, minutesPeriod(deps.now())), eq(usageCounters.metric, MEETING_MINUTES_METRIC))).get();
  const value = { cap, used: row?.count ?? 0 };
  cache.set(orgId, { at: now, value });
  return value;
}

/** The workspace's month, for the meetings page and the operator console. Null cap means no limit. */
export async function meetingMinutesUsage(deps: Deps, orgId: string) {
  const { cap, used } = await meetingMinutes(deps, orgId, true);
  return cap === null ? { used, cap: null, period: minutesPeriod(deps.now()), resetsOn: resetsOn(deps.now()) } : minutesState(used, cap, deps.now());
}

/** At a call's end: ONE upsert adds its minutes to the month (essential write; the call happened). */
export async function recordMeetingMinutes(deps: Deps, orgId: string, minutes: number) {
  const n = Math.max(0, Math.round(minutes));
  if (!n) return 0;
  await deps.db.insert(usageCounters).values({ orgId, period: minutesPeriod(deps.now()), metric: MEETING_MINUTES_METRIC, count: n })
    .onConflictDoUpdate({ target: [usageCounters.orgId, usageCounters.period, usageCounters.metric], set: { count: sql`${usageCounters.count} + ${n}` } });
  cache.delete(orgId);
  return n;
}

const monthName = (period: string) => new Date(`${period}-01T00:00:00Z`).toLocaleString("en-AU", { month: "long", timeZone: "UTC" });
const dayName = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleString("en-AU", { day: "numeric", month: "long", timeZone: "UTC" });

/** The words a person sees when a new call is refused. */
export function usedUpMessage(s: { cap: number; period: string; resetsOn: string }) {
  if (s.cap === 0) return "Calls are switched off for this workspace. Ask the workspace owner, or write to support.";
  return `This workspace has used its ${s.cap.toLocaleString("en-AU")} free call minutes for ${monthName(s.period)}. Calls start again on ${dayName(s.resetsOn)}, or an owner can upgrade the plan.`;
}

/**
 * Before a token for an EMPTY room: refuse once the month is used up. People joining a call that is already
 * running still get in (the call is not cut off; its minutes count when it ends).
 */
export async function assertCanStartCall(deps: Deps, orgId: string, roomHasPeople: () => Promise<boolean>) {
  // A fresh read: joins are rare next to status polls, and an operator's new cap applies at once.
  const { cap, used } = await meetingMinutes(deps, orgId, true);
  if (cap === null || used < cap) return;
  if (await roomHasPeople().catch(() => false)) return;
  const s = minutesState(used, cap, deps.now());
  throw new HttpError(429, "meeting_minutes_used", usedUpMessage(s));
}
