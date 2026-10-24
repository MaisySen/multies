/**
 * Repeating tasks. A rule says how often: daily, weekly on chosen days, monthly on a day of the
 * month, yearly, every N of any of those (custom), with an optional end date. When a repeating
 * task is finished, the next one is made with the next due date, and the rule moves to it.
 */
import { HttpError } from "../../lib/errors";

export interface RepeatRule {
  freq: "daily" | "weekly" | "monthly" | "yearly";
  /** Every N days, weeks, months or years. 1 by default. */
  interval?: number;
  /** For weekly: days of the week, 0 Sunday to 6 Saturday. Defaults to the due date's day. */
  weekdays?: number[];
  /** For monthly: day of the month, 1 to 31 (short months use their last day). Defaults to the due date's day. */
  monthDay?: number;
  /** Last date a repeat may fall on, YYYY-MM-DD. */
  until?: string | null;
}

export function normaliseRule(r: unknown): RepeatRule | null {
  if (r === null || r === undefined) return null;
  const x = r as Partial<RepeatRule>;
  if (!x || !["daily", "weekly", "monthly", "yearly"].includes(x.freq as string)) throw new HttpError(422, "validation_failed", "repeat.freq must be daily, weekly, monthly or yearly.");
  const interval = x.interval === undefined ? 1 : Math.floor(Number(x.interval));
  if (!(interval >= 1 && interval <= 365)) throw new HttpError(422, "validation_failed", "repeat.interval must be 1 to 365.");
  const out: RepeatRule = { freq: x.freq as RepeatRule["freq"], interval };
  if (x.weekdays !== undefined && x.weekdays !== null) {
    const days = [...new Set(x.weekdays.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
    if (!days.length) throw new HttpError(422, "validation_failed", "repeat.weekdays needs days from 0 (Sunday) to 6 (Saturday).");
    out.weekdays = days;
  }
  if (x.monthDay !== undefined && x.monthDay !== null) {
    const d = Math.floor(Number(x.monthDay));
    if (!(d >= 1 && d <= 31)) throw new HttpError(422, "validation_failed", "repeat.monthDay must be 1 to 31.");
    out.monthDay = d;
  }
  if (x.until) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(x.until)) throw new HttpError(422, "validation_failed", "repeat.until must be YYYY-MM-DD.");
    out.until = x.until;
  }
  return out;
}

const DAY = 86_400_000;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** The next date after `from` that the rule lands on, keeping the time of day. Null once past `until`. */
export function nextOccurrence(rule: RepeatRule, from: Date): Date | null {
  const n = rule.interval ?? 1;
  let next: Date;
  if (rule.freq === "daily") next = new Date(from.getTime() + n * DAY);
  else if (rule.freq === "weekly") {
    const days = rule.weekdays?.length ? rule.weekdays : [from.getUTCDay()];
    const dow = from.getUTCDay();
    const later = days.find((d) => d > dow);
    if (later !== undefined) next = new Date(from.getTime() + (later - dow) * DAY);
    else {
      // First chosen day in the week N weeks on.
      const startOfWeek = from.getTime() - dow * DAY;
      next = new Date(startOfWeek + n * 7 * DAY + days[0] * DAY);
    }
  } else if (rule.freq === "monthly") {
    const want = rule.monthDay ?? from.getUTCDate();
    const y = from.getUTCFullYear(), m = from.getUTCMonth() + n;
    const ty = y + Math.floor(m / 12), tm = ((m % 12) + 12) % 12;
    next = new Date(Date.UTC(ty, tm, Math.min(want, daysIn(ty, tm)), from.getUTCHours(), from.getUTCMinutes()));
  } else {
    const ty = from.getUTCFullYear() + n, tm = from.getUTCMonth();
    next = new Date(Date.UTC(ty, tm, Math.min(from.getUTCDate(), daysIn(ty, tm)), from.getUTCHours(), from.getUTCMinutes()));
  }
  if (rule.until && next.getTime() > new Date(`${rule.until}T23:59:59.999Z`).getTime()) return null;
  return next;
}

/** A short plain description, e.g. "Every 2 weeks on Mon, Wed". */
export function describeRule(r: RepeatRule) {
  const n = r.interval ?? 1;
  const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[r.freq];
  let s = n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
  if (r.freq === "weekly" && r.weekdays?.length) s += ` on ${r.weekdays.map((d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]).join(", ")}`;
  if (r.freq === "monthly" && r.monthDay) s += ` on day ${r.monthDay}`;
  if (r.until) s += ` until ${r.until}`;
  return s;
}
