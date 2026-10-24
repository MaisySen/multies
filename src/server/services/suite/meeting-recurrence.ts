/**
 * Weekly meeting series (RFC 5545 RRULE, weekly only): every 1 or 2 weeks on chosen days, with
 * an optional end date (UNTIL) or number of meetings (COUNT). A series is one meetings row;
 * occurrences are worked out on read and never written, and keep their wall clock time in the
 * series' time zone across daylight saving changes.
 */
import { HttpError } from "../../lib/errors";
import { validTimezone, zonedDate, zonedTime } from "./scheduling";

export const WEEKDAYS = ["mo", "tu", "we", "th", "fr", "sa", "su"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface Recurrence {
  interval: 1 | 2;
  days: Weekday[];
  /** Last day of the series, YYYY-MM-DD in the series' zone, inclusive. */
  until: string | null;
  count: number | null;
}

export interface RecurrenceInput { interval?: number; days?: string[]; until?: string | null; count?: number | null }

const DAY_OF: Record<string, Weekday> = { mon: "mo", tue: "tu", wed: "we", thu: "th", fri: "fr", sat: "sa", sun: "su" };
const bad = (message: string) => new HttpError(422, "validation_failed", message);
const pad = (n: number) => String(n).padStart(2, "0");

/** The weekday of an instant in a zone, as an RRULE day. */
export function weekdayIn(at: Date, tz: string): Weekday {
  return DAY_OF[zonedDate(at, tz).day];
}

/** Checks and normalises a recurrence. The start's own weekday is always part of the series. */
export function normaliseRecurrence(input: RecurrenceInput, startsAt: Date, tz: string): Recurrence {
  const interval = input.interval ?? 1;
  if (interval !== 1 && interval !== 2) throw bad("A meeting repeats every week or every two weeks.");
  const days = new Set<Weekday>();
  for (const d of input.days ?? []) {
    const k = d.toLowerCase().slice(0, 2) as Weekday;
    if (!WEEKDAYS.includes(k)) throw bad(`Not a day of the week: ${d}`);
    days.add(k);
  }
  days.add(weekdayIn(startsAt, tz));
  if (input.until && input.count) throw bad("End a series on a date or after a number of meetings, not both.");
  let until: string | null = null;
  if (input.until) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.until)) throw bad("Give the end date as YYYY-MM-DD.");
    const s = zonedDate(startsAt, tz);
    if (input.until < `${s.y}-${pad(s.m)}-${pad(s.d)}`) throw bad("The end date is before the first meeting.");
    until = input.until;
  }
  let count: number | null = null;
  if (input.count !== undefined && input.count !== null) {
    if (!Number.isInteger(input.count) || input.count < 1 || input.count > 520) throw bad("A series has between 1 and 520 meetings.");
    count = input.count;
  }
  return { interval: interval as 1 | 2, days: WEEKDAYS.filter((d) => days.has(d)), until, count };
}

/** RRULE value without the "RRULE:" prefix. UNTIL is the end of the last day, in UTC. */
export function toRrule(r: Recurrence, tz: string) {
  const parts = ["FREQ=WEEKLY", `INTERVAL=${r.interval}`, `BYDAY=${r.days.map((d) => d.toUpperCase()).join(",")}`];
  if (r.count) parts.push(`COUNT=${r.count}`);
  if (r.until) {
    const [y, m, d] = r.until.split("-").map(Number);
    const end = new Date(zonedTime(y, m, d, 24 * 60 - 1, tz).getTime() + 59_000);
    parts.push(`UNTIL=${end.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`);
  }
  return parts.join(";");
}

/** Parses a weekly RRULE (with or without the "RRULE:" prefix). Anything but weekly is refused. */
export function parseRrule(rule: string, tz: string): Recurrence {
  const kv = Object.fromEntries(rule.trim().replace(/^RRULE:/i, "").split(";").filter(Boolean).map((p) => {
    const [k, v = ""] = p.split("=");
    return [k.trim().toUpperCase(), v.trim().toUpperCase()];
  }));
  if (kv.FREQ !== "WEEKLY") throw bad("Only weekly series are supported (FREQ=WEEKLY).");
  const interval = kv.INTERVAL ? Number(kv.INTERVAL) : 1;
  if (interval !== 1 && interval !== 2) throw bad("A meeting repeats every week or every two weeks (INTERVAL=1 or 2).");
  const days = (kv.BYDAY ? kv.BYDAY.split(",") : []).map((d: string) => d.toLowerCase() as Weekday);
  if (days.some((d) => !WEEKDAYS.includes(d))) throw bad("BYDAY takes MO, TU, WE, TH, FR, SA or SU.");
  let until: string | null = null;
  if (kv.UNTIL) {
    const m = /^(\d{4})(\d{2})(\d{2})(T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(kv.UNTIL);
    if (!m) throw bad("UNTIL must look like 20261231 or 20261231T235959Z.");
    if (m[4] && m[8]) {
      const z = zonedDate(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[5], +m[6], +m[7])), tz);
      until = `${z.y}-${pad(z.m)}-${pad(z.d)}`;
    } else until = `${m[1]}-${m[2]}-${m[3]}`;
  }
  const count = kv.COUNT ? Number(kv.COUNT) : null;
  if (count !== null && (!Number.isInteger(count) || count < 1 || count > 520)) throw bad("COUNT runs from 1 to 520.");
  return { interval: interval as 1 | 2, days: WEEKDAYS.filter((d) => days.includes(d)), until, count };
}

/**
 * Occurrence start times of a series that begin in [from, to), at most `limit`.
 * Walks calendar days from the first meeting (skipping whole cycles when there is no COUNT).
 */
export function expandWeekly(startsAt: Date, r: Recurrence, tz: string, from: Date, to: Date, limit = 50): Date[] {
  const start = zonedDate(startsAt, tz);
  const startMin = Math.round((startsAt.getTime() - zonedTime(start.y, start.m, start.d, 0, tz).getTime()) / 60_000);
  const startDay = Date.UTC(start.y, start.m - 1, start.d) / 86_400_000;
  // Monday of the first week (RRULE WKST=MO).
  const weekday = WEEKDAYS.indexOf(DAY_OF[start.day]);
  const firstMonday = startDay - weekday;
  const cycle = 7 * r.interval;
  const untilDay = r.until ? Date.UTC(+r.until.slice(0, 4), +r.until.slice(5, 7) - 1, +r.until.slice(8, 10)) / 86_400_000 : Infinity;
  const days = new Set(r.days.map((d) => WEEKDAYS.indexOf(d)));
  let monday = firstMonday;
  if (!r.count) {
    const fromDay = Math.floor(from.getTime() / 86_400_000) - 2;
    if (fromDay > monday + cycle) monday += Math.floor((fromDay - monday) / cycle) * cycle;
  }
  const out: Date[] = [];
  let seen = 0;
  for (let guard = 0; guard < 2000; guard++, monday += cycle) {
    for (let i = 0; i < 7; i++) {
      const day = monday + i;
      if (day < startDay || !days.has(i)) continue;
      if (day > untilDay) return out;
      const dt = new Date(day * 86_400_000);
      const at = zonedTime(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), startMin, tz);
      seen++;
      if (r.count && seen > r.count) return out;
      if (at.getTime() >= to.getTime()) return out;
      if (at.getTime() >= from.getTime()) {
        out.push(at);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

/** Plain words for a series: "Every week on Monday", "Every 2 weeks on Mon, Wed, until 2026-12-18". */
export function describeRecurrence(r: Recurrence) {
  const names: Record<Weekday, string> = { mo: "Monday", tu: "Tuesday", we: "Wednesday", th: "Thursday", fr: "Friday", sa: "Saturday", su: "Sunday" };
  const list = r.days.length === 1 ? names[r.days[0]] : r.days.map((d) => names[d].slice(0, 3)).join(", ");
  const head = `${r.interval === 2 ? "Every 2 weeks" : "Every week"} on ${list}`;
  return r.count ? `${head}, ${r.count} times` : r.until ? `${head}, until ${r.until}` : head;
}

export function assertZone(tz: string) {
  if (!validTimezone(tz)) throw bad(`Not a time zone: ${tz}`);
}
