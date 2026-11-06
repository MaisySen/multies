/**
 * MPAR3 (1.10.15): the phone's Calendar, meeting notes and transcripts, compose extras (files, send later, saved
 * replies, send securely), connected mailbox folders, bulk select and the shared inbox (assign, comments, One inbox).
 * Shapes are the web API's own (GET /api/calendar/events, /api/meeting-notes/:id, /api/threads/:id/state, ...).
 * Everything here is plain JavaScript: no new native module, so it rides an update to the store builds.
 */
import { currentLang, currentLocale, tr } from "@/i18n";

// ---------------------------------------------------------------- calendar

export type CalendarKind = "meeting" | "due" | "external";
export interface CalendarEvent {
  id: string; kind: CalendarKind; title: string; start: string; end: string; allDay: boolean; url: string | null;
  sourceId: string | null; sourceName: string | null; color: string | null; readOnly: boolean; location?: string | null;
}
export interface CalendarEvents { from: string; to: string; timezone: string; events: CalendarEvent[]; errors: { sourceId: string; name: string; message: string }[] }
export interface CalendarSource {
  id: string; kind: "ics" | "caldav"; name: string; color: string; enabled: boolean; createdAt: string;
  connectionId: string | null; address: string | null; host: string | null; calendars: { name: string; color: string }[];
}
export interface CalendarFeed { enabled: boolean; hint: string | null; includeTasks: boolean; createdAt: string | null; resetAt: string | null; url?: string; webcalUrl?: string }
export type CalendarView = "month" | "week" | "agenda";
export const CALENDAR_VIEWS: CalendarView[] = ["month", "week", "agenda"];
/** The layers the person can show or hide: meetings, due dates, and each other calendar by its id. */
export type Layer = "meeting" | "due" | string;

const pad = (n: number) => String(n).padStart(2, "0");
/** A local calendar day as "2026-11-04". */
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** "2026-11-04" as a local midnight. */
export function parseDay(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
/** Monday of the week holding d (weeks start on Monday, as on the web's calendar for Australia and South Asia). */
export function startOfWeek(d: Date): Date {
  const s = startOfDay(d);
  return addDays(s, -((s.getDay() + 6) % 7));
}
/** Six weeks of days for a month grid, Monday first; days outside the month are marked. */
export function monthGrid(year: number, month: number): { key: string; date: Date; inMonth: boolean }[] {
  const first = startOfWeek(new Date(year, month, 1));
  return Array.from({ length: 42 }, (_, i) => { const date = addDays(first, i); return { key: dayKey(date), date, inMonth: date.getMonth() === month }; });
}
export const weekOf = (d: Date) => Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(d), i));

/** The window to ask the server for (at most 62 days, the server takes up to 400). */
export function windowFor(view: CalendarView, anchor: Date): { from: string; to: string } {
  if (view === "month") {
    const g = monthGrid(anchor.getFullYear(), anchor.getMonth());
    return { from: g[0].date.toISOString(), to: addDays(g[41].date, 1).toISOString() };
  }
  if (view === "week") { const s = startOfWeek(anchor); return { from: s.toISOString(), to: addDays(s, 7).toISOString() }; }
  const s = startOfDay(anchor);
  return { from: s.toISOString(), to: addDays(s, 30).toISOString() };
}

/** The local days an event covers (an all day event's end is the day after it, as in iCalendar). */
export function eventDays(e: Pick<CalendarEvent, "start" | "end" | "allDay">): string[] {
  let s: Date; let last: Date;
  if (e.allDay) {
    s = parseDay(e.start.slice(0, 10));
    const end = parseDay((e.end || e.start).slice(0, 10));
    last = end > s ? addDays(end, -1) : s;
  } else {
    s = startOfDay(new Date(e.start));
    const end = new Date(e.end || e.start);
    last = startOfDay(new Date(Math.max(end.getTime() - 1, new Date(e.start).getTime())));
  }
  if (Number.isNaN(s.getTime()) || Number.isNaN(last.getTime())) return [];
  const out: string[] = [];
  for (let d = s; d <= last && out.length < 62; d = addDays(d, 1)) out.push(dayKey(d));
  return out;
}

export const layerOf = (e: Pick<CalendarEvent, "kind" | "sourceId">): Layer => (e.kind === "external" ? e.sourceId ?? "external" : e.kind);

/** Events by local day, shown layers only, all day first then by time. */
export function byDay(events: CalendarEvent[], hidden: readonly string[] = []): Map<string, CalendarEvent[]> {
  const out = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    if (hidden.includes(layerOf(e))) continue;
    for (const k of eventDays(e)) { const list = out.get(k) ?? []; list.push(e); out.set(k, list); }
  }
  for (const list of out.values()) list.sort((a, b) => (a.allDay === b.allDay ? a.start.localeCompare(b.start) : a.allDay ? -1 : 1));
  return out;
}

/** The server writes "Due: Title (KEY-12)"; the app shows the title and puts Due in a chip in the person's language. */
export function eventTitle(e: Pick<CalendarEvent, "kind" | "title">): string {
  return e.kind === "due" ? e.title.replace(/^Due:\s*/, "") : e.title;
}
/** The task id of a due date event ("task:<id>"), else null. */
export const taskIdOf = (e: Pick<CalendarEvent, "id" | "kind">) => (e.kind === "due" && e.id.startsWith("task:") ? e.id.slice(5) : null);
/** The meeting id of a meeting event (a repeat is "<id>:<start>"), else null. */
export const meetingIdOf = (e: Pick<CalendarEvent, "id" | "kind">) => (e.kind === "meeting" ? e.id.split(":")[0] : null);

export const HEX_RE = /^#[0-9a-fA-F]{6}$/;
/** The dot colour for an event: its calendar's colour, else one per kind. */
export function eventColor(e: Pick<CalendarEvent, "kind" | "color">, c: { brand: string; warn: string; muted: string }): string {
  if (e.kind === "external") return e.color && HEX_RE.test(e.color) ? e.color : c.muted;
  return e.kind === "meeting" ? c.brand : c.warn;
}

/** Hidden layers, kept on the phone (the web keeps its own). Unknown values are dropped. */
export function cleanLayers(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 100))].slice(0, 50);
}

/** A local date and time typed as "2026-11-05" and "09:30", or null when either is not a real moment. */
export function localMoment(day: string, time: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{1,2}:\d{2}$/.test(time)) return null;
  const [h, m] = time.split(":").map(Number);
  if (h > 23 || m > 59) return null;
  const d = parseDay(day);
  if (dayKey(d) !== day) return null;
  d.setHours(h, m, 0, 0);
  return d;
}
export const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && dayKey(parseDay(s)) === s;

/** An ICS address the server will take: http(s) or webcal, 8 to 2000 characters. */
export function icsProblem(url: string): string | null {
  const u = url.trim();
  if (!u) return tr("m.cal.ics_empty");
  if (u.length < 8 || u.length > 2000 || !/^(https?|webcal):\/\/[^\s]+$/i.test(u)) return tr("m.cal.ics_bad");
  return null;
}

// ---------------------------------------------------------------- meeting notes and transcripts

export interface NotesActionItem { key: string; text: string; title: string; assignee: string | null; due: string | null; task: { id: string; ref: string; title: string; done: boolean } | null }
export interface MeetingNotes {
  meeting: { id: string; title: string; startsAt: string; endsAt: string; status: string; invitees: string[]; joinUrl: string; recurrence: string | null };
  timeZone: string;
  doc: { id: string; title: string; updatedAt: string; text: string } | null;
  agenda: string[]; notes: string[]; actionItems: NotesActionItem[]; pending: number;
  summary: string | null; summaryActionItems: { text: string; assignee: string | null; due: string | null }[];
}
export interface MeetingRecording {
  id: string; status: string; stale: boolean; startedBy: { id: string; name: string }; startedAt: string; endedAt: string | null;
  durationSec: number | null; transcript: string; truncated: boolean; summary: string | null; error: string | null;
}
/** A transcript as lines, each "[mm:ss] words" split into its time and words. */
export function transcriptLines(t: string): { at: string | null; text: string }[] {
  return t.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => {
    const m = /^\[(\d{2,3}:\d{2})\]\s*([\s\S]*)$/.exec(p);
    return m ? { at: m[1], text: m[2].trim() } : { at: null, text: p };
  });
}
export const durationText = (sec: number | null) => (sec == null ? "" : sec < 60 ? tr("m.notes.sec", { n: Math.max(0, Math.round(sec)) }) : tr("m.notes.min", { n: Math.round(sec / 60) }));

// ---------------------------------------------------------------- compose extras

/** The server's limits for files written in Compose: 10 files and 20 MB per email. */
export const COMPOSE_FILES_MAX = 10;
export const COMPOSE_BYTES_MAX = 20 * 1024 * 1024;
export interface ComposeFile { id: string; name: string; size?: number; mimeType?: string; uri: string; base64?: string }
export function composeFileProblem(f: Pick<ComposeFile, "name" | "size">, picked: Pick<ComposeFile, "size">[]): string | null {
  if (picked.length >= COMPOSE_FILES_MAX) return tr("m.compose3.too_many", { n: COMPOSE_FILES_MAX });
  if (f.size === 0) return tr("m.compose3.empty_file", { name: f.name });
  const used = picked.reduce((n, x) => n + (x.size ?? 0), 0);
  if (f.size !== undefined && used + f.size > COMPOSE_BYTES_MAX) return tr("m.compose3.too_big", { name: f.name });
  return null;
}

export type SendLaterPreset = "later_today" | "tomorrow" | "next_week";
export const SEND_LATER_PRESETS: SendLaterPreset[] = ["later_today", "tomorrow", "next_week"];
/** The local wall clock the server takes ("2026-11-05T09:00") for a day and time typed on the phone. */
export function localWhen(day: string, time: string, now = new Date()): { local: string } | { error: string } {
  const d = localMoment(day, time);
  if (!d) return { error: tr("m.compose3.when_bad") };
  if (d.getTime() <= now.getTime() + 60_000) return { error: tr("m.compose3.when_past") };
  return { local: `${day}T${time.padStart(5, "0")}` };
}

export interface Snippet { id: string; name: string; body: string; subject: string | null; shortcut: string | null; shared: boolean }
/** Puts text into the body at the cursor (or over the selected words), with the cursor after it. */
export function insertAt(body: string, sel: { start: number; end: number }, text: string): { text: string; cursor: number } {
  const s = Math.max(0, Math.min(sel.start, body.length));
  const e = Math.max(s, Math.min(sel.end, body.length));
  return { text: body.slice(0, s) + text + body.slice(e), cursor: s + text.length };
}

export const SECRET_MAX_TEXT = 10_000;
export const SECRET_VIEWS = [1, 3, 10] as const;
export const SECRET_EXPIRY = [3600, 86_400, 7 * 86_400] as const;

/** base64url, as the web's secret links use. */
export function toB64u(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...Array.from(b.subarray(i, i + 0x8000)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function utf8(s: string): Uint8Array {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s);
  const bin = unescape(encodeURIComponent(s));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
/** The web's plaintext layout (src/web/lib/secret-crypto.ts): 4 byte big endian header length, { k: "text" }, the words. */
export function packSecretText(text: string): Uint8Array {
  const meta = utf8(JSON.stringify({ k: "text" }));
  const body = utf8(text);
  const out = new Uint8Array(4 + meta.length + body.length);
  new DataView(out.buffer).setUint32(0, meta.length);
  out.set(meta, 4);
  out.set(body, 4 + meta.length);
  return out;
}
/** AES GCM with a fresh 256 bit key and a 12 byte nonce; returns nonce, ciphertext and tag together. */
export type SealFn = (plain: Uint8Array, key: Uint8Array, iv: Uint8Array) => Promise<Uint8Array>;
export type RandomFn = (n: number) => Uint8Array;
/**
 * Encrypts a secret on the phone exactly as the web does, so the same public page opens it. Only the ciphertext goes
 * to Multies; the key goes into the link after "#", which is never sent to a server. No passphrase on the phone yet.
 */
export async function encryptSecretText(text: string, seal: SealFn, random: RandomFn): Promise<{ ciphertext: string; key: string }> {
  const raw = random(32);
  const iv = random(12);
  const all = await seal(packSecretText(text), raw, iv);
  return { ciphertext: toB64u(all), key: toB64u(raw) };
}
export const secretLink = (url: string, key: string) => `${url}#${key}`;

// ---------------------------------------------------------------- folders and bulk select

export interface ProviderFolder { key: string; path: string; name: string; role: string | null; synced: boolean }
export interface ProviderFolders { folders: ProviderFolder[]; maxExtra: number }
/** The person's own folders that sync (the standard ones are the app's usual folders). */
export const ownFolders = (p: ProviderFolders | undefined) => (p?.folders ?? []).filter((f) => !f.role && f.synced);
export type BulkAction = "read" | "unread" | "star" | "unstar" | "archive" | "inbox" | "spam" | "trash" | "move";
export const BULK_MAX = 500;
/** Selection: toggles one id, keeping the order they were picked in. */
export const toggleId = (ids: readonly string[], id: string) => (ids.includes(id) ? ids.filter((x) => x !== id) : ids.length >= BULK_MAX ? [...ids] : [...ids, id]);

// ---------------------------------------------------------------- shared inbox

export type ThreadStatus = "open" | "waiting" | "done";
export const THREAD_STATUSES: ThreadStatus[] = ["open", "waiting", "done"];
export interface ThreadState { threadId: string; status: ThreadStatus; assignee: { id: string; name: string } | null; assignedAt: string | null; doneAt: string | null }
export interface ThreadMember { id: string; name: string; email: string; agent: boolean }
export interface ThreadComment {
  id: string; threadId: string; author: { type: string; id: string; name: string }; body: string;
  mentions: { userId: string; name: string }[]; editedAt: string | null; createdAt: string; canEdit: boolean; canDelete: boolean;
}
export const COMMENT_MAX = 4000;

export type InboxLane = "important" | "noise";
export type InboxView = "inbox" | "later" | "done";
export type InboxSource = "mail" | "chat" | "mention" | "task" | "assistant" | "other";
export interface OneItem {
  kind: "note" | "mail" | "run" | "ref"; id: string; source: InboxSource; lane: InboxLane; reason: string; remembered: boolean;
  title: string; who: string | null; at: string; read: boolean; view: InboxView; snoozedUntil: string | null; link: string;
}
export interface OnePage { items: OneItem[]; counts: { important: number; noise: number; importantUnread: number; noiseUnread: number }; lane: InboxLane; view: InboxView }
export const oneKey = (i: Pick<OneItem, "kind" | "id">) => `${i.kind}:${i.id}`;
export const oneRefs = (list: Pick<OneItem, "kind" | "id">[]) => list.map((i) => ({ kind: i.kind, id: i.id }));
export const SOURCE_ICON: Record<InboxSource, "mail" | "chat" | "at-sign" | "check-square" | "zap" | "bell"> = {
  mail: "mail", chat: "chat", mention: "at-sign", task: "check-square", assistant: "zap", other: "bell",
};

/* ---------- Dates on the calendar screens ---------- */
const NE_MONTHS = ["जनवरी", "फेब्रुअरी", "मार्च", "अप्रिल", "मे", "जुन", "जुलाई", "अगस्ट", "सेप्टेम्बर", "अक्टोबर", "नोभेम्बर", "डिसेम्बर"];
const NE_DAYS = ["आइतबार", "सोमबार", "मङ्गलबार", "बुधबार", "बिहीबार", "शुक्रबार", "शनिबार"];
const NE_SHORT = ["आइत", "सोम", "मङ्गल", "बुध", "बिही", "शुक्र", "शनि"];
const NE_NARROW = ["आ", "सो", "मं", "बु", "बि", "शु", "श"];
/**
 * A date in the reader's language. Some browsers (and the web build's test browser) carry no Nepali calendar names
 * and print "M11" or English; then the Nepali names are put together here. Phones carry them, so this is a fallback.
 */
export function calFmt(d: Date, o: Intl.DateTimeFormatOptions): string {
  const named = !!o.weekday || (!!o.month && o.month !== "numeric" && o.month !== "2-digit");
  const out = o.hour ? d.toLocaleString(currentLocale(), o) : d.toLocaleDateString(currentLocale(), o);
  if (currentLang() !== "ne" || !named || (/[\u0900-\u097F]/.test(out) && !/\bM\d/.test(out))) return out;
  const parts: string[] = [];
  if (o.weekday) parts.push((o.weekday === "long" ? NE_DAYS : o.weekday === "short" ? NE_SHORT : NE_NARROW)[d.getDay()]);
  const md: string[] = [];
  if (o.day) md.push(String(d.getDate()));
  if (o.month) md.push(NE_MONTHS[d.getMonth()]);
  if (o.year) md.push(String(d.getFullYear()));
  if (md.length) parts.push(md.join(" "));
  if (o.hour) parts.push(d.toLocaleTimeString(currentLocale(), { hour: o.hour, minute: o.minute }));
  return parts.join(", ");
}
