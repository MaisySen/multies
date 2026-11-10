/**
 * Round 23 (R23.4): calendar sync.
 *
 * Out: each person can turn on a calendar feed, /cal/<token>.ics, for Google Calendar, Apple
 * Calendar or Outlook. The token is the only key: only its SHA-256 hash and a four character hint
 * are kept, and a reset replaces the hash so the old address stops at once. The feed holds the
 * person's meetings (they made them, are invited by email, or the call came from one of their
 * channels or DMs; a weekly series is one event with its RRULE) and the due dates of the tasks
 * assigned to them, 30 days back to 180 days ahead, at most 1,000 items. Serving it writes nothing.
 *
 * In: read only "other calendars" for one person: a connected mailbox's CalDAV account (same user
 * name and app password) or a secret ICS link (stored encrypted). Events are fetched when the
 * calendar opens and kept in memory for a few minutes; they are never written to the database.
 */
import { and, eq, gte, isNotNull, isNull, lt, ne, or } from "drizzle-orm";
import type { Deps } from "../../context";
import { calendarFeeds, calendarSources, chatMembers, mailConnections, mailboxes, meetings, members, organizations, projects, tasks, users } from "../../db/schema";
import { decryptSecret, encryptSecret, randomToken, safeEqual, sha256Hex } from "../../lib/crypto";
import { forbidden, HttpError, notFound } from "../../lib/errors";
import { assertWritable, sortableId, type SuiteActor } from "./common";
import { isPersonalOwner } from "../mail-access-priv1a";
import { buildFeed, type FeedDue, type FeedMeeting } from "./ics-write";
import { eventsIn, type ExternalEvent } from "./ics-parse";
import { CALDAV_BASES, CALDAV_NEEDS_OAUTH, checkUrl, davRequest, discoverCalendars, reportEvents, type DavOptions, type RemoteCalendar } from "./caldav";
import { expandWeekly, parseRrule } from "./meeting-recurrence";
import { zonedDate } from "./scheduling";

const DAY = 86_400_000;
export const FEED_DAYS_BACK = 30;
export const FEED_DAYS_AHEAD = 180;
export const FEED_MAX_ITEMS = 1000;
/** The longest window the events list answers for in one call. */
export const EVENTS_MAX_DAYS = 100;
/** Other calendars are cached this long per isolate. */
export const EXTERNAL_CACHE_MS = 5 * 60_000;
export const MAX_SOURCES = 10;

const TOKEN_RE = /^[A-Za-z0-9]{24,64}$/;
const pad = (n: number) => String(n).padStart(2, "0");

/** A person, not a workspace key: a session, or a person's OAuth token. */
export function isPerson(a: SuiteActor) {
  return !!a.userId && !a.agentId && (!a.apiKeyId || a.apiKeyId.startsWith("oauth:"));
}
/** The feed belongs to a user: a person, the person who made a workspace key, or an agent member. */
function userOnly(a: SuiteActor) {
  if (!a.userId) throw new HttpError(403, "person_only", "A calendar feed belongs to a person. Use the app, or a key made by a person.");
}
function personOnly(a: SuiteActor) {
  if (!isPerson(a)) throw new HttpError(403, "person_only", "Calendar feeds and other calendars belong to a person. Use the app or a person's sign in, not a workspace key.");
}

// ---------------------------------------------------------------- feed out

const feedUrl = (deps: Deps, token: string) => `${deps.config.appUrl}/cal/${token}.ics`;
const webcal = (url: string) => url.replace(/^https?:/, "webcal:");

export async function feedStatus(deps: Deps, actor: SuiteActor) {
  userOnly(actor);
  const row = await deps.db.select().from(calendarFeeds).where(and(eq(calendarFeeds.orgId, actor.orgId), eq(calendarFeeds.userId, actor.userId))).get();
  if (!row) return { enabled: false as const, hint: null, includeTasks: true, createdAt: null, resetAt: null };
  return { enabled: true as const, hint: row.hint, includeTasks: row.includeTasks, createdAt: row.createdAt.toISOString(), resetAt: row.resetAt ? row.resetAt.toISOString() : null };
}

/**
 * Turns the feed on, or gives it a new address (the old one answers 404 at once). The address is
 * shown only in this answer; afterwards only its hint is.
 */
export async function resetFeed(deps: Deps, actor: SuiteActor, opts: { includeTasks?: boolean } = {}) {
  userOnly(actor);
  assertWritable(actor);
  const token = randomToken(30).replace(/[^A-Za-z0-9]/g, "").slice(0, 32);
  const hash = await sha256Hex(token);
  const hint = token.slice(-4);
  const now = deps.now();
  const existing = await deps.db.select({ inc: calendarFeeds.includeTasks }).from(calendarFeeds).where(and(eq(calendarFeeds.orgId, actor.orgId), eq(calendarFeeds.userId, actor.userId))).get();
  if (existing) {
    await deps.db.update(calendarFeeds).set({ tokenHash: hash, hint, resetAt: now, ...(opts.includeTasks !== undefined ? { includeTasks: opts.includeTasks } : {}) })
      .where(and(eq(calendarFeeds.orgId, actor.orgId), eq(calendarFeeds.userId, actor.userId)));
  } else {
    await deps.db.insert(calendarFeeds).values({ orgId: actor.orgId, userId: actor.userId, tokenHash: hash, hint, includeTasks: opts.includeTasks ?? true, createdAt: now });
  }
  const url = feedUrl(deps, token);
  return { ...(await feedStatus(deps, actor)), url, webcalUrl: webcal(url) };
}

export async function updateFeed(deps: Deps, actor: SuiteActor, patch: { includeTasks: boolean }) {
  userOnly(actor);
  assertWritable(actor);
  const r = await deps.db.update(calendarFeeds).set({ includeTasks: patch.includeTasks }).where(and(eq(calendarFeeds.orgId, actor.orgId), eq(calendarFeeds.userId, actor.userId))).returning({ hint: calendarFeeds.hint });
  if (!r.length) throw notFound("Calendar feed");
  return feedStatus(deps, actor);
}

export async function disableFeed(deps: Deps, actor: SuiteActor) {
  userOnly(actor);
  assertWritable(actor);
  await deps.db.delete(calendarFeeds).where(and(eq(calendarFeeds.orgId, actor.orgId), eq(calendarFeeds.userId, actor.userId)));
  return { ok: true as const };
}

/** Meetings and due tasks in [from, to) for one person, or (person null) for the whole workspace. */
export async function workItems(deps: Deps, orgId: string, person: { id: string; email: string } | null, from: Date, to: Date, opts: { includeTasks: boolean; limit: number }) {
  const rows = await deps.db.select().from(meetings).where(and(
    eq(meetings.orgId, orgId), isNull(meetings.deletedAt), lt(meetings.startsAt, to),
    or(gte(meetings.startsAt, new Date(from.getTime() - DAY)), isNotNull(meetings.recurrence)),
  )).limit(opts.limit * 2);
  let mine = rows;
  if (person) {
    const channels = new Set((await deps.db.select({ id: chatMembers.channelId }).from(chatMembers).where(and(eq(chatMembers.userId, person.id), eq(chatMembers.orgId, orgId)))).map((r) => r.id));
    const email = person.email.toLowerCase();
    mine = rows.filter((m) => (m.createdByType === "member" && m.createdById === person.id)
      || (JSON.parse(m.invitees) as string[]).some((e) => e.toLowerCase() === email)
      || (!!m.channelId && channels.has(m.channelId)));
  }
  const dues = opts.includeTasks ? await deps.db.select({ t: tasks, key: projects.key, project: projects.name }).from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(
      eq(tasks.orgId, orgId), isNull(tasks.deletedAt), isNull(tasks.triageState), ne(tasks.status, "done"),
      gte(tasks.dueAt, new Date(from.getTime() - DAY)), lt(tasks.dueAt, new Date(to.getTime() + DAY)),
      person ? and(eq(tasks.assigneeType, "member"), eq(tasks.assigneeId, person.id)) : undefined,
    )).orderBy(tasks.dueAt).limit(opts.limit) : [];
  return { meetings: mine.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()).slice(0, opts.limit), dues };
}

export async function zoneOf(deps: Deps, orgId: string, userId: string | null) {
  const u = userId ? await deps.db.select({ tz: users.timezone }).from(users).where(eq(users.id, userId)).get() : undefined;
  if (u?.tz) return u.tz;
  const o = await deps.db.select({ tz: organizations.timezone }).from(organizations).where(eq(organizations.id, orgId)).get();
  return o?.tz ?? "UTC";
}
const ymd = (d: Date, tz: string) => { const z = zonedDate(d, tz); return `${z.y}-${pad(z.m)}-${pad(z.d)}`; };

/** Feed fetches allowed per token per minute (counted in memory by the route). */
export const FEED_RATE_PER_MIN = 30;

/**
 * The feed for a token: null when the token is unknown, reset, turned off, or its person has left
 * the workspace. Reads only (no last used write).
 */
export async function serveFeed(deps: Deps, token: string): Promise<{ body: string; etag: string } | null> {
  if (!TOKEN_RE.test(token)) return null;
  const hash = await sha256Hex(token);
  const row = await deps.db.select({ f: calendarFeeds, email: users.email, role: members.role }).from(calendarFeeds)
    .innerJoin(users, eq(users.id, calendarFeeds.userId))
    .leftJoin(members, and(eq(members.userId, calendarFeeds.userId), eq(members.organizationId, calendarFeeds.orgId)))
    .where(eq(calendarFeeds.tokenHash, hash)).get();
  if (!row || !row.role || !safeEqual(row.f.tokenHash, hash)) return null;
  const now = deps.now();
  const from = new Date(now.getTime() - FEED_DAYS_BACK * DAY), to = new Date(now.getTime() + FEED_DAYS_AHEAD * DAY);
  const items = await workItems(deps, row.f.orgId, { id: row.f.userId, email: row.email }, from, to, { includeTasks: row.f.includeTasks, limit: FEED_MAX_ITEMS });
  const tz = await zoneOf(deps, row.f.orgId, row.f.userId);
  const app = deps.config.appUrl;
  const ms: FeedMeeting[] = items.meetings.map((m) => ({ id: m.id, title: m.title, startsAt: m.startsAt, durationMin: m.durationMin, status: m.status, recurrence: m.recurrence, recurrenceTz: m.recurrenceTz, version: m.version, updatedAt: m.updatedAt, url: `${app}/app/meetings/${m.id}` }));
  const ds: FeedDue[] = items.dues.slice(0, Math.max(0, FEED_MAX_ITEMS - ms.length)).map(({ t, key, project }) => ({ id: t.id, title: t.title, ref: `${key}-${t.number}`, project, due: ymd(t.dueAt!, tz), url: `${app}/app/tasks?task=${t.id}`, version: t.version, updatedAt: t.updatedAt }));
  const body = buildFeed({ meetings: ms, dues: ds });
  const etag = `"${(await sha256Hex(body)).slice(0, 32)}"`;
  return { body, etag };
}

// ---------------------------------------------------------------- events (Multies and other calendars)

export interface CalendarEvent {
  id: string;
  kind: "meeting" | "due" | "external";
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  url: string | null;
  /** Other calendars: which one, its name and colour. Always read only. */
  sourceId: string | null;
  sourceName: string | null;
  color: string | null;
  readOnly: boolean;
  location?: string | null;
}

export function windowOf(fromS?: string, toS?: string, now = new Date()) {
  const from = fromS ? new Date(fromS) : new Date(now.getTime() - 7 * DAY);
  const to = toS ? new Date(toS) : new Date(from.getTime() + 35 * DAY);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new HttpError(422, "validation_failed", "Give from and to as dates, for example 2026-11-01.");
  if (to <= from) throw new HttpError(422, "validation_failed", "to must be after from.");
  if (to.getTime() - from.getTime() > EVENTS_MAX_DAYS * DAY) throw new HttpError(422, "validation_failed", `Ask for at most ${EVENTS_MAX_DAYS} days at a time.`);
  return { from, to };
}

/**
 * Meetings and due dates in a window, plus (for a person) their other calendars. A workspace or
 * agent key sees every meeting and due date in the workspace and no other calendars.
 */
export async function listCalendarEvents(deps: Deps, actor: SuiteActor, q: { from?: string; to?: string; external?: boolean } = {}) {
  const { from, to } = windowOf(q.from, q.to, deps.now());
  const person = isPerson(actor) ? { id: actor.userId, email: actor.email } : null;
  const items = await workItems(deps, actor.orgId, person, from, to, { includeTasks: true, limit: FEED_MAX_ITEMS });
  const tz = await zoneOf(deps, actor.orgId, person?.id ?? null);
  const app = deps.config.appUrl;
  const events: CalendarEvent[] = [];
  for (const m of items.meetings) {
    if (m.status === "cancelled") continue;
    let starts = [m.startsAt];
    if (m.recurrence) {
      const stz = m.recurrenceTz || "UTC";
      try { starts = expandWeekly(m.startsAt, parseRrule(m.recurrence, stz), stz, from, to, 400); } catch { starts = [m.startsAt]; }
    }
    for (const s of starts) {
      const e = new Date(s.getTime() + m.durationMin * 60_000);
      if (s >= to || e <= from) continue;
      events.push({ id: m.recurrence ? `${m.id}:${s.toISOString()}` : m.id, kind: "meeting", title: m.title, start: s.toISOString(), end: e.toISOString(), allDay: false, url: `${app}/app/meetings/${m.id}`, sourceId: null, sourceName: null, color: null, readOnly: false });
    }
  }
  for (const { t, key } of items.dues) {
    const day = ymd(t.dueAt!, tz);
    const [y, mo, d] = day.split("-").map(Number);
    if (Date.UTC(y, mo - 1, d) >= to.getTime() || Date.UTC(y, mo - 1, d + 1) <= from.getTime()) continue;
    const next = new Date(Date.UTC(y, mo - 1, d + 1));
    events.push({ id: `task:${t.id}`, kind: "due", title: `Due: ${t.title} (${key}-${t.number})`, start: day, end: `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`, allDay: true, url: `${app}/app/tasks?task=${t.id}`, sourceId: null, sourceName: null, color: null, readOnly: false });
  }
  const errors: { sourceId: string; name: string; message: string }[] = [];
  if (person && q.external !== false) {
    const ext = await externalEvents(deps, actor, from, to, tz);
    events.push(...ext.events);
    errors.push(...ext.errors);
  }
  events.sort((a, b) => a.start.localeCompare(b.start));
  return { from: from.toISOString(), to: to.toISOString(), timezone: tz, events: events.slice(0, 3000), errors };
}

// ---------------------------------------------------------------- other calendars (in)

type SourceRow = typeof calendarSources.$inferSelect;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function presentSource(s: SourceRow, extra: { address?: string | null; host?: string | null } = {}) {
  return {
    id: s.id, kind: s.kind, name: s.name, color: s.color, enabled: s.enabled, createdAt: s.createdAt.toISOString(),
    connectionId: s.connectionId, address: extra.address ?? null,
    /** For an ICS link only its host is shown: the full address is a secret and is never sent back. */
    host: extra.host ?? null,
    calendars: s.kind === "caldav" ? (JSON.parse(s.calendars) as RemoteCalendar[]).map((c) => ({ name: c.name, color: c.color })) : [],
  };
}
export type CalendarSource = ReturnType<typeof presentSource>;

const davOpts = (deps: Deps): DavOptions => ({ fetch: (u, i) => deps.fetch(u, i), allowPrivateHosts: deps.config.mailConnect.allowPrivateHosts });

export async function listSources(deps: Deps, actor: SuiteActor) {
  personOnly(actor);
  const rows = await deps.db.select({ s: calendarSources, address: mailConnections.email }).from(calendarSources)
    .leftJoin(mailConnections, eq(mailConnections.id, calendarSources.connectionId))
    .where(and(eq(calendarSources.orgId, actor.orgId), eq(calendarSources.userId, actor.userId))).orderBy(calendarSources.createdAt);
  const out: CalendarSource[] = [];
  for (const r of rows) {
    let host: string | null = null;
    if (r.s.kind === "ics" && r.s.urlEnc) { try { host = new URL(await decryptSecret(deps.config.appSecret, r.s.urlEnc)).hostname; } catch { host = null; } }
    out.push(presentSource(r.s, { address: r.address, host }));
  }
  return out;
}

/**
 * PRIV1b (P62, S2): a connection on a personal mailbox is its owner's (the workspace owner's when it has none), not
 * whoever connected it, so its stored password reads only the owner's calendar. Team mailboxes: the connector, as before.
 */
async function connectionIsMine(deps: Deps, actor: SuiteActor, c: { mailboxId: string; createdByUserId: string | null }) {
  const own = await isPersonalOwner(deps.db, { userId: actor.userId, orgId: actor.orgId, role: actor.role }, c.mailboxId);
  return own === undefined ? c.createdByUserId === actor.userId : own;
}

/** The person's own connected mailboxes and whether each one's provider serves its calendar over CalDAV. */
export async function calendarOptions(deps: Deps, actor: SuiteActor) {
  personOnly(actor);
  // PRIV1b (P62, S2): mine = connected by me on a team mailbox, or on a personal mailbox I own.
  const rows = (await deps.db.select({ c: mailConnections, personal: mailboxes.personal, owner: mailboxes.ownerUserId }).from(mailConnections)
    .innerJoin(mailboxes, eq(mailboxes.id, mailConnections.mailboxId))
    .where(and(eq(mailConnections.orgId, actor.orgId), or(eq(mailConnections.createdByUserId, actor.userId), eq(mailboxes.ownerUserId, actor.userId)))))
    .filter((r) => r.personal ? r.owner === actor.userId : r.c.createdByUserId === actor.userId).map((r) => r.c);
  return rows.map((c) => {
    const oauth = CALDAV_NEEDS_OAUTH[c.provider];
    return {
      connectionId: c.id, address: c.email, provider: c.provider,
      caldav: !oauth,
      message: oauth
        ? `Calendar from ${c.provider.startsWith("google") || c.provider === "gmail" ? "Gmail" : "Outlook"} needs ${oauth} sign in, coming later. For now, add its secret ICS address.`
        : CALDAV_BASES[c.provider] ? null : "Multies will look for the calendar on your mail server. If it is somewhere else, give its CalDAV address.",
    };
  });
}

async function sourceRow(deps: Deps, actor: SuiteActor, id: string) {
  const s = await deps.db.select().from(calendarSources).where(and(eq(calendarSources.orgId, actor.orgId), eq(calendarSources.userId, actor.userId), eq(calendarSources.id, id))).get();
  if (!s) throw notFound("Calendar");
  return s;
}

/** Muted colours given to other calendars in turn (they draw read only, under the workspace's own). */
const PALETTE = ["#5E8AB4", "#8E7CC3", "#6AA084", "#C4895A", "#B5727F", "#8E8E93"];

async function countSources(deps: Deps, actor: SuiteActor) {
  const n = (await deps.db.select({ id: calendarSources.id }).from(calendarSources).where(and(eq(calendarSources.orgId, actor.orgId), eq(calendarSources.userId, actor.userId)))).length;
  if (n >= MAX_SOURCES) throw new HttpError(422, "too_many_calendars", `You can add up to ${MAX_SOURCES} other calendars.`);
  return PALETTE[n % PALETTE.length];
}

/** Fetches an ICS link once (checks it really is a calendar) and returns its text. */
async function fetchIcs(deps: Deps, url: string) {
  const r = await davRequest(davOpts(deps), url, { method: "GET", headers: { accept: "text/calendar, text/plain;q=0.5" } });
  if (r.status === 404 || r.status === 410) throw new HttpError(422, "ics_not_found", "That calendar link was not found. Copy it again from your calendar's settings.");
  if (r.status === 401 || r.status === 403) throw new HttpError(422, "ics_forbidden", "That calendar link needs a sign in. Use the secret (private) address your calendar offers.");
  if (r.status !== 200) throw new HttpError(502, "ics_error", `The calendar server answered ${r.status}. Try again later.`);
  if (!r.text.includes("BEGIN:VCALENDAR")) throw new HttpError(422, "ics_not_calendar", "That link does not lead to a calendar (no iCalendar data). Use the ICS or iCal address.");
  return r.text;
}

export async function addIcsSource(deps: Deps, actor: SuiteActor, input: { url: string; name?: string; color?: string }) {
  personOnly(actor);
  assertWritable(actor);
  const nextColor = await countSources(deps, actor);
  const u = checkUrl(input.url.trim(), deps.config.mailConnect.allowPrivateHosts);
  const text = await fetchIcs(deps, u.toString());
  const calName = text.match(/^X-WR-CALNAME:(.+)$/m)?.[1]?.trim();
  const id = sortableId("cal");
  const row = {
    orgId: actor.orgId, userId: actor.userId, id, kind: "ics" as const, connectionId: null, urlEnc: await encryptSecret(deps.config.appSecret, u.toString()),
    calendars: "[]", name: (input.name?.trim() || calName || u.hostname).slice(0, 80), color: input.color && COLOR_RE.test(input.color) ? input.color : nextColor, enabled: true, createdAt: deps.now(),
  };
  await deps.db.insert(calendarSources).values(row);
  return presentSource(row, { host: u.hostname });
}

export async function addCalDavSource(deps: Deps, actor: SuiteActor, input: { connectionId: string; url?: string; name?: string; color?: string }) {
  personOnly(actor);
  assertWritable(actor);
  const c = await deps.db.select().from(mailConnections).where(and(eq(mailConnections.id, input.connectionId), eq(mailConnections.orgId, actor.orgId))).get();
  if (!c) throw notFound("Connected mailbox");
  if (!(await connectionIsMine(deps, actor, c))) throw forbidden("Only the person this mailbox belongs to can show its calendar."); // PRIV1b (P62, S2)
  if (CALDAV_NEEDS_OAUTH[c.provider] && !input.url) throw new HttpError(422, "caldav_needs_oauth", `Calendar from ${c.provider === "gmail" || c.provider.startsWith("google") ? "Gmail" : "Outlook"} needs ${CALDAV_NEEDS_OAUTH[c.provider]} sign in, coming later. For now, add its secret ICS address.`);
  if (c.authKind !== "password") throw new HttpError(422, "caldav_needs_oauth", "This mailbox signs in with OAuth. Add the calendar's ICS address instead.");
  const existing = await deps.db.select({ id: calendarSources.id }).from(calendarSources).where(and(eq(calendarSources.orgId, actor.orgId), eq(calendarSources.userId, actor.userId), eq(calendarSources.connectionId, c.id))).get();
  if (existing) throw new HttpError(409, "already_added", "This mailbox's calendar is already shown.");
  const nextColor = await countSources(deps, actor);
  const base = input.url?.trim() || CALDAV_BASES[c.provider] || `https://${c.imapHost.replace(/^imap\./, "")}/`;
  checkUrl(base, deps.config.mailConnect.allowPrivateHosts);
  const secret = await decryptSecret(deps.config.appSecret, c.secretEnc);
  const cals = await discoverCalendars(davOpts(deps), base, { username: c.username, password: secret });
  if (!cals.length) throw new HttpError(422, "caldav_no_calendars", "The account has no calendars with events.");
  const row = {
    orgId: actor.orgId, userId: actor.userId, id: sortableId("cal"), kind: "caldav" as const, connectionId: c.id, urlEnc: null,
    calendars: JSON.stringify(cals), name: (input.name?.trim() || c.email).slice(0, 80), color: input.color && COLOR_RE.test(input.color) ? input.color : cals[0].color ?? nextColor, enabled: true, createdAt: deps.now(),
  };
  await deps.db.insert(calendarSources).values(row);
  return presentSource(row, { address: c.email });
}

export async function updateSource(deps: Deps, actor: SuiteActor, id: string, patch: { enabled?: boolean; name?: string; color?: string }) {
  personOnly(actor);
  assertWritable(actor);
  await sourceRow(deps, actor, id);
  const set: Partial<SourceRow> = {};
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.name !== undefined) { if (!patch.name.trim()) throw new HttpError(422, "validation_failed", "Give the calendar a name."); set.name = patch.name.trim().slice(0, 80); }
  if (patch.color !== undefined) { if (!COLOR_RE.test(patch.color)) throw new HttpError(422, "validation_failed", "Colour must look like #8E8E93."); set.color = patch.color; }
  if (Object.keys(set).length) await deps.db.update(calendarSources).set(set).where(and(eq(calendarSources.orgId, actor.orgId), eq(calendarSources.userId, actor.userId), eq(calendarSources.id, id)));
  cache.clear();
  return (await listSources(deps, actor)).find((s) => s.id === id)!;
}

export async function removeSource(deps: Deps, actor: SuiteActor, id: string) {
  personOnly(actor);
  assertWritable(actor);
  await sourceRow(deps, actor, id);
  await deps.db.delete(calendarSources).where(and(eq(calendarSources.orgId, actor.orgId), eq(calendarSources.userId, actor.userId), eq(calendarSources.id, id)));
  return { ok: true as const };
}

/** In memory, per isolate: source id + window -> events, for EXTERNAL_CACHE_MS. */
const cache = new Map<string, { at: number; events: ExternalEvent[] }>();
export function clearCalendarCache() { cache.clear(); }

async function sourceEvents(deps: Deps, actor: SuiteActor, s: SourceRow, from: Date, to: Date, tz: string): Promise<ExternalEvent[]> {
  const key = `${s.orgId}:${s.userId}:${s.id}:${from.getTime()}:${to.getTime()}`;
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < EXTERNAL_CACHE_MS) return hit.events;
  let events: ExternalEvent[];
  if (s.kind === "ics") {
    const text = await fetchIcs(deps, await decryptSecret(deps.config.appSecret, s.urlEnc!));
    events = eventsIn(text, from, to, { defaultTz: tz });
  } else {
    const c = await deps.db.select().from(mailConnections).where(and(eq(mailConnections.id, s.connectionId!), eq(mailConnections.orgId, s.orgId))).get();
    if (!c || !(await connectionIsMine(deps, actor, c))) throw new HttpError(404, "not_found", "The connected mailbox is gone.");
    const auth = { username: c.username, password: await decryptSecret(deps.config.appSecret, c.secretEnc) };
    const cals = JSON.parse(s.calendars) as RemoteCalendar[];
    const texts = (await Promise.all(cals.map((cal) => reportEvents(davOpts(deps), cal.url, auth, from, to)))).flat();
    events = texts.flatMap((t) => eventsIn(t, from, to, { defaultTz: tz }));
  }
  if (cache.size > 500) cache.clear();
  cache.set(key, { at: now, events });
  return events;
}

async function externalEvents(deps: Deps, actor: SuiteActor, from: Date, to: Date, tz: string) {
  const rows = await deps.db.select().from(calendarSources).where(and(eq(calendarSources.orgId, actor.orgId), eq(calendarSources.userId, actor.userId), eq(calendarSources.enabled, true)));
  const events: CalendarEvent[] = [];
  const errors: { sourceId: string; name: string; message: string }[] = [];
  await Promise.all(rows.map(async (s) => {
    try {
      for (const e of await sourceEvents(deps, actor, s, from, to, tz)) {
        events.push({ id: `ext:${s.id}:${e.uid}:${e.start}`, kind: "external", title: e.title, start: e.start, end: e.end, allDay: e.allDay, url: null, sourceId: s.id, sourceName: s.name, color: s.color, readOnly: true, location: e.location });
      }
    } catch (err) {
      errors.push({ sourceId: s.id, name: s.name, message: err instanceof HttpError ? err.message : "This calendar could not be read just now." });
    }
  }));
  return { events, errors };
}
