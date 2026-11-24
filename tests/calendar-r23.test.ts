import { describe, it, expect, beforeEach } from "vitest";
import { buildFeed, foldLine, icsEscape } from "@/server/services/suite/ics-write";
import { eventsIn, parseDuration, zoneFor } from "@/server/services/suite/ics-parse";
import { checkUrl, discoverCalendars, multistatus, reportEvents } from "@/server/services/suite/caldav";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { FakeImapServer, FakeSmtpServer } from "./fake-mail-servers";
import { calendarFeeds, calendarSources, users } from "@/server/db/schema";
import { clearCalendarCache } from "@/server/services/suite/calendar-sync";

const enc = new TextEncoder();
const SAMPLE = {
  meetings: [
    { id: "mtg_1", title: "Weekly sync, team; notes\nand plans", startsAt: new Date("2026-11-02T23:00:00Z"), durationMin: 30, status: "scheduled", recurrence: "FREQ=WEEKLY;INTERVAL=1;BYDAY=TU;COUNT=10", recurrenceTz: "Australia/Sydney", version: 3, updatedAt: new Date("2026-10-20T01:02:03Z"), url: "https://app.example/app/meetings/mtg_1" },
    { id: "mtg_2", title: "Kickoff", startsAt: new Date("2026-11-05T01:00:00Z"), durationMin: 45, status: "scheduled", recurrence: null, recurrenceTz: null, version: 1, updatedAt: new Date("2026-10-21T00:00:00Z"), url: "https://app.example/app/meetings/mtg_2" },
  ],
  dues: [{ id: "tsk_1", title: "Send the quote", ref: "OPS-7", project: "Ops", due: "2026-11-30", url: "https://app.example/app/tasks?task=tsk_1", version: 2, updatedAt: new Date("2026-10-22T00:00:00Z") }],
};
const GOLDEN = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Multies//Calendar feed//EN",
  "CALSCALE:GREGORIAN",
  "METHOD:PUBLISH",
  "X-WR-CALNAME:Multies",
  "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
  "X-PUBLISHED-TTL:PT1H",
  "BEGIN:VTIMEZONE",
  "TZID:Australia/Sydney",
  "BEGIN:STANDARD",
  "DTSTART:20250406T030000",
  "TZOFFSETFROM:+1100",
  "TZOFFSETTO:+1000",
  "RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:20251005T020000",
  "TZOFFSETFROM:+1000",
  "TZOFFSETTO:+1100",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=1SU",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "UID:mtg_1@mymail",
  "DTSTAMP:20261020T010203Z",
  "SEQUENCE:2",
  "DTSTART;TZID=Australia/Sydney:20261103T100000",
  "DTEND;TZID=Australia/Sydney:20261103T103000",
  "RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=TU;COUNT=10",
  "SUMMARY:Weekly sync\\, team\\; notes\\nand plans",
  "URL:https://app.example/app/meetings/mtg_1",
  "LOCATION:https://app.example/app/meetings/mtg_1",
  "DESCRIPTION:Join in Multies: https://app.example/app/meetings/mtg_1",
  "STATUS:CONFIRMED",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:mtg_2@mymail",
  "DTSTAMP:20261021T000000Z",
  "SEQUENCE:0",
  "DTSTART:20261105T010000Z",
  "DTEND:20261105T014500Z",
  "SUMMARY:Kickoff",
  "URL:https://app.example/app/meetings/mtg_2",
  "LOCATION:https://app.example/app/meetings/mtg_2",
  "DESCRIPTION:Join in Multies: https://app.example/app/meetings/mtg_2",
  "STATUS:CONFIRMED",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:task-tsk_1@mymail",
  "DTSTAMP:20261022T000000Z",
  "SEQUENCE:1",
  "DTSTART;VALUE=DATE:20261130",
  "DTEND;VALUE=DATE:20261201",
  "SUMMARY:Due: Send the quote",
  "URL:https://app.example/app/tasks?task=tsk_1",
  "DESCRIPTION:OPS-7 in Ops\\nhttps://app.example/app/tasks?task=tsk_1",
  "TRANSP:TRANSPARENT",
  "END:VEVENT",
  "END:VCALENDAR",
];

const GOOGLE_SECRET_ICS = [
  "BEGIN:VCALENDAR", "PRODID:-//Google Inc//Google Calendar 70.9054//EN", "VERSION:2.0", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
  "X-WR-CALNAME:Grace personal", "X-WR-TIMEZONE:Europe/Paris",
  "BEGIN:VTIMEZONE", "TZID:Europe/Paris", "X-LIC-LOCATION:Europe/Paris", "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST", "DTSTART:19700329T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT", "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "TZNAME:CET", "DTSTART:19701025T030000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD", "END:VTIMEZONE",
  "BEGIN:VEVENT", "DTSTART;TZID=Europe/Paris:20261103T090000", "DTEND;TZID=Europe/Paris:20261103T100000", "DTSTAMP:20261020T000000Z", "UID:dentist@google.com", "SUMMARY:Dentist\\, Dr. Roux", "LOCATION:12 Rue de la Paix\\, Paris", "STATUS:CONFIRMED", "END:VEVENT",
  "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20261111", "DTEND;VALUE=DATE:20261112", "DTSTAMP:20261020T000000Z", "UID:holiday@google.com", "SUMMARY:Armistice Day", "TRANSP:TRANSPARENT", "END:VEVENT",
  "BEGIN:VEVENT", "DTSTART;TZID=Europe/Paris:20261020T183000", "DTEND;TZID=Europe/Paris:20261020T193000", "RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261231T225959Z", "EXDATE;TZID=Europe/Paris:20261110T183000",
  "DTSTAMP:20261020T000000Z", "UID:yoga@google.com", "SUMMARY:Yoga with a very long title that keeps going so that the line has to be folded by Google", "END:VEVENT",
  "BEGIN:VEVENT", "DTSTART;TZID=Europe/Paris:20261117T200000", "DTEND;TZID=Europe/Paris:20261117T210000", "RECURRENCE-ID;TZID=Europe/Paris:20261117T183000", "DTSTAMP:20261020T000000Z", "UID:yoga@google.com", "SUMMARY:Yoga (late)", "END:VEVENT",
  "BEGIN:VEVENT", "DTSTART:20200101T080000Z", "DURATION:PT15M", "RRULE:FREQ=DAILY", "DTSTAMP:20261020T000000Z", "UID:standup@google.com", "SUMMARY:Daily standup", "END:VEVENT",
  "BEGIN:VEVENT", "DTSTART:20261104T120000Z", "DTEND:20261104T130000Z", "DTSTAMP:20261020T000000Z", "UID:gone@google.com", "SUMMARY:Cancelled lunch", "STATUS:CANCELLED", "END:VEVENT",
  "END:VCALENDAR",
].map((l) => (l.length > 75 ? `${l.slice(0, 75)}\r\n ${l.slice(75)}` : l)).join("\r\n");

const FASTMAIL_PRINCIPAL = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/calendars/</D:href><D:propstat><D:prop><D:current-user-principal><D:href>/dav/principals/user/grace@fastmail.com/</D:href></D:current-user-principal></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;
const FASTMAIL_HOMESET = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response><D:href>/dav/principals/user/grace@fastmail.com/</D:href><D:propstat><D:prop><C:calendar-home-set><D:href>/dav/calendars/user/grace@fastmail.com/</D:href></C:calendar-home-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;
const FASTMAIL_HOME = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/">
<D:response><D:href>/dav/calendars/user/grace@fastmail.com/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype><D:displayname>Home</D:displayname></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
<D:response><D:href>/dav/calendars/user/grace@fastmail.com/Default/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>Personal &amp; family</D:displayname><A:calendar-color>#3a87adff</A:calendar-color><C:supported-calendar-component-set><C:comp name="VEVENT"/><C:comp name="VTODO"/></C:supported-calendar-component-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
<D:response><D:href>/dav/calendars/user/grace@fastmail.com/Tasks/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>Tasks</D:displayname><C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
</D:multistatus>`;
const STALWART_REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:" xmlns:B="urn:ietf:params:xml:ns:caldav"><response><href>/dav/cal/grace/default/a.ics</href><propstat><prop><getetag>"1"</getetag><B:calendar-data>BEGIN:VCALENDAR&#13;
VERSION:2.0&#13;
BEGIN:VEVENT&#13;
UID:a1&#13;
DTSTART:20261103T090000Z&#13;
DTEND:20261103T100000Z&#13;
SUMMARY:Board &amp; budget&#13;
END:VEVENT&#13;
END:VCALENDAR&#13;
</B:calendar-data></prop><status>HTTP/1.1 200 OK</status></propstat></response>
<response><href>/dav/cal/grace/default/b.ics</href><propstat><prop><getetag>"2"</getetag><B:calendar-data><![CDATA[BEGIN:VCALENDAR
BEGIN:VEVENT
UID:b1
DTSTART;VALUE=DATE:20261106
SUMMARY:Offsite
END:VEVENT
END:VCALENDAR
]]></B:calendar-data></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;

type FakeRoute = (url: string, init: RequestInit) => Response | undefined;
/** A fetch that answers from routes and records every call. */
function fakeFetch(routes: FakeRoute[]) {
  const calls: { url: string; method: string; auth: string | null; depth: string | null; body: string }[] = [];
  const f = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    // PRIV1b (P45): calendar fetches check DNS first (DNS over HTTPS); answer with a public address, not recorded.
    if (url.startsWith("https://cloudflare-dns.com/")) return dohPublic(url);
    const h = new Headers(init.headers);
    calls.push({ url, method: init.method ?? "GET", auth: h.get("authorization"), depth: h.get("depth"), body: String(init.body ?? "") });
    for (const r of routes) { const res = r(url, init); if (res) return res; }
    return new Response("nope", { status: 404 });
  };
  return { fetch: f as typeof fetch, calls };
}
const dohPublic = (url: string) => Response.json({ Answer: url.endsWith("type=A") ? [{ type: 1, data: "93.184.216.34" }] : [] });
const ms = (xml: string) => new Response(xml, { status: 207, headers: { "content-type": "application/xml" } });
const fastmailRoutes: FakeRoute[] = [
  (u) => (u === "https://caldav.fastmail.com/.well-known/caldav" ? new Response(null, { status: 301, headers: { location: "/dav/calendars/" } }) : undefined),
  (u, i) => (u === "https://caldav.fastmail.com/dav/calendars/" && i.method === "PROPFIND" ? ms(FASTMAIL_PRINCIPAL) : undefined),
  (u) => (u === "https://caldav.fastmail.com/dav/principals/user/grace@fastmail.com/" ? ms(FASTMAIL_HOMESET) : undefined),
  (u, i) => (u === "https://caldav.fastmail.com/dav/calendars/user/grace@fastmail.com/" && i.method === "PROPFIND" ? ms(FASTMAIL_HOME) : undefined),
  (u, i) => (u === "https://caldav.fastmail.com/dav/calendars/user/grace@fastmail.com/Default/" && i.method === "REPORT" ? ms(STALWART_REPORT) : undefined),
];

describe("ICS writer", () => {
  it("escapes commas, semicolons, backslashes and newlines", () => {
    expect(icsEscape("a,b;c\\d\ne\r\nf")).toBe("a\\,b\\;c\\\\d\\ne\\nf");
  });
  it("folds at 75 octets without splitting a UTF-8 character", () => {
    const line = `SUMMARY:${"é".repeat(60)}${"x".repeat(40)}`;
    const folded = foldLine(line);
    const parts = folded.split("\r\n");
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(enc.encode(p).length).toBeLessThanOrEqual(75);
    for (const p of parts.slice(1)) expect(p.startsWith(" ")).toBe(true);
    expect(parts.map((p, i) => (i ? p.slice(1) : p)).join("")).toBe(line);
    expect(folded).not.toContain("\uFFFD");
    expect(foldLine("SHORT:x")).toBe("SHORT:x");
  });
  it("writes the golden feed: CRLF, calendar name, refresh, VTIMEZONE + RRULE, stable UIDs, SEQUENCE, all day dues", () => {
    const out = buildFeed(SAMPLE);
    expect(out).toBe(GOLDEN.join("\r\n") + "\r\n");
    expect(out.replace(/\r\n/g, "")).not.toMatch(/\n/);
    // Same data, same bytes (ETag stable).
    expect(buildFeed(SAMPLE)).toBe(out);
  });
});

describe("ICS reader", () => {
  const from = new Date("2026-11-01T00:00:00Z"), to = new Date("2026-12-01T00:00:00Z");
  it("reads a Google secret address: TZID, all day, escaped text, folded lines, cancelled skipped", () => {
    const ev = eventsIn(GOOGLE_SECRET_ICS, from, to);
    const dentist = ev.find((e) => e.uid === "dentist@google.com")!;
    expect(dentist).toMatchObject({ title: "Dentist, Dr. Roux", start: "2026-11-03T08:00:00.000Z", end: "2026-11-03T09:00:00.000Z", allDay: false, location: "12 Rue de la Paix, Paris" });
    expect(ev.find((e) => e.uid === "holiday@google.com")).toMatchObject({ start: "2026-11-11", end: "2026-11-12", allDay: true });
    expect(ev.some((e) => e.title === "Cancelled lunch")).toBe(false);
  });
  it("expands RRULE inside the window only, with EXDATE and an override, across a DST change", () => {
    const ev = eventsIn(GOOGLE_SECRET_ICS, from, to);
    const yoga = ev.filter((e) => e.uid === "yoga@google.com");
    // Tuesdays in November 2026: 3, 10 (EXDATE), 17 (moved to 20:00), 24.
    expect(yoga.map((e) => e.start)).toEqual(["2026-11-03T17:30:00.000Z", "2026-11-17T19:00:00.000Z", "2026-11-24T17:30:00.000Z"]);
    expect(yoga.find((e) => e.start.startsWith("2026-11-17"))!.title).toBe("Yoga (late)");
    expect(yoga[0].title.startsWith("Yoga with a very long title")).toBe(true);
    // October (summer time, +02:00): 16:30 UTC.
    const oct = eventsIn(GOOGLE_SECRET_ICS, new Date("2026-10-19T00:00:00Z"), new Date("2026-10-22T00:00:00Z")).filter((e) => e.uid === "yoga@google.com");
    expect(oct.map((e) => e.start)).toEqual(["2026-10-20T16:30:00.000Z"]);
  });
  it("bounds a daily series that started years ago to the window", () => {
    const ev = eventsIn(GOOGLE_SECRET_ICS, from, to).filter((e) => e.uid === "standup@google.com");
    expect(ev.length).toBe(30);
    expect(ev[0]).toMatchObject({ start: "2026-11-01T08:00:00.000Z", end: "2026-11-01T08:15:00.000Z" });
    const year = eventsIn(GOOGLE_SECRET_ICS, new Date("2026-01-01T00:00:00Z"), new Date("2027-12-31T00:00:00Z")).filter((e) => e.uid === "standup@google.com");
    expect(year.length).toBe(500);
  });
  it("monthly and yearly rules, durations, zone names", () => {
    const ics = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:m", "DTSTART:20260105T090000Z", "DURATION:PT1H", "RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=12", "SUMMARY:Review", "END:VEVENT",
      "BEGIN:VEVENT", "UID:y", "DTSTART;VALUE=DATE:20200229", "RRULE:FREQ=YEARLY", "SUMMARY:Leap", "END:VEVENT", "END:VCALENDAR"].join("\n");
    const ev = eventsIn(ics, new Date("2026-11-01T00:00:00Z"), new Date("2029-01-01T00:00:00Z"));
    expect(ev.filter((e) => e.uid === "m").map((e) => e.start)).toEqual(["2026-11-27T09:00:00.000Z", "2026-12-25T09:00:00.000Z"]);
    expect(ev.filter((e) => e.uid === "y").map((e) => e.start)).toEqual(["2028-02-29"]);
    expect(parseDuration("P1DT2H")).toBe(26 * 3600_000);
    expect(parseDuration("P2W")).toBe(14 * 86_400_000);
    expect(zoneFor("Eastern Standard Time")).toBe("America/New_York");
    expect(zoneFor("/mozilla.org/20070129_1/Europe/Berlin")).toBe("Europe/Berlin");
    expect(zoneFor("Not/AZone", "UTC")).toBe("UTC");
  });
});

describe("CalDAV", () => {
  it("discovers calendars (well-known redirect, principal, home set) and skips task only lists", async () => {
    const f = fakeFetch(fastmailRoutes);
    const cals = await discoverCalendars({ fetch: f.fetch, allowPrivateHosts: false }, "https://caldav.fastmail.com/", { username: "grace@fastmail.com", password: "app-pass" });
    expect(cals).toEqual([{ url: "https://caldav.fastmail.com/dav/calendars/user/grace@fastmail.com/Default/", name: "Personal & family", color: "#3a87ad" }]);
    expect(f.calls.every((c) => c.auth === `Basic ${btoa("grace@fastmail.com:app-pass")}`)).toBe(true);
    expect(f.calls.map((c) => c.method)).toEqual(["PROPFIND", "PROPFIND", "PROPFIND", "PROPFIND"]);
    expect(f.calls[3].depth).toBe("1");
  });
  it("REPORT asks for the window and reads calendar-data (entities and CDATA, Stalwart shape)", async () => {
    const f = fakeFetch(fastmailRoutes);
    const texts = await reportEvents({ fetch: f.fetch, allowPrivateHosts: false }, "https://caldav.fastmail.com/dav/calendars/user/grace@fastmail.com/Default/", { username: "u", password: "p" }, new Date("2026-11-01T00:00:00Z"), new Date("2026-12-01T00:00:00Z"));
    expect(f.calls[0].body).toContain('<c:time-range start="20261101T000000Z" end="20261201T000000Z"/>');
    expect(texts.length).toBe(2);
    const ev = texts.flatMap((t) => eventsIn(t, new Date("2026-11-01T00:00:00Z"), new Date("2026-12-01T00:00:00Z")));
    expect(ev.map((e) => [e.title, e.start])).toEqual([["Board & budget", "2026-11-03T09:00:00.000Z"], ["Offsite", "2026-11-06"]]);
    expect(multistatus(STALWART_REPORT).map((r) => r.href)).toEqual(["/dav/cal/grace/default/a.ics", "/dav/cal/grace/default/b.ics"]);
  });
  it("says wrong password and no CalDAV in plain words", async () => {
    const opts = (status: number) => ({ fetch: (async (u: string) => (String(u).startsWith("https://cloudflare-dns.com/") ? dohPublic(String(u)) : new Response("", { status }))) as typeof fetch, allowPrivateHosts: false });
    await expect(discoverCalendars(opts(401), "https://caldav.fastmail.com/", { username: "u", password: "bad" })).rejects.toMatchObject({ code: "caldav_auth" });
    await expect(discoverCalendars(opts(405), "https://mail.example.com/", { username: "u", password: "p" })).rejects.toMatchObject({ code: "caldav_unsupported" });
  });
  it("refuses private hosts, plain http and credentials in the address; follows no redirect to a private host", async () => {
    for (const u of ["https://127.0.0.1/cal.ics", "https://10.0.0.5/cal.ics", "https://localhost/cal.ics", "https://[::1]/x.ics"]) expect(() => checkUrl(u, false)).toThrow(/private/);
    expect(() => checkUrl("http://example.com/x.ics", false)).toThrow(/https/);
    expect(() => checkUrl("https://a:b@example.com/x.ics", false)).toThrow(/password/);
    expect(checkUrl("webcal://example.com/x.ics", false).toString()).toBe("https://example.com/x.ics");
    expect(checkUrl("http://127.0.0.1:8080/x.ics", true).hostname).toBe("127.0.0.1");
    const f = fakeFetch([(u) => (u.startsWith("https://evil.example") ? new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest" } }) : undefined)]);
    await expect(discoverCalendars({ fetch: f.fetch, allowPrivateHosts: false }, "https://evil.example/", { username: "u", password: "p" })).rejects.toThrow();
    expect(f.calls.some((c) => c.url.includes("169.254"))).toBe(false);
  });
});


const GOOGLE_URL = "https://calendar.google.com/calendar/ical/grace%40gmail.com/private-0123456789abcdef/basic.ics";
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;
let maya: Client;
let ownerId: string;
let mayaId: string;
let fake: ReturnType<typeof fakeFetch>;

async function me(c: Client) { return (await c.get("/api/account/me")).body as { user: { id: string; email: string }; organization: { id: string } }; }
async function api(key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
async function mcpFor(key: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
  return client;
}
const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
const feedGet = (path: string, init: RequestInit = {}) => ctx.app.request(path, { ...init, headers: { host: "localhost", ...(init.headers ?? {}) } });
/** Counts INSERT, UPDATE and DELETE statements run on the database. */
function writeSpy() {
  const c = (ctx.db as unknown as { $client: { prepare: (q: string) => unknown } }).$client;
  const prepare = c.prepare.bind(c);
  const seen: string[] = [];
  c.prepare = (q: string) => { if (/^\s*(insert|update|delete|replace)\b/i.test(q)) seen.push(q); return prepare(q); };
  return { seen, stop: () => { c.prepare = prepare; } };
}

beforeEach(async () => {
  clearCalendarCache();
  fake = fakeFetch([
    (u) => (u === GOOGLE_URL ? new Response(GOOGLE_SECRET_ICS, { headers: { "content-type": "text/calendar" } }) : undefined),
    (u) => (u === "https://example.com/not-a-calendar" ? new Response("<html>hello</html>") : undefined),
    ...fastmailRoutes,
  ]);
  ctx = await makeTestApp({}, { fetch: fake.fetch });
  ctx.deps.now = () => new Date("2026-10-26T03:00:00Z");
  owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
  const inv = await owner.post("/api/team/invites", { email: "maya@acme.io", role: "member", mailboxIds: [] });
  maya = new Client(ctx.app);
  await maya.signup("maya@acme.io", "Maya Lopez", "");
  await maya.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`);
  ownerId = (await me(owner)).user.id;
  mayaId = (await me(maya)).user.id;
  expect((await me(maya)).organization.id).toBe((await me(owner)).organization.id);
});

async function schedule(c: Client, body: Record<string, unknown>) {
  const r = await c.post("/api/meetings", body);
  expect(r.status).toBe(201);
  return (r.body.meeting ?? r.body) as { id: string };
}

describe("calendar feed (out)", () => {
  it("turns on, serves the person's meetings and due dates, answers HEAD and ETag, and writes nothing per fetch", async () => {
    expect((await owner.get("/api/calendar/feed")).body.feed).toMatchObject({ enabled: false, hint: null });
    const on = await owner.post("/api/calendar/feed", {});
    expect(on.status).toBe(200);
    const url: string = on.body.feed.url;
    expect(url).toMatch(/^http:\/\/localhost:5173\/cal\/[A-Za-z0-9]{32}\.ics$/);
    expect(on.body.feed.webcalUrl).toBe(url.replace("http:", "webcal:"));
    const status = (await owner.get("/api/calendar/feed")).body.feed;
    expect(status).toMatchObject({ enabled: true, hint: url.slice(-8, -4) });
    expect(JSON.stringify(status)).not.toContain(url.split("/cal/")[1].slice(0, 20));
    // Only the hash is stored.
    const row = (await ctx.db.select().from(calendarFeeds).get())!;
    expect(row.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.tokenHash).not.toContain(url.split("/cal/")[1].slice(0, 32));

    const m1 = await schedule(owner, { title: "Pricing review", startsAt: "2026-11-03T01:00:00Z", durationMin: 30 });
    const m2 = await schedule(maya, { title: "Maya's 1:1, with Olive", startsAt: "2026-11-04T01:00:00Z", invitees: ["owner@acme.io"] });
    const m3 = await schedule(maya, { title: "Maya alone", startsAt: "2026-11-05T01:00:00Z" });
    await schedule(owner, { title: "Weekly sync", startsAt: "2026-11-02T23:00:00Z", recurrence: { interval: 1, days: ["tu"], count: 8, timezone: "Australia/Sydney" } });
    const t = await owner.post("/api/tasks", { title: "Send the quote", due: "2026-11-20", assignee: `member:${ownerId}` });
    expect(t.status).toBe(201);
    await owner.post("/api/tasks", { title: "Maya's task", due: "2026-11-21", assignee: `member:${mayaId}` });

    const path = new URL(url).pathname;
    const spy = writeSpy();
    const res = await feedGet(path);
    const again = await feedGet(path);
    const head = await feedGet(path, { method: "HEAD" });
    spy.stop();
    expect(spy.seen).toEqual([]);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    const body = await res.text();
    expect(body.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(body.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(body).toContain("X-WR-CALNAME:Multies");
    expect(body).toContain(`UID:${m1.id}@mymail`);
    expect(body).toContain(`UID:${m2.id}@mymail`);
    expect(body).not.toContain(`UID:${m3.id}@mymail`);
    expect(body).toContain("SUMMARY:Maya's 1:1\\, with Olive");
    expect(body).toContain("RRULE:FREQ=WEEKLY");
    expect(body).toContain("BEGIN:VTIMEZONE\r\nTZID:Australia/Sydney");
    expect(body).toContain("SUMMARY:Due: Send the quote");
    expect(body).not.toContain("Maya's task");
    expect(body).toContain("DTSTART;VALUE=DATE:20261120");
    const etag = res.headers.get("etag")!;
    expect(etag).toMatch(/^"[a-f0-9]{32}"$/);
    expect(again.headers.get("etag")).toBe(etag);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("etag")).toBe(etag);
    const notModified = await feedGet(path, { headers: { "if-none-match": etag } });
    expect(notModified.status).toBe(304);

    // Without due dates.
    expect((await owner.patch("/api/calendar/feed", { includeTasks: false })).body.feed.includeTasks).toBe(false);
    expect(await (await feedGet(path)).text()).not.toContain("Due: Send the quote");
  });

  it("reset gives a new address and the old one answers 404 at once; turning off stops it", async () => {
    const first = (await owner.post("/api/calendar/feed", {})).body.feed.url as string;
    expect((await feedGet(new URL(first).pathname)).status).toBe(200);
    const second = (await owner.post("/api/calendar/feed", {})).body.feed.url as string;
    expect(second).not.toBe(first);
    expect((await feedGet(new URL(first).pathname)).status).toBe(404);
    expect((await feedGet(new URL(second).pathname)).status).toBe(200);
    for (const bad of ["/cal/short.ics", "/cal/../etc.ics", "/cal/" + "A".repeat(32) + ".ics", "/cal/" + "A".repeat(32)]) expect((await feedGet(bad)).status).toBe(404);
    expect((await owner.del("/api/calendar/feed")).status).toBe(200);
    expect((await feedGet(new URL(second).pathname)).status).toBe(404);
    // Each person has their own; Maya's feed never shows Olive's own meetings.
    await schedule(owner, { title: "Olive only", startsAt: "2026-11-03T01:00:00Z" });
    const mayaUrl = (await maya.post("/api/calendar/feed", {})).body.feed.url as string;
    expect(await (await feedGet(new URL(mayaUrl).pathname)).text()).not.toContain("Olive only");
  });

  it("stops serving a person who left the workspace, and limits polling per token", async () => {
    const url = (await maya.post("/api/calendar/feed", {})).body.feed.url as string;
    const path = new URL(url).pathname;
    let last = 200;
    for (let i = 0; i < 31; i++) last = (await feedGet(path, { headers: { "x-forwarded-for": `10.0.0.${i}` } })).status;
    expect(last).toBe(429);
    const url2 = (await maya.post("/api/calendar/feed", {})).body.feed.url as string;
    expect((await feedGet(new URL(url2).pathname, { headers: { "x-forwarded-for": "10.9.9.9" } })).status).toBe(200);
    expect((await owner.del(`/api/team/members/${mayaId}`)).status).toBe(200);
    expect((await feedGet(new URL(url2).pathname, { headers: { "x-forwarded-for": "10.9.9.8" } })).status).toBe(404);
  });
});

describe("other calendars (in)", () => {
  it("adds a secret ICS link, shows its events read only, never returns the address", async () => {
    const add = await owner.post("/api/calendar/sources", { kind: "ics", url: GOOGLE_URL });
    expect(add.status).toBe(201);
    expect(add.body.source).toMatchObject({ kind: "ics", name: "Grace personal", host: "calendar.google.com", enabled: true });
    const raw = JSON.stringify([add.body, (await owner.get("/api/calendar/sources")).body]);
    expect(raw).not.toContain("private-0123456789abcdef");
    const row = (await ctx.db.select().from(calendarSources).get())!;
    expect(row.urlEnc).not.toContain("private-0123456789abcdef");
    const fetchesBefore = fake.calls.length;
    const spy = writeSpy();
    const ev = await owner.get("/api/calendar/events?from=2026-11-01&to=2026-12-01");
    const ev2 = await owner.get("/api/calendar/events?from=2026-11-01&to=2026-12-01");
    spy.stop();
    expect(spy.seen).toEqual([]);
    expect(fake.calls.length).toBe(fetchesBefore + 1); // cached in memory
    expect(ev.status).toBe(200);
    expect(ev2.body.events.length).toBe(ev.body.events.length);
    const ext = ev.body.events.filter((e: { kind: string }) => e.kind === "external");
    expect(ext.find((e: { title: string }) => e.title === "Dentist, Dr. Roux")).toMatchObject({ readOnly: true, sourceName: "Grace personal", start: "2026-11-03T08:00:00.000Z" });
    expect(ev.body.errors).toEqual([]);
    // Turned off: no events, no fetch.
    await owner.patch(`/api/calendar/sources/${add.body.source.id}`, { enabled: false });
    const off = await owner.get("/api/calendar/events?from=2026-11-01&to=2026-12-01");
    expect(off.body.events.filter((e: { kind: string }) => e.kind === "external")).toEqual([]);
  });

  it("refuses private hosts, plain http and pages that are not calendars, in plain words", async () => {
    const priv = await owner.post("/api/calendar/sources", { kind: "ics", url: "https://192.168.1.10/cal.ics" });
    expect(priv.status).toBe(422);
    expect(priv.body.error.message).toMatch(/private network/);
    expect((await owner.post("/api/calendar/sources", { kind: "ics", url: "http://example.com/cal.ics" })).status).toBe(422);
    const html = await owner.post("/api/calendar/sources", { kind: "ics", url: "https://example.com/not-a-calendar" });
    expect(html.status).toBe(422);
    expect(html.body.error.message).toMatch(/does not lead to a calendar/);
    expect(fake.calls.some((c) => c.url.includes("192.168"))).toBe(false);
  });

  it("another person's calendars are invisible and untouchable; another workspace's too", async () => {
    const add = await owner.post("/api/calendar/sources", { kind: "ics", url: GOOGLE_URL });
    const id = add.body.source.id;
    expect((await maya.get("/api/calendar/sources")).body.data).toEqual([]);
    expect((await maya.patch(`/api/calendar/sources/${id}`, { enabled: false })).status).toBe(404);
    expect((await maya.del(`/api/calendar/sources/${id}`)).status).toBe(404);
    const mayaEvents = await maya.get("/api/calendar/events?from=2026-11-01&to=2026-12-01");
    expect(mayaEvents.body.events.some((e: { kind: string }) => e.kind === "external")).toBe(false);
    const other = new Client(ctx.app);
    await other.signup("eve@other.io", "Eve Other", "Other");
    expect((await other.patch(`/api/calendar/sources/${id}`, { enabled: false })).status).toBe(404);
    expect((await other.del(`/api/calendar/sources/${id}`)).status).toBe(404);
    expect((await other.get("/api/calendar/events?from=2026-11-01&to=2026-12-01")).body.events).toEqual([]);
    expect((await new Client(ctx.app).get("/api/calendar/sources")).status).toBe(401);
    expect((await owner.get("/api/calendar/events?from=2026-11-01&to=2027-06-01")).status).toBe(422);
  });

  it("connects a mailbox's CalDAV calendar (Fastmail) for its owner only, and offers Gmail as coming later", async () => {
    const imap = new FakeImapServer().addAccount("me@fastmail.com", "fm-app-pass");
    const smtp = new FakeSmtpServer();
    smtp.accounts.set("me@fastmail.com", "fm-app-pass");
    ctx.deps.imap = imap.connector;
    ctx.deps.openSocket = smtp.opener;
    await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, "owner@acme.io"));
    const conn = await owner.post("/api/connections", { email: "me@fastmail.com", password: "fm-app-pass" });
    expect(conn.status).toBe(201);
    const connectionId = conn.body.connection?.id ?? conn.body.id;
    const opts = (await owner.get("/api/calendar/sources/options")).body.data;
    expect(opts).toEqual([expect.objectContaining({ connectionId, provider: "fastmail", caldav: true })]);
    expect((await maya.get("/api/calendar/sources/options")).body.data).toEqual([]);
    expect((await maya.post("/api/calendar/sources", { kind: "caldav", connectionId })).status).toBe(403);
    const add = await owner.post("/api/calendar/sources", { kind: "caldav", connectionId });
    expect(add.status).toBe(201);
    expect(add.body.source).toMatchObject({ kind: "caldav", address: "me@fastmail.com", calendars: [{ name: "Personal & family", color: "#3a87ad" }] });
    expect(JSON.stringify(add.body)).not.toContain("fm-app-pass");
    expect((await owner.post("/api/calendar/sources", { kind: "caldav", connectionId })).status).toBe(409);
    const ev = (await owner.get("/api/calendar/events?from=2026-11-01&to=2026-12-01")).body.events;
    expect(ev.filter((e: { kind: string }) => e.kind === "external").map((e: { title: string }) => e.title)).toEqual(["Board & budget", "Offsite"]);
    expect(fake.calls.filter((c) => c.method === "REPORT").every((c) => c.auth === `Basic ${btoa("me@fastmail.com:fm-app-pass")}`)).toBe(true);
  });
});

describe("REST and MCP", () => {
  it("lists events for keys (workspace only, no other calendars), feed status for people only, read only keys can't reset", async () => {
    await owner.post("/api/calendar/sources", { kind: "ics", url: GOOGLE_URL });
    await schedule(owner, { title: "Pricing review", startsAt: "2026-11-03T01:00:00Z" });
    await schedule(maya, { title: "Maya alone", startsAt: "2026-11-05T01:00:00Z" });
    await owner.post("/api/tasks", { title: "Send the quote", due: "2026-11-20", assignee: `member:${ownerId}` });
    const key = (await owner.post("/api/developer/keys", { name: "Full" })).body.secret;
    const r = await api(key, "GET", "/calendar/events?from=2026-11-01&to=2026-12-01");
    expect(r.status).toBe(200);
    const titles = r.body.events.map((e: { title: string }) => e.title);
    expect(titles).toEqual(expect.arrayContaining(["Pricing review", "Maya alone"]));
    expect(titles.some((t: string) => t.startsWith("Due: Send the quote"))).toBe(true);
    expect(r.body.events.some((e: { kind: string }) => e.kind === "external")).toBe(false);
    // A workspace key reads its maker's feed status, never the address.
    expect((await api(key, "GET", "/calendar/feed")).body.feed).toMatchObject({ enabled: false, hint: null });
    // PRIV1b (P63, round 2 owner decision): making or resetting the secret address is the person's own (a session or
    // their own OAuth sign in). A key would hand the person's whole calendar to whatever holds the key.
    const reset = await api(key, "POST", "/calendar/feed/reset");
    expect(reset.status).toBe(403);
    expect(reset.body.error.code).toBe("person_only");
    expect(JSON.stringify(reset.body)).not.toMatch(/\/cal\//);
    expect((await owner.get("/api/calendar/feed")).body.feed.enabled).toBe(false);
    const own = await owner.post("/api/calendar/feed", {});
    expect(own.status).toBe(200);
    const st = await api(key, "GET", "/calendar/feed");
    expect(st.body.feed).toMatchObject({ enabled: true, hint: own.body.feed.url.slice(-8, -4) });
    expect(JSON.stringify(st.body)).not.toContain(own.body.feed.url.split("/cal/")[1].slice(0, 32));
    const ro = (await owner.post("/api/developer/keys", { name: "Reader", scope: "read" })).body.secret;
    expect((await api(ro, "GET", "/calendar/events")).status).toBe(200);
    expect((await api(ro, "POST", "/calendar/feed/reset")).status).toBe(403);
    expect((await api("mm_live_nope", "GET", "/calendar/events")).status).toBe(401);
    // Another workspace's key sees none of this.
    const other = new Client(ctx.app);
    await other.signup("eve@other.io", "Eve Other", "Other");
    const otherKey = (await other.post("/api/developer/keys", { name: "Other" })).body.secret;
    expect((await api(otherKey, "GET", "/calendar/events?from=2026-11-01&to=2026-12-01")).body.events).toEqual([]);

    const mcp = await mcpFor(key);
    const tools = (await mcp.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("list_calendar_events");
    const out = data(await mcp.callTool({ name: "list_calendar_events", arguments: { from: "2026-11-01", to: "2026-12-01" } }));
    expect(out.events.map((e: { title: string }) => e.title)).toEqual(expect.arrayContaining(["Pricing review", "Maya alone"]));
    expect(out.events.some((e: { kind: string }) => e.kind === "external")).toBe(false);
  });
});

describe("who sees other calendars", () => {
  it("a person's OAuth token (MCP) gets their other calendars; a key with the same user does not", async () => {
    await owner.post("/api/calendar/sources", { kind: "ics", url: GOOGLE_URL });
    const m = await me(owner);
    const { isPerson, listCalendarEvents } = await import("@/server/services/suite/calendar-sync");
    const base = { orgId: m.organization.id, userId: m.user.id, email: m.user.email, name: "Olive Owner" };
    const oauth = { ...base, apiKeyId: "oauth:grant_1", scope: "read" as const };
    const key = { ...base, apiKeyId: "key_1", role: "admin" as const };
    expect(isPerson(base)).toBe(true);
    expect(isPerson(oauth)).toBe(true);
    expect(isPerson(key)).toBe(false);
    expect(isPerson({ ...base, agentId: "agt_1" })).toBe(false);
    const viaOauth = await listCalendarEvents(ctx.deps, oauth, { from: "2026-11-01", to: "2026-12-01" });
    expect(viaOauth.events.some((e) => e.kind === "external" && e.title === "Dentist, Dr. Roux")).toBe(true);
    const viaKey = await listCalendarEvents(ctx.deps, key, { from: "2026-11-01", to: "2026-12-01" });
    expect(viaKey.events.some((e) => e.kind === "external")).toBe(false);
  });
});
