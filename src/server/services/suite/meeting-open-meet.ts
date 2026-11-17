/**
 * MEET fixes (12 Nov 2026): whether a meeting's link is closed now.
 *
 * A one off meeting or a chat call closes for good when it ends (Bidur, 10 Nov: the link stays ended after the
 * last person leaves, no rejoin). A weekly series is one row for every week: before this, the first call that
 * emptied marked the whole series ended, so the guest link stopped working for every later week. Now a series
 * keeps status "scheduled", its endedAt marks the call that ended, and the link stays closed until the next
 * meeting in the series opens (JOIN_EARLY_MS before it starts). Ending a series by hand (status "ended") still
 * closes it for good.
 */
import { expandWeekly, parseRrule } from "./meeting-recurrence";

/** How early before a meeting in a series starts its link opens again. */
export const JOIN_EARLY_MS = 15 * 60_000;

export interface OpenCheck { status: string; endedAt: Date | null; startsAt: Date; recurrence: string | null; recurrenceTz: string | null }

/** null when people can join now, else why not ("ended" or "cancelled"). */
export function closedReason(m: OpenCheck, now: Date): "ended" | "cancelled" | null {
  if (m.status === "cancelled") return "cancelled";
  if (m.status !== "scheduled") return "ended";
  if (!m.recurrence || !m.endedAt) return null;
  const tz = m.recurrenceTz || "UTC";
  try {
    const next = expandWeekly(m.startsAt, parseRrule(m.recurrence, tz), tz, m.endedAt, new Date(now.getTime() + JOIN_EARLY_MS), 1);
    return next.length ? null : "ended";
  } catch {
    return null;
  }
}

/** The status people see: "ended" while a series waits for its next meeting, else the row's own. */
export function shownStatus<S extends string>(m: OpenCheck & { status: S }, now: Date): S | "ended" {
  return m.status === "scheduled" && closedReason(m, now) === "ended" ? "ended" : m.status;
}
