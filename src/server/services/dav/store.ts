/**
 * R99: the collections Multies serves over CalDAV and CardDAV, for one signed in person.
 *   meetings  their meetings (the feed's set), editable by the meeting's maker or an owner or admin
 *   tasks     due dates of open tasks assigned to them, all day events; a phone may move the day only
 *   bookings  bookings on their own scheduling pages, read only
 *   contacts  the workspace contacts any member can open in the app (vCard 3.0)
 * Every listing is one bounded, indexed query. Sync tokens are stored snapshots of { name: etag }.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne } from "drizzle-orm";
import type { Deps } from "../../context";
import { bookings, companies, contacts, davNames, davSyncStates, projects, schedulingPages, tasks } from "../../db/schema";
import { sha256Hex } from "../../lib/crypto";
import { HttpError } from "../../lib/errors";
import { FEED_DAYS_AHEAD, FEED_DAYS_BACK, FEED_MAX_ITEMS, workItems, zoneOf } from "../suite/calendar-sync";
import { sortableId } from "../suite/common";
import { createContact, deleteContact, updateContact } from "../suite/contacts";
import { buildObject, type FeedMeeting } from "../suite/ics-write";
import { parseComponents, parseDuration, parseWhen } from "../suite/ics-parse";
import { createMeeting, deleteMeeting, updateMeeting } from "../suite/meetings";
import { zonedDate } from "../suite/scheduling";
import { updateTask } from "../suite/tasks";
import { actorOfPrincipal, type DavPrincipal } from "./app-passwords";
import { buildVCard, parseVCard } from "./vcard";

const DAY = 86_400_000;
export const CONTACTS_MAX = 5000;
export const SNAPSHOTS_KEPT = 5;
export const MAX_OBJECT_BYTES = 256 * 1024;

export type CollectionId = "meetings" | "tasks" | "bookings" | "contacts";
export interface CollectionInfo { id: CollectionId; kind: "calendar" | "addressbook"; name: string; description: string; color: string; order: number }
export const CALENDARS: CollectionInfo[] = [
  { id: "meetings", kind: "calendar", name: "Multies meetings", description: "Your meetings in Multies", color: "#5B5BD6FF", order: 1 },
  { id: "tasks", kind: "calendar", name: "Multies task due dates", description: "Due dates of the open tasks assigned to you", color: "#E5484DFF", order: 2 },
  { id: "bookings", kind: "calendar", name: "Multies bookings", description: "Bookings on your scheduling pages", color: "#30A46CFF", order: 3 },
];
export const ADDRESSBOOK: CollectionInfo = { id: "contacts", kind: "addressbook", name: "Multies contacts", description: "Your workspace contacts", color: "#5B5BD6FF", order: 1 };
export const collectionInfo = (id: string): CollectionInfo | null => (id === "contacts" ? ADDRESSBOOK : CALENDARS.find((c) => c.id === id) ?? null);

/** Whether a person may write in a collection at all (single items can still be read only for them). */
export const collectionWritable = (id: CollectionId) => id === "meetings" || id === "contacts" || id === "tasks";

export interface Entry { name: string; etag: string; entityId: string; contentType: string; render: () => string; canWrite: boolean }

/** Resource names: letters, digits, dot, dash, underscore, @ and percent, with the collection's extension. */
const NAME_RE = /^[A-Za-z0-9._@%+-]{1,120}$/;
export function validName(col: CollectionId, name: string) {
  return NAME_RE.test(name) && !name.startsWith(".") && name.endsWith(col === "contacts" ? ".vcf" : ".ics");
}

async function namesOf(deps: Deps, orgId: string, col: CollectionId) {
  const rows = await deps.db.select({ name: davNames.name, entityId: davNames.entityId, uid: davNames.uid }).from(davNames)
    .where(and(eq(davNames.orgId, orgId), eq(davNames.collection, col))).limit(CONTACTS_MAX);
  return { byEntity: new Map(rows.map((r) => [r.entityId, r])), byName: new Map(rows.map((r) => [r.name, r])) };
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymdIn = (d: Date, tz: string) => { const z = zonedDate(d, tz); return `${z.y}-${pad(z.m)}-${pad(z.d)}`; };

/** Every member of a collection for this person, with its etag and a renderer for its body. */
export async function entries(deps: Deps, p: DavPrincipal, col: CollectionId): Promise<Entry[]> {
  const names = await namesOf(deps, p.orgId, col);
  const app = deps.config.appUrl;
  const now = deps.now();
  const from = new Date(now.getTime() - FEED_DAYS_BACK * DAY), to = new Date(now.getTime() + FEED_DAYS_AHEAD * DAY);
  const nameFor = (id: string, ext: string) => names.byEntity.get(id)?.name ?? `${id}${ext}`;
  const admin = p.role === "owner" || p.role === "admin";
  if (col === "meetings") {
    const items = await workItems(deps, p.orgId, { id: p.userId, email: p.email }, from, to, { includeTasks: false, limit: FEED_MAX_ITEMS });
    return items.meetings.map((m) => {
      const fm: FeedMeeting = { id: m.id, title: m.title, startsAt: m.startsAt, durationMin: m.durationMin, status: m.status, recurrence: m.recurrence, recurrenceTz: m.recurrenceTz, version: m.version, updatedAt: m.updatedAt, url: `${app}/app/meetings/${m.id}` };
      return { name: nameFor(m.id, ".ics"), etag: `"m${m.version}-${m.updatedAt.getTime()}"`, entityId: m.id, contentType: "text/calendar; charset=utf-8; component=vevent",
        canWrite: admin || (m.createdByType === "member" && m.createdById === p.userId), render: () => buildObject({ meetings: [fm], dues: [] }, { uid: names.byEntity.get(m.id)?.uid }) };
    });
  }
  if (col === "tasks") {
    const tz = await zoneOf(deps, p.orgId, p.userId);
    const rows = await deps.db.select({ t: tasks, key: projects.key, project: projects.name }).from(tasks).innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(and(eq(tasks.orgId, p.orgId), isNull(tasks.deletedAt), isNull(tasks.triageState), ne(tasks.status, "done"),
        gte(tasks.dueAt, new Date(from.getTime() - DAY)), lt(tasks.dueAt, new Date(to.getTime() + DAY)), eq(tasks.assigneeType, "member"), eq(tasks.assigneeId, p.userId)))
      .orderBy(asc(tasks.dueAt)).limit(FEED_MAX_ITEMS);
    return rows.map(({ t, key, project }) => {
      const due = ymdIn(t.dueAt!, tz);
      const url = `${app}/app/tasks?task=${t.id}`;
      return { name: nameFor(t.id, ".ics"), etag: `"t${t.version}-${t.updatedAt.getTime()}-${due}"`, entityId: t.id, contentType: "text/calendar; charset=utf-8; component=vevent", canWrite: true,
        render: () => buildObject({ meetings: [], dues: [{ id: t.id, title: t.title, ref: `${key}-${t.number}`, project, due, url, version: t.version, updatedAt: t.updatedAt }] }) };
    });
  }
  if (col === "bookings") {
    const rows = await deps.db.select({ b: bookings, page: schedulingPages.title }).from(bookings).innerJoin(schedulingPages, eq(schedulingPages.id, bookings.pageId))
      .where(and(eq(bookings.orgId, p.orgId), eq(schedulingPages.userId, p.userId), gte(bookings.startsAt, new Date(from.getTime() - DAY)), lt(bookings.startsAt, to)))
      .orderBy(asc(bookings.startsAt)).limit(FEED_MAX_ITEMS);
    return rows.map(({ b, page }) => {
      const changed = b.cancelledAt ?? b.createdAt;
      const url = b.meetingId ? `${app}/app/meetings/${b.meetingId}` : `${app}/app/calendar`;
      const fm: FeedMeeting = { id: b.id, title: `${page}: ${b.name}`, startsAt: b.startsAt, durationMin: b.durationMin, status: b.status === "cancelled" ? "cancelled" : "scheduled", recurrence: null, recurrenceTz: null, version: b.status === "cancelled" ? 2 : 1, updatedAt: changed, url };
      return { name: nameFor(b.id, ".ics"), etag: `"b${b.status}-${changed.getTime()}"`, entityId: b.id, contentType: "text/calendar; charset=utf-8; component=vevent", canWrite: false,
        render: () => buildObject({ meetings: [fm], dues: [] }, { uid: `booking-${b.id}@mymail` }) };
    });
  }
  const rows = await deps.db.select({ c: contacts, company: companies.name }).from(contacts).leftJoin(companies, eq(companies.id, contacts.companyId))
    .where(and(eq(contacts.orgId, p.orgId), isNull(contacts.deletedAt))).orderBy(desc(contacts.updatedAt)).limit(CONTACTS_MAX);
  return rows.map(({ c, company }) => ({
    name: nameFor(c.id, ".vcf"), etag: `"c${c.version}-${c.updatedAt.getTime()}"`, entityId: c.id, contentType: "text/vcard; charset=utf-8", canWrite: true,
    render: () => buildVCard({ id: c.id, uid: names.byEntity.get(c.id)?.uid, name: c.name, email: c.email, phone: c.phone, title: c.title, notes: c.notes, company, updatedAt: c.updatedAt }),
  }));
}

// ---------------------------------------------------------------- sync tokens (RFC 6578)

export const syncTokenUrl = (deps: Deps, id: string) => `${deps.config.appUrl.replace(/\/$/, "")}/dav/sync/${id}`;
const membersJson = (list: Entry[]) => JSON.stringify(list.map((e) => [e.name, e.etag]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
export async function ctagOf(list: Entry[]) { return `"${(await sha256Hex(membersJson(list))).slice(0, 24)}"`; }

/** The current sync token: the newest snapshot when nothing changed since, else a new one (older ones pruned). */
export async function currentSyncToken(deps: Deps, p: DavPrincipal, col: CollectionId, list: Entry[]) {
  const json = membersJson(list);
  const latest = await deps.db.select().from(davSyncStates).where(and(eq(davSyncStates.passwordId, p.passwordId), eq(davSyncStates.collection, col)))
    .orderBy(desc(davSyncStates.createdAt)).limit(SNAPSHOTS_KEPT + 1);
  if (latest[0] && latest[0].members === json) return syncTokenUrl(deps, latest[0].id);
  const now = deps.now();
  const id = sortableId("dst", now.getTime());
  await deps.db.insert(davSyncStates).values({ id, passwordId: p.passwordId, collection: col, members: json, createdAt: now });
  const stale = latest.slice(SNAPSHOTS_KEPT - 1).map((r) => r.id);
  if (stale.length) await deps.db.delete(davSyncStates).where(and(eq(davSyncStates.passwordId, p.passwordId), inArray(davSyncStates.id, stale)));
  return syncTokenUrl(deps, id);
}

/** What changed since a token: names to send again, names gone (404). Null when the token is unknown or pruned. */
export async function changesSince(deps: Deps, p: DavPrincipal, col: CollectionId, token: string, list: Entry[]) {
  const m = token.trim().match(/\/dav\/sync\/(dst_[A-Za-z0-9_]{1,80})$/);
  if (!m) return null;
  const row = await deps.db.select().from(davSyncStates).where(and(eq(davSyncStates.id, m[1]), eq(davSyncStates.passwordId, p.passwordId), eq(davSyncStates.collection, col))).get();
  if (!row) return null;
  const before = new Map(JSON.parse(row.members) as [string, string][]);
  const now = new Map(list.map((e) => [e.name, e]));
  const changed = list.filter((e) => before.get(e.name) !== e.etag);
  const removed = [...before.keys()].filter((n) => !now.has(n));
  return { changed, removed };
}

// ---------------------------------------------------------------- writes

export interface WriteResult { status: 201 | 204; created: boolean }
/** A DAV answer a service step chose (412 and 415 are not in the app's HttpError statuses). */
export class DavError extends Error {
  constructor(public status: 400 | 403 | 409 | 412 | 413 | 415, public code: string, message: string) { super(message); }
}
const fail = (status: DavError["status"], code: string, message: string) => new DavError(status, code, message);

/** If-Match and If-None-Match (RFC 7232) against the current etag; a mismatch answers 412. */
export function checkPreconditions(current: Entry | undefined, h: { ifMatch?: string | null; ifNoneMatch?: string | null }) {
  const tags = (v: string) => v.split(",").map((s) => s.trim().replace(/^W\//, "")).filter(Boolean);
  if (h.ifMatch) {
    if (!current) throw fail(412, "precondition_failed", "That item is gone. Refresh to get the newest version.");
    if (!tags(h.ifMatch).some((t) => t === "*" || t === current.etag)) throw fail(412, "precondition_failed", "That item changed in Multies. Refresh to get the newest version.");
  }
  if (h.ifNoneMatch && current && tags(h.ifNoneMatch).some((t) => t === "*" || t === current.etag)) throw fail(412, "precondition_failed", "An item with that name already exists.");
}

/** The main VEVENT of a calendar object (the one without RECURRENCE-ID). */
function mainEvent(body: string) {
  const comps = parseComponents(body);
  const cal = comps.find((c) => c.type === "VCALENDAR");
  if (!cal) throw fail(400, "valid_calendar_data", "That is not an iCalendar object.");
  if (cal.children.some((c) => c.type === "VTODO" || c.type === "VJOURNAL")) throw fail(403, "supported_calendar_component", "Only events can be saved in this calendar.");
  const events = cal.children.filter((c) => c.type === "VEVENT");
  const ev = events.find((e) => !e.props.some((x) => x.name === "RECURRENCE-ID")) ?? events[0];
  if (!ev) throw fail(400, "valid_calendar_data", "The calendar object has no event.");
  const prop = (n: string) => ev.props.find((x) => x.name === n);
  const unescape = (s: string) => s.replace(/\\([\\,;nN])/g, (_m, ch: string) => (ch === "n" || ch === "N" ? "\n" : ch));
  const start = prop("DTSTART") ? parseWhen(prop("DTSTART")!) : null;
  if (!start) throw fail(400, "valid_calendar_data", "The event has no start.");
  let endAt: Date | null = null;
  if (prop("DTEND")) { const e = parseWhen(prop("DTEND")!); if (e && !e.allDay) endAt = e.at; }
  else if (prop("DURATION") && !start.allDay) { const ms = parseDuration(prop("DURATION")!.value); if (ms) endAt = new Date(start.at.getTime() + ms); }
  return { title: unescape(prop("SUMMARY")?.value ?? "").trim(), start, endAt, rrule: prop("RRULE")?.value.trim() ?? null, uid: prop("UID")?.value.trim().slice(0, 200) ?? null };
}

async function rememberName(deps: Deps, p: DavPrincipal, col: CollectionId, name: string, entityId: string, uid: string | null) {
  await deps.db.insert(davNames).values({ orgId: p.orgId, collection: col, name, entityId, uid, createdAt: deps.now() }).onConflictDoNothing();
}

/**
 * PUT: create or update one item. Multies wins on the fields it owns (see DESIGN): a phone may change a meeting's
 * title, start and length, a task's due day, a contact's name, phone, title and notes. The stored copy usually
 * differs from the bytes sent, so the route answers without an ETag and the phone fetches the server copy.
 */
export async function putItem(deps: Deps, p: DavPrincipal, col: CollectionId, name: string, body: string, h: { ifMatch?: string | null; ifNoneMatch?: string | null }): Promise<WriteResult> {
  if (!validName(col, name)) throw fail(403, "bad_name", "That item name is not allowed here.");
  if (new TextEncoder().encode(body).length > MAX_OBJECT_BYTES) throw fail(413, "too_large", "That item is too large.");
  if (col === "bookings") throw fail(403, "read_only", "Bookings are read only. Change them in Multies.");
  const list = await entries(deps, p, col);
  const current = list.find((e) => e.name === name);
  checkPreconditions(current, h);
  const actor = actorOfPrincipal(p);
  if (current && !current.canWrite) throw fail(403, "read_only", "Only the person who made this meeting, or an admin, can change it.");

  if (col === "contacts") {
    const card = parseVCard(body);
    if (!card) throw fail(400, "valid_address_data", "That is not a vCard.");
    if (current) {
      await updateContact(deps, actor, current.entityId, { name: card.name, phone: card.phone, title: card.title, ...(card.notes !== null ? { notes: card.notes } : {}) });
      return { status: 204, created: false };
    }
    if (!card.email) throw fail(403, "email_required", "A contact in Multies needs an email address.");
    const made = await createContact(deps, actor, { email: card.email, name: card.name || undefined, phone: card.phone ?? undefined, title: card.title ?? undefined, notes: card.notes ?? undefined });
    await rememberName(deps, p, col, name, made.id, card.uid);
    return { status: 201, created: true };
  }

  const ev = mainEvent(body);
  if (col === "tasks") {
    if (!current) throw fail(403, "read_only", "Make tasks in Multies. This calendar shows their due dates.");
    const tz = await zoneOf(deps, p.orgId, p.userId);
    const due = ev.start.allDay ? ev.start.ymd : ymdIn(ev.start.at, tz);
    await updateTask(deps, actor, current.entityId, { due });
    return { status: 204, created: false };
  }
  // meetings
  if (ev.start.allDay) throw fail(403, "all_day", "Meetings need a start time. All day events cannot be saved here.");
  const durationMin = ev.endAt ? Math.round((ev.endAt.getTime() - ev.start.at.getTime()) / 60_000) : 30;
  if (durationMin < 5 || durationMin > 480) throw fail(403, "duration", "A meeting runs between 5 minutes and 8 hours.");
  if (current) {
    await updateMeeting(deps, actor, current.entityId, { ...(ev.title ? { title: ev.title } : {}), startsAt: ev.start.at.toISOString(), durationMin });
    return { status: 204, created: false };
  }
  const input = { title: ev.title || "Meeting", startsAt: ev.start.at.toISOString(), durationMin };
  let made: Awaited<ReturnType<typeof createMeeting>>;
  const weekly = ev.rrule && /(^|;)FREQ=WEEKLY(;|$)/i.test(ev.rrule) ? ev.rrule.replace(/^RRULE:/i, "") : null;
  try {
    made = await createMeeting(deps, actor, weekly ? { ...input, recurrence: weekly } : input);
  } catch (e) {
    // A rule Multies cannot keep (not weekly, or out of range): save the first occurrence; the phone refetches it.
    if (!weekly || !(e instanceof HttpError) || e.status !== 422) throw e;
    made = await createMeeting(deps, actor, input);
  }
  await rememberName(deps, p, col, name, made.meeting.id, ev.uid);
  return { status: 201, created: true };
}

export async function deleteItem(deps: Deps, p: DavPrincipal, col: CollectionId, name: string, h: { ifMatch?: string | null }) {
  const list = await entries(deps, p, col);
  const current = list.find((e) => e.name === name);
  if (!current) throw new HttpError(404, "not_found", "Not found.");
  checkPreconditions(current, { ifMatch: h.ifMatch });
  if (col === "bookings") throw fail(403, "read_only", "Cancel bookings in Multies.");
  if (col === "tasks") throw fail(403, "read_only", "Finish or delete tasks in Multies.");
  if (!current.canWrite) throw fail(403, "read_only", "Only the person who made this meeting, or an admin, can delete it.");
  const actor = actorOfPrincipal(p);
  if (col === "contacts") await deleteContact(deps, actor, current.entityId);
  else await deleteMeeting(deps, actor, current.entityId);
  await deps.db.delete(davNames).where(and(eq(davNames.orgId, p.orgId), eq(davNames.collection, col), eq(davNames.entityId, current.entityId)));
}
