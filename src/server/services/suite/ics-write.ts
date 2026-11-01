/**
 * Round 23 (R23.4): writing iCalendar (RFC 5545) for a person's calendar feed. Pure functions:
 * escaping, folding at 75 octets (never inside a UTF-8 character), CRLF line ends, and the feed
 * document itself. Every value in the document comes from stored rows (no "now"), so the same
 * data always gives the same bytes and the same ETag.
 */
import { vtimezone } from "./vtimezone";

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** TEXT value escaping (RFC 5545 3.3.11): backslash, semicolon, comma and newlines. */
export function icsEscape(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

const enc = new TextEncoder();
/**
 * Folds a content line so no line is longer than 75 octets (RFC 5545 3.1). A continuation line
 * starts with one space, which counts toward its 75. Multi byte characters are never split.
 */
export function foldLine(line: string) {
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "", size = 0, limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (size + n > limit) { out.push(cur); cur = " "; size = 1; limit = 75; }
    cur += ch; size += n;
  }
  out.push(cur);
  return out.join("\r\n");
}

export const icsUtc = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
export const icsDay = (ymd: string) => ymd.replace(/-/g, "");

export function icsLocal(d: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}T${pad(Number(p.hour) % 24)}${p.minute}${p.second}`;
}

/** The day after YYYY-MM-DD (an all day event's DTEND is exclusive). */
export function nextDay(ymd: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export interface FeedMeeting {
  id: string; title: string; startsAt: Date; durationMin: number; status: string;
  recurrence: string | null; recurrenceTz: string | null; version: number; updatedAt: Date; url: string;
}
export interface FeedDue { id: string; title: string; ref: string; due: string; url: string; version: number; updatedAt: Date; project: string }

/** The document's lines joined with CRLF and folded. */
export function icsDocument(lines: string[]) {
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

export const FEED_NAME = "Multies";

/**
 * A calendar feed: meetings (a weekly series is one VEVENT with its RRULE and the zone's VTIMEZONE)
 * and task due dates as all day events ("Due: ..."; Google Calendar ignores VTODO).
 * UIDs are stable (a meeting keeps the UID its email invite used), SEQUENCE follows the row's version.
 */
export function buildFeed(input: { meetings: FeedMeeting[]; dues: FeedDue[]; name?: string }) {
  const zones = new Map<string, Date>();
  for (const m of input.meetings) if (m.recurrence && m.recurrenceTz && !zones.has(m.recurrenceTz)) zones.set(m.recurrenceTz, m.startsAt);
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Multies//Calendar feed//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(input.name ?? FEED_NAME)}`, "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H",
  ];
  for (const [tz, around] of [...zones].sort((a, b) => a[0].localeCompare(b[0]))) lines.push(...vtimezone(tz, around));
  for (const m of input.meetings) {
    const end = new Date(m.startsAt.getTime() + m.durationMin * 60_000);
    const series = !!(m.recurrence && m.recurrenceTz);
    lines.push(
      "BEGIN:VEVENT", `UID:${m.id}@mymail`, `DTSTAMP:${icsUtc(m.updatedAt)}`, `SEQUENCE:${Math.max(0, m.version - 1)}`,
      ...(series
        ? [`DTSTART;TZID=${m.recurrenceTz}:${icsLocal(m.startsAt, m.recurrenceTz!)}`, `DTEND;TZID=${m.recurrenceTz}:${icsLocal(end, m.recurrenceTz!)}`, `RRULE:${m.recurrence}`]
        : [`DTSTART:${icsUtc(m.startsAt)}`, `DTEND:${icsUtc(end)}`]),
      `SUMMARY:${icsEscape(m.title)}`, `URL:${m.url}`, `LOCATION:${icsEscape(m.url)}`,
      `DESCRIPTION:${icsEscape(`Join in Multies: ${m.url}`)}`,
      `STATUS:${m.status === "cancelled" ? "CANCELLED" : "CONFIRMED"}`, "END:VEVENT",
    );
  }
  for (const t of input.dues) {
    lines.push(
      "BEGIN:VEVENT", `UID:task-${t.id}@mymail`, `DTSTAMP:${icsUtc(t.updatedAt)}`, `SEQUENCE:${Math.max(0, t.version - 1)}`,
      `DTSTART;VALUE=DATE:${icsDay(t.due)}`, `DTEND;VALUE=DATE:${icsDay(nextDay(t.due))}`,
      `SUMMARY:${icsEscape(`Due: ${t.title}`)}`, `URL:${t.url}`,
      `DESCRIPTION:${icsEscape(`${t.ref} in ${t.project}\n${t.url}`)}`, "TRANSP:TRANSPARENT", "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return icsDocument(lines);
}

/**
 * R99: one calendar object resource for CalDAV (RFC 4791 4.1): the same event lines as the feed, without METHOD
 * or the feed's name and refresh lines, and with the UID the phone chose when the phone made the event.
 */
export function buildObject(input: { meetings: FeedMeeting[]; dues: FeedDue[] }, opts: { uid?: string | null; prodId?: string } = {}) {
  const feedOnly = /^(METHOD|X-WR-CALNAME|REFRESH-INTERVAL|X-PUBLISHED-TTL)[:;]/;
  let lines = buildFeed(input).split("\r\n").filter((l) => l && !feedOnly.test(l));
  lines = lines.map((l) => (l.startsWith("PRODID:") ? `PRODID:${opts.prodId ?? "-//Multies//Calendar sync//EN"}` : l));
  if (opts.uid) {
    const i = lines.findIndex((l) => l.startsWith("UID:"));
    if (i >= 0) lines[i] = foldLine(`UID:${opts.uid.replace(/[\r\n]/g, "")}`);
  }
  return lines.join("\r\n") + "\r\n";
}
