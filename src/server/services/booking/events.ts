/**
 * R92: free events with RSVP tickets. A member makes an event (draft, then published at /book/event/<slug>), guests
 * RSVP without an account (spam shield), get a QR ticket by mail and on /book/ticket/<id>?c=<code>; the door checks
 * people in from a phone by scanning the QR or typing the code. Capacity is held by an atomic counter; when the event
 * is full new people join the waitlist and the first in line moves up when someone cancels. Paid tickets are held.
 * Only a hash of each ticket code is stored.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { bookingEvents, eventTickets, organizations } from "../../db/schema";
import { hmacSha256Hex, sha256Hex } from "../../lib/crypto";
import { HttpError, notFound } from "../../lib/errors";
import { assertWritable, sortableId, type SuiteActor } from "../suite/common";
import { validTimezone } from "../suite/scheduling";
import { assertBookingPlus } from "./resources";
import { EVENT_MAX_CAPACITY, csvCell, formatTicketCode, makeTicketCode, normaliseTicketCode } from "@/shared/booking-plus";

type EventRow = typeof bookingEvents.$inferSelect;
type TicketRow = typeof eventTickets.$inferSelect;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,47}$/;
const isAdmin = (a: SuiteActor) => a.role === "owner" || a.role === "admin";
export const MAX_TICKETS_LIST = 5000;

/** A ticket's code is derived from its id with the app secret, so a resend or a move up from the waitlist mails the same code. */
async function codeFor(deps: Deps, ticketId: string) {
  const hex = await hmacSha256Hex(`ticket:${deps.config.appSecret || "dev-secret"}`, ticketId);
  return makeTicketCode(Uint8Array.from(hex.slice(0, 16).match(/../g)!.map((h) => parseInt(h, 16))));
}
function slugify(s: string) {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "event";
}

export function presentEvent(e: EventRow, appUrl: string) {
  return {
    id: e.id, slug: e.slug, title: e.title, description: e.description, location: e.location, onlineUrl: e.onlineUrl, startsAt: e.startsAt.toISOString(), endsAt: e.endsAt.toISOString(),
    timezone: e.timezone, capacity: e.capacity, waitlist: e.waitlist, status: e.status, going: e.goingCount, waiting: e.waitlistCount, checkedIn: e.checkedInCount,
    url: `${appUrl}/book/event/${e.slug}`,
  };
}
export type EventView = ReturnType<typeof presentEvent>;
function presentTicket(t: TicketRow) {
  return { id: t.id, name: t.name, email: t.email, status: t.status, checkedInAt: t.checkedInAt?.toISOString() ?? null, createdAt: t.createdAt.toISOString() };
}

async function eventRow(deps: Deps, actor: SuiteActor, id: string) {
  const e = await deps.db.select().from(bookingEvents).where(and(eq(bookingEvents.id, id), eq(bookingEvents.orgId, actor.orgId))).get();
  if (!e) throw notFound("Event");
  return e;
}
function assertOwner(actor: SuiteActor, e: EventRow) {
  if (e.createdBy !== actor.userId && !isAdmin(actor)) throw new HttpError(403, "forbidden", "Only the organiser or an admin can change this event.");
}

export interface EventInput {
  title?: string; description?: string; location?: string; onlineUrl?: string; startsAt?: string; endsAt?: string; timezone?: string;
  capacity?: number | null; waitlist?: boolean; slug?: string; status?: "draft" | "published";
}

export async function saveEvent(deps: Deps, actor: SuiteActor, input: EventInput, id?: string) {
  assertBookingPlus(deps);
  assertWritable(actor);
  const prev = id ? await eventRow(deps, actor, id) : null;
  if (prev) assertOwner(actor, prev);
  if (prev?.status === "cancelled") throw new HttpError(409, "cancelled", "This event was cancelled.");
  const title = (input.title ?? prev?.title ?? "").trim().slice(0, 120);
  if (!title) throw new HttpError(422, "validation_failed", "Give the event a title.");
  const tz = input.timezone ?? prev?.timezone ?? "UTC";
  if (!validTimezone(tz)) throw new HttpError(422, "validation_failed", "Pick a valid time zone.");
  const start = input.startsAt ? new Date(input.startsAt) : prev?.startsAt;
  const end = input.endsAt ? new Date(input.endsAt) : prev?.endsAt;
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new HttpError(422, "validation_failed", "Pick when it starts and ends.");
  if (end.getTime() <= start.getTime()) throw new HttpError(422, "validation_failed", "The end must be after the start.");
  if (!prev && start.getTime() < deps.now().getTime()) throw new HttpError(422, "validation_failed", "The start must be in the future.");
  const capacity = input.capacity !== undefined ? input.capacity : prev?.capacity ?? null;
  if (capacity != null && (capacity < 1 || capacity > EVENT_MAX_CAPACITY)) throw new HttpError(422, "validation_failed", `Capacity must be between 1 and ${EVENT_MAX_CAPACITY}.`);
  if (prev && capacity != null && capacity < prev.goingCount) throw new HttpError(422, "validation_failed", `${prev.goingCount} people are already going. Capacity can't be lower.`);
  const onlineUrl = (input.onlineUrl ?? prev?.onlineUrl ?? "").trim().slice(0, 500);
  if (onlineUrl && !/^https:\/\/\S+$/.test(onlineUrl)) throw new HttpError(422, "validation_failed", "The online link must start with https://.");
  const now = deps.now();
  const values = {
    title, description: (input.description ?? prev?.description ?? "").trim().slice(0, 5000), location: (input.location ?? prev?.location ?? "").trim().slice(0, 200), onlineUrl,
    startsAt: start, endsAt: end, timezone: tz, capacity, waitlist: input.waitlist ?? prev?.waitlist ?? true, status: input.status ?? prev?.status ?? "draft", updatedAt: now,
  } as const;
  if (prev) {
    await deps.db.update(bookingEvents).set(values).where(eq(bookingEvents.id, prev.id));
    if (prev.capacity != null && (capacity == null || capacity > prev.capacity)) await promoteWaitlist(deps, prev.id);
    return { event: presentEvent(await eventRow(deps, actor, prev.id), deps.config.appUrl) };
  }
  let slug = input.slug ? input.slug.trim().toLowerCase() : `${slugify(title)}-${Math.random().toString(36).slice(2, 7)}`;
  if (!SLUG.test(slug)) throw new HttpError(422, "validation_failed", "Use 3 to 48 lowercase letters, numbers and hyphens for the link.");
  const taken = await deps.db.select({ id: bookingEvents.id }).from(bookingEvents).where(eq(bookingEvents.slug, slug)).get();
  if (taken) {
    if (input.slug) throw new HttpError(409, "slug_taken", "That link is taken. Try another.");
    slug = `${slug.slice(0, 40)}-${Math.random().toString(36).slice(2, 6)}`;
  }
  const newId = sortableId("evt", now.getTime());
  await deps.db.insert(bookingEvents).values({ id: newId, orgId: actor.orgId, createdBy: actor.userId, slug, createdAt: now, ...values });
  return { event: presentEvent(await eventRow(deps, actor, newId), deps.config.appUrl) };
}

export async function listEvents(deps: Deps, actor: SuiteActor) {
  assertBookingPlus(deps);
  const rows = await deps.db.select().from(bookingEvents).where(eq(bookingEvents.orgId, actor.orgId)).orderBy(desc(bookingEvents.startsAt)).limit(200).all();
  return rows.map((e) => ({ ...presentEvent(e, deps.config.appUrl), mine: e.createdBy === actor.userId }));
}

export async function eventDetail(deps: Deps, actor: SuiteActor, id: string) {
  assertBookingPlus(deps);
  const e = await eventRow(deps, actor, id);
  const tickets = await deps.db.select().from(eventTickets).where(eq(eventTickets.eventId, e.id)).orderBy(asc(eventTickets.createdAt)).limit(MAX_TICKETS_LIST).all();
  return { event: presentEvent(e, deps.config.appUrl), tickets: tickets.map(presentTicket) };
}

export async function attendeesCsv(deps: Deps, actor: SuiteActor, id: string) {
  const { event, tickets } = await eventDetail(deps, actor, id);
  const head = ["Name", "Email", "Status", "Checked in", "Signed up"].map(csvCell).join(",");
  const lines = tickets.map((t) => [t.name, t.email, t.status === "going" ? "Going" : t.status === "waitlist" ? "Waitlist" : "Cancelled", t.checkedInAt ?? "", t.createdAt].map(csvCell).join(","));
  return { filename: `${event.slug}-attendees.csv`, csv: `\ufeff${[head, ...lines].join("\r\n")}\r\n` };
}

/** Cancels the event and tells everyone going or waiting. */
export async function cancelEvent(deps: Deps, actor: SuiteActor, id: string) {
  assertBookingPlus(deps);
  const e = await eventRow(deps, actor, id);
  assertOwner(actor, e);
  if (e.status === "cancelled") return { event: presentEvent(e, deps.config.appUrl), mailed: 0 };
  await deps.db.update(bookingEvents).set({ status: "cancelled", updatedAt: deps.now() }).where(eq(bookingEvents.id, e.id));
  let mailed = 0;
  if (e.status === "published") {
    const people = await deps.db.select({ email: eventTickets.email }).from(eventTickets).where(and(eq(eventTickets.eventId, e.id), sql`${eventTickets.status} != 'cancelled'`)).limit(1000).all();
    const { sendSystemEmail } = await import("../system-mail");
    for (const p of people) {
      const r = await sendSystemEmail(deps, { to: p.email, orgId: e.orgId, template: "event-cancelled", subject: `Cancelled: ${e.title}`, text: `${e.title} on ${whenText(e)} has been cancelled. Your ticket no longer works. Sorry for the change of plans.` })
        .catch((err) => { deps.reportError?.(err, { where: "event_cancel_email" }); return null; });
      if (r?.delivered) mailed++;
    }
  }
  return { event: presentEvent(await eventRow(deps, actor, id), deps.config.appUrl), mailed };
}

export async function deleteEvent(deps: Deps, actor: SuiteActor, id: string) {
  assertBookingPlus(deps);
  const e = await eventRow(deps, actor, id);
  assertOwner(actor, e);
  if (e.status === "published" && e.goingCount + e.waitlistCount > 0) throw new HttpError(409, "has_people", "People have tickets. Cancel the event instead, so they hear about it.");
  await deps.db.delete(bookingEvents).where(eq(bookingEvents.id, e.id));
  return { ok: true };
}

/** Door check in: by the QR's ticket id and code, or by the typed code alone. */
export async function checkInTicket(deps: Deps, actor: SuiteActor, id: string, input: { code: string; ticketId?: string | null; undo?: boolean }) {
  assertBookingPlus(deps);
  assertWritable(actor);
  const e = await eventRow(deps, actor, id);
  const code = normaliseTicketCode(input.code ?? "");
  if (code.length !== 8) throw new HttpError(422, "validation_failed", "Enter the 8 character ticket code.");
  const hash = await sha256Hex(`${e.id}:${code}`);
  const t = await deps.db.select().from(eventTickets).where(and(eq(eventTickets.eventId, e.id), eq(eventTickets.codeHash, hash))).get();
  if (!t || (input.ticketId && input.ticketId !== t.id)) return { result: "unknown" as const };
  if (t.status === "cancelled") return { result: "cancelled" as const, ticket: presentTicket(t) };
  if (t.status === "waitlist") return { result: "waitlist" as const, ticket: presentTicket(t) };
  if (input.undo) {
    if (t.checkedInAt) {
      await deps.db.update(eventTickets).set({ checkedInAt: null, updatedAt: deps.now() }).where(eq(eventTickets.id, t.id));
      await deps.db.update(bookingEvents).set({ checkedInCount: sql`max(0, ${bookingEvents.checkedInCount} - 1)` }).where(eq(bookingEvents.id, e.id));
    }
    return { result: "undone" as const, ticket: presentTicket((await deps.db.select().from(eventTickets).where(eq(eventTickets.id, t.id)).get())!) };
  }
  if (t.checkedInAt) return { result: "already" as const, ticket: presentTicket(t) };
  const done = await deps.db.update(eventTickets).set({ checkedInAt: deps.now(), updatedAt: deps.now() }).where(and(eq(eventTickets.id, t.id), sql`${eventTickets.checkedInAt} is null`)).returning({ id: eventTickets.id });
  if (done.length) await deps.db.update(bookingEvents).set({ checkedInCount: sql`${bookingEvents.checkedInCount} + 1` }).where(eq(bookingEvents.id, e.id));
  return { result: done.length ? ("ok" as const) : ("already" as const), ticket: presentTicket((await deps.db.select().from(eventTickets).where(eq(eventTickets.id, t.id)).get())!) };
}

function whenText(e: EventRow) {
  return new Intl.DateTimeFormat("en-AU", { timeZone: e.timezone, weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(e.startsAt);
}

/** Moves people up from the waitlist while there is room, oldest first, and mails their tickets. */
export async function promoteWaitlist(deps: Deps, eventId: string) {
  for (let i = 0; i < 50; i++) {
    const seat = await deps.db.update(bookingEvents).set({ goingCount: sql`${bookingEvents.goingCount} + 1`, waitlistCount: sql`max(0, ${bookingEvents.waitlistCount} - 1)` })
      .where(and(eq(bookingEvents.id, eventId), sql`${bookingEvents.waitlistCount} > 0`, sql`(${bookingEvents.capacity} is null or ${bookingEvents.goingCount} < ${bookingEvents.capacity})`)).returning();
    if (!seat.length) return;
    const next = await deps.db.select().from(eventTickets).where(and(eq(eventTickets.eventId, eventId), eq(eventTickets.status, "waitlist"))).orderBy(asc(eventTickets.createdAt)).get();
    if (!next) {
      await deps.db.update(bookingEvents).set({ goingCount: sql`max(0, ${bookingEvents.goingCount} - 1)`, waitlistCount: 0 }).where(eq(bookingEvents.id, eventId));
      return;
    }
    const code = await codeFor(deps, next.id);
    await deps.db.update(eventTickets).set({ status: "going", updatedAt: deps.now() }).where(eq(eventTickets.id, next.id));
    await mailTicket(deps, seat[0], next.id, next.email, next.name, code, "promoted");
  }
}

export function ticketUrl(appUrl: string, ticketId: string, code: string) {
  return `${appUrl}/book/ticket/${ticketId}?c=${code}`;
}

async function mailTicket(deps: Deps, e: EventRow, ticketId: string, to: string, name: string, code: string, why: "new" | "promoted" | "waitlist" | "resent") {
  const url = ticketUrl(deps.config.appUrl, ticketId, code);
  const where = [e.location, e.onlineUrl].filter(Boolean).join("\n");
  const lead = why === "waitlist" ? `You're on the waitlist for ${e.title}. We'll mail your ticket if a place opens up.`
    : why === "promoted" ? `Good news, ${name}: a place opened up and you're going to ${e.title}.`
      : `You're going to ${e.title}, ${name}.`;
  const text = why === "waitlist" ? `${lead}\n\n${whenText(e)}${where ? `\n${where}` : ""}\n\nYour place: ${url}`
    : `${lead}\n\n${whenText(e)}${where ? `\n${where}` : ""}\n\nShow this QR code at the door, or tell them your code: ${formatTicketCode(code)}\n\nYour ticket: ${url}`;
  const { sendSystemEmail, emailBrand } = await import("../system-mail");
  const { EventTicket } = await import("../../emails");
  const { createElement } = await import("react");
  const subject = why === "waitlist" ? `Waitlist: ${e.title}` : `Your ticket: ${e.title}`;
  const qrUrl = why === "waitlist" ? null : `${deps.config.appUrl}/api/pub/booking/tickets/${ticketId}/qr.png?c=${code}`;
  await sendSystemEmail(deps, {
    to, orgId: e.orgId, template: "event-ticket", subject, text, action: { label: why === "waitlist" ? "See my place" : "Show my ticket", url },
    element: createElement(EventTicket, { brand: emailBrand(deps), title: subject, text, qrUrl, code: why === "waitlist" ? null : formatTicketCode(code), action: { label: why === "waitlist" ? "See my place" : "Show my ticket", url } }),
  }).catch((err) => deps.reportError?.(err, { where: "event_ticket_email" }));
}

/* Public side: /book/event/<slug> and /book/ticket/<id>?c=<code> */

async function publicEventRow(deps: Deps, slug: string) {
  assertBookingPlus(deps);
  if (!SLUG.test(slug)) throw notFound("Event");
  const e = await deps.db.select().from(bookingEvents).where(eq(bookingEvents.slug, slug)).get();
  if (!e || e.status === "draft") throw notFound("Event");
  return e;
}

function publicView(deps: Deps, e: EventRow, org: string) {
  const { id: _id, going, waiting, checkedIn: _c, ...rest } = presentEvent(e, deps.config.appUrl);
  const full = e.capacity != null && going >= e.capacity;
  return { ...rest, organiser: org, spotsLeft: e.capacity == null ? null : Math.max(0, e.capacity - going), full, waitlistOpen: full && e.waitlist, waiting: full ? waiting : 0, past: e.endsAt.getTime() < deps.now().getTime() };
}

export async function publicEvent(deps: Deps, slug: string) {
  const e = await publicEventRow(deps, slug);
  const org = await deps.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, e.orgId)).get();
  return { event: publicView(deps, e, org?.name ?? "") };
}

export async function rsvp(deps: Deps, slug: string, input: { name: string; email: string }) {
  const e = await publicEventRow(deps, slug);
  if (e.status === "cancelled") throw new HttpError(409, "cancelled", "This event was cancelled.");
  if (e.endsAt.getTime() < deps.now().getTime()) throw new HttpError(409, "past", "This event has ended.");
  const name = input.name.trim().slice(0, 80);
  const email = input.email.trim().toLowerCase();
  if (!name) throw new HttpError(422, "validation_failed", "Enter your name.");
  if (!EMAIL.test(email) || email.length > 200) throw new HttpError(422, "validation_failed", "Enter a valid email address.");
  const now = deps.now();
  const existing = await deps.db.select().from(eventTickets).where(and(eq(eventTickets.eventId, e.id), eq(eventTickets.email, email))).get();
  if (existing && existing.status !== "cancelled") {
    // Never hand someone else's ticket to whoever typed the address: mail it to the address instead.
    await mailTicket(deps, e, existing.id, email, existing.name, await codeFor(deps, existing.id), existing.status === "waitlist" ? "waitlist" : "resent");
    return { status: "resent" as const };
  }
  const seat = await deps.db.update(bookingEvents).set({ goingCount: sql`${bookingEvents.goingCount} + 1` })
    .where(and(eq(bookingEvents.id, e.id), sql`(${bookingEvents.capacity} is null or ${bookingEvents.goingCount} < ${bookingEvents.capacity})`)).returning({ id: bookingEvents.id });
  let status: "going" | "waitlist" = "going";
  if (!seat.length) {
    if (!e.waitlist) throw new HttpError(409, "full", "This event is full.");
    status = "waitlist";
    await deps.db.update(bookingEvents).set({ waitlistCount: sql`${bookingEvents.waitlistCount} + 1` }).where(eq(bookingEvents.id, e.id));
  }
  const id = existing?.id ?? sortableId("tkt", now.getTime());
  const code = await codeFor(deps, id);
  const codeHash = await sha256Hex(`${e.id}:${code}`);
  if (existing) await deps.db.update(eventTickets).set({ name, status, codeHash, checkedInAt: null, createdAt: now, updatedAt: now }).where(eq(eventTickets.id, existing.id));
  else await deps.db.insert(eventTickets).values({ id, eventId: e.id, orgId: e.orgId, name, email, status, codeHash, createdAt: now, updatedAt: now });
  await mailTicket(deps, e, id, email, name, code, status === "waitlist" ? "waitlist" : "new");
  try {
    const { notify } = await import("../suite/notify");
    await notify(deps, e.orgId, e.createdBy, { type: "event.rsvp", entityType: "meeting", entityId: e.id, title: `${name} ${status === "going" ? "is going to" : "joined the waitlist for"} ${e.title}`, actorName: name });
  } catch { /* a missing notice never fails the RSVP */ }
  return { status, ticketId: id, code, url: ticketUrl(deps.config.appUrl, id, code) };
}

async function ticketByCode(deps: Deps, id: string, code: string) {
  assertBookingPlus(deps);
  const c = normaliseTicketCode(code ?? "");
  const t = /^tkt_[a-z0-9]{10,40}$/.test(id) && c.length === 8 ? await deps.db.select().from(eventTickets).where(eq(eventTickets.id, id)).get() : null;
  if (!t || (await sha256Hex(`${t.eventId}:${c}`)) !== t.codeHash) throw notFound("Ticket");
  const e = (await deps.db.select().from(bookingEvents).where(eq(bookingEvents.id, t.eventId)).get())!;
  return { t, e, code: c };
}

export async function publicTicket(deps: Deps, id: string, code: string) {
  const { t, e, code: c } = await ticketByCode(deps, id, code);
  const org = await deps.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, e.orgId)).get();
  return { ticket: { id: t.id, name: t.name, status: t.status, checkedIn: !!t.checkedInAt, code: formatTicketCode(c), url: ticketUrl(deps.config.appUrl, t.id, c) }, event: publicView(deps, e, org?.name ?? "") };
}

export async function cancelTicket(deps: Deps, id: string, code: string) {
  const { t, e } = await ticketByCode(deps, id, code);
  if (t.status === "cancelled") return publicTicket(deps, id, code);
  await deps.db.update(eventTickets).set({ status: "cancelled", updatedAt: deps.now() }).where(eq(eventTickets.id, t.id));
  if (t.status === "going") {
    await deps.db.update(bookingEvents).set({ goingCount: sql`max(0, ${bookingEvents.goingCount} - 1)` }).where(eq(bookingEvents.id, e.id));
    await promoteWaitlist(deps, e.id);
  } else {
    await deps.db.update(bookingEvents).set({ waitlistCount: sql`max(0, ${bookingEvents.waitlistCount} - 1)` }).where(eq(bookingEvents.id, e.id));
  }
  return publicTicket(deps, id, code);
}

export async function ticketQrPng(deps: Deps, id: string, code: string) {
  const { t, code: c } = await ticketByCode(deps, id, code);
  const { qrPng } = await import("./qr-png");
  return qrPng(ticketUrl(deps.config.appUrl, t.id, c));
}
