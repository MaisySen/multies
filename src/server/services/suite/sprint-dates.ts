/**
 * Round 25 (MB-54, MB-55): sprint dates. A date with no time (YYYY-MM-DD) is a calendar day in the
 * workspace's time zone: a start is the first moment of that day, an end is the last moment of it,
 * the same on create and on update. A full ISO instant is kept as given.
 */
import { parseDate } from "./common";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Minutes the zone is ahead of UTC at a given instant (Sydney in summer: +660). */
export function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** The first moment of a calendar day (YYYY-MM-DD) in a zone, as a UTC instant. */
export function startOfDayIn(day: string, timeZone: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  // Two passes settle days where the offset changes (daylight saving).
  let at = guess - zoneOffsetMinutes(new Date(guess), timeZone) * 60_000;
  at = guess - zoneOffsetMinutes(new Date(at), timeZone) * 60_000;
  return new Date(at);
}

function nextDay(day: string) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** The last moment (…:59.999) of a calendar day in a zone. */
export function endOfDayIn(day: string, timeZone: string): Date {
  return new Date(startOfDayIn(nextDay(day), timeZone).getTime() - 1);
}

/** Today's date (YYYY-MM-DD) in a zone. */
export function todayIn(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** A sprint's start or end from an API value: date only means that day in the zone. */
export function sprintDate(v: string | null | undefined, which: "start" | "end", timeZone: string): Date | null {
  if (v === undefined || v === null || v === "") return null;
  const s = v.trim();
  if (DATE_ONLY.test(s)) return which === "start" ? startOfDayIn(s, timeZone) : endOfDayIn(s, timeZone);
  return parseDate(s);
}

/** Accepts startDate/endDate (and start/end) as names for startAt/endAt, so callers who guess them are not ignored. */
export function sprintDateAliases<T extends { startAt?: string; endAt?: string; startDate?: string; endDate?: string; start?: string; end?: string }>(b: T) {
  const { startDate, endDate, start, end, ...rest } = b;
  return { ...rest, startAt: b.startAt ?? startDate ?? start, endAt: b.endAt ?? endDate ?? end } as Omit<T, "startDate" | "endDate" | "start" | "end"> & { startAt?: string; endAt?: string };
}
