/**
 * Round 23 (R23.4): reading iCalendar from other calendars (a CalDAV REPORT or a secret ICS link).
 * Pure functions: unfolding, VEVENT properties, dates with TZID, UTC, floating or all day, and a
 * bounded RRULE expander (daily, weekly, monthly, yearly) that never leaves the asked window.
 * Nothing read here is stored.
 */
import { zoneOffsetMin } from "./vtimezone";

export interface ExternalEvent {
  uid: string;
  title: string;
  /** ISO instant, or YYYY-MM-DD for an all day event. */
  start: string;
  /** Exclusive end: ISO instant, or YYYY-MM-DD. */
  end: string;
  allDay: boolean;
  location: string | null;
  recurring: boolean;
}

interface Prop { name: string; params: Record<string, string>; value: string }
type Comp = { type: string; props: Prop[]; children: Comp[] };

/** Most occurrences one event yields, and most loop steps spent finding them. */
export const MAX_OCCURRENCES = 500;
const MAX_STEPS = 20_000;
const DAY = 86_400_000;
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

const WINDOWS_ZONES: Record<string, string> = {
  "Eastern Standard Time": "America/New_York", "Central Standard Time": "America/Chicago", "Mountain Standard Time": "America/Denver",
  "Pacific Standard Time": "America/Los_Angeles", "GMT Standard Time": "Europe/London", "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest", "Romance Standard Time": "Europe/Paris", "AUS Eastern Standard Time": "Australia/Sydney",
  "E. Australia Standard Time": "Australia/Brisbane", "Cen. Australia Standard Time": "Australia/Adelaide", "W. Australia Standard Time": "Australia/Perth",
  "Tokyo Standard Time": "Asia/Tokyo", "India Standard Time": "Asia/Kolkata", "China Standard Time": "Asia/Shanghai", "UTC": "UTC",
  "Central European Standard Time": "Europe/Warsaw", "New Zealand Standard Time": "Pacific/Auckland", "Singapore Standard Time": "Asia/Singapore",
};

export function validZone(tz: string) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/** An IANA zone for a TZID as calendars write it (IANA, "/mozilla.org/.../Europe/Paris", or a Windows name). */
export function zoneFor(tzid: string | undefined, fallback = "UTC"): string {
  if (!tzid) return fallback;
  const t = tzid.replace(/^"|"$/g, "").trim();
  if (WINDOWS_ZONES[t]) return WINDOWS_ZONES[t];
  if (validZone(t)) return t;
  const m = t.match(/([A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)$/);
  if (m && validZone(m[1])) return m[1];
  return fallback;
}

/** Wall clock time in a zone to an instant (two passes, so the hour after a change is right). */
export function fromLocal(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  if (tz === "UTC") return new Date(guess);
  let t = guess - zoneOffsetMin(new Date(guess), tz) * 60_000;
  t = guess - zoneOffsetMin(new Date(t), tz) * 60_000;
  return new Date(t);
}

function unescapeText(v: string) {
  return v.replace(/\\(n|N|,|;|\\)/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

function parseParams(s: string) {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/;([A-Za-z0-9-]+)=("[^"]*"|[^;:]*)/g)) out[m[1].toUpperCase()] = m[2].replace(/^"|"$/g, "");
  return out;
}

/** Splits an iCalendar text into nested components. Tolerates LF only files and stray blank lines. */
export function parseComponents(text: string): Comp[] {
  const lines = text.replace(/\r\n|\r/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const root: Comp = { type: "ROOT", props: [], children: [] };
  const stack: Comp[] = [root];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    // The value starts at the first colon that is not inside a quoted parameter.
    let i = 0, q = false;
    for (; i < raw.length; i++) { const ch = raw[i]; if (ch === '"') q = !q; else if (ch === ":" && !q) break; }
    if (i >= raw.length) continue;
    const head = raw.slice(0, i), value = raw.slice(i + 1);
    const semi = head.indexOf(";");
    const name = (semi < 0 ? head : head.slice(0, semi)).toUpperCase();
    if (name === "BEGIN") { const c: Comp = { type: value.trim().toUpperCase(), props: [], children: [] }; stack[stack.length - 1].children.push(c); stack.push(c); continue; }
    if (name === "END") { if (stack.length > 1) stack.pop(); continue; }
    stack[stack.length - 1].props.push({ name, params: semi < 0 ? {} : parseParams(head.slice(semi)), value });
  }
  return root.children;
}

type When = { allDay: true; ymd: string } | { allDay: false; at: Date; tz: string };

/** A DATE or DATE-TIME value: UTC (Z), with TZID, floating (read in `defaultTz`), or a date. */
export function parseWhen(p: Prop, defaultTz = "UTC"): When | null {
  const v = p.value.trim();
  const d = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (d || p.params.VALUE === "DATE") {
    if (!d) return null;
    return { allDay: true, ymd: `${d[1]}-${d[2]}-${d[3]}` };
  }
  const t = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!t) return null;
  const [y, mo, da, h, mi, s] = t.slice(1, 7).map(Number);
  if (t[7] === "Z") return { allDay: false, at: new Date(Date.UTC(y, mo - 1, da, h, mi, s)), tz: p.params.TZID ? zoneFor(p.params.TZID, defaultTz) : defaultTz };
  const tz = zoneFor(p.params.TZID, defaultTz);
  return { allDay: false, at: fromLocal(y, mo, da, h, mi, s, tz), tz };
}

/** ISO 8601 duration (P1D, PT1H30M, P2W, -PT15M) in milliseconds. */
export function parseDuration(v: string) {
  const m = v.trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const ms = ((Number(m[2] ?? 0) * 7 + Number(m[3] ?? 0)) * 24 * 3600 + Number(m[4] ?? 0) * 3600 + Number(m[5] ?? 0) * 60 + Number(m[6] ?? 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}

const DOW = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
interface Rule { freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY"; interval: number; count: number | null; until: Date | null; byDay: { n: number; day: number }[]; byMonthDay: number[]; byMonth: number[] }

export function parseRule(v: string, tz: string): Rule | null {
  const kv = Object.fromEntries(v.split(";").map((x) => x.split("=")).filter((x) => x.length === 2).map(([k, val]) => [k.toUpperCase(), val]));
  const freq = kv.FREQ?.toUpperCase();
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return null;
  let until: Date | null = null;
  if (kv.UNTIL) {
    const w = parseWhen({ name: "UNTIL", params: {}, value: kv.UNTIL }, tz);
    // An all day UNTIL includes that whole day.
    until = !w ? null : w.allDay ? new Date(fromLocal(...(w.ymd.split("-").map(Number) as [number, number, number]), 23, 59, 59, tz)) : w.at;
  }
  const byDay = (kv.BYDAY ?? "").split(",").filter(Boolean).map((x) => { const m = x.trim().toUpperCase().match(/^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/); return m ? { n: Number(m[1] ?? 0), day: DOW.indexOf(m[2]) } : null; }).filter((x): x is { n: number; day: number } => !!x);
  const nums = (s?: string) => (s ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n !== 0);
  return { freq, interval: Math.max(1, Math.min(Number(kv.INTERVAL) || 1, 1000)), count: kv.COUNT ? Math.max(1, Number(kv.COUNT) || 1) : null, until, byDay, byMonthDay: nums(kv.BYMONTHDAY), byMonth: nums(kv.BYMONTH) };
}

/** Days in a month, and the dates in month (y, m) matching BYDAY entries like 2TU or -1FR (or every TU). */
const dim = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
function monthDays(y: number, m: number, r: Rule, startDay: number): number[] {
  const n = dim(y, m);
  const out = new Set<number>();
  if (r.byDay.length) {
    for (const b of r.byDay) {
      const all: number[] = [];
      for (let d = 1; d <= n; d++) if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === b.day) all.push(d);
      if (!b.n) all.forEach((d) => out.add(d));
      else { const pick = b.n > 0 ? all[b.n - 1] : all[all.length + b.n]; if (pick) out.add(pick); }
    }
  } else if (r.byMonthDay.length) {
    for (const md of r.byMonthDay) { const d = md > 0 ? md : n + md + 1; if (d >= 1 && d <= n) out.add(d); }
  } else if (startDay <= n) out.add(startDay);
  return [...out].sort((a, b) => a - b);
}

/**
 * Local start dates (y, m, d) of a rule's occurrences, in order, from the first one. Calls `take`
 * for each; stops when it returns false, after COUNT, or after the step limit.
 */
function eachDate(start: { y: number; m: number; d: number }, r: Rule, take: (y: number, m: number, d: number) => boolean) {
  let emitted = 0, steps = 0;
  const emit = (y: number, m: number, d: number) => { emitted++; return take(y, m, d) && (r.count === null || emitted < r.count); };
  const base = Date.UTC(start.y, start.m - 1, start.d);
  if (r.freq === "DAILY" || r.freq === "WEEKLY") {
    const startDow = new Date(base).getUTCDay();
    const days = r.byDay.length ? r.byDay.map((b) => b.day) : [startDow];
    // Weeks start on Monday (WKST=MO, the default).
    const weekStart = base - ((startDow + 6) % 7) * DAY;
    for (let t = base; steps < MAX_STEPS; t += DAY, steps++) {
      const dt = new Date(t);
      if (r.freq === "DAILY") {
        if (Math.round((t - base) / DAY) % r.interval !== 0) continue;
        if (r.byDay.length && !days.includes(dt.getUTCDay())) continue;
      } else {
        if (Math.floor((t - weekStart) / (7 * DAY)) % r.interval !== 0) continue;
        if (!days.includes(dt.getUTCDay())) continue;
      }
      if (!emit(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate())) return;
    }
    return;
  }
  const months = r.freq === "MONTHLY" ? r.interval : 12 * r.interval;
  for (let k = 0; steps < MAX_STEPS; k += months, steps++) {
    const y = start.y + Math.floor((start.m - 1 + k) / 12), m = ((start.m - 1 + k) % 12) + 1;
    const list = r.freq === "YEARLY" && !r.byDay.length && !r.byMonthDay.length
      ? (start.d <= dim(y, m) ? [start.d] : [])
      : monthDays(y, m, r, start.d);
    for (const d of list) {
      if (k === 0 && d < start.d) continue;
      if (!emit(y, m, d)) return;
    }
    if (r.freq === "YEARLY" && r.byMonth.length > 1) break; // rare shapes: first year only
  }
}

const ymdOf = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const ymdKey = (w: When) => (w.allDay ? w.ymd : w.at.toISOString());

/**
 * The VEVENTs of an iCalendar text that touch [from, to), recurring ones expanded inside the window
 * only (RRULE, EXDATE, and RECURRENCE-ID overrides). Sorted by start.
 */
export function eventsIn(text: string, from: Date, to: Date, opts: { defaultTz?: string; limit?: number } = {}): ExternalEvent[] {
  const defaultTz = opts.defaultTz ?? "UTC";
  const limit = opts.limit ?? 2000;
  const cal = parseComponents(text);
  const calTz = cal.flatMap((c) => c.props).find((p) => p.name === "X-WR-TIMEZONE")?.value;
  const tz0 = zoneFor(calTz, defaultTz);
  const vevents = cal.flatMap((c) => (c.type === "VEVENT" ? [c] : c.children.filter((x) => x.type === "VEVENT")));
  const overrides = new Map<string, Set<string>>();
  const out: ExternalEvent[] = [];
  const get = (c: Comp, n: string) => c.props.find((p) => p.name === n);
  // Overrides first, so the series skips the occurrences they replace.
  for (const ev of vevents) {
    const rid = get(ev, "RECURRENCE-ID"), uid = get(ev, "UID")?.value ?? "";
    if (!rid) continue;
    const w = parseWhen(rid, tz0);
    if (w) (overrides.get(uid) ?? overrides.set(uid, new Set()).get(uid)!).add(ymdKey(w));
  }
  const push = (ev: Comp, start: When, durMs: number, recurring: boolean): boolean => {
    if (out.length >= limit) return false;
    const uid = get(ev, "UID")?.value ?? "";
    if (start.allDay) {
      const s = start.ymd;
      const days = Math.max(1, Math.round(durMs / DAY));
      const [y, m, d] = s.split("-").map(Number);
      const e = new Date(Date.UTC(y, m - 1, d + days));
      const end = ymdOf(e.getUTCFullYear(), e.getUTCMonth() + 1, e.getUTCDate());
      if (Date.UTC(y, m - 1, d) >= to.getTime() || e.getTime() <= from.getTime()) return false;
      out.push({ uid, title: unescapeText(get(ev, "SUMMARY")?.value ?? "(no title)"), start: s, end, allDay: true, location: get(ev, "LOCATION") ? unescapeText(get(ev, "LOCATION")!.value) : null, recurring });
      return true;
    } else {
      const s = start.at, e = new Date(s.getTime() + durMs);
      if (s.getTime() >= to.getTime() || e.getTime() <= from.getTime()) return false;
      out.push({ uid, title: unescapeText(get(ev, "SUMMARY")?.value ?? "(no title)"), start: s.toISOString(), end: e.toISOString(), allDay: false, location: get(ev, "LOCATION") ? unescapeText(get(ev, "LOCATION")!.value) : null, recurring });
      return true;
    }
  };
  for (const ev of vevents) {
    if ((get(ev, "STATUS")?.value ?? "").toUpperCase() === "CANCELLED") continue;
    const ds = get(ev, "DTSTART");
    const start = ds && parseWhen(ds, tz0);
    if (!start) continue;
    const de = get(ev, "DTEND"), du = get(ev, "DURATION");
    const endW = de ? parseWhen(de, start.allDay ? tz0 : start.tz) : null;
    let durMs = du ? parseDuration(du.value) ?? 0 : 0;
    if (endW) durMs = endW.allDay && start.allDay ? Date.parse(endW.ymd) - Date.parse(start.ymd) : !endW.allDay && !start.allDay ? endW.at.getTime() - start.at.getTime() : 0;
    if (!de && !du && start.allDay) durMs = DAY;
    durMs = Math.max(0, durMs);
    const rr = get(ev, "RRULE");
    const tz = start.allDay ? tz0 : start.tz;
    const rule = rr && !get(ev, "RECURRENCE-ID") ? parseRule(rr.value, tz) : null;
    if (!rule) { push(ev, start, durMs, !!get(ev, "RECURRENCE-ID")); continue; }
    const uid = get(ev, "UID")?.value ?? "";
    const skip = new Set(overrides.get(uid) ?? []);
    for (const ex of ev.props.filter((p) => p.name === "EXDATE")) {
      for (const v of ex.value.split(",")) { const w = parseWhen({ ...ex, value: v }, tz); if (w) skip.add(ymdKey(w)); }
    }
    const local = start.allDay ? (() => { const [y, m, d] = start.ymd.split("-").map(Number); return { y, m, d, h: 0, mi: 0, s: 0 }; })() : (() => {
      const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(start.at).map((x) => [x.type, x.value]));
      return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
    })();
    let n = 0;
    eachDate(local, rule, (y, m, d) => {
      // Cheap check on the local date before any zone work: two days of slack either side.
      const dayMs = Date.UTC(y, m - 1, d);
      if (dayMs > to.getTime() + 2 * DAY) return false;
      const occ: When = start.allDay ? { allDay: true, ymd: ymdOf(y, m, d) } : { allDay: false, at: fromLocal(y, m, d, local.h, local.mi, local.s, tz), tz };
      if (rule.until && (occ.allDay ? dayMs : occ.at.getTime()) > rule.until.getTime()) return false;
      if (dayMs + durMs + 2 * DAY < from.getTime()) return true;
      if (skip.has(ymdKey(occ))) return true;
      if (push(ev, occ, durMs, true)) n++;
      return n < MAX_OCCURRENCES && out.length < limit;
    });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}
