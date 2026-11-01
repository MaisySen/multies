/**
 * Repeating tasks. A rule says how often: daily, weekly on chosen days, monthly on a day of the
 * month (or, R95, the nth weekday), yearly, every N of any of those (custom), with an optional end date.
 * R95 adds counting from when the task was finished, a time zone (so 9 am stays 9 am across daylight
 * saving) and a rotation of assignees. When a repeating task is finished, the next one is made with the
 * next due date, and the rule moves to it. The date math lives in src/shared/tasks-plus-r95.ts.
 */
import { HttpError } from "../../lib/errors";
import { ruleProblem, type RepeatRule } from "../../../shared/tasks-plus-r95";

export type { RepeatRule } from "../../../shared/tasks-plus-r95";
export { nextOccurrence, describeRule, repeatBase, nextInRotation } from "../../../shared/tasks-plus-r95";

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
  // R95: smart repeat. Unset fields keep the old behaviour exactly.
  const problem = ruleProblem(x);
  if (problem) throw new HttpError(422, "validation_failed", problem);
  if (x.nth !== undefined && x.nth !== null) { out.nth = Number(x.nth); out.nthWeekday = Number(x.nthWeekday); delete out.monthDay; }
  if (x.basis === "done") out.basis = "done";
  if (x.tz) out.tz = x.tz;
  if (x.rotate?.length) out.rotate = [...new Set(x.rotate)];
  return out;
}
