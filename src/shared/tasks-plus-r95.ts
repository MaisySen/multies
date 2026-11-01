/**
 * R95 Tasks plus: the pure rules behind My Day time blocks, smart repeats (time zones, after done, nth weekday,
 * rotation), the idle prompt, the timesheet submit and approve steps, mind map moves and the time CSV.
 * Shared by the server and the web app so both sides agree; no I/O here.
 */

// ---------------------------------------------------------------- repeat rules

export interface RepeatRule {
  freq: "daily" | "weekly" | "monthly" | "yearly";
  /** Every N days, weeks, months or years. 1 by default. */
  interval?: number;
  /** For weekly: days of the week, 0 Sunday to 6 Saturday. Defaults to the due date's day. */
  weekdays?: number[];
  /** For monthly: day of the month, 1 to 31 (short months use their last day). Defaults to the due date's day. */
  monthDay?: number;
  /** R95: for monthly, the nth weekday instead of a day number: 1 to 5, or -1 for the last. A 5th a month lacks falls back to the last. */
  nth?: number;
  /** R95: the weekday for nth, 0 Sunday to 6 Saturday. */
  nthWeekday?: number;
  /** R95: count the next date from the due date (default) or from when the task was finished. */
  basis?: "due" | "done";
  /** R95: the time zone the dates are counted in, so 9 am stays 9 am across daylight saving. UTC when unset. */
  tz?: string;
  /** R95: hand the next task to the next person in this list ("member:<id>"), in order, wrapping round. */
  rotate?: string[];
  /** Last date a repeat may fall on, YYYY-MM-DD. */
  until?: string | null;
}

const DAY = 86_400_000;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
export const WEEKDAYS = [1, 2, 3, 4, 5];
const SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ORD = ["", "1st", "2nd", "3rd", "4th", "5th"];

export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/** A plain reason the rule can't be used, or null when it is fine. Shape only; the server turns it into a 422. */
export function ruleProblem(r: Partial<RepeatRule>): string | null {
  if (!["daily", "weekly", "monthly", "yearly"].includes(r.freq as string)) return "repeat.freq must be daily, weekly, monthly or yearly.";
  if (r.nth !== undefined && r.nth !== null) {
    if (r.freq !== "monthly") return "repeat.nth works with a monthly repeat.";
    if (![1, 2, 3, 4, 5, -1].includes(Number(r.nth))) return "repeat.nth must be 1 to 5, or -1 for the last.";
    const wd = Number(r.nthWeekday);
    if (!(Number.isInteger(wd) && wd >= 0 && wd <= 6)) return "repeat.nthWeekday must be 0 (Sunday) to 6 (Saturday).";
  }
  if (r.basis !== undefined && r.basis !== null && r.basis !== "due" && r.basis !== "done") return "repeat.basis must be due or done.";
  if (r.tz !== undefined && r.tz !== null && r.tz !== "" && !validTimeZone(r.tz)) return "repeat.tz must be a time zone such as Australia/Sydney.";
  if (r.rotate !== undefined && r.rotate !== null) {
    if (!Array.isArray(r.rotate) || r.rotate.length > 20) return "repeat.rotate takes up to 20 people.";
    if (r.rotate.some((k) => typeof k !== "string" || !/^member:[A-Za-z0-9_-]{1,80}$/.test(k))) return "repeat.rotate lists people as member:<id>.";
  }
  return null;
}

/** Wall clock parts of an instant in a time zone. */
export function zonedParts(at: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(at)) if (x.type !== "literal") p[x.type] = Number(x.value);
  return { y: p.year, m: p.month - 1, d: p.day, h: p.hour === 24 ? 0 : p.hour, mi: p.minute, s: p.second };
}

/** The instant whose wall clock in tz reads the given parts (a time skipped by daylight saving moves forward). */
export function fromZoned(y: number, m: number, d: number, h: number, mi: number, tz: string, s = 0): Date {
  const want = Date.UTC(y, m, d, h, mi, s);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess), tz);
    const seen = Date.UTC(p.y, p.m, p.d, p.h, p.mi, p.s);
    if (seen === want) return new Date(guess);
    guess += want - seen;
  }
  return new Date(guess);
}

/** The day of the month of the nth weekday (n -1 = last; a 5th the month lacks falls back to the last). */
export function nthWeekdayOf(y: number, m: number, weekday: number, n: number): number {
  const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
  const firstHit = 1 + ((weekday - first + 7) % 7);
  const len = daysIn(y, m);
  const lastHit = firstHit + Math.floor((len - firstHit) / 7) * 7;
  if (n === -1) return lastHit;
  const day = firstHit + (n - 1) * 7;
  return day > len ? lastHit : day;
}

/** The next date on a UTC wall clock (the time zone is handled by the caller). */
function nextCore(rule: RepeatRule, from: Date): Date {
  const n = rule.interval ?? 1;
  if (rule.freq === "daily") return new Date(from.getTime() + n * DAY);
  if (rule.freq === "weekly") {
    const days = rule.weekdays?.length ? rule.weekdays : [from.getUTCDay()];
    const dow = from.getUTCDay();
    const later = days.find((d) => d > dow);
    if (later !== undefined) return new Date(from.getTime() + (later - dow) * DAY);
    const startOfWeek = from.getTime() - dow * DAY;
    return new Date(startOfWeek + n * 7 * DAY + days[0] * DAY);
  }
  if (rule.freq === "monthly") {
    const y = from.getUTCFullYear(), m = from.getUTCMonth() + n;
    const ty = y + Math.floor(m / 12), tm = ((m % 12) + 12) % 12;
    const day = rule.nth ? nthWeekdayOf(ty, tm, rule.nthWeekday ?? 1, rule.nth) : Math.min(rule.monthDay ?? from.getUTCDate(), daysIn(ty, tm));
    return new Date(Date.UTC(ty, tm, day, from.getUTCHours(), from.getUTCMinutes()));
  }
  const ty = from.getUTCFullYear() + n, tm = from.getUTCMonth();
  return new Date(Date.UTC(ty, tm, Math.min(from.getUTCDate(), daysIn(ty, tm)), from.getUTCHours(), from.getUTCMinutes()));
}

/**
 * The next date after `from` that the rule lands on, keeping the time of day on the rule's wall clock
 * (its time zone, else UTC). Null once past `until`.
 */
export function nextOccurrence(rule: RepeatRule, from: Date): Date | null {
  const tz = rule.tz && validTimeZone(rule.tz) ? rule.tz : null;
  const local = tz ? (() => { const p = zonedParts(from, tz); return new Date(Date.UTC(p.y, p.m, p.d, p.h, p.mi, p.s)); })() : from;
  const next = nextCore(rule, local);
  if (rule.until && next.getTime() > new Date(`${rule.until}T23:59:59.999Z`).getTime()) return null;
  if (!tz) return next;
  return fromZoned(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate(), next.getUTCHours(), next.getUTCMinutes(), tz, next.getUTCSeconds());
}

/**
 * Where the next task's date is counted from: the old due date, or (after done) the moment it was finished
 * with the old due date's time of day on the rule's clock.
 */
export function repeatBase(rule: RepeatRule, due: Date | null, finishedAt: Date): Date {
  if (rule.basis !== "done" || !due) return due ?? finishedAt;
  const tz = rule.tz && validTimeZone(rule.tz) ? rule.tz : "UTC";
  const f = zonedParts(finishedAt, tz), d = zonedParts(due, tz);
  return fromZoned(f.y, f.m, f.d, d.h, d.mi, tz);
}

/** The next few dates, for the "Next:" preview under the repeat control. */
export function previewDates(rule: RepeatRule, from: Date, count = 3): Date[] {
  const out: Date[] = [];
  let at: Date | null = from;
  for (let i = 0; i < count && at; i++) { at = nextOccurrence(rule, at); if (at) out.push(at); }
  return out;
}

/** The person after `current` in a rotation, wrapping round; the first one when current is not in the list. */
export function nextInRotation(list: string[] | undefined, current: string | null): string | null {
  if (!list?.length) return null;
  const i = current ? list.indexOf(current) : -1;
  return list[(i + 1) % list.length];
}

export const isEveryWeekday = (r: Pick<RepeatRule, "freq" | "interval" | "weekdays">) =>
  r.freq === "weekly" && (r.interval ?? 1) === 1 && (r.weekdays ?? []).join(",") === WEEKDAYS.join(",");

/** A short plain description, e.g. "Every 2 weeks on Mon, Wed" or "Every month on the last Fri". */
export function describeRule(r: RepeatRule) {
  const n = r.interval ?? 1;
  const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[r.freq];
  let s = isEveryWeekday(r) ? "Every weekday" : n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
  if (r.freq === "weekly" && r.weekdays?.length && !isEveryWeekday(r)) s += ` on ${r.weekdays.map((d) => SHORT[d]).join(", ")}`;
  if (r.freq === "monthly" && r.nth) s += ` on the ${r.nth === -1 ? "last" : ORD[r.nth]} ${SHORT[r.nthWeekday ?? 1]}`;
  else if (r.freq === "monthly" && r.monthDay) s += ` on day ${r.monthDay}`;
  if (r.basis === "done") s += " after done";
  if (r.until) s += ` until ${r.until}`;
  return s;
}

// ---------------------------------------------------------------- My Day time blocks

export const DAY_MINUTES = 1440;
export const SNAP = 15;
export const MIN_BLOCK = 15;
export const MAX_BLOCK = 720;
export interface Block { id: string; start: number; minutes: number }

/** Snaps a block to the 15 minute grid and keeps it inside the day. */
export function clampBlock(start: number, minutes: number) {
  const len = Math.min(MAX_BLOCK, Math.max(MIN_BLOCK, Math.round(minutes / SNAP) * SNAP));
  const s = Math.min(DAY_MINUTES - len, Math.max(0, Math.round(start / SNAP) * SNAP));
  return { start: s, minutes: len };
}

export const overlaps = (a: Pick<Block, "start" | "minutes">, b: Pick<Block, "start" | "minutes">) =>
  a.start < b.start + b.minutes && b.start < a.start + a.minutes;

/** The block's own id is ignored, so moving a block never clashes with where it was. */
export function clashOf(blocks: Block[], want: Block): Block | null {
  return blocks.find((b) => b.id !== want.id && overlaps(b, want)) ?? null;
}

/**
 * The nearest free start for a block (searching later first, then earlier, in 15 minute steps),
 * or null when the day has no room of that length.
 */
export function fitBlock(blocks: Block[], want: Block): number | null {
  const { start, minutes } = clampBlock(want.start, want.minutes);
  for (let step = 0; step <= DAY_MINUTES / SNAP; step++) {
    for (const s of step === 0 ? [start] : [start + step * SNAP, start - step * SNAP]) {
      if (s < 0 || s + minutes > DAY_MINUTES) continue;
      if (!clashOf(blocks, { id: want.id, start: s, minutes })) return s;
    }
  }
  return null;
}

export interface PlanItem { id: string; taskId: string; start: number | null; minutes: number; done: boolean }

/**
 * "Plan tomorrow": every unfinished item of today moves to tomorrow. It keeps its time when that is free
 * on tomorrow (after the items already there), else it goes to tomorrow's list without a time. A task
 * already on tomorrow's plan is not added twice: today's copy is just removed.
 */
export function planTomorrow(today: PlanItem[], tomorrow: PlanItem[]) {
  const placed: Block[] = tomorrow.filter((t) => t.start !== null).map((t) => ({ id: t.id, start: t.start!, minutes: t.minutes }));
  const there = new Set(tomorrow.map((t) => t.taskId));
  const moves: { id: string; start: number | null }[] = [];
  const drops: string[] = [];
  for (const it of [...today].sort((a, b) => (a.start ?? 9999) - (b.start ?? 9999))) {
    if (it.done) continue;
    if (there.has(it.taskId)) { drops.push(it.id); continue; }
    there.add(it.taskId);
    if (it.start === null) { moves.push({ id: it.id, start: null }); continue; }
    const b = { id: it.id, start: it.start, minutes: it.minutes };
    if (clashOf(placed, b)) moves.push({ id: it.id, start: null });
    else { placed.push(b); moves.push({ id: it.id, start: it.start }); }
  }
  return { moves, drops };
}

export const minutesText = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** "9:30" style time for a minute of the day in the person's locale. */
export function clockOf(min: number, locale?: string) {
  const d = new Date(Date.UTC(2000, 0, 1, Math.floor(min / 60), min % 60));
  return d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
}

export function addDays(ymd: string, n: number) {
  const d = new Date(`${ymd}T12:00:00Z`);
  return new Date(d.getTime() + n * DAY).toISOString().slice(0, 10);
}
export const isYmd = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

// ---------------------------------------------------------------- idle prompt

export const IDLE_AFTER_MS = 10 * 60_000;

/** Seconds the person was away when they come back, or 0 when the gap is under the threshold or no timer runs. */
export function idleAway(lastActiveMs: number, nowMs: number, opts: { running: boolean; timerStartMs: number; thresholdMs?: number }) {
  if (!opts.running) return 0;
  const from = Math.max(lastActiveMs, opts.timerStartMs);
  const gap = nowMs - from;
  return gap >= (opts.thresholdMs ?? IDLE_AFTER_MS) ? Math.round(gap / 1000) : 0;
}

/** Dropping the away time stops the timer at the last activity (never before the timer started). */
export const dropStopAt = (lastActiveMs: number, timerStartMs: number) => new Date(Math.max(lastActiveMs, timerStartMs));

// ---------------------------------------------------------------- timesheets

export type SheetStatus = "open" | "submitted" | "approved" | "returned";
export type SheetAction = "submit" | "withdraw" | "approve" | "return";
export const SHEET_LOCKED: SheetStatus[] = ["submitted", "approved"];

/** One step of a week's timesheet. Self = the sheet is the actor's own; admin = workspace owner or admin. */
export function sheetStep(status: SheetStatus, action: SheetAction, who: { self: boolean; admin: boolean }):
  { ok: true; status: SheetStatus } | { ok: false; status: 403 | 409; code: string; message: string } {
  const no = (code: string, message: string, s: 403 | 409 = 409) => ({ ok: false as const, status: s, code, message });
  if (action === "submit" || action === "withdraw") {
    if (!who.self) return no("not_your_timesheet", "Only the person can submit or take back their own week.", 403);
    if (action === "submit") return status === "open" || status === "returned" ? { ok: true, status: "submitted" } : no("timesheet_" + status, status === "approved" ? "This week is already approved." : "This week is already submitted.");
    return status === "submitted" ? { ok: true, status: "open" } : no("timesheet_" + status, "Only a submitted week can be taken back.");
  }
  if (!who.admin) return no("admin_only", "Only an admin can approve or return a timesheet.", 403);
  if (action === "approve") return status === "submitted" ? { ok: true, status: "approved" } : no("timesheet_" + status, "Only a submitted week can be approved.");
  return status === "submitted" || status === "approved" ? { ok: true, status: "returned" } : no("timesheet_" + status, "Only a submitted or approved week can be returned.");
}

/** Monday of the week a YYYY-MM-DD falls in. */
export function weekStartOf(ymd: string) {
  const d = new Date(`${ymd}T12:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * DAY).toISOString().slice(0, 10);
}

/** YYYY-MM-DD of an instant in a time zone. */
export const ymdIn = (at: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: validTimeZone(tz) ? tz : "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

// ---------------------------------------------------------------- tags

export function cleanTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const raw of v) {
    const t = String(raw ?? "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 32);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 10) break;
  }
  return out;
}

// ---------------------------------------------------------------- mind map

/** True when making `parentId` the parent of `nodeId` would put the node under itself. */
export function wouldCycle(parentOf: Map<string, string | null>, nodeId: string, parentId: string | null): boolean {
  let at = parentId;
  for (let i = 0; at && i < 1000; i++) { if (at === nodeId) return true; at = parentOf.get(at) ?? null; }
  return false;
}

export interface MapNode<T> { item: T; children: MapNode<T>[] }
/** Tasks as a tree under the project: a task whose parent is missing (other project, deleted) sits at the top. */
export function buildTree<T extends { id: string; parentId: string | null }>(items: T[]): MapNode<T>[] {
  const nodes = new Map(items.map((t) => [t.id, { item: t, children: [] as MapNode<T>[] }]));
  const roots: MapNode<T>[] = [];
  const parentOf = new Map(items.map((t) => [t.id, t.parentId]));
  for (const t of items) {
    const p = t.parentId ? nodes.get(t.parentId) : undefined;
    if (p && !wouldCycle(parentOf, t.id, t.parentId)) p.children.push(nodes.get(t.id)!);
    else roots.push(nodes.get(t.id)!);
  }
  return roots;
}

// ---------------------------------------------------------------- CSV

/** One CSV cell: quoted when needed, and a leading = + - @ made harmless for spreadsheet apps. */
export function csvCell(v: unknown) {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csvRow = (cells: unknown[]) => cells.map(csvCell).join(",");
