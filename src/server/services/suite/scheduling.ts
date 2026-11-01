/**
 * Meeting scheduling (round 11, on when SCHEDULING_ENABLED=true). A member sets weekly hours
 * and slot rules and shares /book/<slug>. Guests pick a free slot (existing meetings the host
 * created and other bookings are busy), and booking makes a meeting record with its video
 * guest link, an .ics file and a confirmation email through system mail. No paid calendar APIs.
 * A booking costs two inserts (meeting and booking); cancelling costs two updates.
 */
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, ne, or } from "drizzle-orm";
import type { Deps } from "../../context";
import { bookings, meetings, organizations, schedulingPages, users } from "../../db/schema";
import { randomToken, sha256Hex } from "../../lib/crypto";
import { HttpError, notFound } from "../../lib/errors";
import { emitEvent } from "../developer/webhooks";
import { assertWritable, sortableId, type SuiteActor } from "./common";
import { buildIcs } from "./meetings";
import { expandWeekly, parseRrule } from "./meeting-recurrence";

export const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Day = (typeof DAYS)[number];
export type WeeklyHours = Partial<Record<Day, [string, string][]>>;
export const SLOT_LENGTHS = [15, 30, 45, 60] as const;

export function schedulingEnabled(deps: Deps) { return !!deps.config.schedulingEnabled; }
export function assertScheduling(deps: Deps) {
  if (!schedulingEnabled(deps)) throw new HttpError(404, "not_found", "Not found.");
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validTimezone(tz: string) {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
}

/** The zone's offset from UTC in minutes at an instant. */
export function tzOffset(at: Date, tz: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** The instant of a wall clock time in a zone (DST safe: the offset is checked at the result). */
export function zonedTime(y: number, m: number, d: number, minutes: number, tz: string) {
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  let t = guess - tzOffset(new Date(guess), tz) * 60_000;
  const again = guess - tzOffset(new Date(t), tz) * 60_000;
  if (again !== t) t = again;
  return new Date(t);
}

/** The calendar date (y, m, d, weekday) of an instant in a zone. */
export function zonedDate(at: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(at).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), day: p.weekday.toLowerCase().slice(0, 3) as Day };
}

export function normaliseHours(h: WeeklyHours): WeeklyHours {
  const out: WeeklyHours = {};
  for (const day of DAYS) {
    const ranges = (h[day] ?? []).filter((r) => Array.isArray(r) && r.length === 2);
    for (const [a, b] of ranges) {
      if (!HHMM.test(a) || !HHMM.test(b) || toMin(a) >= toMin(b)) throw new HttpError(422, "validation_failed", `Check the hours on ${day}: use HH:MM, and end after start.`);
    }
    if (ranges.length) out[day] = ranges.slice(0, 6).sort((x, y) => toMin(x[0]) - toMin(y[0]));
  }
  return out;
}

export interface SlotRules { timezone: string; hours: WeeklyHours; slotMin: number; bufferMin: number; maxDaysAhead: number; minNoticeMin: number }
type Busy = { start: number; end: number };

/**
 * Free slot start times between `from` and `to`. A slot is free when it sits inside the day's
 * hours, starts after the minimum notice, and no busy time (widened by the buffer) overlaps it.
 */
export function computeSlots(rules: SlotRules, busy: Busy[], now: Date, from: Date, to: Date) {
  const out: string[] = [];
  const earliest = now.getTime() + rules.minNoticeMin * 60_000;
  const horizon = Math.min(to.getTime(), now.getTime() + rules.maxDaysAhead * 86400_000);
  const len = rules.slotMin * 60_000;
  const buf = rules.bufferMin * 60_000;
  let cursor = zonedDate(from, rules.timezone);
  for (let i = 0; i < 190; i++) {
    const dayStart = zonedTime(cursor.y, cursor.m, cursor.d, 0, rules.timezone).getTime();
    if (dayStart > horizon) break;
    for (const [a, b] of rules.hours[cursor.day] ?? []) {
      for (let m = toMin(a); m + rules.slotMin <= toMin(b); m += rules.slotMin) {
        const s = zonedTime(cursor.y, cursor.m, cursor.d, m, rules.timezone).getTime();
        if (s < earliest || s < from.getTime() || s + len > horizon + len || s >= to.getTime()) continue;
        if (busy.some((x) => s < x.end + buf && s + len > x.start - buf)) continue;
        out.push(new Date(s).toISOString());
      }
    }
    // Next calendar day in the zone (noon avoids DST edges).
    const next = new Date(zonedTime(cursor.y, cursor.m, cursor.d, 12 * 60, rules.timezone).getTime() + 86400_000);
    cursor = zonedDate(next, rules.timezone);
  }
  return out;
}

type PageRow = typeof schedulingPages.$inferSelect;

function presentPage(p: PageRow, appUrl: string) {
  return {
    id: p.id, slug: p.slug, title: p.title, description: p.description, timezone: p.timezone, hours: JSON.parse(p.hours) as WeeklyHours,
    slotMin: p.slotMin, bufferMin: p.bufferMin, maxDaysAhead: p.maxDaysAhead, minNoticeMin: p.minNoticeMin, video: p.video, enabled: p.enabled,
    url: `${appUrl}/book/${p.slug}`, updatedAt: p.updatedAt.toISOString(),
  };
}
export type SchedulingPage = ReturnType<typeof presentPage>;

type BookingRow = typeof bookings.$inferSelect;
function presentBooking(b: BookingRow, appUrl: string, guestUrl?: string | null) {
  return {
    id: b.id, pageId: b.pageId, meetingId: b.meetingId, startsAt: b.startsAt.toISOString(), endsAt: new Date(b.startsAt.getTime() + b.durationMin * 60_000).toISOString(),
    durationMin: b.durationMin, name: b.name, email: b.email, note: b.note, status: b.status, cancelledBy: b.cancelledBy,
    cancelledAt: b.cancelledAt ? b.cancelledAt.toISOString() : null, createdAt: b.createdAt.toISOString(),
    meetingUrl: b.meetingId ? `${appUrl}/app/meetings/${b.meetingId}` : null, guestUrl: guestUrl ?? null,
  };
}
export type Booking = ReturnType<typeof presentBooking>;

export async function getMyPage(deps: Deps, actor: SuiteActor) {
  assertScheduling(deps);
  const p = await deps.db.select().from(schedulingPages).where(and(eq(schedulingPages.orgId, actor.orgId), eq(schedulingPages.userId, actor.userId))).get();
  return p ? presentPage(p, deps.config.appUrl) : null;
}

export interface PageInput { slug?: string; title?: string; description?: string; timezone?: string; hours?: WeeklyHours; slotMin?: number; bufferMin?: number; maxDaysAhead?: number; minNoticeMin?: number; video?: boolean; enabled?: boolean }

const DEFAULT_HOURS: WeeklyHours = { mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]], wed: [["09:00", "17:00"]], thu: [["09:00", "17:00"]], fri: [["09:00", "17:00"]] };

/** Creates or updates the member's own booking page. */
export async function savePage(deps: Deps, actor: SuiteActor, input: PageInput) {
  assertScheduling(deps);
  assertWritable(actor);
  if (!actor.userId || actor.agentId) throw new HttpError(403, "forbidden", "Booking pages belong to people.");
  const existing = await deps.db.select().from(schedulingPages).where(and(eq(schedulingPages.orgId, actor.orgId), eq(schedulingPages.userId, actor.userId))).get();
  const slug = (input.slug ?? existing?.slug ?? (actor.name || actor.email.split("@")[0] || "meet")).toLowerCase().trim().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(slug)) throw new HttpError(422, "validation_failed", "Use 3 to 40 letters, numbers or dashes for the link.");
  const taken = await deps.db.select({ id: schedulingPages.id }).from(schedulingPages).where(eq(schedulingPages.slug, slug)).get();
  if (taken && taken.id !== existing?.id) throw new HttpError(409, "slug_taken", "That link is taken. Try another.");
  const timezone = input.timezone ?? existing?.timezone ?? (await deps.db.select({ tz: organizations.timezone }).from(organizations).where(eq(organizations.id, actor.orgId)).get())?.tz ?? "UTC";
  if (!validTimezone(timezone)) throw new HttpError(422, "validation_failed", "Choose a valid time zone.");
  const slotMin = input.slotMin ?? existing?.slotMin ?? 30;
  if (!(SLOT_LENGTHS as readonly number[]).includes(slotMin)) throw new HttpError(422, "validation_failed", "Slots are 15, 30, 45 or 60 minutes.");
  const bufferMin = input.bufferMin ?? existing?.bufferMin ?? 0;
  const maxDaysAhead = input.maxDaysAhead ?? existing?.maxDaysAhead ?? 30;
  const minNoticeMin = input.minNoticeMin ?? existing?.minNoticeMin ?? 120;
  if (bufferMin < 0 || bufferMin > 120) throw new HttpError(422, "validation_failed", "Buffer is 0 to 120 minutes.");
  if (maxDaysAhead < 1 || maxDaysAhead > 180) throw new HttpError(422, "validation_failed", "Book up to 1 to 180 days ahead.");
  if (minNoticeMin < 0 || minNoticeMin > 10_080) throw new HttpError(422, "validation_failed", "Notice is 0 minutes to 7 days.");
  const hours = normaliseHours(input.hours ?? (existing ? (JSON.parse(existing.hours) as WeeklyHours) : DEFAULT_HOURS));
  const values = {
    slug, title: (input.title ?? existing?.title ?? `Meet ${actor.name || "me"}`).trim().slice(0, 120) || "Meeting", description: (input.description ?? existing?.description ?? "").slice(0, 1000),
    timezone, hours: JSON.stringify(hours), slotMin, bufferMin, maxDaysAhead, minNoticeMin, video: input.video ?? existing?.video ?? true, enabled: input.enabled ?? existing?.enabled ?? true, updatedAt: deps.now(),
  };
  if (existing) await deps.db.update(schedulingPages).set(values).where(eq(schedulingPages.id, existing.id));
  else await deps.db.insert(schedulingPages).values({ id: sortableId("bkp", deps.now().getTime()), orgId: actor.orgId, userId: actor.userId, createdAt: deps.now(), ...values });
  return (await getMyPage(deps, actor))!;
}

/**
 * Busy time for a page's host in [from, to): their own meetings and confirmed bookings. A weekly
 * series is one row; every occurrence in the window counts as busy, worked out on read.
 */
async function busyFor(deps: Deps, p: PageRow, from: Date, to: Date): Promise<Busy[]> {
  const lookBack = new Date(from.getTime() - 8 * 3600_000);
  const [m, b] = await Promise.all([
    deps.db.select({ startsAt: meetings.startsAt, durationMin: meetings.durationMin, recurrence: meetings.recurrence, recurrenceTz: meetings.recurrenceTz }).from(meetings)
      .where(and(eq(meetings.orgId, p.orgId), eq(meetings.createdById, p.userId), ne(meetings.status, "cancelled"), isNull(meetings.deletedAt), lt(meetings.startsAt, to),
        or(gte(meetings.startsAt, lookBack), isNotNull(meetings.recurrence)))),
    deps.db.select({ startsAt: bookings.startsAt, durationMin: bookings.durationMin }).from(bookings)
      .where(and(eq(bookings.pageId, p.id), eq(bookings.status, "confirmed"), gte(bookings.startsAt, lookBack), lt(bookings.startsAt, to))),
  ]);
  return busyTimes(m, b, lookBack, to);
}

type BusyRow = { startsAt: Date; durationMin: number; recurrence?: string | null; recurrenceTz?: string | null };

/** Turns meeting and booking rows into busy ranges, expanding weekly series inside [from, to). */
export function busyTimes(meetingRows: BusyRow[], bookingRows: BusyRow[], from: Date, to: Date): Busy[] {
  const out: Busy[] = [];
  const add = (at: number, min: number) => out.push({ start: at, end: at + min * 60_000 });
  for (const x of meetingRows) {
    if (!x.recurrence) { if (x.startsAt.getTime() >= from.getTime()) add(x.startsAt.getTime(), x.durationMin); continue; }
    const tz = x.recurrenceTz || "UTC";
    let starts: Date[];
    try {
      // A meeting that began before the window can still run into it.
      starts = expandWeekly(x.startsAt, parseRrule(x.recurrence, tz), tz, new Date(from.getTime() - x.durationMin * 60_000), to, 500);
    } catch {
      starts = x.startsAt.getTime() >= from.getTime() ? [x.startsAt] : [];
    }
    for (const at of starts) add(at.getTime(), x.durationMin);
  }
  for (const x of bookingRows) add(x.startsAt.getTime(), x.durationMin);
  return out;
}

const rulesOf = (p: PageRow): SlotRules => ({ timezone: p.timezone, hours: JSON.parse(p.hours) as WeeklyHours, slotMin: p.slotMin, bufferMin: p.bufferMin, maxDaysAhead: p.maxDaysAhead, minNoticeMin: p.minNoticeMin });

async function publicRow(deps: Deps, slug: string) {
  assertScheduling(deps);
  const p = await deps.db.select().from(schedulingPages).where(eq(schedulingPages.slug, slug.toLowerCase())).get();
  if (!p || !p.enabled) throw notFound("Booking page");
  return p;
}

/** The public page: who, what, and the free slots in a window (default 14 days, at most 31). */
export async function publicAvailability(deps: Deps, slug: string, q: { from?: string; days?: number } = {}) {
  const p = await publicRow(deps, slug);
  const now = deps.now();
  const from = q.from && !Number.isNaN(Date.parse(q.from)) ? new Date(Math.max(Date.parse(q.from), now.getTime())) : now;
  const to = new Date(from.getTime() + Math.min(Math.max(q.days ?? 14, 1), 31) * 86400_000);
  const [host, org, location] = await Promise.all([
    deps.db.select({ name: users.name }).from(users).where(eq(users.id, p.userId)).get(),
    deps.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, p.orgId)).get(),
    // R115: the meeting place the host set (MAPS_R115 only; one indexed read).
    deps.config.mapsR115 ? import("../maps-r115").then((m) => m.bookingPlace(deps, p.orgId, p.id)) : Promise.resolve(null),
  ]);
  const slots = computeSlots(rulesOf(p), await busyFor(deps, p, from, to), now, from, to);
  return { page: { slug: p.slug, title: p.title, description: p.description, timezone: p.timezone, slotMin: p.slotMin, video: p.video, host: host?.name ?? "", organization: org?.name ?? "", maxDaysAhead: p.maxDaysAhead, ...(location ? { location } : {}) }, slots };
}

const when = (d: Date, tz: string) => new Intl.DateTimeFormat("en-AU", { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(d);

/** A guest books a slot. Checks the slot is still free; the unique slot key stops double booking. */
export async function bookSlot(deps: Deps, slug: string, input: { startsAt: string; name: string; email: string; note?: string; timezone?: string }) {
  const p = await publicRow(deps, slug);
  const name = input.name.trim().slice(0, 120);
  const email = input.email.trim().toLowerCase();
  if (!name) throw new HttpError(422, "validation_failed", "Enter your name.");
  if (!EMAIL.test(email) || email.length > 200) throw new HttpError(422, "validation_failed", "Enter a valid email address.");
  const start = new Date(input.startsAt);
  if (Number.isNaN(start.getTime())) throw new HttpError(422, "validation_failed", "Pick a time.");
  const now = deps.now();
  const dayFrom = new Date(start.getTime() - 60_000);
  const free = computeSlots(rulesOf(p), await busyFor(deps, p, dayFrom, new Date(start.getTime() + 86400_000)), now, dayFrom, new Date(start.getTime() + 60_000));
  if (!free.includes(start.toISOString())) throw new HttpError(409, "slot_taken", "That time is no longer free. Pick another.");

  const meetingId = sortableId("mtg", now.getTime());
  const guestToken = randomToken(18).replace(/[^A-Za-z0-9]/g, "").slice(0, 24);
  const cancelToken = randomToken(24).replace(/[^A-Za-z0-9]/g, "").slice(0, 32);
  const id = sortableId("bkg", now.getTime());
  const title = `${p.title}: ${name}`.slice(0, 200);
  try {
    await deps.db.insert(bookings).values({
      id, orgId: p.orgId, pageId: p.id, meetingId, startsAt: start, durationMin: p.slotMin, name, email, note: (input.note ?? "").trim().slice(0, 1000),
      status: "confirmed", slotKey: start.getTime(), cancelTokenHash: await sha256Hex(cancelToken), createdAt: now,
    });
  } catch {
    throw new HttpError(409, "slot_taken", "That time was just booked. Pick another.");
  }
  await deps.db.insert(meetings).values({
    id: meetingId, orgId: p.orgId, title, room: `multies-${meetingId.slice(4)}`, guestToken, startsAt: start, durationMin: p.slotMin, status: "scheduled",
    sourceType: "contact", sourceId: null, invitees: JSON.stringify([email]), createdByType: "member", createdById: p.userId, createdAt: now, updatedAt: now,
  });
  const booking = (await deps.db.select().from(bookings).where(eq(bookings.id, id)).get())!;
  const guestUrl = p.video ? `${deps.config.appUrl}/m/${guestToken}` : null;
  const cancelUrl = `${deps.config.appUrl}/book/${p.slug}/cancel/${id}?t=${cancelToken}`;
  const icsUrl = `${deps.config.appUrl}/api/book/bookings/${id}/ics?t=${cancelToken}`;
  await emitEvent(deps, p.orgId, "booking.created", { id, pageId: p.id, meetingId, startsAt: start.toISOString(), durationMin: p.slotMin, name, email, title });
  // R90: flows on "someone books a time".
  await (await import("./flows")).fireFlows(deps, p.orgId, "booking_made", { bookingId: id, title, name, email, start: start.toISOString(), minutes: p.slotMin, link: `${deps.config.appUrl}/app/booking` }, id);
  const host = await deps.db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, p.userId)).get();
  const tz = input.timezone && validTimezone(input.timezone) ? input.timezone : p.timezone;
  const { sendSystemEmail } = await import("../system-mail");
  await sendSystemEmail(deps, {
    to: email, orgId: p.orgId, template: "booking-confirmed", subject: `Confirmed: ${p.title} with ${host?.name ?? "your host"}`,
    text: `You're booked with ${host?.name ?? "your host"}.\n\n${p.title}\n${when(start, tz)} (${p.slotMin} minutes)\n${guestUrl ? `\nJoin the video call: ${guestUrl}\n` : ""}\nAdd it to your calendar: ${icsUrl}\nNeed to cancel? ${cancelUrl}`,
    action: { label: "Add to calendar", url: icsUrl },
  }).catch((err) => deps.reportError?.(err, { where: "booking_email" }));
  if (host) {
    const { notify } = await import("./notify");
    await notify(deps, p.orgId, p.userId, { type: "meeting.booked", entityType: "meeting", entityId: meetingId, title: `${name} booked ${when(start, p.timezone)}`, actorName: name });
  }
  return { booking: presentBooking(booking, deps.config.appUrl, guestUrl), cancelUrl, icsUrl, cancelToken };
}

async function bookingByToken(deps: Deps, id: string, token: string) {
  assertScheduling(deps);
  const b = await deps.db.select().from(bookings).where(eq(bookings.id, id)).get();
  if (!b || !token || (await sha256Hex(token)) !== b.cancelTokenHash) throw notFound("Booking");
  return b;
}

/** What the guest sees on the cancel page. */
export async function guestBooking(deps: Deps, id: string, token: string) {
  const b = await bookingByToken(deps, id, token);
  const p = (await deps.db.select().from(schedulingPages).where(eq(schedulingPages.id, b.pageId)).get())!;
  return { booking: presentBooking(b, deps.config.appUrl), page: { slug: p.slug, title: p.title, timezone: p.timezone } };
}

export async function bookingIcs(deps: Deps, id: string, token: string) {
  const b = await bookingByToken(deps, id, token);
  const p = (await deps.db.select().from(schedulingPages).where(eq(schedulingPages.id, b.pageId)).get())!;
  const m = b.meetingId ? await deps.db.select().from(meetings).where(eq(meetings.id, b.meetingId)).get() : undefined;
  const host = await deps.db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, p.userId)).get();
  const guestUrl = m && p.video ? `${deps.config.appUrl}/m/${m.guestToken}` : `${deps.config.appUrl}/book/${p.slug}`;
  return buildIcs({ id: b.id, title: `${p.title} with ${host?.name ?? "host"}`, startsAt: b.startsAt, durationMin: b.durationMin }, {
    organizer: { address: deps.config.systemFrom.address, name: host?.name }, invitees: [b.email], guestUrl, now: deps.now(),
    method: b.status === "cancelled" ? "CANCEL" : "REQUEST", sequence: b.status === "cancelled" ? 1 : 0,
  });
}

async function cancel(deps: Deps, b: BookingRow, by: "guest" | "host", actorName: string) {
  if (b.status === "cancelled") return b;
  const now = deps.now();
  await deps.db.update(bookings).set({ status: "cancelled", slotKey: null, cancelledBy: by, cancelledAt: now }).where(eq(bookings.id, b.id));
  if (b.meetingId) await deps.db.update(meetings).set({ status: "cancelled", updatedAt: now }).where(eq(meetings.id, b.meetingId));
  await emitEvent(deps, b.orgId, "booking.cancelled", { id: b.id, pageId: b.pageId, meetingId: b.meetingId, startsAt: b.startsAt.toISOString(), name: b.name, email: b.email, cancelledBy: by });
  const p = (await deps.db.select().from(schedulingPages).where(eq(schedulingPages.id, b.pageId)).get())!;
  if (by === "host") {
    const { sendSystemEmail } = await import("../system-mail");
    await sendSystemEmail(deps, {
      to: b.email, orgId: b.orgId, template: "booking-cancelled", subject: `Cancelled: ${p.title}`,
      text: `${actorName} cancelled your booking for ${when(b.startsAt, p.timezone)}.\n\nYou can pick a new time here: ${deps.config.appUrl}/book/${p.slug}`,
      action: { label: "Pick a new time", url: `${deps.config.appUrl}/book/${p.slug}` },
    }).catch((err) => deps.reportError?.(err, { where: "booking_email" }));
  } else if (b.meetingId) {
    const { notify } = await import("./notify");
    await notify(deps, b.orgId, p.userId, { type: "meeting.booking_cancelled", entityType: "meeting", entityId: b.meetingId, title: `${b.name} cancelled ${when(b.startsAt, p.timezone)}`, actorName: b.name });
  }
  return (await deps.db.select().from(bookings).where(eq(bookings.id, b.id)).get())!;
}

export async function cancelByGuest(deps: Deps, id: string, token: string) {
  const b = await bookingByToken(deps, id, token);
  return { booking: presentBooking(await cancel(deps, b, "guest", b.name), deps.config.appUrl) };
}

export async function cancelByHost(deps: Deps, actor: SuiteActor, id: string) {
  assertScheduling(deps);
  assertWritable(actor);
  const b = await deps.db.select().from(bookings).where(and(eq(bookings.orgId, actor.orgId), eq(bookings.id, id))).get();
  if (!b) throw notFound("Booking");
  const p = (await deps.db.select().from(schedulingPages).where(eq(schedulingPages.id, b.pageId)).get())!;
  const admin = actor.role === "owner" || actor.role === "admin";
  if (p.userId !== actor.userId && !admin && !actor.apiKeyId) throw new HttpError(403, "forbidden", "Only the host or an admin can cancel this booking.");
  return { booking: presentBooking(await cancel(deps, b, "host", actor.name || "Your host"), deps.config.appUrl) };
}

/**
 * R115 (R99 low): the scheduling pages whose bookings a person can open: their own pages in this workspace, admins
 * included (an admin opens only their own booking pages too). The app's Bookings list and the synced bookings
 * calendar (/dav/cal/bookings/) both read this, so a phone shows exactly what the app shows.
 */
export async function ownBookingPageIds(deps: Deps, orgId: string, userId: string): Promise<string[]> {
  return (await deps.db.select({ id: schedulingPages.id }).from(schedulingPages).where(and(eq(schedulingPages.orgId, orgId), eq(schedulingPages.userId, userId)))).map((r) => r.id);
}

/** Bookings, newest start last. A person sees their own pages'; an API key sees the workspace's. */
export async function listBookings(deps: Deps, actor: SuiteActor, q: { upcoming?: boolean; status?: "confirmed" | "cancelled"; limit?: number } = {}) {
  assertScheduling(deps);
  const own = !actor.apiKeyId && !actor.agentId;
  const pageIds = own ? await ownBookingPageIds(deps, actor.orgId, actor.userId) : null;
  if (pageIds && !pageIds.length) return [];
  const rows = await deps.db.select().from(bookings).where(and(
    eq(bookings.orgId, actor.orgId), pageIds ? inArray(bookings.pageId, pageIds) : undefined, // R115: every own page, not only the first
    q.upcoming ? gte(bookings.startsAt, new Date(deps.now().getTime() - 3600_000)) : undefined, q.status ? eq(bookings.status, q.status) : undefined,
  )).orderBy(asc(bookings.startsAt)).limit(Math.min(q.limit ?? 100, 500));
  return rows.map((b) => presentBooking(b, deps.config.appUrl));
}
