import { DEFAULT_TIMEZONE, LOCALE } from "@/shared/locale";

/** Dates show in the workspace's time zone (Settings, General). Set once the workspace loads. */
let displayTimeZone = DEFAULT_TIMEZONE;
export function setDisplayTimeZone(tz: string | null | undefined) {
  if (tz) displayTimeZone = tz;
}
export const tz = () => displayTimeZone;
const dayKey = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: displayTimeZone });

/** Locale-formatted number (en-AU). */
export const num = (n: number) => n.toLocaleString(LOCALE);

/** A date (no time) in the workspace's zone, e.g. "23 Oct 2026". */
export function shortDate(iso: string | Date, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" }) {
  return new Date(iso).toLocaleDateString(LOCALE, { ...opts, timeZone: opts.timeZone ?? displayTimeZone });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function timeAgo(iso: string | Date | null | undefined): string {
  if (!iso) return "never";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const raw = Math.round((Date.now() - d.getTime()) / 1000);
  if (raw < -45) {
    const f = -raw;
    if (f < 3600) return `in ${Math.round(f / 60)}m`;
    if (f < 86400) return `in ${Math.round(f / 3600)}h`;
    return `in ${Math.round(f / 86400)}d`;
  }
  const s = Math.max(0, raw);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`;
  return d.toLocaleDateString(LOCALE, { month: "short", day: "numeric", timeZone: displayTimeZone });
}

/** Inbox-style date: time today, weekday this week, date otherwise. */
export function mailDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const o = { timeZone: displayTimeZone };
  if (dayKey(d) === dayKey(now)) return d.toLocaleTimeString(LOCALE, { ...o, hour: "numeric", minute: "2-digit" });
  if (now.getTime() - d.getTime() < 6 * 86400_000) return d.toLocaleDateString(LOCALE, { ...o, weekday: "short" });
  const sameYear = dayKey(d).slice(0, 4) === dayKey(now).slice(0, 4);
  return d.toLocaleDateString(LOCALE, { ...o, month: "short", day: "numeric", year: sameYear ? undefined : "numeric" });
}

export function fullDate(iso: string): string {
  return new Date(iso).toLocaleString(LOCALE, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: displayTimeZone });
}

export function initials(nameOrEmail: string): string {
  const base = nameOrEmail.includes("@") && !nameOrEmail.includes(" ") ? nameOrEmail.split("@")[0] : nameOrEmail;
  const parts = base.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}
