import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import {
  GEO_DAILY_CAP, MAP_CREDITS, bestHint, highlightAfterResults, directionsLinks, haversineKm, legs, normaliseQuery, orderStops, parseNominatim, parsePhoton, pathKm, routeLinks, shortAddress, validPoint,
} from "@/shared/maps-r115";
import { appCsp } from "@/server/lib/security-headers";
import { sql } from "drizzle-orm";

const SYD = { lat: -33.8688, lon: 151.2093 };
const MEL = { lat: -37.8136, lon: 144.9631 };

describe("R115 shared helpers", () => {
  it("measures straight line distance", () => {
    expect(Math.round(haversineKm(SYD, MEL))).toBe(713);
    expect(haversineKm(SYD, SYD)).toBe(0);
    expect(pathKm([SYD])).toBe(0);
  });
  it("normalises queries so the same address hits the cache", () => {
    expect(normaliseQuery("  12  George St ,  SYDNEY ")).toBe("12 george st , sydney");
    expect(normaliseQuery("x".repeat(400))).toHaveLength(200);
  });
  it("checks map points", () => {
    expect(validPoint(SYD)).toBe(true);
    expect(validPoint({ lat: 91, lon: 0 })).toBe(false);
    expect(validPoint({ lat: null, lon: 1 })).toBe(false);
    expect(validPoint({ lat: Number.NaN, lon: 1 })).toBe(false);
    expect(validPoint(null)).toBe(false);
  });
  it("orders stops shorter than the given order and keeps stops without a point at the end", () => {
    const line = [0, 5, 1, 4, 2, 3].map((x) => ({ id: `s${x}`, lat: -33.8, lon: 151 + x * 0.01 }));
    const noPoint = { id: "typed", lat: null, lon: null };
    const out = orderStops([...line, noPoint], { lat: -33.8, lon: 150.99 });
    expect(out.map((s) => s.id)).toEqual(["s0", "s1", "s2", "s3", "s4", "s5", "typed"]);
    expect(pathKm(out.slice(0, 6) as never)).toBeLessThan(pathKm(line));
  });
  it("orders without a start from the first stop, and leaves short lists alone", () => {
    const a = { id: "a", lat: 0, lon: 0 }, b = { id: "b", lat: 0, lon: 3 }, c = { id: "c", lat: 0, lon: 1 };
    expect(orderStops([a, b, c]).map((s) => s.id)).toEqual(["a", "c", "b"]);
    expect(orderStops([b])).toEqual([b]);
    expect(orderStops([])).toEqual([]);
  });
  it("2 opt fixes a crossing nearest neighbour leaves", () => {
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 0.5, y: 0.1 }, { x: 0.6, y: 1.1 }].map((p, i) => ({ id: String(i), lat: p.y, lon: p.x }));
    const out = orderStops(pts, { lat: 0, lon: -0.2 });
    const nn = pathKm([{ lat: 0, lon: -0.2 }, ...out]);
    for (let k = 0; k < 20; k++) {
      const shuffled = [...pts].sort(() => Math.sin(k * 7.1 + pts.length) - 0.0);
      expect(nn).toBeLessThanOrEqual(pathKm([{ lat: 0, lon: -0.2 }, ...shuffled]) + 1e-6);
    }
  });
  it("builds directions links with the point, or the address when there is none", () => {
    const l = directionsLinks({ ...SYD, address: "Sydney NSW" });
    expect(l.apple).toBe("https://maps.apple.com/?daddr=-33.868800%2C151.209300&dirflg=d");
    expect(l.google).toContain("destination=-33.868800%2C151.209300");
    expect(l.view).toContain("mlat=-33.868800");
    const t = directionsLinks({ lat: null, lon: null, address: "1 Main St & Co, Hobart" });
    expect(t.google).toContain(encodeURIComponent("1 Main St & Co, Hobart"));
    expect(t.view).toContain("/search?query=");
  });
  it("splits a long day into legs that chain end to start", () => {
    const pts = Array.from({ length: 23 }, (_, i) => i);
    const ls = legs(pts);
    expect(ls.map((l) => l.length)).toEqual([10, 10, 5]);
    expect(ls[1][0]).toBe(ls[0][9]);
    expect(ls[2][ls[2].length - 1]).toBe(22);
    expect(legs([1])).toEqual([]);
    expect(legs([1, 2])).toEqual([[1, 2]]);
  });
  it("builds route links through every stop", () => {
    const pts = [{ ...SYD, address: "a" }, { lat: null, lon: null, address: "2 B St" }, { ...MEL, address: "c" }];
    const [r] = routeLinks(pts);
    expect(r.google).toContain("origin=-33.868800%2C151.209300");
    expect(r.google).toContain(`waypoints=${encodeURIComponent("2 B St")}`);
    expect(r.google).toContain("destination=-37.813600%2C144.963100");
    expect(r.apple).toBe(`https://maps.apple.com/?saddr=-33.868800%2C151.209300&daddr=2%20B%20St+to:-37.813600%2C144.963100&dirflg=d`);
    expect(routeLinks([pts[0]])).toEqual([]);
  });
  it("shortens addresses for lists", () => {
    expect(shortAddress("1, George St, Sydney, NSW, 2000, Australia")).toBe("1, George St, Sydney");
  });
  it("reads Photon answers and skips bad rows", () => {
    const r = parsePhoton({ features: [
      { geometry: { coordinates: [151.2, -33.86] }, properties: { housenumber: "1", street: "George St", city: "Sydney", state: "NSW", postcode: "2000", country: "Australia" } },
      { geometry: { coordinates: [151.2, -33.86] }, properties: { housenumber: "1", street: "George St", city: "Sydney", state: "NSW", postcode: "2000", country: "Australia" } },
      { geometry: { coordinates: ["x", 1] }, properties: { name: "Bad" } },
      { geometry: { coordinates: [85.32, 27.71] }, properties: { name: "Thamel", city: "Kathmandu", country: "Nepal" } },
      { geometry: { coordinates: [0, 0] }, properties: {} },
    ] });
    expect(r).toEqual([
      { label: "1 George St", address: "1 George St, Sydney, NSW 2000, Australia", lat: -33.86, lon: 151.2 },
      { label: "Thamel", address: "Thamel, Kathmandu, Nepal", lat: 27.71, lon: 85.32 },
    ]);
    expect(parsePhoton(null)).toEqual([]);
    expect(parsePhoton({ features: "x" })).toEqual([]);
  });
  it("reads Nominatim answers", () => {
    expect(parseNominatim([{ lat: "-33.86", lon: "151.2", display_name: "Opera House, Sydney", name: "Opera House" }, { lat: "x", lon: "1", display_name: "Bad" }, { lat: "1", lon: "1" }]))
      .toEqual([{ label: "Opera House", address: "Opera House, Sydney", lat: -33.86, lon: 151.2 }]);
    expect(parseNominatim({})).toEqual([]);
  });
  it("allows the free map tiles in the app's connect-src", () => {
    expect(appCsp()).toContain("https://tiles.openfreemap.org");
  });
});

const PHOTON = { features: [{ geometry: { coordinates: [151.2093, -33.8688] }, properties: { housenumber: "1", street: "George St", city: "Sydney", country: "Australia" } }] };
const NOMI = [{ lat: "-33.8568", lon: "151.2153", display_name: "Sydney Opera House, Bennelong Point, Sydney", name: "Sydney Opera House" }];

function fakeNet() {
  const calls: { url: string; ua: string | null }[] = [];
  let fail: string | null = null;
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ua: new Headers(init?.headers).get("user-agent") });
    if (fail && new RegExp(fail).test(url)) return new Response("nope", { status: 503 });
    if (url.startsWith("https://photon.komoot.io/")) return Response.json(PHOTON);
    if (url.startsWith("https://nominatim.openstreetmap.org/")) return Response.json(NOMI);
    throw new Error("unexpected " + url);
  }) as typeof fetch;
  return { f, calls, failOn: (s: string | null) => { fail = s; } };
}

async function setup(env: Record<string, string> = { MAPS_R115: "on", SCHEDULING_ENABLED: "true" }) {
  const net = fakeNet();
  let now = Date.parse("2026-11-01T00:00:00Z");
  const t = await makeTestApp(env, { fetch: net.f });
  t.deps.now = () => new Date(now);
  const owner = new Client(t.app);
  await owner.signup("owner-r115@example.com");
  const contact = (await owner.post("/api/contacts", { email: "sam@harbour.com.au", name: "Sam Lee" })).body.contact;
  return { ...t, owner, contact, net, tick: (ms: number) => { now += ms; } };
}
async function addMember(t: Awaited<ReturnType<typeof setup>>) {
  const invite = await t.owner.post("/api/team/invites", { email: "mate-r115@example.com", role: "member" });
  const mate = new Client(t.app);
  await mate.signup("mate-r115@example.com", "Mate", "");
  expect((await mate.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  return mate;
}

describe("R115 API", () => {
  it("is not found while MAPS_R115 is off, and says so in public config", async () => {
    const t = await setup({});
    expect((await t.owner.get("/api/maps/lookup?q=george st")).status).toBe(404);
    expect((await t.owner.get("/api/config")).body.maps).toBe(false);
    const on = await setup();
    expect((await on.owner.get("/api/config")).body.maps).toBe(true);
  });

  it("needs a signed in person", async () => {
    const t = await setup();
    expect((await new Client(t.app).get("/api/maps/lookup?q=george st")).status).toBe(401);
  });

  it("suggests through Photon with our agent, caches by query, and counts only live lookups", async () => {
    const t = await setup();
    const a = await t.owner.get("/api/maps/lookup?q=1 George St");
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ cached: false, left: GEO_DAILY_CAP - 1, results: [{ address: "1 George St, Sydney, Australia", lat: -33.8688, lon: 151.2093 }] });
    expect(t.net.calls).toHaveLength(1);
    expect(t.net.calls[0].url).toContain("photon.komoot.io");
    expect(t.net.calls[0].ua).toMatch(/^Multies\/1\.0 \(\+https:\/\/multies\.si/);
    const b = await t.owner.get("/api/maps/lookup?q=  1  GEORGE st ");
    expect(b.body).toMatchObject({ cached: true, left: GEO_DAILY_CAP - 1 });
    expect(t.net.calls).toHaveLength(1);
  });

  it("does not keep the query text in the cache", async () => {
    const t = await setup();
    await t.owner.get("/api/maps/lookup?q=42 Secret Lane");
    const rows = await t.deps.db.all<{ key: string; results: string }>(sql`SELECT key, results FROM geo_cache`);
    expect(JSON.stringify(rows)).not.toMatch(/secret lane/i);
    expect(rows[0].key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses Nominatim for a full search and falls back to Photon when it fails", async () => {
    const t = await setup();
    const a = await t.owner.get("/api/maps/lookup?q=opera house&mode=find");
    expect(a.body.results[0].label).toBe("Sydney Opera House");
    expect(t.net.calls[0].url).toContain("nominatim.openstreetmap.org/search?format=jsonv2");
    t.net.failOn("nominatim");
    t.tick(1500);
    const b = await t.owner.get("/api/maps/lookup?q=town hall&mode=find");
    expect(b.status).toBe(200);
    expect(b.body.results[0].address).toContain("George St");
    t.net.failOn("nominatim|komoot");
    t.tick(1500);
    const c = await t.owner.get("/api/maps/lookup?q=central&mode=find");
    expect(c.status).toBe(502);
    expect(c.body.error.message).toMatch(/Save the address as typed/);
  });

  it("keeps each service to one call a second across the app", async () => {
    const t = await setup();
    expect((await t.owner.get("/api/maps/lookup?q=first street")).body.cached).toBe(false);
    const busy = await t.owner.get("/api/maps/lookup?q=second street");
    expect(busy.status).toBe(200);
    expect(busy.body).toMatchObject({ results: [], busy: true });
    // A full search in the same second goes to the other service.
    expect((await t.owner.get("/api/maps/lookup?q=third street&mode=find")).body.cached).toBe(false);
    expect((await t.owner.get("/api/maps/lookup?q=fourth street&mode=find")).status).toBe(429);
    t.tick(1001);
    expect((await t.owner.get("/api/maps/lookup?q=second street")).body.busy).toBeUndefined();
    expect(t.net.calls).toHaveLength(3);
  });

  it("stops live lookups at the daily cap but still answers from the cache, and resets the next day", async () => {
    const t = await setup();
    await t.owner.get("/api/maps/lookup?q=cached place");
    await t.deps.db.run(sql`UPDATE geo_usage SET count = ${GEO_DAILY_CAP}`);
    t.tick(1500);
    const capped = await t.owner.get("/api/maps/lookup?q=new place");
    expect(capped.status).toBe(429);
    expect(capped.body.error.code).toBe("geo_daily_cap");
    expect((await t.owner.get("/api/maps/lookup?q=cached place")).body).toMatchObject({ cached: true, left: 0 });
    t.tick(86_400_000);
    expect((await t.owner.get("/api/maps/lookup?q=new place")).status).toBe(200);
  });

  it("rejects too short queries without a call", async () => {
    const t = await setup();
    expect((await t.owner.get("/api/maps/lookup?q=ab")).status).toBe(400);
    expect(t.net.calls).toHaveLength(0);
  });

  it("saves, reads, replaces and removes a contact's address", async () => {
    const t = await setup();
    const id = t.contact.id;
    expect((await t.owner.get(`/api/maps/places?type=contact&id=${id}`)).body.place).toBeNull();
    const put = await t.owner.put("/api/maps/places", { entityType: "contact", entityId: id, address: "  1 George St,   Sydney ", lat: -33.86, lon: 151.2 });
    expect(put.status).toBe(200);
    expect(put.body.place).toMatchObject({ address: "1 George St, Sydney", lat: -33.86, lon: 151.2 });
    const typed = await t.owner.put("/api/maps/places", { entityType: "contact", entityId: id, address: "Back shed, Farm Rd" });
    expect(typed.body.place).toMatchObject({ id: put.body.place.id, address: "Back shed, Farm Rd", lat: null, lon: null });
    expect((await t.owner.del(`/api/maps/places?type=contact&id=${id}`)).status).toBe(200);
    expect((await t.owner.get(`/api/maps/places?type=contact&id=${id}`)).body.place).toBeNull();
    const again = await t.owner.put("/api/maps/places", { entityType: "contact", entityId: id, address: "2 Pitt St" });
    expect(again.body.place.id).toBe(put.body.place.id);
  });

  it("validates addresses and map points", async () => {
    const t = await setup();
    const base = { entityType: "contact", entityId: t.contact.id };
    expect((await t.owner.put("/api/maps/places", { ...base, address: "   " })).status).toBe(400);
    expect((await t.owner.put("/api/maps/places", { ...base, address: "x", lat: 95, lon: 1 })).status).toBe(422);
    expect((await t.owner.put("/api/maps/places", { ...base, address: "x", lat: 10 })).status).toBe(400);
    expect((await t.owner.put("/api/maps/places", { ...base, address: "x".repeat(301) })).status).toBe(422);
    expect((await t.owner.get("/api/maps/places?type=planet&id=x")).status).toBe(400);
  });

  it("keeps addresses inside the workspace", async () => {
    const t = await setup();
    const other = new Client(t.app);
    await other.signup("stranger-r115@example.com");
    expect((await other.get(`/api/maps/places?type=contact&id=${t.contact.id}`)).status).toBe(404);
    expect((await other.put("/api/maps/places", { entityType: "contact", entityId: t.contact.id, address: "Mine now" })).status).toBe(404);
    expect((await t.owner.put("/api/maps/places", { entityType: "company", entityId: "cmp_nope", address: "x" })).status).toBe(404);
  });

  it("lists contacts and companies with an address for visits, without deleted ones", async () => {
    const t = await setup({ MAPS_R115: "on", CRM_TIMELINE: "on" });
    const co = (await t.owner.post("/api/crm/companies", { name: "Harbour Co" })).body.company;
    const gone = (await t.owner.post("/api/contacts", { email: "gone@x.io", name: "Gone" })).body.contact;
    await t.owner.put("/api/maps/places", { entityType: "contact", entityId: t.contact.id, address: "1 George St", lat: -33.86, lon: 151.2 });
    await t.owner.put("/api/maps/places", { entityType: "company", entityId: co.id, address: "Pier 1" });
    await t.owner.put("/api/maps/places", { entityType: "contact", entityId: gone.id, address: "Gone St" });
    await t.owner.del(`/api/contacts/${gone.id}`);
    const v = await t.owner.get("/api/maps/visits");
    expect(v.body.candidates.map((c: { name: string; type: string }) => `${c.type}:${c.name}`)).toEqual(["company:Harbour Co", "contact:Sam Lee"]);
    expect(v.body.limit).toBe(25);
  });

  it("lets a member set a contact's address, but only the owner or an admin a booking page's place", async () => {
    const t = await setup();
    const page = (await t.owner.put("/api/scheduling/page", { slug: "olive-r115", title: "Site visit", timezone: "Australia/Sydney", hours: { mon: [["09:00", "11:00"]] }, slotMin: 30, minNoticeMin: 0 })).body.page;
    expect(page).toBeTruthy();
    const mate = await addMember(t);
    expect((await mate.put("/api/maps/places", { entityType: "contact", entityId: t.contact.id, address: "1 George St" })).status).toBe(200);
    const mine = await t.owner.put("/api/maps/places", { entityType: "scheduling_page", entityId: "mine", address: "Level 2, 10 Pitt St, Sydney", lat: -33.865, lon: 151.208 });
    expect(mine.status).toBe(200);
    const pageId = mine.body.place.entityId;
    expect(pageId).not.toBe("mine");
    expect((await mate.put("/api/maps/places", { entityType: "scheduling_page", entityId: pageId, address: "Elsewhere" })).status).toBe(403);
    expect((await mate.del(`/api/maps/places?type=scheduling_page&id=${pageId}`)).status).toBe(403);
    expect((await mate.get(`/api/maps/places?type=scheduling_page&id=${pageId}`)).body.place.address).toBe("Level 2, 10 Pitt St, Sydney");
    // The public booking page shows the place only while maps are on.
    const pub = await new Client(t.app).get("/api/book/olive-r115?days=7");
    expect(pub.body.page.location).toEqual({ address: "Level 2, 10 Pitt St, Sydney", lat: -33.865, lon: 151.208 });
  });

  it("leaves the public booking page as it was when maps are off", async () => {
    const t = await setup({ SCHEDULING_ENABLED: "true" });
    await t.owner.put("/api/scheduling/page", { slug: "plain-r115", title: "Call", timezone: "Australia/Sydney", hours: { mon: [["09:00", "11:00"]] }, slotMin: 30, minNoticeMin: 0 });
    const pub = await new Client(t.app).get("/api/book/plain-r115?days=7");
    expect(pub.status).toBe(200);
    expect("location" in pub.body.page).toBe(false);
  });
});

describe("R115 verifier v8 fixes (staging 3b16457d0584)", () => {
  it("keeps the highlighted suggestion when newer results re order, else highlights nothing", () => {
    const nsw = { address: "10 Pitt Street, Sydney NSW 2000, Australia" };
    const ns = { address: "10 Pitt Street, Sydney, Nova Scotia, Canada" };
    expect(highlightAfterResults(nsw.address, [ns, nsw])).toBe(1);
    expect(highlightAfterResults(nsw.address, [ns])).toBe(-1);
    expect(highlightAfterResults(null, [nsw, ns])).toBe(-1);
    expect(highlightAfterResults(nsw.address, [])).toBe(-1);
  });
  it("map credits: tile host, tile schema and OpenStreetMap, each an https link, no dashes", () => {
    expect(MAP_CREDITS.map((c) => c.label)).toEqual(["OpenFreeMap", "© OpenMapTiles", "© OpenStreetMap contributors"]);
    for (const c of MAP_CREDITS) { expect(c.href).toMatch(/^https:\/\//); expect(c.label).not.toMatch(/[\u2013\u2014-]/); }
  });
  it("explains why Shortest order has nothing to do", () => {
    expect(bestHint(2, false)).toMatch(/same distance either way/);
    expect(bestHint(2, true)).toBe("Already in the shortest order.");
    expect(bestHint(3, false)).toBe("Already in the shortest order.");
    expect(bestHint(1, false)).toMatch(/at least two stops/);
    for (const n of [0, 1, 2, 3]) expect(bestHint(n, false)).not.toMatch(/[\u2013\u2014-]/);
  });
});
