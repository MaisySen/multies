import { DEFAULT_TIMEZONE, LOCALE } from "@/shared/locale";
import { t, uiLocale } from "@/web/i18n"; // R104
import { devaDigits, formatDateIn, hasLocale, numberLocale } from "@/web/i18n/intl"; // R104

/** R104: the locale dates and numbers use: Nepali or Hindi while the app shows one (LANG_R104), else en-AU as before. */
const loc = () => uiLocale() ?? LOCALE;
/** R104: a date or time in the app language; English (and flag off) keeps the exact call it always made. */
const dt = (d: Date, kind: "date" | "time" | "any", o: Intl.DateTimeFormatOptions) => {
  const ui = uiLocale();
  if (ui) return formatDateIn(d, ui, o);
  return kind === "date" ? d.toLocaleDateString(LOCALE, o) : kind === "time" ? d.toLocaleTimeString(LOCALE, o) : d.toLocaleString(LOCALE, o);
};

/** The browser's own time zone, when it says. */
export function browserTimeZone(): string | null {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
}

/**
 * Dates show in the person's own time zone: the one they saved (onboarding, Account settings),
 * else their browser's, else the workspace's. Set once the account loads.
 */
let displayTimeZone = browserTimeZone() ?? DEFAULT_TIMEZONE;
export function setDisplayTimeZone(...candidates: (string | null | undefined)[]) {
  const tz = candidates.find((t): t is string => !!t);
  if (tz) displayTimeZone = tz;
}
export const tz = () => displayTimeZone;
const dayKey = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: displayTimeZone });

/** Locale-formatted number (en-AU). */
// MPLAT-110: a missing count shows as 0 instead of throwing and taking the whole page down.
export const num = (n: number) => (n ?? 0).toLocaleString(numberLocale(loc()));

/** A date (no time) in the workspace's zone, e.g. "23 Oct 2026". */
export function shortDate(iso: string | Date, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" }) {
  return dt(new Date(iso), "date", { ...opts, timeZone: opts.timeZone ?? displayTimeZone });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

type Rel = { format: (v: number, unit: "minute" | "hour" | "day") => string };
/** R104: Nepali relative times where the browser has no Nepali data ("५ मिनेट अघि", "हिजो"). */
const nepaliRel: Rel = {
  format: (v, unit) => {
    if (unit === "day" && Math.abs(v) === 1) return t(v < 0 ? "time.yesterday" : "time.tomorrow");
    return t(v < 0 ? `time.${unit}s_ago` : `time.in_${unit}s`, { n: devaDigits(String(Math.abs(v))) });
  },
};
let relCache: [string, Rel] | null = null;
function relative(): Rel | null {
  const l = uiLocale();
  if (!l) return null;
  if (l.startsWith("ne") && !hasLocale(l)) return nepaliRel;
  if (!relCache || relCache[0] !== l) { try { relCache = [l, new Intl.RelativeTimeFormat(l, { numeric: "auto", style: "short" })]; } catch { return null; } }
  return relCache[1];
}

export function timeAgo(iso: string | Date | null | undefined): string {
  if (!iso) return uiLocale() ? t("time.never") : "never";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const raw = Math.round((Date.now() - d.getTime()) / 1000);
  if (raw < -45) {
    const f = -raw;
    const ahead = relative(); // R104
    if (ahead) return f < 3600 ? ahead.format(Math.round(f / 60), "minute") : f < 86400 ? ahead.format(Math.round(f / 3600), "hour") : ahead.format(Math.round(f / 86400), "day");
    if (f < 3600) return `in ${Math.round(f / 60)}m`;
    if (f < 86400) return `in ${Math.round(f / 3600)}h`;
    return `in ${Math.round(f / 86400)}d`;
  }
  const s = Math.max(0, raw);
  if (s < 45) return uiLocale() ? t("time.just_now") : "just now";
  const rel = uiLocale() ? relative() : null; // R104: Nepali and Hindi say it their own way
  if (rel && s < 86400 * 7) return s < 3600 ? rel.format(-Math.round(s / 60), "minute") : s < 86400 ? rel.format(-Math.round(s / 3600), "hour") : rel.format(-Math.round(s / 86400), "day");
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`;
  return dt(d, "date", { month: "short", day: "numeric", timeZone: displayTimeZone });
}

/** Inbox-style date: time today, weekday this week, date otherwise. */
export function mailDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const o = { timeZone: displayTimeZone };
  if (dayKey(d) === dayKey(now)) return dt(d, "time", { ...o, hour: "numeric", minute: "2-digit" });
  if (now.getTime() - d.getTime() < 6 * 86400_000) return dt(d, "date", { ...o, weekday: "short" });
  const sameYear = dayKey(d).slice(0, 4) === dayKey(now).slice(0, 4);
  return dt(d, "date", { ...o, month: "short", day: "numeric", year: sameYear ? undefined : "numeric" });
}

export function fullDate(iso: string): string {
  return dt(new Date(iso), "any", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: displayTimeZone });
}

/** A meeting time in the workspace's zone, with the zone named ("Mon, 26 Oct, 10:00 am AEDT"). */
export function zonedDateTime(iso: string): string {
  return dt(new Date(iso), "any", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: displayTimeZone, timeZoneName: "short" });
}

/** Minutes the zone is ahead of UTC at this instant. */
function zoneOffsetMin(t: number, zone: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(t)).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]));
  return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000) / 60_000;
}

/** A datetime-local value ("2026-10-26T10:00") read as wall clock time in the workspace's zone, as an ISO instant. */
export function zonedInputToIso(local: string, zone = displayTimeZone): string {
  const [d, hm] = local.split("T");
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi] = (hm ?? "00:00").split(":").map(Number);
  const wall = Date.UTC(y, mo - 1, da, h, mi);
  let t = wall - zoneOffsetMin(wall, zone) * 60_000;
  t = wall - zoneOffsetMin(t, zone) * 60_000;
  return new Date(t).toISOString();
}

/** An instant as a datetime-local value in the workspace's zone. */
export function isoToZonedInput(t: Date | string, zone = displayTimeZone): string {
  const ms = new Date(t).getTime();
  return new Date(ms + zoneOffsetMin(ms, zone) * 60_000).toISOString().slice(0, 16);
}

export function initials(nameOrEmail: string): string {
  const base = nameOrEmail.includes("@") && !nameOrEmail.includes(" ") ? nameOrEmail.split("@")[0] : nameOrEmail;
  const parts = base.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

/**
 * R44: the accessible name of a control that shows someone's initials (WCAG 2.5.3, axe label-content-name-mismatch).
 * The initials are on screen, so the name must contain them as a whole word, outside brackets (axe drops bracketed text
 * before it compares): "Assignee: AR, Alex Rivera".
 */
export function initialsLabel(role: string, name: string): string {
  return `${role}: ${initials(name)}, ${name}`;
}

/** "morning", "afternoon" or "evening" in the person's own zone. */
export function dayPart(now = new Date()) {
  const h = Number(now.toLocaleString("en-AU", { hour: "numeric", hourCycle: "h23", timeZone: tz() }));
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}
