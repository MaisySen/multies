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

/** A meeting time in the workspace's zone, with the zone named ("Mon, 26 Oct, 10:00 am AEDT"). */
export function zonedDateTime(iso: string): string {
  return new Date(iso).toLocaleString(LOCALE, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: displayTimeZone, timeZoneName: "short" });
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
