/**
 * M1 (1.10.9): Contacts with Maps on the phone, the same as the web's Contacts page and its address card (server R115).
 * Pure helpers only (shapes, search trimming, call and directions links, the visit route); the server decides access.
 * The directions and route links mirror the web's shared maps module (src/shared/maps-r115.ts) word for word.
 */

export interface ContactView {
  id: string; name: string; email: string; phone: string | null; title: string | null; notes: string | null; source?: string | null;
  company: { id: string; name: string; domain: string | null } | null; companyId: string | null;
  messageCount?: number; firstContactAt?: string | null; lastContactAt: string | null; createdAt?: string; updatedAt?: string;
}
export interface ContactListResponse { contacts: ContactView[]; total: number }
export interface ContactThread { threadId: string; subject?: string | null; lastAt?: string; [k: string]: unknown }
export interface ContactDetailResponse { contact: ContactView; threads?: ContactThread[]; tasks?: unknown[]; deals?: unknown[] }
export interface CompanyDetailResponse { company: { id: string; name: string; domain: string | null; notes: string | null }; contacts: ContactView[]; deals?: unknown[] }
export type PlaceEntity = "contact" | "company";
export interface PlaceView { id: string; entityType: PlaceEntity | "scheduling_page"; entityId: string; address: string; lat: number | null; lon: number | null; updatedAt: string }
export interface VisitCandidate { id: string; type: "contact" | "company"; entityId: string; name: string; detail: string; address: string; lat: number | null; lon: number | null }
export interface VisitsResponse { candidates: VisitCandidate[]; limit: number }

/** The web's limits (src/shared/maps-r115.ts): points in one maps link, and stops in a day. */
export const LINK_MAX_POINTS = 10;
export const MAX_VISIT_STOPS = 25;
/**
 * The server matches a search with a LIKE pattern `%text%`, and the database refuses a pattern over 50 bytes. Until the
 * server's own fix ships, the phone keeps the search to 46 bytes (whole characters only), so a long search never fails.
 */
export const CONTACT_SEARCH_MAX_BYTES = 46;

function utf8Len(ch: string): number { const c = ch.codePointAt(0) ?? 0; return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }

/** The text sent as the contact search: spaces collapsed, trimmed, and cut to whole characters within the byte limit. */
export function contactSearchTerm(q: string, maxBytes = CONTACT_SEARCH_MAX_BYTES): string {
  const t = q.replace(/\s+/g, " ").trim();
  let out = "", n = 0;
  for (const ch of t) { const l = utf8Len(ch); if (n + l > maxBytes) break; out += ch; n += l; }
  return out.trim();
}

export function contactsQuery(q: string, limit = 100): string {
  const term = contactSearchTerm(q);
  return `?limit=${limit}${term ? `&q=${encodeURIComponent(term)}` : ""}`;
}

export const contactName = (c: Pick<ContactView, "name" | "email">) => (c.name || "").trim() || c.email;
export function contactSub(c: ContactView): string {
  return [c.title, c.company?.name].filter(Boolean).join(", ") || c.email;
}

/** A tel: link for a phone number as typed (keeps a leading plus and digits; null when nothing callable is left). */
export function telUrl(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const t = phone.trim();
  const digits = t.replace(/[^\d]/g, "");
  if (digits.length < 3) return null;
  return `tel:${t.startsWith("+") ? "+" : ""}${digits}`;
}

/* ---------------------------------------------------------------- maps links (the web's shared module) */

export interface GeoPoint { lat: number; lon: number }
export function validPoint(p: { lat?: number | null; lon?: number | null } | null | undefined): p is GeoPoint {
  return !!p && typeof p.lat === "number" && typeof p.lon === "number" && Number.isFinite(p.lat) && Number.isFinite(p.lon)
    && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
}
function where(p: { lat?: number | null; lon?: number | null; address?: string }): string {
  return validPoint(p) ? `${(p.lat as number).toFixed(6)},${(p.lon as number).toFixed(6)}` : (p.address ?? "").trim();
}
export type MapsApp = "apple" | "google";
/** Apple Maps on iPhone, Google Maps on Android (and the web build). */
export const mapsAppFor = (os: string): MapsApp => (os === "ios" ? "apple" : "google");
export const MAPS_APP_NAME: Record<MapsApp, string> = { apple: "Apple Maps", google: "Google Maps" };

/** Directions to one place, by car, from where the phone is. */
export function directionsUrl(p: { lat?: number | null; lon?: number | null; address: string }, app: MapsApp): string {
  const to = where(p);
  return app === "apple"
    ? `https://maps.apple.com/?daddr=${encodeURIComponent(to)}&dirflg=d`
    : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(to)}&travelmode=driving`;
}

/**
 * Splits the day into legs of at most LINK_MAX_POINTS points. The first leg starts where the phone is (the maps app's
 * own current location, so it holds one stop fewer); each later leg starts at the stop the last one ended on.
 */
export function routeLegs<T>(stops: T[], max = LINK_MAX_POINTS): { from: T | null; stops: T[] }[] {
  if (!stops.length) return [];
  const out: { from: T | null; stops: T[] }[] = [{ from: null, stops: stops.slice(0, max - 1) }];
  let i = max - 1;
  while (i < stops.length) { out.push({ from: stops[i - 1], stops: stops.slice(i, i + max - 1) }); i += max - 1; }
  return out;
}

type Pt = { lat?: number | null; lon?: number | null; address: string };
/** One maps link per leg: through every stop in order to the last, by car. */
export function routeUrls(stops: Pt[], app: MapsApp): string[] {
  return routeLegs(stops).map(({ from, stops: s }) => {
    const pts = s.map(where);
    const to = pts.pop()!;
    if (app === "apple") {
      return `https://maps.apple.com/?${from ? `saddr=${encodeURIComponent(where(from))}&` : ""}daddr=${[...pts, to].map(encodeURIComponent).join("+to:")}&dirflg=d`;
    }
    return `https://www.google.com/maps/dir/?api=1${from ? `&origin=${encodeURIComponent(where(from))}` : ""}&destination=${encodeURIComponent(to)}`
      + (pts.length ? `&waypoints=${encodeURIComponent(pts.join("|"))}` : "") + "&travelmode=driving";
  });
}

export function shortAddress(a: string): string {
  return a.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 3).join(", ");
}

/* ---------------------------------------------------------------- the visit plan (kept on this phone, as the web keeps it in the browser) */

export interface VisitPlan { ids: string[] }
export const VISIT_PLAN_KEY = "visits:plan";

export function parsePlan(raw: string | null): VisitPlan {
  try { const v = JSON.parse(raw ?? "null") as VisitPlan | null; return v && Array.isArray(v.ids) ? { ids: v.ids.filter((x) => typeof x === "string") } : { ids: [] }; } catch { return { ids: [] }; }
}
/** The planned stops in order, dropping any that no longer have an address. */
export function plannedStops(plan: VisitPlan, candidates: VisitCandidate[]): VisitCandidate[] {
  const by = new Map(candidates.map((c) => [c.id, c]));
  return plan.ids.map((id) => by.get(id)).filter((c): c is VisitCandidate => !!c);
}
export function togglePlan(plan: VisitPlan, id: string, limit = MAX_VISIT_STOPS): VisitPlan | "full" {
  if (plan.ids.includes(id)) return { ids: plan.ids.filter((x) => x !== id) };
  if (plan.ids.length >= limit) return "full";
  return { ids: [...plan.ids, id] };
}
export function moveInPlan(plan: VisitPlan, id: string, by: -1 | 1): VisitPlan {
  const i = plan.ids.indexOf(id), j = i + by;
  if (i < 0 || j < 0 || j >= plan.ids.length) return plan;
  const ids = [...plan.ids]; [ids[i], ids[j]] = [ids[j], ids[i]];
  return { ids };
}

function km(a: GeoPoint, b: GeoPoint): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}
/**
 * A short order for the stops that have a map point (nearest next from the first stop); stops with no point keep
 * their place at the end, as on the web.
 */
export function shortestOrder<T extends { lat: number | null; lon: number | null }>(stops: T[]): T[] {
  const located = stops.filter((s) => validPoint(s)) as (T & GeoPoint)[];
  const rest = stops.filter((s) => !validPoint(s));
  if (located.length < 3) return [...located, ...rest];
  const out: (T & GeoPoint)[] = [located[0]];
  const left = located.slice(1);
  while (left.length) {
    const last = out[out.length - 1];
    let bi = 0;
    for (let i = 1; i < left.length; i++) if (km(last, left[i]) < km(last, left[bi])) bi = i;
    out.push(left.splice(bi, 1)[0]);
  }
  return [...out, ...rest];
}
