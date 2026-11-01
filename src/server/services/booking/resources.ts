/**
 * R92: resource booking (rooms, desks, vehicles, equipment). Admins set rules (open days and hours, steps, shortest
 * and longest booking, weekly quota per member, approval, check in by QR with release of no shows); members book from
 * the day grid. Overlaps are refused, also when two people book the same slot at once (checked after the insert).
 * No shows are released lazily when the grid or a list is read. Nothing here sits on a hot read route.
 */
import { and, asc, eq, gt, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { bookingResources, resourceBookings } from "../../db/schema";
import { randomToken, sha256Hex } from "../../lib/crypto";
import { inIds } from "../../lib/sql-chunks";
import { HttpError, notFound } from "../../lib/errors";
import { assertWritable, sortableId, type SuiteActor } from "../suite/common";
import { validTimezone, zonedDate, zonedTime } from "../suite/scheduling";
import { RESOURCE_KINDS, WEEK_DAYS, durationLabel, ruleProblem, rulesProblem, toMinutes, type ResourceKind, type WeekDay } from "@/shared/booking-plus";

type ResourceRow = typeof bookingResources.$inferSelect;
type BookingRow = typeof resourceBookings.$inferSelect;
const ACTIVE = ["pending", "confirmed"] as const;
export const MAX_RESOURCES = 200;

export function assertBookingPlus(deps: Deps) {
  if (!deps.config.bookingPlus) throw new HttpError(404, "not_found", "Not found.");
}
const isAdmin = (a: SuiteActor) => a.role === "owner" || a.role === "admin";
function requireAdminActor(a: SuiteActor) {
  if (!isAdmin(a)) throw new HttpError(403, "forbidden", "Only workspace admins can change resources.");
}

function daysOf(r: ResourceRow): WeekDay[] {
  try { const d = JSON.parse(r.days) as string[]; return WEEK_DAYS.filter((x) => d.includes(x)); } catch { return []; }
}

export function presentResource(r: ResourceRow, appUrl: string, admin: boolean) {
  return {
    id: r.id, name: r.name, kind: r.kind as ResourceKind, location: r.location, description: r.description, capacity: r.capacity, timezone: r.timezone,
    days: daysOf(r), openFrom: r.openFrom, openTo: r.openTo, stepMin: r.stepMin, minMin: r.minMin, maxMin: r.maxMin, quotaMinWeek: r.quotaMinWeek,
    needsApproval: r.needsApproval, checkinRequired: r.checkinRequired, releaseAfterMin: r.releaseAfterMin, archived: !!r.archivedAt,
    /** Only admins get the check in link (it is printed as a QR at the resource). */
    checkinUrl: admin ? `${appUrl}/app/scheduling?tab=resources&checkin=${r.id}&k=${r.checkinKey}` : null,
  };
}
export type ResourceView = ReturnType<typeof presentResource>;

export function presentResourceBooking(b: BookingRow, me: string) {
  return {
    id: b.id, resourceId: b.resourceId, userId: b.userId, userName: b.userName, title: b.title, startsAt: b.startsAt.toISOString(), endsAt: b.endsAt.toISOString(),
    status: b.status, checkedInAt: b.checkedInAt?.toISOString() ?? null, mine: b.userId === me,
  };
}

export interface ResourceInput {
  name?: string; kind?: ResourceKind; location?: string; description?: string; capacity?: number | null; timezone?: string; days?: WeekDay[];
  openFrom?: string; openTo?: string; stepMin?: number; minMin?: number; maxMin?: number; quotaMinWeek?: number | null; needsApproval?: boolean;
  checkinRequired?: boolean; releaseAfterMin?: number; archived?: boolean;
}

async function resourceRow(deps: Deps, orgId: string, id: string) {
  const r = await deps.db.select().from(bookingResources).where(and(eq(bookingResources.id, id), eq(bookingResources.orgId, orgId))).get();
  if (!r) throw notFound("Resource");
  return r;
}

export async function listResources(deps: Deps, actor: SuiteActor, q: { archived?: boolean } = {}) {
  assertBookingPlus(deps);
  const rows = await deps.db.select().from(bookingResources)
    .where(and(eq(bookingResources.orgId, actor.orgId), q.archived ? undefined : isNull(bookingResources.archivedAt)))
    .orderBy(asc(bookingResources.name)).limit(MAX_RESOURCES).all();
  return rows.map((r) => presentResource(r, deps.config.appUrl, isAdmin(actor)));
}

export async function saveResource(deps: Deps, actor: SuiteActor, input: ResourceInput, id?: string) {
  assertBookingPlus(deps);
  assertWritable(actor);
  requireAdminActor(actor);
  const now = deps.now();
  const prev = id ? await resourceRow(deps, actor.orgId, id) : null;
  const name = (input.name ?? prev?.name ?? "").trim().slice(0, 80);
  if (!name) throw new HttpError(422, "validation_failed", "Give the resource a name.");
  const tz = input.timezone ?? prev?.timezone ?? "UTC";
  if (!validTimezone(tz)) throw new HttpError(422, "validation_failed", "Pick a valid time zone.");
  const kind = input.kind ?? (prev?.kind as ResourceKind | undefined) ?? "room";
  if (!RESOURCE_KINDS.includes(kind)) throw new HttpError(422, "validation_failed", "Pick a kind.");
  const rules = {
    days: input.days ? WEEK_DAYS.filter((d) => input.days!.includes(d)) : prev ? daysOf(prev) : (["mon", "tue", "wed", "thu", "fri"] as WeekDay[]),
    openFrom: input.openFrom ?? prev?.openFrom ?? "08:00", openTo: input.openTo ?? prev?.openTo ?? "18:00",
    stepMin: input.stepMin ?? prev?.stepMin ?? 30, minMin: input.minMin ?? prev?.minMin ?? 30, maxMin: input.maxMin ?? prev?.maxMin ?? 240,
  };
  const bad = rulesProblem(rules);
  if (bad) throw new HttpError(422, "validation_failed", bad);
  const quota = input.quotaMinWeek !== undefined ? input.quotaMinWeek : prev?.quotaMinWeek ?? null;
  if (quota != null && (quota < rules.minMin || quota > 7 * 24 * 60)) throw new HttpError(422, "validation_failed", `The weekly limit must be at least ${durationLabel(rules.minMin)}.`);
  const capacity = input.capacity !== undefined ? input.capacity : prev?.capacity ?? null;
  const values = {
    name, kind, timezone: tz, location: (input.location ?? prev?.location ?? "").trim().slice(0, 120), description: (input.description ?? prev?.description ?? "").trim().slice(0, 1000),
    capacity: capacity && capacity > 0 ? Math.min(capacity, 10_000) : null, days: JSON.stringify(rules.days), openFrom: rules.openFrom, openTo: rules.openTo,
    stepMin: rules.stepMin, minMin: rules.minMin, maxMin: rules.maxMin, quotaMinWeek: quota,
    needsApproval: input.needsApproval ?? prev?.needsApproval ?? false, checkinRequired: input.checkinRequired ?? prev?.checkinRequired ?? false,
    releaseAfterMin: Math.max(5, Math.min(120, input.releaseAfterMin ?? prev?.releaseAfterMin ?? 15)),
    archivedAt: input.archived === undefined ? prev?.archivedAt ?? null : input.archived ? now : null, updatedAt: now,
  };
  if (prev) {
    await deps.db.update(bookingResources).set(values).where(eq(bookingResources.id, prev.id));
    return presentResource((await resourceRow(deps, actor.orgId, prev.id)), deps.config.appUrl, true);
  }
  const count = await deps.db.select({ n: sql<number>`count(*)` }).from(bookingResources).where(eq(bookingResources.orgId, actor.orgId)).get();
  if ((count?.n ?? 0) >= MAX_RESOURCES) throw new HttpError(422, "limit_reached", `A workspace can have up to ${MAX_RESOURCES} resources.`);
  const newId = sortableId("rsc", now.getTime());
  await deps.db.insert(bookingResources).values({ id: newId, orgId: actor.orgId, createdBy: actor.userId, checkinKey: randomToken(18).replace(/[^A-Za-z0-9]/g, "").slice(0, 24), createdAt: now, ...values });
  return presentResource(await resourceRow(deps, actor.orgId, newId), deps.config.appUrl, true);
}

/** Marks confirmed bookings that needed a check in and did not get one as released, so the slot frees up. */
export async function releaseNoShows(deps: Deps, orgId: string) {
  const now = deps.now().getTime();
  const rows = await deps.db.select({ id: resourceBookings.id, startsAt: resourceBookings.startsAt, release: bookingResources.releaseAfterMin })
    .from(resourceBookings).innerJoin(bookingResources, eq(bookingResources.id, resourceBookings.resourceId))
    .where(and(eq(resourceBookings.orgId, orgId), eq(resourceBookings.status, "confirmed"), isNull(resourceBookings.checkedInAt), eq(bookingResources.checkinRequired, true),
      lt(resourceBookings.startsAt, new Date(now)), gt(resourceBookings.endsAt, new Date(now - 7 * 86400_000))))
    .limit(200).all();
  const due = rows.filter((r) => r.startsAt.getTime() + r.release * 60_000 <= now).map((r) => r.id);
  if (due.length) await deps.db.update(resourceBookings).set({ status: "released", decidedAt: new Date(now) }).where(and(inIds(resourceBookings.id, due), eq(resourceBookings.status, "confirmed"), isNull(resourceBookings.checkedInAt)));
  return due.length;
}

/** The day grid: resources with their open window on that date and the day's bookings. `date` is YYYY-MM-DD. */
export async function dayGrid(deps: Deps, actor: SuiteActor, date: string) {
  assertBookingPlus(deps);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new HttpError(422, "validation_failed", "Pick a date.");
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  await releaseNoShows(deps, actor.orgId);
  const list = await listResources(deps, actor);
  const rows = await deps.db.select().from(bookingResources).where(and(eq(bookingResources.orgId, actor.orgId), isNull(bookingResources.archivedAt))).limit(MAX_RESOURCES).all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const weekday = WEEK_DAYS[(new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 6) % 7];
  let from = Infinity, to = -Infinity;
  const resources = list.map((r) => {
    const row = byId.get(r.id)!;
    const open = daysOf(row).includes(weekday) ? { from: zonedTime(y, mo, d, toMinutes(row.openFrom), row.timezone), to: zonedTime(y, mo, d, toMinutes(row.openTo), row.timezone) } : null;
    if (open) { from = Math.min(from, open.from.getTime()); to = Math.max(to, open.to.getTime()); }
    return { ...r, open: open ? { from: open.from.toISOString(), to: open.to.toISOString() } : null };
  });
  const bookingsOfDay = Number.isFinite(from) ? await deps.db.select().from(resourceBookings)
    .where(and(eq(resourceBookings.orgId, actor.orgId), inArray(resourceBookings.status, [...ACTIVE]), lt(resourceBookings.startsAt, new Date(to)), gt(resourceBookings.endsAt, new Date(from))))
    .orderBy(asc(resourceBookings.startsAt)).limit(1000).all() : [];
  return { date, weekday, resources, bookings: bookingsOfDay.map((b) => presentResourceBooking(b, actor.userId)) };
}

function weekBounds(at: Date, tz: string) {
  const z = zonedDate(at, tz);
  const idx = WEEK_DAYS.indexOf(z.day as WeekDay);
  const monday = new Date(Date.UTC(z.y, z.m - 1, z.d - idx));
  const start = zonedTime(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate(), 0, tz);
  const next = new Date(Date.UTC(z.y, z.m - 1, z.d - idx + 7));
  return { start, end: zonedTime(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, tz) };
}

export async function bookResource(deps: Deps, actor: SuiteActor, input: { resourceId: string; startsAt: string; endsAt: string; title?: string }) {
  assertBookingPlus(deps);
  assertWritable(actor);
  const r = await resourceRow(deps, actor.orgId, input.resourceId);
  if (r.archivedAt) throw new HttpError(409, "archived", "This resource is archived.");
  const start = new Date(input.startsAt), end = new Date(input.endsAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new HttpError(422, "validation_failed", "Pick a start and end time.");
  const now = deps.now();
  if (end.getTime() <= now.getTime()) throw new HttpError(422, "validation_failed", "That time has passed.");
  if (start.getTime() > now.getTime() + 180 * 86400_000) throw new HttpError(422, "validation_failed", "Book up to 180 days ahead.");
  const zs = zonedDate(start, r.timezone);
  const dayStart = zonedTime(zs.y, zs.m, zs.d, 0, r.timezone).getTime();
  const startMin = Math.round((start.getTime() - dayStart) / 60_000), endMin = Math.round((end.getTime() - dayStart) / 60_000);
  const problem = ruleProblem({ days: daysOf(r), openFrom: r.openFrom, openTo: r.openTo, stepMin: r.stepMin, minMin: r.minMin, maxMin: r.maxMin }, zs.day as WeekDay, startMin, endMin);
  if (problem) throw new HttpError(422, "rule_broken", problem);
  await releaseNoShows(deps, actor.orgId);
  const clash = await deps.db.select({ id: resourceBookings.id }).from(resourceBookings)
    .where(and(eq(resourceBookings.resourceId, r.id), inArray(resourceBookings.status, [...ACTIVE]), lt(resourceBookings.startsAt, end), gt(resourceBookings.endsAt, start))).get();
  if (clash) throw new HttpError(409, "slot_taken", "Someone already has that time. Pick another.");
  if (r.quotaMinWeek != null) {
    const w = weekBounds(start, r.timezone);
    const mine = await deps.db.select({ s: resourceBookings.startsAt, e: resourceBookings.endsAt }).from(resourceBookings)
      .where(and(eq(resourceBookings.resourceId, r.id), eq(resourceBookings.userId, actor.userId), inArray(resourceBookings.status, [...ACTIVE]), gte(resourceBookings.startsAt, w.start), lt(resourceBookings.startsAt, w.end))).limit(500).all();
    const used = mine.reduce((n, b) => n + (b.e.getTime() - b.s.getTime()) / 60_000, 0);
    const want = (end.getTime() - start.getTime()) / 60_000;
    if (used + want > r.quotaMinWeek) throw new HttpError(422, "quota_reached", `You can book ${durationLabel(r.quotaMinWeek)} of this a week. You have ${durationLabel(Math.max(0, r.quotaMinWeek - used))} left.`);
  }
  const id = sortableId("rbk", now.getTime());
  const status = r.needsApproval && !isAdmin(actor) ? "pending" : "confirmed";
  await deps.db.insert(resourceBookings).values({ id, orgId: actor.orgId, resourceId: r.id, userId: actor.userId, userName: (actor.name ?? actor.email ?? "").slice(0, 120), title: (input.title ?? "").trim().slice(0, 120), startsAt: start, endsAt: end, status, createdAt: now });
  // Two people pressing Book at the same moment both pass the check above; the earlier id keeps the slot.
  const race = await deps.db.select({ id: resourceBookings.id }).from(resourceBookings)
    .where(and(eq(resourceBookings.resourceId, r.id), inArray(resourceBookings.status, [...ACTIVE]), lt(resourceBookings.startsAt, end), gt(resourceBookings.endsAt, start), ne(resourceBookings.id, id), lt(resourceBookings.id, id))).get();
  if (race) {
    await deps.db.delete(resourceBookings).where(eq(resourceBookings.id, id));
    throw new HttpError(409, "slot_taken", "Someone booked that time just now. Pick another.");
  }
  if (status === "pending") await notifyAdmins(deps, actor, r, `${actor.name || "A member"} asks for ${r.name}`, id);
  return { booking: presentResourceBooking((await deps.db.select().from(resourceBookings).where(eq(resourceBookings.id, id)).get())!, actor.userId) };
}

async function notifyAdmins(deps: Deps, actor: SuiteActor, r: ResourceRow, title: string, id: string) {
  try {
    const { members } = await import("../../db/schema");
    const admins = await deps.db.select({ userId: members.userId }).from(members).where(and(eq(members.organizationId, actor.orgId), or(eq(members.role, "owner"), eq(members.role, "admin")))).limit(20).all();
    const { notify } = await import("../suite/notify");
    for (const a of admins) if (a.userId !== actor.userId) await notify(deps, actor.orgId, a.userId, { type: "booking.approval", entityType: "meeting", entityId: id, title, actorName: actor.name });
  } catch (err) { deps.reportError?.(err, { where: "resource_approval_notify", resource: r.id }); }
}

async function bookingRow(deps: Deps, orgId: string, id: string) {
  const b = await deps.db.select().from(resourceBookings).where(and(eq(resourceBookings.id, id), eq(resourceBookings.orgId, orgId))).get();
  if (!b) throw notFound("Booking");
  return b;
}

export async function cancelResourceBooking(deps: Deps, actor: SuiteActor, id: string) {
  assertBookingPlus(deps);
  assertWritable(actor);
  const b = await bookingRow(deps, actor.orgId, id);
  if (b.userId !== actor.userId && !isAdmin(actor)) throw new HttpError(403, "forbidden", "You can only cancel your own bookings.");
  if (!ACTIVE.includes(b.status as (typeof ACTIVE)[number])) throw new HttpError(409, "not_active", "This booking is no longer active.");
  await deps.db.update(resourceBookings).set({ status: "cancelled", decidedBy: actor.userId, decidedAt: deps.now() }).where(eq(resourceBookings.id, id));
  return { booking: presentResourceBooking(await bookingRow(deps, actor.orgId, id), actor.userId) };
}

export async function decideResourceBooking(deps: Deps, actor: SuiteActor, id: string, approve: boolean) {
  assertBookingPlus(deps);
  assertWritable(actor);
  requireAdminActor(actor);
  const b = await bookingRow(deps, actor.orgId, id);
  if (b.status !== "pending") throw new HttpError(409, "not_pending", "This request was already decided.");
  if (approve) {
    const clash = await deps.db.select({ id: resourceBookings.id }).from(resourceBookings)
      .where(and(eq(resourceBookings.resourceId, b.resourceId), eq(resourceBookings.status, "confirmed"), lt(resourceBookings.startsAt, b.endsAt), gt(resourceBookings.endsAt, b.startsAt))).get();
    if (clash) throw new HttpError(409, "slot_taken", "Another booking now holds this time. Decline this one.");
  }
  await deps.db.update(resourceBookings).set({ status: approve ? "confirmed" : "declined", decidedBy: actor.userId, decidedAt: deps.now() }).where(eq(resourceBookings.id, id));
  const r = await resourceRow(deps, actor.orgId, b.resourceId);
  const { notify } = await import("../suite/notify");
  await notify(deps, actor.orgId, b.userId, { type: "booking.decided", entityType: "meeting", entityId: id, title: `${r.name}: ${approve ? "approved" : "declined"}`, actorName: actor.name });
  return { booking: presentResourceBooking(await bookingRow(deps, actor.orgId, id), actor.userId) };
}

/** My upcoming bookings plus, for admins, requests waiting for approval. */
export async function resourceInbox(deps: Deps, actor: SuiteActor) {
  assertBookingPlus(deps);
  await releaseNoShows(deps, actor.orgId);
  const now = deps.now();
  const mine = await deps.db.select().from(resourceBookings)
    .where(and(eq(resourceBookings.orgId, actor.orgId), eq(resourceBookings.userId, actor.userId), gt(resourceBookings.endsAt, now), inArray(resourceBookings.status, [...ACTIVE])))
    .orderBy(asc(resourceBookings.startsAt)).limit(50).all();
  const pending = isAdmin(actor) ? await deps.db.select().from(resourceBookings)
    .where(and(eq(resourceBookings.orgId, actor.orgId), eq(resourceBookings.status, "pending"), gt(resourceBookings.endsAt, now)))
    .orderBy(asc(resourceBookings.startsAt)).limit(100).all() : [];
  return { mine: mine.map((b) => presentResourceBooking(b, actor.userId)), pending: pending.map((b) => presentResourceBooking(b, actor.userId)) };
}

/** Scanning the QR at a resource: checks the member in to their booking that is on now (from 15 minutes before). */
export async function checkInResource(deps: Deps, actor: SuiteActor, resourceId: string, key: string) {
  assertBookingPlus(deps);
  const r = await resourceRow(deps, actor.orgId, resourceId);
  if (!key || (await sha256Hex(key)) !== (await sha256Hex(r.checkinKey))) throw new HttpError(403, "bad_key", "This check in code is not valid. Scan the code at the resource again.");
  await releaseNoShows(deps, actor.orgId);
  const now = deps.now();
  const b = await deps.db.select().from(resourceBookings)
    .where(and(eq(resourceBookings.resourceId, r.id), eq(resourceBookings.userId, actor.userId), eq(resourceBookings.status, "confirmed"), lt(resourceBookings.startsAt, new Date(now.getTime() + 15 * 60_000)), gt(resourceBookings.endsAt, now)))
    .orderBy(asc(resourceBookings.startsAt)).get();
  const resource = presentResource(r, deps.config.appUrl, false);
  if (!b) return { checkedIn: false as const, resource };
  if (!b.checkedInAt) await deps.db.update(resourceBookings).set({ checkedInAt: now }).where(eq(resourceBookings.id, b.id));
  return { checkedIn: true as const, resource, booking: presentResourceBooking(await bookingRow(deps, actor.orgId, b.id), actor.userId) };
}

