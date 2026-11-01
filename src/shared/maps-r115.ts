/**
 * R115 maps: pure helpers shared by the server, the web app and the tests. Distances are straight line (haversine);
 * stop order is nearest neighbour then 2 opt improvement (the idea GraphHopper and others use; our own code), and the
 * route opens in the phone's maps app by link, so no routing service or key is needed.
 */

export interface GeoPoint { lat: number; lon: number }
export interface GeoResult { label: string; address: string; lat: number; lon: number }
export interface Stop { id: string; name: string; address: string; lat: number | null; lon: number | null }

/** Live lookups a workspace may make in one UTC day; answers from the cache are free. */
export const GEO_DAILY_CAP = 200;
/** How long a lookup answer is reused. */
export const GEO_CACHE_DAYS = 30;
/** Points one maps link carries (start, 8 stops between, end). Longer days split into legs. */
export const LINK_MAX_POINTS = 10;
export const MAX_VISIT_STOPS = 25;
export const MAP_ATTRIBUTION = "Map data from OpenStreetMap contributors";
/** Credits shown behind the map's small "i" button: the tile host, the tile schema and the map data, each a link. */
export const MAP_CREDITS: readonly { label: string; href: string }[] = [
  { label: "OpenFreeMap", href: "https://openfreemap.org/" },
  { label: "© OpenMapTiles", href: "https://www.openmaptiles.org/" },
  { label: "© OpenStreetMap contributors", href: "https://www.openstreetmap.org/copyright" },
];

/** Trim, fold spaces and case, so the same address typed twice hits the cache. */
export function normaliseQuery(q: string): string {
  return q.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 200);
}

export function validPoint(p: { lat?: number | null; lon?: number | null } | null | undefined): p is GeoPoint {
  return !!p && typeof p.lat === "number" && typeof p.lon === "number" && Number.isFinite(p.lat) && Number.isFinite(p.lon)
    && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
}

export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Total straight line length of a path through the points, in km. */
export function pathKm(points: GeoPoint[]): number {
  let km = 0;
  for (let i = 1; i < points.length; i++) km += haversineKm(points[i - 1], points[i]);
  return km;
}

/**
 * The shortest order found for visiting every stop once, starting at `start` when given (the path does not return).
 * Stops without a map point keep their place at the end, in the order given. Deterministic: ties keep input order.
 */
export function orderStops<T extends { lat: number | null; lon: number | null }>(stops: T[], start?: GeoPoint | null): T[] {
  const located = stops.filter((s) => validPoint(s));
  const rest = stops.filter((s) => !validPoint(s));
  if (located.length < 2) return [...located, ...rest];
  const pts = located as (T & GeoPoint)[];
  // Nearest neighbour from the start (or from the first stop when there is no start).
  const left = [...pts];
  const out: (T & GeoPoint)[] = [];
  let at: GeoPoint = start && validPoint(start) ? start : left.shift()!;
  if (!(start && validPoint(start))) out.push(at as T & GeoPoint);
  while (left.length) {
    let best = 0, bestKm = Infinity;
    left.forEach((s, i) => { const km = haversineKm(at, s); if (km < bestKm) { bestKm = km; best = i; } });
    at = left.splice(best, 1)[0];
    out.push(at as T & GeoPoint);
  }
  // 2 opt: reverse any stretch that makes the path shorter, until nothing improves (bounded passes).
  const head = start && validPoint(start) ? [start] : [];
  const len = (o: GeoPoint[]) => pathKm([...head, ...o]);
  let best = len(out), improved = true, passes = 0;
  while (improved && passes++ < 50) {
    improved = false;
    for (let i = 0; i < out.length - 1; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const next = [...out.slice(0, i), ...out.slice(i, j + 1).reverse(), ...out.slice(j + 1)];
        const km = len(next);
        if (km + 1e-9 < best) { best = km; out.splice(0, out.length, ...next); improved = true; }
      }
    }
  }
  return [...out, ...rest];
}

/** How a point goes into a maps link: its coordinates when known, else the address text. */
function where(p: { lat?: number | null; lon?: number | null; address?: string }): string {
  return validPoint(p as GeoPoint) ? `${(p.lat as number).toFixed(6)},${(p.lon as number).toFixed(6)}` : (p.address ?? "").trim();
}

/** Directions to one place in Apple Maps and Google Maps (both open the app on a phone when installed). */
export function directionsLinks(p: { lat?: number | null; lon?: number | null; address: string }) {
  const to = where(p);
  return {
    apple: `https://maps.apple.com/?daddr=${encodeURIComponent(to)}&dirflg=d`,
    google: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(to)}&travelmode=driving`,
    view: validPoint(p as GeoPoint)
      ? `https://www.openstreetmap.org/?mlat=${(p.lat as number).toFixed(6)}&mlon=${(p.lon as number).toFixed(6)}#map=17/${(p.lat as number).toFixed(6)}/${(p.lon as number).toFixed(6)}`
      : `https://www.openstreetmap.org/search?query=${encodeURIComponent(p.address)}`,
  };
}

/** Splits a day of points into legs of at most LINK_MAX_POINTS, each leg starting where the last ended. */
export function legs<T>(points: T[], max = LINK_MAX_POINTS): T[][] {
  if (points.length <= max) return points.length >= 2 ? [points] : [];
  const out: T[][] = [];
  for (let i = 0; i < points.length - 1; i += max - 1) out.push(points.slice(i, i + max));
  return out.filter((l) => l.length >= 2);
}

/** One link per leg for the whole day: from the first point through every stop to the last, by car. */
export function routeLinks(points: { lat?: number | null; lon?: number | null; address: string }[]) {
  return legs(points).map((leg) => {
    const [from, ...restPts] = leg.map(where);
    const to = restPts.pop()!;
    const google = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(from)}&destination=${encodeURIComponent(to)}`
      + (restPts.length ? `&waypoints=${encodeURIComponent(restPts.join("|"))}` : "") + "&travelmode=driving";
    const apple = `https://maps.apple.com/?saddr=${encodeURIComponent(from)}&daddr=${[...restPts, to].map(encodeURIComponent).join("+to:")}&dirflg=d`;
    return { from: leg[0], to: leg[leg.length - 1], stops: leg.length, google, apple };
  });
}

/** A short one line form of an address, for lists. */
export function shortAddress(a: string): string {
  const parts = a.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.slice(0, 3).join(", ");
}

type Props = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

/** Photon (GeoJSON) answer to results. Bad or partial rows are skipped. */
export function parsePhoton(json: unknown): GeoResult[] {
  const feats = (json as { features?: unknown[] })?.features;
  if (!Array.isArray(feats)) return [];
  const out: GeoResult[] = [];
  for (const f of feats) {
    const g = (f as { geometry?: { coordinates?: unknown[] } })?.geometry?.coordinates;
    const p = ((f as { properties?: Props })?.properties ?? {}) as Props;
    if (!Array.isArray(g) || typeof g[0] !== "number" || typeof g[1] !== "number") continue;
    const street = [str(p.housenumber), str(p.street)].filter(Boolean).join(" ");
    const name = str(p.name);
    const place = [str(p.city) || str(p.town) || str(p.village) || str(p.district) || str(p.locality), [str(p.state), str(p.postcode)].filter(Boolean).join(" "), str(p.country)].filter(Boolean);
    const lineParts = [name && name !== street ? name : "", street, ...place].filter(Boolean);
    if (!lineParts.length) continue;
    const point = { lat: g[1], lon: g[0] };
    if (!validPoint(point)) continue;
    out.push({ label: name || street || lineParts[0], address: dedupe(lineParts).join(", "), ...point });
  }
  return unique(out);
}

/** Nominatim (format=jsonv2) answer to results. */
export function parseNominatim(json: unknown): GeoResult[] {
  if (!Array.isArray(json)) return [];
  const out: GeoResult[] = [];
  for (const r of json as Props[]) {
    const point = { lat: Number(r.lat), lon: Number(r.lon) };
    const address = str(r.display_name);
    if (!address || !validPoint(point)) continue;
    out.push({ label: str(r.name) || address.split(",")[0].trim(), address, ...point });
  }
  return unique(out);
}

function dedupe(parts: string[]) {
  const seen = new Set<string>();
  return parts.filter((p) => { const k = p.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}
function unique(rs: GeoResult[]) {
  const seen = new Set<string>();
  return rs.filter((r) => { const k = r.address.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 6);
}

/** Which suggestion stays highlighted when newer results land: the same address if it is still listed, else none. */
export function highlightAfterResults(prevAddress: string | null, results: readonly { address: string }[]): number {
  return prevAddress ? results.findIndex((r) => r.address === prevAddress) : -1;
}

/** Why Shortest order has nothing to do, in plain words (shown beside the disabled button). */
export function bestHint(located: number, hasStart: boolean): string {
  if (located < 2) return "Shortest order needs at least two stops with a map pin.";
  if (located === 2 && !hasStart) return "Two stops are the same distance either way. Add a starting point or a third stop to compare.";
  return "Already in the shortest order.";
}
