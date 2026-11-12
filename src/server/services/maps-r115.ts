/**
 * R115 maps (MAPS_R115): address lookup and saved addresses for contacts, companies and booking pages.
 *
 * Lookups run on the server only, through free services that need no key, kept to their usage policies:
 *  - suggestions while typing go to Photon (built for search as you type);
 *  - a full search (Enter) goes to Nominatim, falling back to Photon.
 * Each service is called at most once a second across the whole app (one geo_throttle row per service, claimed with a
 * conditional update), with an identifying User-Agent. Answers are cached for 30 days under a hash of the service and
 * the normalised query (the query text is not stored), and a workspace may make GEO_DAILY_CAP live lookups a day.
 */
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Deps } from "../context";
import { companies, contacts, geoCache, geoThrottle, geoUsage, places, schedulingPages } from "../db/schema";
import { HttpError, badRequest, forbidden, notFound } from "../lib/errors";
import { assertWritable, createdBy, sortableId, type SuiteActor } from "./suite/common";
import { GEO_CACHE_DAYS, GEO_DAILY_CAP, MAX_VISIT_STOPS, normaliseQuery, parseNominatim, parsePhoton, validPoint, type GeoResult } from "../../shared/maps-r115";

type Actor = SuiteActor & { role?: "owner" | "admin" | "member" };
const isAdmin = (a: Actor) => !!a.system || a.role === "owner" || a.role === "admin";
export type PlaceEntity = "contact" | "company" | "scheduling_page";
export type LookupMode = "suggest" | "find";
type Service = "photon" | "nominatim";

// Semgrep (QUAL1): the User-Agent the address lookup sends, not a user name.
export const GEO_USER_AGENT = "Multies/1.0 (+https://multies.si; support@multies.si)"; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_username
const ENDPOINT: Record<Service, (q: string) => string> = {
  photon: (q) => `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=en`,
  nominatim: (q) => `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&q=${encodeURIComponent(q)}`,
};
const PARSE: Record<Service, (j: unknown) => GeoResult[]> = { photon: parsePhoton, nominatim: parseNominatim };

const busy = () => new HttpError(429, "geo_busy", "Address search is busy for a moment. Try again in a few seconds.");
const capped = () => new HttpError(429, "geo_daily_cap", "This workspace has used today's address searches. Type the address in full and save it, or try again tomorrow.");

async function sha256(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const today = (now: Date) => now.toISOString().slice(0, 10);

/** Claims the next one second slot for a service. False when another lookup went out less than a second ago. */
export async function claimSlot(deps: Deps, service: Service): Promise<boolean> {
  const now = deps.now().getTime();
  await deps.db.insert(geoThrottle).values({ service, nextAt: 0 }).onConflictDoNothing();
  const res = await deps.db.update(geoThrottle).set({ nextAt: now + 1000 }).where(and(eq(geoThrottle.service, service), lte(geoThrottle.nextAt, now))).run();
  const changes = (res as { meta?: { changes?: number }; changes?: number }).meta?.changes ?? (res as { changes?: number }).changes ?? 0;
  return changes > 0;
}

async function cached(deps: Deps, key: string): Promise<GeoResult[] | null> {
  const row = await deps.db.select().from(geoCache).where(eq(geoCache.key, key)).get();
  if (!row) return null;
  if (deps.now().getTime() - row.createdAt.getTime() > GEO_CACHE_DAYS * 86_400_000) return null;
  try { return JSON.parse(row.results) as GeoResult[]; } catch { return null; }
}

export async function usageToday(deps: Deps, orgId: string): Promise<number> {
  const row = await deps.db.select({ count: geoUsage.count }).from(geoUsage).where(and(eq(geoUsage.orgId, orgId), eq(geoUsage.day, today(deps.now())))).get();
  return row?.count ?? 0;
}

/** MAPS_GEO_MOCK=1 (e2e): a fixed answer near Sydney for any query, none for one containing "nowhere". No network. */
export function mockResults(q: string): GeoResult[] {
  if (q.includes("nowhere")) return [];
  let h = 0;
  for (const ch of q) h = (h * 31 + ch.charCodeAt(0)) % 1000;
  const name = q.replace(/\b\w/g, (c) => c.toUpperCase());
  return [0, 1].map((i) => ({ label: i ? `${name} North` : name, address: `${i ? `${name} North` : name}, Sydney NSW 2000, Australia`, lat: -33.87 + (h % 50) / 1000 + i * 0.01, lon: 151.2 + (h % 37) / 1000 + i * 0.01 }));
}

async function callService(deps: Deps, service: Service, q: string): Promise<GeoResult[]> {
  if (deps.config.mapsGeoMock) return mockResults(q);
  const res = await deps.fetch(ENDPOINT[service](q), {
    headers: { "user-agent": GEO_USER_AGENT, accept: "application/json", "accept-language": "en" },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`${service} ${res.status}`);
  return PARSE[service](await res.json());
}

/**
 * Looks an address up. Cache first (free). Then the daily cap, then one live call to the first service with a free
 * slot. A suggestion that cannot go out now answers an empty list with busy: true (the box keeps what was typed).
 */
export async function lookup(deps: Deps, a: Actor, rawQ: string, mode: LookupMode): Promise<{ results: GeoResult[]; cached: boolean; busy?: boolean; left: number }> {
  const q = normaliseQuery(rawQ);
  if (q.length < 3) throw badRequest("Type at least 3 characters of the address.");
  const order: Service[] = mode === "suggest" ? ["photon"] : ["nominatim", "photon"];
  for (const s of order) {
    const hit = await cached(deps, await sha256(`${s}:${q}`));
    if (hit) return { results: hit, cached: true, left: Math.max(0, GEO_DAILY_CAP - (await usageToday(deps, a.orgId))) };
  }
  const used = await usageToday(deps, a.orgId);
  if (used >= GEO_DAILY_CAP) throw capped();
  let lastErr: unknown = null;
  for (const s of order) {
    if (!deps.config.mapsGeoMock && !(await claimSlot(deps, s))) continue;
    try {
      const results = await callService(deps, s, q);
      const now = deps.now();
      await deps.db.insert(geoUsage).values({ orgId: a.orgId, day: today(now), count: 1 })
        .onConflictDoUpdate({ target: [geoUsage.orgId, geoUsage.day], set: { count: sql`${geoUsage.count} + 1` } });
      const key = await sha256(`${s}:${q}`);
      await deps.db.insert(geoCache).values({ key, results: JSON.stringify(results), createdAt: now })
        .onConflictDoUpdate({ target: geoCache.key, set: { results: JSON.stringify(results), createdAt: now } });
      return { results, cached: false, left: Math.max(0, GEO_DAILY_CAP - used - 1) };
    } catch (e) {
      lastErr = e;
      deps.log?.warn?.("maps lookup failed", { service: s, error: String(e) });
    }
  }
  if (mode === "suggest") return { results: [], cached: false, busy: true, left: Math.max(0, GEO_DAILY_CAP - used) };
  if (lastErr) throw new HttpError(502, "geo_unavailable", "Address search is not answering right now. Save the address as typed, or try again soon.");
  throw busy();
}

/**
 * The entity must be in the workspace; writing a booking page's place needs its owner or an admin. Answers the
 * entity id ("mine" for a booking page means the caller's own page).
 */
async function checkEntity(deps: Deps, a: Actor, type: PlaceEntity, id: string, write: boolean): Promise<string> {
  if (type === "contact") {
    const r = await deps.db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.id, id), eq(contacts.orgId, a.orgId), isNull(contacts.deletedAt))).get();
    if (!r) throw notFound("Contact");
  } else if (type === "company") {
    const r = await deps.db.select({ id: companies.id }).from(companies).where(and(eq(companies.id, id), eq(companies.orgId, a.orgId), isNull(companies.deletedAt))).get();
    if (!r) throw notFound("Company");
  } else {
    const r = await deps.db.select({ id: schedulingPages.id, userId: schedulingPages.userId }).from(schedulingPages)
      .where(and(id === "mine" ? eq(schedulingPages.userId, a.userId) : eq(schedulingPages.id, id), eq(schedulingPages.orgId, a.orgId))).get();
    if (!r) throw notFound("Booking page");
    if (write && r.userId !== a.userId && !isAdmin(a)) throw forbidden("Only the page's owner or an admin can change its meeting place.");
    return r.id;
  }
  return id;
}

export interface PlaceOut { id: string; entityType: PlaceEntity; entityId: string; address: string; lat: number | null; lon: number | null; updatedAt: string }
const out = (p: typeof places.$inferSelect): PlaceOut => ({ id: p.id, entityType: p.entityType, entityId: p.entityId, address: p.address, lat: p.lat, lon: p.lon, updatedAt: p.updatedAt.toISOString() });

export async function getPlace(deps: Deps, a: Actor, type: PlaceEntity, id: string): Promise<PlaceOut | null> {
  id = await checkEntity(deps, a, type, id, false);
  const p = await deps.db.select().from(places).where(and(eq(places.orgId, a.orgId), eq(places.entityType, type), eq(places.entityId, id), isNull(places.deletedAt))).get();
  return p ? out(p) : null;
}

export async function setPlace(deps: Deps, a: Actor, i: { entityType: PlaceEntity; entityId: string; address: string; lat?: number | null; lon?: number | null }): Promise<PlaceOut> {
  assertWritable(a);
  const address = i.address.replace(/\s+/g, " ").trim();
  if (!address) throw badRequest("Type an address first.");
  const point = { lat: i.lat ?? null, lon: i.lon ?? null };
  if ((point.lat !== null || point.lon !== null) && !validPoint(point)) throw badRequest("That map point is not valid.");
  i = { ...i, entityId: await checkEntity(deps, a, i.entityType, i.entityId, true) };
  const now = deps.now();
  const had = await deps.db.select().from(places).where(and(eq(places.orgId, a.orgId), eq(places.entityType, i.entityType), eq(places.entityId, i.entityId))).get();
  if (had) {
    await deps.db.update(places).set({ address, lat: point.lat, lon: point.lon, deletedAt: null, updatedAt: now, version: sql`${places.version} + 1` }).where(eq(places.id, had.id));
    return out({ ...had, address, lat: point.lat, lon: point.lon, deletedAt: null, updatedAt: now });
  }
  const row = { id: sortableId("plc", now.getTime()), orgId: a.orgId, entityType: i.entityType, entityId: i.entityId, address, lat: point.lat, lon: point.lon, ...createdBy(a), createdAt: now, updatedAt: now, version: 1, deletedAt: null };
  await deps.db.insert(places).values(row);
  return out(row as typeof places.$inferSelect);
}

export async function removePlace(deps: Deps, a: Actor, type: PlaceEntity, id: string) {
  assertWritable(a);
  id = await checkEntity(deps, a, type, id, true);
  await deps.db.update(places).set({ deletedAt: deps.now(), updatedAt: deps.now() }).where(and(eq(places.orgId, a.orgId), eq(places.entityType, type), eq(places.entityId, id)));
  return { ok: true };
}

export interface VisitCandidate { id: string; type: "contact" | "company"; entityId: string; name: string; detail: string; address: string; lat: number | null; lon: number | null }

/** Contacts and companies with a saved address, for the visit planner. Bounded and on the places index. */
export async function visitCandidates(deps: Deps, a: Actor): Promise<{ candidates: VisitCandidate[]; limit: number }> {
  const rows = await deps.db.select().from(places)
    .where(and(eq(places.orgId, a.orgId), inArray(places.entityType, ["contact", "company"]), isNull(places.deletedAt)))
    .orderBy(asc(places.entityType), asc(places.entityId)).limit(500).all();
  const cIds = rows.filter((r) => r.entityType === "contact").map((r) => r.entityId);
  const coIds = rows.filter((r) => r.entityType === "company").map((r) => r.entityId);
  const people = new Map<string, { name: string; email: string; deleted: boolean }>();
  const orgs = new Map<string, { name: string; deleted: boolean }>();
  for (let i = 0; i < cIds.length; i += 90) {
    for (const c of await deps.db.select({ id: contacts.id, name: contacts.name, email: contacts.email, deletedAt: contacts.deletedAt }).from(contacts).where(and(eq(contacts.orgId, a.orgId), inArray(contacts.id, cIds.slice(i, i + 90)))).all()) people.set(c.id, { name: c.name, email: c.email, deleted: !!c.deletedAt });
  }
  for (let i = 0; i < coIds.length; i += 90) {
    for (const c of await deps.db.select({ id: companies.id, name: companies.name, deletedAt: companies.deletedAt }).from(companies).where(and(eq(companies.orgId, a.orgId), inArray(companies.id, coIds.slice(i, i + 90)))).all()) orgs.set(c.id, { name: c.name, deleted: !!c.deletedAt });
  }
  const candidates: VisitCandidate[] = [];
  for (const r of rows) {
    if (r.entityType === "contact") {
      const p = people.get(r.entityId); if (!p || p.deleted) continue;
      candidates.push({ id: r.id, type: "contact", entityId: r.entityId, name: p.name || p.email, detail: p.email, address: r.address, lat: r.lat, lon: r.lon });
    } else {
      const c = orgs.get(r.entityId); if (!c || c.deleted) continue;
      candidates.push({ id: r.id, type: "company", entityId: r.entityId, name: c.name, detail: "Company", address: r.address, lat: r.lat, lon: r.lon });
    }
  }
  candidates.sort((x, y) => x.name.localeCompare(y.name));
  return { candidates, limit: MAX_VISIT_STOPS };
}

/** The meeting place shown on a public booking page (only when maps are on). */
export async function bookingPlace(deps: Deps, orgId: string, pageId: string): Promise<{ address: string; lat: number | null; lon: number | null } | null> {
  const p = await deps.db.select({ address: places.address, lat: places.lat, lon: places.lon }).from(places)
    .where(and(eq(places.orgId, orgId), eq(places.entityType, "scheduling_page"), eq(places.entityId, pageId), isNull(places.deletedAt))).get();
  return p ?? null;
}
