/**
 * R119: helpdesk mode for the shared inbox and the website chat. Pure rules shared by the server, the web app and
 * the tests: business hours, SLA clocks with pauses, status transitions, macros, saved reply answers, origin checks.
 */
import { z } from "zod";

export const TICKET_STATUSES = ["open", "pending", "on_hold", "solved"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export const TICKET_KINDS = ["mail", "chat", "web"] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];
export const TICKET_VIEWS = ["open", "mine", "unassigned", "breaching", "solved", "all"] as const;
export type TicketView = (typeof TICKET_VIEWS)[number];

export const STATUS_LABEL: Record<TicketStatus, string> = { open: "Open", pending: "Waiting on customer", on_hold: "On hold", solved: "Solved" };
export const PRIORITY_LABEL: Record<TicketPriority, string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };
export const KIND_LABEL: Record<TicketKind, string> = { mail: "Email", chat: "Chat", web: "Website chat" };

/** Minutes after midnight, local time. A day is closed when null. Index 0 is Sunday. */
export const DayHours = z.object({ start: z.number().int().min(0).max(1439), end: z.number().int().min(1).max(1440) })
  .refine((d) => d.end > d.start, { message: "The day must end after it starts." });
export type DayHours = z.infer<typeof DayHours>;
export const BusinessHours = z.object({
  /** Every hour of every day counts (no business hours). */
  always: z.boolean().default(false),
  timezone: z.string().min(1).max(64),
  days: z.array(DayHours.nullable()).length(7),
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(60).default([]),
});
export type BusinessHours = z.infer<typeof BusinessHours>;

const Target = z.object({ first: z.number().int().min(5).max(43_200), resolve: z.number().int().min(5).max(129_600) });
export type SlaTarget = z.infer<typeof Target>;
export const SlaTargets = z.object({ urgent: Target, high: Target, normal: Target, low: Target });
export type SlaTargets = z.infer<typeof SlaTargets>;

export const DOMAIN_MAX = 20;
export const WidgetSettings = z.object({
  on: z.boolean().default(false),
  title: z.string().trim().min(1).max(60).default("Chat with us"),
  greeting: z.string().trim().max(300).default("Hi there. Ask us anything and we will reply here."),
  /** A #rrggbb override; null follows the workspace brand. */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().default(null),
  domains: z.array(z.string().trim().min(1).max(253)).max(DOMAIN_MAX).default([]),
  /** Replies to visitors who left an email and went away (and offline messages) go out from this mailbox. */
  mailboxId: z.string().max(64).nullable().default(null),
  botAnswers: z.boolean().default(true),
  askEmail: z.enum(["before", "after", "never"]).default("after"),
});
export type WidgetSettings = z.infer<typeof WidgetSettings>;

export const HelpdeskSettings = z.object({
  mailboxIds: z.array(z.string().max(64)).max(50).default([]),
  chats: z.boolean().default(false),
  hours: BusinessHours,
  sla: SlaTargets,
  csat: z.object({ on: z.boolean().default(false) }).default({ on: false }),
  widget: WidgetSettings,
});
export type HelpdeskSettings = z.infer<typeof HelpdeskSettings>;
export const HelpdeskSettingsPatch = HelpdeskSettings.partial();

export const DEFAULT_SLA: SlaTargets = {
  urgent: { first: 60, resolve: 240 },
  high: { first: 240, resolve: 1440 },
  normal: { first: 480, resolve: 2880 },
  low: { first: 1440, resolve: 5760 },
};
const NINE_TO_FIVE: DayHours = { start: 540, end: 1020 };
export function defaultSettings(timezone = "Australia/Sydney"): HelpdeskSettings {
  return {
    mailboxIds: [], chats: false,
    hours: { always: false, timezone, days: [null, NINE_TO_FIVE, NINE_TO_FIVE, NINE_TO_FIVE, NINE_TO_FIVE, NINE_TO_FIVE, null], holidays: [] },
    sla: DEFAULT_SLA, csat: { on: false },
    widget: WidgetSettings.parse({}),
  };
}
/** Stored JSON, read leniently: anything missing or broken falls back to the default for that part. */
export function readSettings(raw: string | null | undefined, timezone?: string): HelpdeskSettings {
  const d = defaultSettings(timezone);
  if (!raw) return d;
  let j: Record<string, unknown>;
  try { j = JSON.parse(raw) as Record<string, unknown>; } catch { return d; }
  const pick = <T,>(schema: z.ZodType<T>, v: unknown, fb: T): T => { const r = schema.safeParse(v); return r.success ? r.data : fb; };
  return {
    mailboxIds: pick(z.array(z.string()), j.mailboxIds, d.mailboxIds),
    chats: pick(z.boolean(), j.chats, d.chats),
    hours: pick(BusinessHours, j.hours, d.hours),
    sla: pick(SlaTargets, j.sla, d.sla),
    csat: pick(z.object({ on: z.boolean() }), j.csat, d.csat),
    widget: pick(WidgetSettings, j.widget, d.widget),
  };
}

// ---------- time zones and business hours ----------

const MIN = 60_000;
const DAY_MS = 86_400_000;
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", weekday: "short" });
    fmtCache.set(tz, f);
  }
  return f;
}
export function validTimezone(tz: string): boolean {
  try { fmt(tz).format(0); return true; } catch { return false; }
}
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
/** Local calendar parts of an instant in a zone. */
export function localParts(ms: number, tz: string) {
  const p: Record<string, string> = {};
  for (const x of fmt(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second, weekday: WD[p.weekday] ?? 0 };
}
/** Minutes the zone is ahead of UTC at an instant. */
export function tzOffset(ms: number, tz: string): number {
  const l = localParts(ms, tz);
  return Math.round((Date.UTC(l.y, l.m - 1, l.d, l.hour, l.minute, l.second) - Math.floor(ms / 1000) * 1000) / MIN);
}
/** The instant a local wall clock time happens (a time skipped by a clock change moves forward). */
export function localToUtc(y: number, m: number, d: number, minuteOfDay: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, 0, minuteOfDay);
  let t = guess - tzOffset(guess, tz) * MIN;
  t = guess - tzOffset(t, tz) * MIN;
  return t;
}
const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const hasOpenDay = (h: BusinessHours) => h.days.some(Boolean);
const LOOKAHEAD_DAYS = 400;

/** Open windows [start, end) in UTC ms that overlap [from, to), day by day in the zone. */
function* windows(from: number, h: BusinessHours, to = Number.POSITIVE_INFINITY): Generator<[number, number]> {
  const start = localParts(from - DAY_MS, h.timezone);
  let cursor = Date.UTC(start.y, start.m - 1, start.d);
  const holidays = new Set(h.holidays);
  for (let i = 0; i < LOOKAHEAD_DAYS + 2; i++, cursor += DAY_MS) {
    const c = new Date(cursor);
    const y = c.getUTCFullYear(), m = c.getUTCMonth() + 1, d = c.getUTCDate();
    const dayStart = localToUtc(y, m, d, 0, h.timezone);
    if (dayStart >= to) return;
    const hours = h.days[c.getUTCDay()];
    if (!hours || holidays.has(ymd(y, m, d))) continue;
    const a = Math.max(from, localToUtc(y, m, d, hours.start, h.timezone));
    const b = Math.min(to, localToUtc(y, m, d, hours.end, h.timezone));
    if (b > a) yield [a, b];
  }
}
const isAlways = (h: BusinessHours | null | undefined) => !h || h.always || !hasOpenDay(h);

/** Working minutes between two instants (0 when to is before from). */
export function businessMinutesBetween(from: number, to: number, h: BusinessHours | null): number {
  if (to <= from) return 0;
  if (isAlways(h)) return (to - from) / MIN;
  let total = 0;
  for (const [a, b] of windows(from, h!, to)) total += b - a;
  return total / MIN;
}
/** The instant a number of working minutes after from. */
export function addBusinessMinutes(from: number, minutes: number, h: BusinessHours | null): number {
  if (minutes <= 0) return from;
  if (isAlways(h)) return from + minutes * MIN;
  let left = minutes * MIN;
  for (const [a, b] of windows(from, h!)) {
    if (b - a >= left) return a + left;
    left -= b - a;
  }
  return from + minutes * MIN;
}
export function isOpenAt(ms: number, h: BusinessHours | null): boolean {
  if (isAlways(h)) return true;
  for (const [a, b] of windows(ms, h!, ms + 1)) if (ms >= a && ms < b) return true;
  return false;
}
/** The next moment the team is open (now when open), or null when no day is open. */
export function nextOpening(ms: number, h: BusinessHours | null): number | null {
  if (isAlways(h)) return ms;
  for (const [a] of windows(ms, h!)) return a;
  return null;
}

// ---------- SLA clocks and status transitions ----------

/** The clock fields stored on a ticket (epoch ms). */
export interface SlaClock {
  status: TicketStatus;
  priority: TicketPriority;
  createdAt: number;
  firstReplyAt: number | null;
  firstReplyDueAt: number | null;
  resolveDueAt: number | null;
  /** Working minutes the resolve clock already ran before its current run. */
  resolveUsedMin: number;
  /** Start of the current run; null while paused or solved. */
  runningSince: number | null;
  solvedAt: number | null;
}
export interface SlaConfig { hours: BusinessHours | null; sla: SlaTargets }

export const isRunning = (s: TicketStatus) => s === "open";

export function newClock(now: number, priority: TicketPriority, cfg: SlaConfig): SlaClock {
  const t = cfg.sla[priority];
  return {
    status: "open", priority, createdAt: now, firstReplyAt: null,
    firstReplyDueAt: addBusinessMinutes(now, t.first, cfg.hours),
    resolveDueAt: addBusinessMinutes(now, t.resolve, cfg.hours),
    resolveUsedMin: 0, runningSince: now, solvedAt: null,
  };
}

function resolveDue(now: number, used: number, target: number, h: BusinessHours | null) {
  const left = target - used;
  return left > 0 ? addBusinessMinutes(now, left, h) : now - Math.round(-left) * MIN;
}

/** Moves a ticket to a status; pausing and resuming keep the resolve clock honest. Same status: no change. */
export function transition(c: SlaClock, to: TicketStatus, now: number, cfg: SlaConfig): SlaClock {
  if (!TICKET_STATUSES.includes(to)) throw new Error("bad status");
  if (c.status === to) return c;
  const n: SlaClock = { ...c, status: to };
  if (c.runningSince != null) {
    n.resolveUsedMin = c.resolveUsedMin + businessMinutesBetween(c.runningSince, now, cfg.hours);
    n.runningSince = null;
    n.resolveDueAt = null;
  }
  if (to === "open") {
    n.runningSince = now;
    n.solvedAt = null;
    n.resolveDueAt = resolveDue(now, n.resolveUsedMin, cfg.sla[c.priority].resolve, cfg.hours);
  } else if (to === "solved") {
    n.solvedAt = now;
  }
  return n;
}

/** A new priority moves the due times to the new targets (time already used still counts). */
export function changePriority(c: SlaClock, p: TicketPriority, now: number, cfg: SlaConfig): SlaClock {
  if (c.priority === p) return c;
  const t = cfg.sla[p];
  const n: SlaClock = { ...c, priority: p };
  if (c.firstReplyAt == null) n.firstReplyDueAt = addBusinessMinutes(c.createdAt, t.first, cfg.hours);
  if (c.runningSince != null) {
    const used = c.resolveUsedMin + businessMinutesBetween(c.runningSince, now, cfg.hours);
    n.resolveDueAt = resolveDue(now, used, t.resolve, cfg.hours);
    n.resolveUsedMin = used;
    n.runningSince = now;
  }
  return n;
}

/** The customer wrote again: a waiting, held or solved ticket opens again. */
export function onCustomerMessage(c: SlaClock, now: number, cfg: SlaConfig): SlaClock {
  return c.status === "open" ? c : transition(c, "open", now, cfg);
}
/** The team replied: the first reply clock stops for good. */
export function onTeamReply(c: SlaClock, now: number): SlaClock {
  return c.firstReplyAt != null ? c : { ...c, firstReplyAt: now };
}

export type SlaLevel = "ok" | "warn" | "breached" | "met" | "paused" | "none";
export interface SlaPart { level: SlaLevel; dueAt: number | null; leftMin: number | null }
export interface SlaView { first: SlaPart; resolve: SlaPart; worst: SlaLevel }
/** Share of the target left at which a ticket shows as about to breach. */
export const WARN_SHARE = 0.25;

function part(dueAt: number | null, now: number, target: number, h: BusinessHours | null): SlaPart {
  if (dueAt == null) return { level: "none", dueAt: null, leftMin: null };
  if (dueAt <= now) return { level: "breached", dueAt, leftMin: -Math.round((now - dueAt) / MIN) };
  const left = businessMinutesBetween(now, dueAt, h);
  return { level: left <= target * WARN_SHARE ? "warn" : "ok", dueAt, leftMin: Math.round(left) };
}
const RANK: Record<SlaLevel, number> = { breached: 5, warn: 4, ok: 3, paused: 2, met: 1, none: 0 };

export function slaView(c: SlaClock, now: number, cfg: SlaConfig): SlaView {
  const t = cfg.sla[c.priority];
  const first: SlaPart = c.firstReplyAt != null
    ? { level: c.firstReplyDueAt != null && c.firstReplyAt > c.firstReplyDueAt ? "breached" : "met", dueAt: c.firstReplyDueAt, leftMin: null }
    : c.status === "solved" ? { level: "none", dueAt: null, leftMin: null }
    : part(c.firstReplyDueAt, now, t.first, cfg.hours);
  let resolve: SlaPart;
  if (c.status === "solved") resolve = { level: "met", dueAt: null, leftMin: null };
  else if (c.runningSince == null) {
    const left = Math.round(t.resolve - c.resolveUsedMin);
    resolve = { level: left < 0 ? "breached" : "paused", dueAt: null, leftMin: left };
  } else resolve = part(c.resolveDueAt, now, t.resolve, cfg.hours);
  // A met first reply that was late still counts against the ticket, but it is history: only live clocks rank.
  const live = [first.level === "met" ? "none" : first.level === "breached" && c.firstReplyAt != null ? "none" : first.level, resolve.level] as SlaLevel[];
  const worst = live.reduce((w, l) => (RANK[l] > RANK[w] ? l : w), "none" as SlaLevel);
  return { first, resolve, worst };
}
export const isBreaching = (v: SlaView) => v.worst === "breached" || v.worst === "warn";

/** "2h 5m", "45m", "3d 4h": working time in short words. */
export function shortDuration(min: number): string {
  const m = Math.max(0, Math.round(Math.abs(min)));
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return `${d}d${h ? ` ${h}h` : ""}`;
}
export function slaLabel(p: SlaPart, what: "First reply" | "Resolve"): string {
  switch (p.level) {
    case "breached": return p.leftMin != null && p.leftMin < 0 ? `${what} overdue by ${shortDuration(-p.leftMin)}` : `${what} was late`;
    case "warn": case "ok": return `${what} due in ${shortDuration(p.leftMin ?? 0)}`;
    case "paused": return `${what} paused, ${shortDuration(p.leftMin ?? 0)} left`;
    case "met": return `${what} on time`;
    default: return "";
  }
}

// ---------- macros ----------

export const MACRO_STEPS_MAX = 10;
export const MacroStep = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status"), status: z.enum(TICKET_STATUSES) }),
  z.object({ type: z.literal("priority"), priority: z.enum(TICKET_PRIORITIES) }),
  z.object({ type: z.literal("assign"), to: z.string().min(1).max(64) }), // "me", "none" or a user id
  z.object({ type: z.literal("note"), text: z.string().trim().min(1).max(2000) }),
  z.object({ type: z.literal("reply"), text: z.string().max(4000).optional(), snippetId: z.string().max(64).optional() })
    .refine((s) => !!(s.text?.trim() || s.snippetId), { message: "A reply step needs text or a saved reply." }),
]);
export type MacroStep = z.infer<typeof MacroStep>;
export const MacroInput = z.object({ name: z.string().trim().min(1).max(80), steps: z.array(MacroStep).min(1).max(MACRO_STEPS_MAX) });
export type MacroInput = z.infer<typeof MacroInput>;

export interface MacroPlan {
  status?: TicketStatus;
  priority?: TicketPriority;
  /** undefined: unchanged; null: nobody. */
  assignee?: string | null;
  notes: string[];
  reply: { text: string | null; snippetId: string | null } | null;
}
/** Folds the steps in order: a later step wins for the same field; notes add up; the reply is the last one. */
export function planMacro(steps: MacroStep[], me: string): MacroPlan {
  const p: MacroPlan = { notes: [], reply: null };
  for (const s of steps.slice(0, MACRO_STEPS_MAX)) {
    if (s.type === "status") p.status = s.status;
    else if (s.type === "priority") p.priority = s.priority;
    else if (s.type === "assign") p.assignee = s.to === "none" ? null : s.to === "me" ? me : s.to;
    else if (s.type === "note") p.notes.push(s.text);
    else p.reply = { text: s.text?.trim() || null, snippetId: s.snippetId || null };
  }
  return p;
}
export function describeStep(s: MacroStep, names: { person?: (id: string) => string | undefined; snippet?: (id: string) => string | undefined } = {}): string {
  switch (s.type) {
    case "status": return `Set status to ${STATUS_LABEL[s.status].toLowerCase()}`;
    case "priority": return `Set priority to ${PRIORITY_LABEL[s.priority].toLowerCase()}`;
    case "assign": return s.to === "me" ? "Assign to me" : s.to === "none" ? "Unassign" : `Assign to ${names.person?.(s.to) ?? "a teammate"}`;
    case "note": return "Add a note";
    case "reply": return s.snippetId ? `Insert reply: ${names.snippet?.(s.snippetId) ?? "saved reply"}` : "Insert reply text";
  }
}

// ---------- automatic answers from saved replies ----------

const STOP = new Set("the and for you your our are was were with this that have has had not but can could would should will what when where which who how why does did from into about any all its it's i'm im hi hello hey there please thanks thank just like want need get got".split(" "));
export function words(s: string): string[] {
  return [...new Set(s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)))].map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w));
}
export interface AnswerCandidate { id: string; name: string; body: string }
/** The saved reply that best answers a first question, or null when nothing is a clear match. */
export function bestAnswer(question: string, candidates: AnswerCandidate[]): { id: string; score: number } | null {
  const q = words(question);
  if (!q.length) return null;
  let best: { id: string; score: number } | null = null;
  for (const c of candidates) {
    const name = new Set(words(c.name)), body = new Set(words(c.body));
    let nameHits = 0, bodyHits = 0;
    for (const w of q) { if (name.has(w)) nameHits++; else if (body.has(w)) bodyHits++; }
    if (!nameHits) continue; // the saved reply's name must speak to the question
    const score = (2 * nameHits + bodyHits) / (2 * q.length);
    if (score >= 0.35 && (!best || score > best.score)) best = { id: c.id, score: Math.round(score * 100) / 100 };
  }
  return best;
}

// ---------- website chat guard ----------

/** A domain as typed ("https://www.Shop.com/x" -> "www.shop.com"), or null when it is not a host name. */
export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/^\*\./, "").replace(/\.$/, "");
  if (s === "localhost") return s;
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(s) ? s : null;
}
/** The page's Origin is allowed when its host is a listed domain or under one. */
export function originAllowed(origin: string | null | undefined, domains: string[], extra: string[] = []): boolean {
  if (!origin) return false;
  let host: string;
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    host = u.hostname.toLowerCase();
  } catch { return false; }
  for (const e of extra) { try { if (new URL(e).origin === new URL(origin).origin) return true; } catch { /* skip */ } }
  return domains.some((d) => { const n = normalizeDomain(d); return !!n && (host === n || host.endsWith(`.${n}`)); });
}
export const WIDGET_TEXT_MAX = 2000;
export const WIDGET_NAME_MAX = 80;
/** Visitor text: control characters out, spaces tidied, capped. */
export function cleanVisitorText(s: string, max = WIDGET_TEXT_MAX): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, "").replace(/\r\n?/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim().slice(0, max);
}
export const emailOk = (s: string) => s.length <= 254 && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/.test(s);

export const CSAT_RATINGS = ["great", "okay", "bad"] as const;
export type CsatRating = (typeof CSAT_RATINGS)[number];
export const CSAT_LABEL: Record<CsatRating, string> = { great: "Great", okay: "Okay", bad: "Not good" };
