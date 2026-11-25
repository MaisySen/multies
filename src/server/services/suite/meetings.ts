/**
 * Video meetings on LiveKit (Apache 2.0, LiveKit Cloud or self-hosted). A meeting is started
 * from a thread, a task or a contact, gets a guest link (/m/<token>) for people outside the
 * workspace, and its calendar invite (an .ics file) goes out through Multies' own sending.
 * No recording, notes or transcripts: Multies never pays for AI. With no LiveKit keys set,
 * meetings can still be scheduled and invited, and joining says video is not switched on.
 */
import { and, desc, eq, gte, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { bookings, contacts, entityLinks, mailboxes, meetingActionItems, meetingLobby, meetingRecordings, meetings, members, messages, organizations, tasks } from "../../db/schema";
import { runBatch } from "../../db";
import { randomToken, toB64 } from "../../lib/crypto";
import { forbidden, HttpError, notFound } from "../../lib/errors";
import { assertWritable, createdBy, iso, parseDate, recordWrite, scopeOf, sortableId, type SuiteActor } from "./common";
import { link, resolveTaskId } from "./tasks";
import { admittedGuest, cleanGuestName, guestJoinIdentity } from "./meeting-lobby-r32";
import { vtimezone } from "./vtimezone";
import { closedReason, shownStatus } from "./meeting-open-meet";
import { assertZone, describeRecurrence, expandWeekly, normaliseRecurrence, parseRrule, toRrule, weekdayIn, type Recurrence, type RecurrenceInput } from "./meeting-recurrence";
import { parseAddressList } from "../mail/address-list"; // Wave 3 (M4)
import { assertMeetingVisible, meetingVisibleTo } from "./meeting-visibility"; // Review Z1

type MeetingRow = typeof meetings.$inferSelect;
export type MeetingSource = { type: "thread" | "task" | "contact"; id: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const urlToken = (bytes: number) => randomToken(bytes).replace(/[^A-Za-z0-9]/g, "").slice(0, Math.ceil(bytes * 1.3));

export function meetingsEnabled(deps: Deps) { return !!deps.config.meetings; }

function seriesOf(m: MeetingRow): (Recurrence & { rrule: string; timezone: string; summary: string }) | null {
  if (!m.recurrence) return null;
  const tz = m.recurrenceTz || "UTC";
  try {
    const r = parseRrule(m.recurrence, tz);
    return { ...r, rrule: m.recurrence, timezone: tz, summary: describeRecurrence(r) };
  } catch {
    return null;
  }
}

function present(m: MeetingRow, origin: string, enabled: boolean, rawStatus: MeetingRow["status"] = m.status) {
  return {
    id: m.id, title: m.title, room: m.room, startsAt: m.startsAt.toISOString(), durationMin: m.durationMin,
    endsAt: new Date(m.startsAt.getTime() + m.durationMin * 60_000).toISOString(), status: m.status,
    source: m.sourceType && m.sourceId ? { type: m.sourceType, id: m.sourceId } : null,
    invitees: JSON.parse(m.invitees) as string[], invitesSentAt: iso(m.invitesSentAt),
    joinUrl: `${origin}/app/meetings/${m.id}`, guestUrl: `${origin}/m/${m.guestToken}`, videoEnabled: enabled,
    createdBy: { type: m.createdByType, id: m.createdById }, createdAt: m.createdAt.toISOString(), updatedAt: m.updatedAt.toISOString(), version: m.version,
    /** Set on a weekly series. In an upcoming list each occurrence is its own entry with the series' id. */
    recurrence: seriesOf(m),
    seriesStartsAt: null as string | null,
    /** Round 23: the chat channel or DM a call started from, and the agenda and notes doc. */
    channelId: m.channelId ?? null,
    docId: m.docId ?? null,
    /** Round 32: guests from the link wait until a member lets them in. */
    guestsWait: m.guestLobby,
    /** Review Z8: an owner or admin can reopen it (ended or cancelled; a series between its meetings is not). */
    canReopen: rawStatus === "ended" || rawStatus === "cancelled",
  };
}
export type Meeting = ReturnType<typeof present>;

async function meetingRow(deps: Deps, orgId: string, id: string) {
  const m = await deps.db.select().from(meetings).where(and(eq(meetings.orgId, orgId), eq(meetings.id, id), isNull(meetings.deletedAt))).get();
  if (!m) throw notFound("Meeting");
  return m;
}

const out = (deps: Deps, m: MeetingRow) => present({ ...m, status: shownStatus(m, deps.now()) }, deps.config.appUrl, meetingsEnabled(deps), m.status);

/** How far ahead an upcoming list expands a weekly series, and how many of each it shows. */
export const SERIES_WINDOW_DAYS = 60;
export const SERIES_MAX_PER_LIST = 12;

/** One entry per occurrence of a series in [from, to), worked out on read (nothing is written). */
export function occurrencesOf(m: Meeting, from: Date, to: Date, now: Date, limit = SERIES_MAX_PER_LIST): Meeting[] {
  if (!m.recurrence || m.status === "cancelled") return [];
  const starts = expandWeekly(new Date(m.startsAt), m.recurrence, m.recurrence.timezone, from, to, limit);
  return starts.map((at) => ({
    ...m, startsAt: at.toISOString(), endsAt: new Date(at.getTime() + m.durationMin * 60_000).toISOString(), seriesStartsAt: m.startsAt,
    // A past meeting in the series may have ended; the ones still to come are scheduled.
    status: at.getTime() + m.durationMin * 60_000 < now.getTime() ? m.status : "scheduled",
  }));
}

export async function listMeetings(deps: Deps, actor: SuiteActor, q: { upcoming?: boolean; sourceType?: string; sourceId?: string; limit?: number; to?: Date } = {}) {
  const cutoff = new Date(deps.now().getTime() - 3 * 3600_000);
  const rows = await deps.db.select().from(meetings).where(and(
    eq(meetings.orgId, actor.orgId), isNull(meetings.deletedAt),
    // Review Z1: a DM's or private channel's call is listed only for the people in that chat.
    meetingVisibleTo(deps, actor),
    // A series whose first meeting is past still has upcoming occurrences.
    q.upcoming ? or(gte(meetings.startsAt, cutoff), isNotNull(meetings.recurrence)) : undefined,
    q.sourceType ? eq(meetings.sourceType, q.sourceType as "thread") : undefined, q.sourceId ? eq(meetings.sourceId, q.sourceId) : undefined,
    // R41 (MB-199 CPU): My Work only needs today, so it reads and expands meetings up to a near horizon.
    q.to ? or(lt(meetings.startsAt, q.to), isNotNull(meetings.recurrence)) : undefined,
  )).orderBy(desc(meetings.startsAt)).limit(Math.min(q.limit ?? 100, 500));
  const list = rows.map((m) => out(deps, m));
  if (!q.upcoming) return list;
  const to = q.to ?? new Date(deps.now().getTime() + SERIES_WINDOW_DAYS * 86_400_000);
  return list
    .flatMap((m) => (m.recurrence ? occurrencesOf(m, cutoff, to, deps.now()) : [m]))
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt));
}

async function zoneFor(deps: Deps, orgId: string, tz?: string | null) {
  if (tz) { assertZone(tz); return tz; }
  const org = await deps.db.select({ tz: organizations.timezone }).from(organizations).where(eq(organizations.id, orgId)).get();
  return org?.tz ?? "UTC";
}

/** A weekly series from either { interval, days, until, count, timezone } or an RRULE string. Null clears it. */
export type MeetingRecurrenceInput = (RecurrenceInput & { timezone?: string | null }) | string | null;

async function recurrenceColumns(deps: Deps, orgId: string, input: MeetingRecurrenceInput | undefined, startsAt: Date, currentTz?: string | null) {
  if (input === undefined) return undefined;
  if (input === null) return { recurrence: null, recurrenceTz: null };
  const tz = await zoneFor(deps, orgId, typeof input === "string" ? currentTz : input.timezone ?? currentTz);
  const r = normaliseRecurrence(typeof input === "string" ? parseRrule(input, tz) : input, startsAt, tz);
  return { recurrence: toRrule(r, tz), recurrenceTz: tz };
}

export async function getMeeting(deps: Deps, actor: SuiteActor, id: string) {
  return out(deps, await meetingHere(deps, actor, id));
}

/**
 * MEET fixes (12 Nov 2026): a meeting link opened while this browser is in another of the person's workspaces.
 * Before, it said "not found" and the link looked broken; now the answer names the meeting's workspace
 * (404 meeting_in_other_workspace with details.workspace) so the page can offer to switch. Only a person who is
 * a member of that workspace is told; anyone else still gets a plain not found.
 */
async function meetingHere(deps: Deps, actor: SuiteActor, id: string) {
  let found;
  try {
    found = await meetingRow(deps, actor.orgId, id);
  } catch (err) {
    if (!actor.userId || actor.agentId || actor.apiKeyId) throw err;
    const other = await deps.db.select({ orgId: meetings.orgId, name: organizations.name }).from(meetings)
      .innerJoin(organizations, eq(organizations.id, meetings.orgId))
      .innerJoin(members, and(eq(members.organizationId, meetings.orgId), eq(members.userId, actor.userId)))
      .where(and(eq(meetings.id, id), isNull(meetings.deletedAt))).get();
    if (!other || other.orgId === actor.orgId) throw err;
    throw new HttpError(404, "meeting_in_other_workspace", `This meeting is in your other workspace, ${other.name}. Switch to it to open the meeting.`, { workspace: { id: other.orgId, name: other.name } });
  }
  await assertMeetingVisible(deps, actor, found);
  return found;
}

/** Review Z1: a meeting this actor may see (a DM's or private channel's call only for the people in it), else 404. */
async function visibleRow(deps: Deps, actor: SuiteActor, id: string) {
  const m = await meetingRow(deps, actor.orgId, id);
  await assertMeetingVisible(deps, actor, m);
  return m;
}

/** Title, guests and the sending mailbox suggested by what the meeting was started from. */
async function fromSource(deps: Deps, actor: SuiteActor, s: MeetingSource) {
  if (s.type === "thread") {
    const scope = await scopeOf(deps, actor);
    const rows = await deps.db.select().from(messages).where(and(eq(messages.orgId, actor.orgId), eq(messages.threadId, s.id))).orderBy(desc(messages.date)).limit(20);
    const visible = rows.filter((m) => !scope || scope.includes(m.mailboxId));
    if (!visible.length) throw notFound("Thread");
    const own = new Set((await deps.db.select({ address: mailboxes.address }).from(mailboxes).where(eq(mailboxes.orgId, actor.orgId))).map((m) => m.address.toLowerCase()));
    const guests = new Set<string>();
    for (const m of visible) {
      if (m.folder !== "sent") guests.add(m.fromAddress.toLowerCase());
      else for (const t of parseAddressList(m.to)) guests.add(t.address.toLowerCase()); // Wave 3 (M4)
    }
    return { title: visible[0].subject.replace(/^(re|fwd?):\s*/i, "") || "Meeting", invitees: [...guests].filter((g) => !own.has(g)), mailboxId: visible[0].mailboxId, sourceId: s.id };
  }
  if (s.type === "task") {
    const id = await resolveTaskId(deps, actor.orgId, s.id);
    const t = await deps.db.select({ id: tasks.id, title: tasks.title, sourceFrom: tasks.sourceFrom }).from(tasks).where(and(eq(tasks.orgId, actor.orgId), eq(tasks.id, id), isNull(tasks.deletedAt))).get();
    if (!t) throw notFound("Task");
    const from = t.sourceFrom ?? "";
    const lt = from.indexOf("<"), gt = from.indexOf(">", lt + 1);
    const candidate = (lt >= 0 && gt > lt ? from.slice(lt + 1, gt) : from).trim();
    const addr = candidate.length <= 254 && EMAIL.test(candidate) ? candidate : null; // nosemgrep: regex_dos (a linear pattern on a stored sender address of at most 254 characters)
    return { title: t.title, invitees: addr ? [addr.toLowerCase()] : [], mailboxId: undefined, sourceId: t.id };
  }
  const c = await deps.db.select({ id: contacts.id, name: contacts.name, email: contacts.email }).from(contacts).where(and(eq(contacts.orgId, actor.orgId), eq(contacts.id, s.id), isNull(contacts.deletedAt))).get();
  if (!c) throw notFound("Contact");
  return { title: `Meeting with ${c.name || c.email}`, invitees: [c.email], mailboxId: undefined, sourceId: c.id };
}

export interface MeetingInput { title?: string; startsAt?: string; durationMin?: number; source?: MeetingSource; invitees?: string[]; sendInvites?: boolean; mailboxId?: string; recurrence?: MeetingRecurrenceInput; /** Round 23: set by a call from chat. */ channelId?: string }

export async function createMeeting(deps: Deps, actor: SuiteActor, input: MeetingInput, opts: { id?: string; retry?: boolean } = {}) {
  assertWritable(actor);
  if (opts.id && opts.retry && await deps.db.select({ id: meetings.id }).from(meetings).where(and(eq(meetings.id, opts.id), eq(meetings.orgId, actor.orgId))).get()) return { meeting: out(deps, await meetingRow(deps, actor.orgId, opts.id)), invites: null }; // R52 (MB-239): a retry under the same Idempotency-Key returns what the first attempt made
  const suggested = input.source ? await fromSource(deps, actor, input.source) : { title: "Meeting", invitees: [] as string[], mailboxId: undefined, sourceId: undefined };
  const invitees = [...new Set((input.invitees ?? suggested.invitees).map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const bad = invitees.filter((e) => e.length > 254 || !EMAIL.test(e)); // B6: the length first, for any caller
  if (bad.length) throw new HttpError(422, "validation_failed", `Not an email address: ${bad.join(", ")}`);
  if (invitees.length > 50) throw new HttpError(422, "validation_failed", "Invite up to 50 guests.");
  const now = deps.now();
  const startsAt = input.startsAt ? parseDate(input.startsAt)! : now;
  const durationMin = Math.round(input.durationMin ?? 30);
  if (durationMin < 5 || durationMin > 480) throw new HttpError(422, "validation_failed", "A meeting runs between 5 minutes and 8 hours.");
  const id = opts.id ?? sortableId("mtg", now.getTime()); // R51 (MB-239)
  const title = (input.title?.trim() || suggested.title).slice(0, 200);
  const series = await recurrenceColumns(deps, actor.orgId, input.recurrence, startsAt);
  await deps.db.insert(meetings).values({
    ...(series ?? {}),
    id, orgId: actor.orgId, title, room: `multies-${id.slice(4)}`, guestToken: urlToken(18), startsAt, durationMin, status: "scheduled",
    sourceType: input.source?.type ?? null, sourceId: suggested.sourceId ?? null, invitees: JSON.stringify(invitees), mailboxId: input.mailboxId ?? suggested.mailboxId ?? null, channelId: input.channelId ?? null,
    ...createdBy(actor), createdAt: now, updatedAt: now,
  });
  if (input.source && input.source.type !== "thread" && suggested.sourceId) await link(deps, actor.orgId, { type: "meeting", id }, { type: input.source.type, id: suggested.sourceId }, "about");
  await recordWrite(deps, actor, { entityType: "meeting", entityId: id, op: "create", verb: "meeting.created", data: { title, startsAt: startsAt.toISOString() },
    event: "meeting.created", eventData: { id, title, startsAt: startsAt.toISOString(), durationMin, source: input.source ?? null } });
  if (input.source?.type === "task" && suggested.sourceId) await recordWrite(deps, actor, { entityType: "task", entityId: suggested.sourceId, op: "update", verb: "meeting.created", data: { meetingId: id, title } });
  let invites: Awaited<ReturnType<typeof sendInvites>> | null = null;
  if (input.sendInvites && invitees.length) invites = await sendInvites(deps, actor, id, { mailboxId: input.mailboxId });
  return { meeting: out(deps, await meetingRow(deps, actor.orgId, id)), invites };
}

/** Edits apply to the whole series: a series is one row. */
export async function updateMeeting(deps: Deps, actor: SuiteActor, id: string, patch: { title?: string; startsAt?: string; durationMin?: number; status?: "scheduled" | "ended" | "cancelled"; invitees?: string[]; recurrence?: MeetingRecurrenceInput }) {
  assertWritable(actor);
  const m = await visibleRow(deps, actor, id);
  const set: Partial<MeetingRow> = { updatedAt: deps.now(), version: m.version + 1 };
  let reopened = false;
  if (patch.title !== undefined) set.title = patch.title.trim().slice(0, 200) || m.title;
  if (patch.startsAt !== undefined) {
    // PRIV1b (P64): an empty start is refused, never written into the required column.
    const d = parseDate(patch.startsAt);
    if (!d) throw new HttpError(422, "validation_failed", "Give the meeting a start time.");
    set.startsAt = d;
  }
  if (patch.durationMin !== undefined) { if (patch.durationMin < 5 || patch.durationMin > 480) throw new HttpError(422, "validation_failed", "A meeting runs between 5 minutes and 8 hours."); set.durationMin = Math.round(patch.durationMin); }
  if (patch.status !== undefined) {
    // Wave 3 review Y4: an owner or admin can reopen an ended or cancelled meeting (its link works again). Review Z8:
    // a series between its meetings shows as ended but has nothing to reopen (it opens again before its next meeting).
    const shown = shownStatus(m, deps.now());
    if (patch.status === "scheduled" && shown !== "scheduled") {
      if (!actor.system && actor.role !== "owner" && actor.role !== "admin") throw forbidden("Only an owner or admin can reopen a meeting.");
      if (m.status === "scheduled") throw new HttpError(409, "nothing_to_reopen", "This series opens again 15 minutes before its next meeting.");
      set.endedAt = null;
      set.emptySince = null;
      reopened = true;
    }
    set.status = patch.status;
    if (patch.status === "ended") set.endedAt = deps.now();
  }
  if (patch.invitees !== undefined) {
    const list = [...new Set(patch.invitees.map((e) => e.trim().toLowerCase()).filter(Boolean))];
    const bad = list.filter((e) => e.length > 254 || !EMAIL.test(e)); // B6
    if (bad.length) throw new HttpError(422, "validation_failed", `Not an email address: ${bad.join(", ")}`);
    set.invitees = JSON.stringify(list.slice(0, 50));
  }
  if (patch.recurrence !== undefined || (patch.startsAt !== undefined && m.recurrence)) {
    // A new start re-anchors the series (its weekday joins the days); a null recurrence ends it as a one off.
    let keep: MeetingRecurrenceInput = patch.recurrence === undefined ? m.recurrence : patch.recurrence;
    if (patch.recurrence === undefined && m.recurrence && set.startsAt) {
      // Moving the series moves its day: the old start's weekday gives way to the new one.
      const tz = m.recurrenceTz || "UTC";
      const r = parseRrule(m.recurrence, tz);
      const old = weekdayIn(m.startsAt, tz);
      keep = { interval: r.interval, days: r.days.filter((d) => d !== old), until: r.until, count: r.count, timezone: tz };
    }
    Object.assign(set, await recurrenceColumns(deps, actor.orgId, keep, set.startsAt ?? m.startsAt, m.recurrenceTz));
  }
  await deps.db.update(meetings).set(set).where(eq(meetings.id, id));
  // Review Z8: admissions given before it ended stay over once it is reopened (the end no longer marks them).
  if (reopened) await deps.db.update(meetingLobby).set({ status: "denied", decidedBy: "system:reopened", decidedAt: deps.now() }).where(and(eq(meetingLobby.meetingId, id), eq(meetingLobby.status, "admitted")));
  await recordWrite(deps, actor, { entityType: "meeting", entityId: id, op: "update", version: m.version + 1, verb: "meeting.updated", data: { status: patch.status },
    event: "meeting.updated", eventData: { id, status: set.status ?? m.status } });
  // R24.4: meeting_ended rules, once when a meeting is marked ended.
  if (patch.status === "ended" && m.status !== "ended") await (await import("./automations-r24")).runMeetingEnded(deps, actor, { id, title: set.title ?? m.title });
  return out(deps, await meetingRow(deps, actor.orgId, id));
}

/**
 * R52 (MB-239): delete a meeting (or a whole series; a series is one row). Whoever can edit a meeting can delete
 * it; guests and read only keys cannot (assertWritable). The lobby goes with it (foreign key), and its action items,
 * recording transcripts and links are removed in the same batch; a booking that pointed at it keeps its slot and
 * loses the pointer. meeting.deleted fires after the delete commits, shaped like meeting.created.
 */
export async function deleteMeeting(deps: Deps, actor: SuiteActor, id: string) {
  assertWritable(actor);
  const m = await visibleRow(deps, actor, id);
  const { db } = deps;
  await runBatch(db, [
    db.delete(meetingActionItems).where(and(eq(meetingActionItems.orgId, actor.orgId), eq(meetingActionItems.meetingId, m.id))),
    db.delete(meetingRecordings).where(and(eq(meetingRecordings.orgId, actor.orgId), eq(meetingRecordings.meetingId, m.id))),
    db.delete(entityLinks).where(and(eq(entityLinks.orgId, actor.orgId), or(and(eq(entityLinks.fromType, "meeting"), eq(entityLinks.fromId, m.id)), and(eq(entityLinks.toType, "meeting"), eq(entityLinks.toId, m.id))))),
    db.update(bookings).set({ meetingId: null }).where(and(eq(bookings.orgId, actor.orgId), eq(bookings.meetingId, m.id))),
    db.delete(meetings).where(and(eq(meetings.id, m.id), eq(meetings.orgId, actor.orgId))),
  ]);
  await recordWrite(deps, actor, { entityType: "meeting", entityId: m.id, op: "delete", version: m.version + 1, verb: "meeting.deleted", data: { title: m.title },
    event: "meeting.deleted", eventData: { id: m.id, object: "meeting", title: m.title, startsAt: m.startsAt.toISOString(), durationMin: m.durationMin, status: m.status } });
  return { id: m.id, deleted: true };
}

// ---------------------------------------------------------------- calendar invite (RFC 5545)

const icsDate = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
/** Lines longer than 75 octets are folded with a space, as RFC 5545 asks. */
function fold(line: string) {
  const parts: string[] = [];
  let rest = line;
  while (rest.length > 74) { parts.push(rest.slice(0, 74)); rest = ` ${rest.slice(74)}`; }
  parts.push(rest);
  return parts.join("\r\n");
}

/** Wall clock stamp in a zone, for DTSTART;TZID=... (a weekly series keeps its local time across DST). */
function icsLocal(d: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}T${p.hour}${p.minute}${p.second}`;
}

export function buildIcs(m: { id: string; title: string; startsAt: Date; durationMin: number; status?: string; recurrence?: string | null; recurrenceTz?: string | null }, opts: { organizer: { address: string; name?: string | null }; invitees: string[]; guestUrl: string; now: Date; method?: "REQUEST" | "CANCEL"; sequence?: number }) {
  const end = new Date(m.startsAt.getTime() + m.durationMin * 60_000);
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Multies//Meetings//EN", "CALSCALE:GREGORIAN", `METHOD:${opts.method ?? "REQUEST"}`,
    ...(m.recurrence && m.recurrenceTz ? vtimezone(m.recurrenceTz, m.startsAt) : []),
    "BEGIN:VEVENT", `UID:${m.id}@mymail`, `SEQUENCE:${opts.sequence ?? 0}`, `DTSTAMP:${icsDate(opts.now)}`, ...(m.recurrence && m.recurrenceTz
      ? [`DTSTART;TZID=${m.recurrenceTz}:${icsLocal(m.startsAt, m.recurrenceTz)}`, `DTEND;TZID=${m.recurrenceTz}:${icsLocal(end, m.recurrenceTz)}`, `RRULE:${m.recurrence}`]
      : [`DTSTART:${icsDate(m.startsAt)}`, `DTEND:${icsDate(end)}`]),
    `SUMMARY:${icsText(m.title)}`, `LOCATION:${icsText(opts.guestUrl)}`, `URL:${opts.guestUrl}`,
    `DESCRIPTION:${icsText(`Join the video meeting: ${opts.guestUrl}\n\nNo account or app needed. Open the link in a browser.`)}`,
    `ORGANIZER;CN=${icsText(opts.organizer.name || opts.organizer.address)}:mailto:${opts.organizer.address}`,
    ...opts.invitees.map((e) => `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${e}`),
    `STATUS:${opts.method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`, "END:VEVENT", "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** The meeting (or whole series) as an .ics file, for a download link. */
export async function meetingIcs(deps: Deps, actor: SuiteActor, id: string) {
  const m = await visibleRow(deps, actor, id);
  const box = m.mailboxId ? await deps.db.select({ address: mailboxes.address, name: mailboxes.displayName }).from(mailboxes).where(and(eq(mailboxes.orgId, actor.orgId), eq(mailboxes.id, m.mailboxId))).get() : undefined;
  const organizer = box ?? { address: `meetings@${new URL(deps.config.appUrl).hostname}`, name: "Multies" };
  return buildIcs(m, { organizer, invitees: JSON.parse(m.invitees) as string[], guestUrl: `${deps.config.appUrl}/m/${m.guestToken}`, now: deps.now(), sequence: m.version - 1, method: m.status === "cancelled" ? "CANCEL" : "REQUEST" });
}

function inviteText(title: string, when: string, guestUrl: string, host: string) {
  return `${host} invited you to a video meeting.\n\n${title}\n${when}\n\nJoin: ${guestUrl}\n\nNo account or app needed. Open the link in a browser at the time of the meeting. The calendar invite is attached.`;
}

/**
 * Sends the invite to every guest. A person sends from a mailbox they can use; an agent's
 * invite goes through its approval rules like any other mail it sends outside the business.
 */
export async function sendInvites(deps: Deps, actor: SuiteActor, id: string, opts: { mailboxId?: string } = {}) {
  assertWritable(actor);
  const m = await visibleRow(deps, actor, id);
  const invitees = JSON.parse(m.invitees) as string[];
  if (!invitees.length) throw new HttpError(422, "no_guests", "Add at least one guest email first.");
  const org = await deps.db.select({ name: organizations.name, timezone: organizations.timezone }).from(organizations).where(eq(organizations.id, actor.orgId)).get();
  const guestUrl = `${deps.config.appUrl}/m/${m.guestToken}`;
  const when = new Intl.DateTimeFormat("en-AU", { timeZone: org?.timezone ?? "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(m.startsAt);
  const series = seriesOf(m);
  const subject = `Invitation: ${m.title}`;
  const whenText = series ? `${when}\n${series.summary}` : when;

  if (actor.agentId) {
    const { getAgent, requestSend } = await import("../agents");
    const agent = await getAgent(deps, actor.orgId, actor.agentId);
    const ics = buildIcs(m, { organizer: { address: agent.address, name: agent.name }, invitees, guestUrl, now: deps.now() });
    const res = await requestSend(deps, actor as unknown as AuthContext & { agentId: string }, actor.agentId, {
      to: invitees, subject, text: inviteText(m.title, whenText, guestUrl, agent.name),
      attachments: [{ filename: "invite.ics", contentType: "text/calendar; method=REQUEST; charset=UTF-8", contentBase64: toB64(new TextEncoder().encode(ics)) }],
    });
    if (res.status === "sent") await deps.db.update(meetings).set({ invitesSentAt: deps.now(), mailboxId: agent.inboxId }).where(eq(meetings.id, id));
    return res.status === "sent" ? { status: "sent" as const, to: invitees } : { status: "pending_approval" as const, to: invitees, approvalId: res.approval.id };
  }

  const scope = await scopeOf(deps, actor);
  const boxes = await deps.db.select().from(mailboxes).where(and(eq(mailboxes.orgId, actor.orgId), eq(mailboxes.status, "active")));
  const usable = boxes.filter((b) => b.kind === "person" && (!scope || scope.includes(b.id)));
  const pick = opts.mailboxId ?? m.mailboxId;
  const from = (pick ? usable.find((b) => b.id === pick) : undefined) ?? usable[0];
  if (!from) throw new HttpError(422, "no_mailbox", "You need a mailbox to send invites from. Add one in Mailboxes, or copy the guest link instead.");
  const ics = buildIcs(m, { organizer: { address: from.address, name: from.displayName }, invitees, guestUrl, now: deps.now() });
  const { sendMessage } = await import("../mail/send");
  const result = await sendMessage(deps, actor as AuthContext, { mailboxId: from.id, to: invitees, subject, text: inviteText(m.title, whenText, guestUrl, from.displayName || from.address) }, {
    attachments: [{ filename: "invite.ics", contentType: "text/calendar; method=REQUEST; charset=UTF-8", content: new TextEncoder().encode(ics) }],
  });
  await deps.db.update(meetings).set({ invitesSentAt: deps.now(), mailboxId: from.id }).where(eq(meetings.id, id));
  await recordWrite(deps, actor, { entityType: "meeting", entityId: id, op: "update", version: m.version, verb: "meeting.invited", data: { to: invitees } });
  return { status: "sent" as const, to: invitees, messageId: result.messageId };
}

// ---------------------------------------------------------------- joining

/** R34 (MB-171): a new call (an empty room) is refused once a capped workspace has used its month; a running call is never cut off. */
async function minutesLeftForRoom(deps: Deps, m: { orgId: string; room: string }) {
  if (!deps.config.meetings && !deps.config.callsTestHook && !deps.callRooms) return;
  const { assertCanStartCall } = await import("./meeting-minutes-r34");
  const { roomParticipants } = await import("./calls");
  await assertCanStartCall(deps, m.orgId, async () => (await roomParticipants(deps, m.room)).length > 0);
}

export async function livekitToken(deps: Deps, room: string, who: { identity: string; name: string; host: boolean; /** R114: false for webinar attendees (watch only). */ publish?: boolean }) {
  const cfg = deps.config.meetings;
  if (!cfg) throw new HttpError(503, "meetings_off", "Video calls aren't switched on for this workspace yet. The guest link and invite still work once they are.");
  const { AccessToken, TrackSource } = await import("livekit-server-sdk");
  const at = new AccessToken(cfg.apiKey, cfg.apiSecret, { identity: who.identity, name: who.name, ttl: "6h" });
  // Round 23: screen share (with its audio) is allowed for everyone in the room, guests included.
  const publish = who.publish !== false;
  at.addGrant({ room, roomJoin: true, canPublish: publish, canSubscribe: true, canPublishData: publish, roomAdmin: who.host, canPublishSources: publish ? [TrackSource.CAMERA, TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO] : [] });
  return { url: cfg.url, token: await at.toJwt(), room };
}

/** A workspace member (or agent key) joining: their own name, host rights. */
export async function joinMeeting(deps: Deps, actor: SuiteActor, id: string, opts: { name?: string } = {}) {
  const m = await meetingHere(deps, actor, id);
  // Wave 3 review Y8 (f), Z1: a call from a DM or private channel is joined only by people who can open that chat
  // (meetingHere checks it); anyone else, an agent key included, gets a plain not found.
  if (m.status === "cancelled") throw new HttpError(409, "meeting_cancelled", "This meeting was cancelled.");
  // MEET fixes (12 Nov 2026): an ended meeting stays ended for members too, as it already did for guests (Bidur, 10 Nov).
  if (closedReason(m, deps.now())) throw new HttpError(409, "meeting_ended", "This meeting has ended.");
  await minutesLeftForRoom(deps, m);
  const identity = actor.agentId ? `agent-${actor.agentId}` : `member-${actor.userId}`;
  // R114: in a webinar only hosts and panelists speak; other members watch.
  const stage = deps.config.webinar ? await (await import("./webinar-r114")).stageRole(deps, actor, m) : null;
  const host = stage ? stage.host : true;
  return { meeting: out(deps, m), webinarRole: stage ? (stage.host ? "host" : stage.publish ? "panelist" : "attendee") : null, ...(await livekitToken(deps, m.room, { identity, name: cleanGuestName(opts.name) || actor.name || actor.email || "Host", host, publish: stage ? stage.publish : true })) };
}

async function guestRow(deps: Deps, token: string) {
  const m = await deps.db.select().from(meetings).where(and(eq(meetings.guestToken, token), isNull(meetings.deletedAt))).get();
  if (!m) throw notFound("Meeting");
  return m;
}

/** What the guest page shows before joining: no ids, no guest list. */
export async function guestInfo(deps: Deps, token: string) {
  const m = await guestRow(deps, token);
  const org = await deps.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, m.orgId)).get();
  return { title: m.title, startsAt: m.startsAt.toISOString(), durationMin: m.durationMin, status: shownStatus(m, deps.now()), host: org?.name ?? "", videoEnabled: meetingsEnabled(deps), guestsWait: m.guestLobby };
}

export async function guestJoin(deps: Deps, token: string, name: string, lobbyId?: string) {
  const m = await guestRow(deps, token);
  const closed = closedReason(m, deps.now());
  if (closed) throw new HttpError(409, closed === "cancelled" ? "meeting_cancelled" : "meeting_ended", closed === "cancelled" ? "This meeting was cancelled." : "This meeting has ended.");
  // Round 32: with the waiting room on, only an admitted request gets a token, under the name it asked with.
  const admitted = deps.config.meetings ? await admittedGuest(deps, m, lobbyId) : null;
  const clean = admitted?.name ?? name.trim().slice(0, 60);
  if (!clean) throw new HttpError(422, "validation_failed", "Tell the others your name.");
  await minutesLeftForRoom(deps, m);
  // R114: in a webinar a guest from the meeting link watches only.
  const stage = deps.config.webinar ? await (await import("./webinar-r114")).stageRole(deps, null, m) : null;
  // Review Z8, F2: a guest let in through the waiting room joins under their request's room key (never its id, which
  // everyone in the call would see) plus a suffix per join, so Remove disconnects every tab of theirs and only theirs.
  const identity = admitted ? guestJoinIdentity(admitted.roomKey) : `guest-${urlToken(6)}`;
  return { title: m.title, ...(await livekitToken(deps, m.room, { identity, name: clean, host: false, publish: stage ? stage.publish : true })) };
}

/** R114: the same minutes check for a webinar attendee joining. */
export async function minutesLeftForRoomPublic(deps: Deps, m: { orgId: string; room: string }) { await minutesLeftForRoom(deps, m); }
