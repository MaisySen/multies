import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { auditLogs, contacts, members, meetings, tasks } from "@/server/db/schema";
import { child, children, NS, parseXml } from "@/server/services/dav/xml";
import { buildVCard, parseVCard } from "@/server/services/dav/vcard";
import { basicCredentials, canonical, createAppPassword, newAppPassword } from "@/server/services/dav/app-passwords";
import { buildObject } from "@/server/services/suite/ics-write";
import { mobileConfig, targetOf } from "@/server/routes/dav";

// ---------------------------------------------------------------- units

describe("R99 DAV units", () => {
  it("reads XML with any prefixes, entities and CDATA; refuses broken or oversized bodies", () => {
    const x = parseXml(`<?xml version="1.0"?><A:propfind xmlns:A="DAV:" xmlns:B="urn:ietf:params:xml:ns:caldav"><A:prop><A:getetag/><B:calendar-data/></A:prop><A:href>/a&amp;b</A:href><A:x><![CDATA[<raw>]]></A:x></A:propfind>`)!;
    expect(x.ns).toBe(NS.dav);
    expect(x.name).toBe("propfind");
    expect(child(x, NS.dav, "prop")!.children.map((c) => `${c.ns}|${c.name}`)).toEqual(["DAV:|getetag", `${NS.cal}|calendar-data`]);
    expect(child(x, NS.dav, "href")!.text).toBe("/a&b");
    expect(child(x, NS.dav, "x")!.text).toBe("<raw>");
    const dflt = parseXml(`<sync-collection xmlns="DAV:"><sync-token>t1</sync-token><prop><getetag/></prop></sync-collection>`)!;
    expect(child(dflt, NS.dav, "sync-token")!.text).toBe("t1");
    expect(parseXml("<a><b></a>")).toBeNull();
    expect(parseXml("")).toBeNull();
    expect(parseXml(`<!DOCTYPE x [<!ENTITY a "aaaa">]><d:prop xmlns:d="DAV:">&a;</d:prop>`)?.text ?? "").not.toContain("aaaa");
    expect(parseXml(`<a>${"x".repeat(600 * 1024)}</a>`)).toBeNull();
    expect(children(parseXml(`<d:m xmlns:d="DAV:"><d:href>1</d:href><d:href>2</d:href></d:m>`), NS.dav, "href").length).toBe(2);
  });

  it("writes and reads vCards: escaping, folding, N fallback, preferred email", () => {
    const card = buildVCard({ id: "con_1", name: "Sam Lee", email: "sam@harbour.com.au", phone: "+61 400 000 000", title: "Owner, Harbour; Co", notes: "Line one\nline two " + "x".repeat(120), company: "Harbour", updatedAt: new Date("2026-11-01T00:00:00Z") });
    expect(card).toContain("UID:con_1\r\n");
    expect(card).toContain("N:Lee;Sam;;;\r\n");
    expect(card).toContain("TITLE:Owner\\, Harbour\\; Co\r\n");
    expect(card.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    const back = parseVCard(card)!;
    expect(back).toMatchObject({ uid: "con_1", name: "Sam Lee", email: "sam@harbour.com.au", phone: "+61 400 000 000", title: "Owner, Harbour; Co" });
    expect(back.notes).toContain("Line one\nline two");
    const v4 = parseVCard("BEGIN:VCARD\nVERSION:4.0\nN:Doe;Jane;;;\nitem1.EMAIL;TYPE=work:jane@work.io\nEMAIL;TYPE=home,pref:JANE@home.io\nTEL;VALUE=uri:tel:+61-2-1234\nEND:VCARD\n")!;
    expect(v4).toMatchObject({ name: "Jane Doe", email: "jane@home.io", phone: "+61-2-1234" });
    expect(parseVCard("BEGIN:VCARD\nFN:A\nEND:VCARD\nBEGIN:VCARD\nFN:B\nEND:VCARD")).toBeNull();
    expect(parseVCard("hello")).toBeNull();
  });

  it("makes app passwords of four groups without look alike characters; reads Basic credentials", () => {
    const pw = newAppPassword();
    expect(pw).toMatch(/^[a-hj-km-np-z2-9]{5}(-[a-hj-km-np-z2-9]{5}){3}$/);
    expect(new Set(Array.from({ length: 50 }, newAppPassword)).size).toBe(50);
    expect(canonical(" ABCDE-fghjk mnpqr-stuvw ")).toBe("abcdefghjkmnpqrstuvw");
    expect(basicCredentials(`Basic ${btoa("ada@acme.io:abc:def")}`)).toEqual({ user: "ada@acme.io", password: "abc:def" });
    expect(basicCredentials("Bearer x")).toBeNull();
    expect(basicCredentials("Basic !!!")).toBeNull();
  });

  it("builds a CalDAV object without METHOD and with the phone's UID; keeps time zones and all day dates", () => {
    const m = { id: "mtg_1", title: "Weekly, sync", startsAt: new Date("2026-11-03T23:00:00Z"), durationMin: 30, status: "scheduled", recurrence: "FREQ=WEEKLY;INTERVAL=1;BYDAY=WE;COUNT=4", recurrenceTz: "Australia/Sydney", version: 2, updatedAt: new Date("2026-11-01T00:00:00Z"), url: "https://a/app/meetings/mtg_1" };
    const ics = buildObject({ meetings: [m], dues: [] }, { uid: "ABC-123" });
    expect(ics).not.toMatch(/METHOD:|X-WR-CALNAME|REFRESH-INTERVAL/);
    expect(ics).toContain("UID:ABC-123\r\n");
    expect(ics).toContain("BEGIN:VTIMEZONE\r\nTZID:Australia/Sydney");
    expect(ics).toContain("DTSTART;TZID=Australia/Sydney:20261104T100000");
    expect(ics).toContain("RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=WE;COUNT=4");
    const due = buildObject({ meetings: [], dues: [{ id: "t1", title: "Quote", ref: "OPS-1", project: "Ops", due: "2026-11-30", url: "u", version: 1, updatedAt: new Date() }] });
    expect(due).toContain("DTSTART;VALUE=DATE:20261130\r\nDTEND;VALUE=DATE:20261201");
  });

  it("maps paths to collections and refuses anything else", () => {
    expect(targetOf("/dav/")).toEqual({ kind: "root" });
    expect(targetOf("/dav/principal/")).toEqual({ kind: "principal" });
    expect(targetOf("/dav/cal/meetings/")).toMatchObject({ kind: "collection", col: { id: "meetings" } });
    expect(targetOf("/dav/card/contacts/x.vcf")).toMatchObject({ kind: "object", name: "x.vcf" });
    expect(targetOf("/dav/card/meetings/")).toBeNull();
    expect(targetOf("/dav/cal/contacts/")).toBeNull();
    expect(targetOf("/dav/cal/other/")).toBeNull();
    expect(targetOf("/dav/cal/meetings/a/b")).toBeNull();
  });

  it("guard: the Worker hands /dav and the well known paths to the app (not the static 404)", async () => {
    const { readFileSync } = await import("node:fs");
    const wr = readFileSync("wrangler.toml", "utf8");
    const first = wr.match(/run_worker_first = \[([^\]]*)\]/)![1];
    expect(first).toContain('"/dav"');
    expect(first).toContain('"/dav/*"');
    expect(first).toContain('"/.well-known/*"');
    const worker = readFileSync("src/entry/worker.ts", "utf8");
    expect(worker).toContain('url.pathname.startsWith("/dav/")');
    expect(wr).toMatch(/\[env\.staging\.vars\][\s\S]*DAV_SYNC_R99 = "on"/);
  });

  it("builds an unsigned profile with both accounts and no password", async () => {
    const xml = await mobileConfig("https://multies.si", { id: "u1", email: "ada@acme.io" });
    expect(xml).toContain("com.apple.caldav.account");
    expect(xml).toContain("com.apple.carddav.account");
    expect(xml).toContain("<key>CalDAVHostName</key><string>multies.si</string>");
    expect(xml).toContain("<key>CardDAVUseSSL</key><true/>");
    expect(xml).not.toMatch(/Password/);
    expect(await mobileConfig("https://multies.si", { id: "u1", email: "ada@acme.io" })).toBe(xml);
  });
});

// ---------------------------------------------------------------- API and protocol

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client, maya: Client, other: Client;
let ownerId = "", mayaId = "";
let ownerPw = "", mayaPw = "";
const auth = (email: string, pw: string) => `Basic ${btoa(`${email}:${pw}`)}`;
const dav = (path: string, init: { method?: string; auth?: string; depth?: string; body?: string; headers?: Record<string, string> } = {}) =>
  ctx.app.request(path, { method: init.method ?? "PROPFIND", headers: { host: "localhost", ...(init.auth ? { authorization: init.auth } : {}), ...(init.depth ? { depth: init.depth } : {}), ...(init.body ? { "content-type": init.method === "PUT" ? "text/calendar" : "application/xml" } : {}), ...(init.headers ?? {}) }, body: init.body });
const O = () => auth("owner@acme.io", ownerPw);
const M = () => auth("maya@acme.io", mayaPw);
const hrefs = (xml: string) => [...xml.matchAll(/<d:response><d:href>([^<]*)<\/d:href>/g)].map((m) => m[1]);
const PROP_ETAG = `<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:resourcetype/></d:prop></d:propfind>`;
const me = async (c: Client) => (await c.get("/api/account/me")).body as { user: { id: string } };

const EVENT = (uid: string, title: string, start = "20261110T010000Z", end = "20261110T013000Z", extra = "") =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261101T000000Z\r\nDTSTART:${start}\r\nDTEND:${end}\r\nSUMMARY:${title}\r\n${extra}ATTENDEE:mailto:stranger@x.io\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

describe("R99 DAV server", () => {
  beforeAll(async () => {
    ctx = await makeTestApp({ DAV_SYNC_R99: "on" });
    owner = new Client(ctx.app);
    await owner.signup("owner@acme.io", "Olive Owner");
    const inv = await owner.post("/api/team/invites", { email: "maya@acme.io", role: "member", mailboxIds: [] });
    maya = new Client(ctx.app);
    await maya.signup("maya@acme.io", "Maya Lopez", "");
    await maya.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`);
    other = new Client(ctx.app);
    await other.signup("eve@other.io", "Eve Other", "Other Co");
    ownerId = (await me(owner)).user.id;
    mayaId = (await me(maya)).user.id;
  });

  it("is off unless the flag is on", async () => {
    const off = await makeTestApp({});
    const c = new Client(off.app);
    await c.signup("x@y.io", "X Y");
    expect((await c.get("/api/dav/passwords")).status).toBe(404);
    expect((await off.app.request("/dav/", { method: "PROPFIND", headers: { host: "localhost" } })).status).toBe(404);
    expect((await off.app.request("/.well-known/caldav", { headers: { host: "localhost" } })).status).toBe(404);
  });

  it("creates app passwords shown once, lists names and hints only, caps at 10, refuses keys", async () => {
    const r = await owner.post("/api/dav/passwords", { name: "  Olive's  iPhone " });
    expect(r.status).toBe(201);
    ownerPw = r.body.password;
    expect(r.body.item).toMatchObject({ name: "Olive's iPhone", hint: ownerPw.slice(-4), lastUsedAt: null });
    expect(r.body.server).toMatch(/\/dav\/$/);
    expect(r.body.username).toBe("owner@acme.io");
    const list = await owner.get("/api/dav/passwords");
    expect(list.body.passwords).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(ownerPw);
    expect(JSON.stringify(list.body)).not.toMatch(/tokenHash|token_hash/);
    expect((await owner.post("/api/dav/passwords", { name: "   " })).status).toBe(422);
    mayaPw = (await maya.post("/api/dav/passwords", { name: "Android" })).body.password;
    // Maya cannot see or revoke the owner's.
    expect((await maya.get("/api/dav/passwords")).body.passwords.map((p: { name: string }) => p.name)).toEqual(["Android"]);
    expect((await maya.del(`/api/dav/passwords/${list.body.passwords[0].id}`)).status).toBe(404);
    for (let i = 0; i < 9; i++) await other.post("/api/dav/passwords", { name: `d${i}` });
    expect((await other.post("/api/dav/passwords", { name: "d9" })).status).toBe(201);
    expect((await other.post("/api/dav/passwords", { name: "d10" })).status).toBe(422);
    const orgId = (await ctx.db.select({ o: members.organizationId }).from(members).where(eq(members.userId, ownerId)).get())!.o;
    await expect(createAppPassword(ctx.deps, { orgId, userId: ownerId, email: "owner@acme.io", name: "O", apiKeyId: "key_1" }, { name: "k" })).rejects.toMatchObject({ status: 403 });
    await expect(createAppPassword(ctx.deps, { orgId, userId: ownerId, email: "owner@acme.io", name: "O", agentId: "agt_1" }, { name: "k" })).rejects.toMatchObject({ status: 403 });
  });

  it("signs in only with a valid app password over https, and limits failed sign ins", async () => {
    const no = await dav("/dav/");
    expect(no.status).toBe(401);
    expect(no.headers.get("www-authenticate")).toMatch(/^Basic realm="Multies"/);
    expect((await dav("/dav/", { auth: auth("owner@acme.io", "a-strong-password") })).status).toBe(401);
    expect((await dav("/dav/", { auth: auth("maya@acme.io", ownerPw) })).status).toBe(401);
    expect((await dav("/dav/", { auth: auth("OWNER@acme.io", ownerPw.toUpperCase().replace(/-/g, " ")), depth: "0" })).status).toBe(207);
    expect((await dav("/dav/", { method: "OPTIONS" })).headers.get("dav")).toContain("calendar-access");
    const wk = await ctx.app.request("/.well-known/carddav", { headers: { host: "localhost" } });
    expect(wk.status).toBe(301);
    expect(wk.headers.get("location")).toBe("/dav/");
    const https = await makeTestApp({ DAV_SYNC_R99: "on", APP_URL: "https://app.example" });
    expect((await https.app.request("http://app.example/dav/", { method: "PROPFIND", headers: { host: "app.example" } })).status).toBe(403);
    const lim = await makeTestApp({ DAV_SYNC_R99: "on" });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await lim.app.request("/dav/", { method: "PROPFIND", headers: { host: "localhost", authorization: auth("a@b.io", "aaaaa-bbbbb-ccccc-ddddd") } })).status);
    expect(codes.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });

  it("discovers principal, homes, three calendars and one address book", async () => {
    const p = await (await dav("/dav/principal/", { auth: O(), depth: "0", body: `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><d:current-user-principal/><c:calendar-home-set/><card:addressbook-home-set/><d:unknown-x/></d:prop></d:propfind>` })).text();
    expect(p).toContain("<c:calendar-home-set><d:href>/dav/cal/</d:href></c:calendar-home-set>");
    expect(p).toContain("<card:addressbook-home-set><d:href>/dav/card/</d:href>");
    expect(p).toMatch(/<d:unknown-x\/><\/d:prop><d:status>HTTP\/1.1 404/);
    const cals = await (await dav("/dav/cal/", { auth: O(), depth: "1" })).text();
    expect(hrefs(cals)).toEqual(expect.arrayContaining(["/dav/cal/", "/dav/cal/meetings/", "/dav/cal/tasks/", "/dav/cal/bookings/"]));
    expect(cals).toContain("<c:calendar/>");
    expect(cals).toContain('<c:comp name="VEVENT"/>');
    expect(cals).toContain("<d:sync-token>");
    const books = await (await dav("/dav/card/", { auth: O(), depth: "1" })).text();
    expect(hrefs(books)).toEqual(["/dav/card/", "/dav/card/contacts/"]);
    expect(books).toContain("<card:addressbook/>");
  });

  it("shows each person only their own meetings; edits need the maker or an admin; ETag mismatch is 412", async () => {
    const mine = (await owner.post("/api/meetings", { title: "Owner only", startsAt: "2026-11-05T01:00:00Z" })).body.meeting;
    const shared = (await owner.post("/api/meetings", { title: "Owner with Maya", startsAt: "2026-11-06T01:00:00Z", invitees: ["maya@acme.io"] })).body.meeting;
    const mayas = (await maya.post("/api/meetings", { title: "Maya private", startsAt: "2026-11-07T01:00:00Z" })).body.meeting;
    const ownerList = hrefs(await (await dav("/dav/cal/meetings/", { auth: O(), depth: "1", body: PROP_ETAG })).text());
    expect(ownerList).toEqual(expect.arrayContaining([`/dav/cal/meetings/${mine.id}.ics`, `/dav/cal/meetings/${shared.id}.ics`]));
    expect(ownerList).not.toContain(`/dav/cal/meetings/${mayas.id}.ics`);
    const mayaList = hrefs(await (await dav("/dav/cal/meetings/", { auth: M(), depth: "1", body: PROP_ETAG })).text());
    expect(mayaList).toEqual(expect.arrayContaining([`/dav/cal/meetings/${shared.id}.ics`, `/dav/cal/meetings/${mayas.id}.ics`]));
    expect(mayaList).not.toContain(`/dav/cal/meetings/${mine.id}.ics`);
    // Maya cannot read or address the owner's private meeting at all.
    expect((await dav(`/dav/cal/meetings/${mine.id}.ics`, { method: "GET", auth: M() })).status).toBe(404);
    expect((await dav(`/dav/cal/meetings/${mine.id}.ics`, { method: "PUT", auth: M(), body: EVENT("x", "Hijack") })).status).toBe(403);
    expect((await ctx.db.select().from(meetings).where(eq(meetings.id, mine.id)).get())!.title).toBe("Owner only");

    const get = await dav(`/dav/cal/meetings/${shared.id}.ics`, { method: "GET", auth: O() });
    expect(get.status).toBe(200);
    const etag = get.headers.get("etag")!;
    expect(await get.text()).toContain("SUMMARY:Owner with Maya");
    expect((await dav(`/dav/cal/meetings/${shared.id}.ics`, { method: "GET", auth: O(), headers: { "if-none-match": etag } })).status).toBe(304);
    // Invited but not the maker: read only.
    expect((await dav(`/dav/cal/meetings/${shared.id}.ics`, { method: "PUT", auth: M(), body: EVENT(`${shared.id}@mymail`, "Renamed by Maya") })).status).toBe(403);
    expect((await dav(`/dav/cal/meetings/${shared.id}.ics`, { method: "DELETE", auth: M() })).status).toBe(403);
    // Stale ETag: 412.
    const stale = await dav(`/dav/cal/meetings/${shared.id}.ics`, { method: "PUT", auth: O(), body: EVENT(`${shared.id}@mymail`, "Renamed"), headers: { "if-match": '"m0-1"' } });
    expect(stale.status).toBe(412);
    expect(await stale.text()).toContain("<d:getetag/>");
    // Right ETag: title, start and length change; invitees and the video link stay (Multies wins).
    const ok = await dav(`/dav/cal/meetings/${shared.id}.ics`, { method: "PUT", auth: O(), body: EVENT(`${shared.id}@mymail`, "Renamed", "20261106T020000Z", "20261106T030000Z"), headers: { "if-match": etag } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("etag")).toBeNull();
    const row = (await ctx.db.select().from(meetings).where(eq(meetings.id, shared.id)).get())!;
    expect(row).toMatchObject({ title: "Renamed", durationMin: 60 });
    expect(row.startsAt.toISOString()).toBe("2026-11-06T02:00:00.000Z");
    expect(JSON.parse(row.invitees)).toEqual(["maya@acme.io"]);
    // The owner (an admin) may edit Maya's meeting when it is in the owner's calendar.
    const invitesOwner = (await maya.post("/api/meetings", { title: "Maya asks Olive", startsAt: "2026-11-08T01:00:00Z", invitees: ["owner@acme.io"] })).body.meeting;
    expect((await dav(`/dav/cal/meetings/${invitesOwner.id}.ics`, { method: "PUT", auth: O(), body: EVENT("u", "Moved by admin") })).status).toBe(204);
  });

  it("creates meetings from the phone under the phone's name and UID, weekly rules kept, all day refused, delete works", async () => {
    const name = "6F1E2B3C-AAAA-4BBB-8CCC-1234567890AB.ics";
    const put = await dav(`/dav/cal/meetings/${name}`, { method: "PUT", auth: M(), body: EVENT("phone-uid-1", "From the phone", "20261112T230000Z", "20261112T233000Z", "RRULE:FREQ=WEEKLY;COUNT=3\r\n"), headers: { "if-none-match": "*" } });
    expect(put.status).toBe(201);
    const list = await (await dav("/dav/cal/meetings/", { auth: M(), depth: "1", body: PROP_ETAG })).text();
    expect(hrefs(list)).toContain(`/dav/cal/meetings/${name}`);
    const body = await (await dav(`/dav/cal/meetings/${name}`, { method: "GET", auth: M() })).text();
    expect(body).toContain("UID:phone-uid-1");
    expect(body).toContain("RRULE:FREQ=WEEKLY");
    expect(body).not.toContain("stranger@x.io");
    expect((await dav(`/dav/cal/meetings/${name}`, { method: "PUT", auth: M(), body: EVENT("phone-uid-1", "Again"), headers: { "if-none-match": "*" } })).status).toBe(412);
    expect((await dav("/dav/cal/meetings/allday.ics", { method: "PUT", auth: M(), body: EVENT("ad", "Holiday", "20261120", "20261121").replace("DTSTART:", "DTSTART;VALUE=DATE:").replace("DTEND:", "DTEND;VALUE=DATE:") })).status).toBe(403);
    expect((await dav("/dav/cal/meetings/bad.ics", { method: "PUT", auth: M(), body: "not ical" })).status).toBe(400);
    expect((await dav("/dav/cal/meetings/../x.ics", { method: "PUT", auth: M(), body: EVENT("z", "z") })).status).toBeGreaterThanOrEqual(400);
    expect((await dav(`/dav/cal/meetings/${name}`, { method: "DELETE", auth: M() })).status).toBe(204);
    expect((await dav(`/dav/cal/meetings/${name}`, { method: "GET", auth: M() })).status).toBe(404);
  });

  it("answers multiget, calendar query and sync-collection with only what changed", async () => {
    const r0 = await (await dav("/dav/cal/meetings/", { method: "REPORT", auth: O(), depth: "1", body: `<d:sync-collection xmlns:d="DAV:"><d:sync-token/><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>` })).text();
    const token = r0.match(/<d:sync-token>([^<]+)<\/d:sync-token>/)![1];
    const all = hrefs(r0);
    expect(all.length).toBeGreaterThanOrEqual(3);
    // Nothing changed: same token, no members.
    const same = await (await dav("/dav/cal/meetings/", { method: "REPORT", auth: O(), body: `<d:sync-collection xmlns:d="DAV:"><d:sync-token>${token}</d:sync-token><d:prop><d:getetag/></d:prop></d:sync-collection>` })).text();
    expect(hrefs(same)).toEqual([]);
    expect(same).toContain(`<d:sync-token>${token}</d:sync-token>`);
    const fresh = (await owner.post("/api/meetings", { title: "New after token", startsAt: "2026-11-09T01:00:00Z" })).body.meeting;
    const gone = all[0].split("/").pop()!.replace(".ics", "");
    await owner.del(`/api/meetings/${gone}`);
    const diff = await (await dav("/dav/cal/meetings/", { method: "REPORT", auth: O(), body: `<d:sync-collection xmlns:d="DAV:"><d:sync-token>${token}</d:sync-token><d:prop><d:getetag/><c:calendar-data xmlns:c="urn:ietf:params:xml:ns:caldav"/></d:prop></d:sync-collection>` })).text();
    expect(hrefs(diff)).toEqual(expect.arrayContaining([`/dav/cal/meetings/${fresh.id}.ics`, all[0]]));
    expect(diff).toContain("SUMMARY:New after token");
    expect(diff).toMatch(new RegExp(`${all[0].replace(/[.]/g, "\\.")}</d:href><d:status>HTTP/1.1 404`));
    const bad = await dav("/dav/cal/meetings/", { method: "REPORT", auth: O(), body: `<d:sync-collection xmlns:d="DAV:"><d:sync-token>https://x/dav/sync/dst_nope</d:sync-token></d:sync-collection>` });
    expect(bad.status).toBe(403);
    expect(await bad.text()).toContain("<d:valid-sync-token/>");
    // Another person's token is not valid for me.
    const mayaTok = (await (await dav("/dav/cal/meetings/", { method: "REPORT", auth: M(), body: `<d:sync-collection xmlns:d="DAV:"><d:sync-token/></d:sync-collection>` })).text()).match(/<d:sync-token>([^<]+)</)![1];
    expect((await dav("/dav/cal/meetings/", { method: "REPORT", auth: O(), body: `<d:sync-collection xmlns:d="DAV:"><d:sync-token>${mayaTok}</d:sync-token></d:sync-collection>` })).status).toBe(403);
    const mg = await (await dav("/dav/cal/meetings/", { method: "REPORT", auth: O(), body: `<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><d:href>/dav/cal/meetings/${fresh.id}.ics</d:href><d:href>/dav/cal/meetings/nope.ics</d:href></c:calendar-multiget>` })).text();
    expect(mg).toContain("New after token");
    expect(mg).toMatch(/nope\.ics<\/d:href><d:status>HTTP\/1\.1 404/);
    const todo = await (await dav("/dav/cal/meetings/", { method: "REPORT", auth: O(), body: `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/></c:comp-filter></c:filter></c:calendar-query>` })).text();
    expect(hrefs(todo)).toEqual([]);
    const ev = await (await dav("/dav/cal/meetings/", { method: "REPORT", auth: O(), body: `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter></c:filter></c:calendar-query>` })).text();
    expect(hrefs(ev).length).toBeGreaterThan(0);
    expect((await dav("/dav/cal/meetings/", { method: "REPORT", auth: O(), body: `<d:expand-property xmlns:d="DAV:"/>` })).status).toBe(403);
  });

  it("serves due dates of my open tasks; a phone may move the day only", async () => {
    const t = (await owner.post("/api/tasks", { title: "Send the quote", due: "2026-11-20", assignee: `member:${ownerId}` })).body.task;
    await owner.post("/api/tasks", { title: "Maya's task", due: "2026-11-21", assignee: `member:${mayaId}` });
    const list = await (await dav("/dav/cal/tasks/", { auth: O(), depth: "1", body: PROP_ETAG })).text();
    expect(hrefs(list)).toContain(`/dav/cal/tasks/${t.id}.ics`);
    expect(list).not.toContain("Maya");
    const g = await dav(`/dav/cal/tasks/${t.id}.ics`, { method: "GET", auth: O() });
    expect(await g.text()).toContain("DTSTART;VALUE=DATE:20261120");
    const moved = EVENT(`task-${t.id}@mymail`, "Due: Changed title", "20261125", "20261126").replace("DTSTART:", "DTSTART;VALUE=DATE:").replace("DTEND:", "DTEND;VALUE=DATE:");
    expect((await dav(`/dav/cal/tasks/${t.id}.ics`, { method: "PUT", auth: O(), body: moved, headers: { "if-match": g.headers.get("etag")! } })).status).toBe(204);
    const row = (await ctx.db.select().from(tasks).where(eq(tasks.id, t.id)).get())!;
    expect(row.title).toBe("Send the quote");
    expect(row.dueAt!.toISOString().slice(0, 10)).toBe("2026-11-25");
    expect((await dav(`/dav/cal/tasks/${t.id}.ics`, { method: "DELETE", auth: O() })).status).toBe(403);
    expect((await dav("/dav/cal/tasks/new.ics", { method: "PUT", auth: O(), body: EVENT("n", "New") })).status).toBe(403);
    expect((await dav("/dav/cal/bookings/x.ics", { method: "PUT", auth: O(), body: EVENT("n", "New") })).status).toBe(403);
  });

  it("serves workspace contacts as vCards and keeps the email Multies owns", async () => {
    const sam = (await owner.post("/api/contacts", { email: "sam@harbour.com.au", name: "Sam Lee", phone: "+61 400 111 222" })).body.contact;
    await other.post("/api/contacts", { email: "secret@other.io", name: "Other Workspace" });
    const list = await (await dav("/dav/card/contacts/", { auth: M(), depth: "1", body: PROP_ETAG })).text();
    expect(hrefs(list)).toContain(`/dav/card/contacts/${sam.id}.vcf`);
    const eveList = await (await dav("/dav/card/contacts/", { auth: auth("eve@other.io", (await other.post("/api/dav/passwords", { name: "x" })).body.password ?? ""), depth: "1" })).text();
    expect(eveList).not.toContain(sam.id);
    const g = await dav(`/dav/card/contacts/${sam.id}.vcf`, { method: "GET", auth: M() });
    expect(g.headers.get("content-type")).toContain("text/vcard");
    expect(await g.text()).toContain("FN:Sam Lee");
    const edit = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:" + sam.id + "\r\nFN:Samuel Lee\r\nEMAIL:changed@evil.io\r\nTEL:+61 499 999 999\r\nTITLE:Director\r\nEND:VCARD\r\n";
    const put = await ctx.app.request(`/dav/card/contacts/${sam.id}.vcf`, { method: "PUT", headers: { host: "localhost", authorization: M(), "content-type": "text/vcard", "if-match": g.headers.get("etag")! }, body: edit });
    expect(put.status).toBe(204);
    const row = (await ctx.db.select().from(contacts).where(eq(contacts.id, sam.id)).get())!;
    expect(row).toMatchObject({ name: "Samuel Lee", email: "sam@harbour.com.au", phone: "+61 499 999 999", title: "Director" });
    const newCard = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:phone-card-1\r\nN:Ng;Ava;;;\r\nEMAIL;TYPE=INTERNET:ava@ng.io\r\nEND:VCARD\r\n";
    const made = await ctx.app.request("/dav/card/contacts/phone-card-1.vcf", { method: "PUT", headers: { host: "localhost", authorization: M(), "content-type": "text/vcard; charset=utf-8" }, body: newCard });
    expect(made.status).toBe(201);
    const back = await (await dav("/dav/card/contacts/phone-card-1.vcf", { method: "GET", auth: O() })).text();
    expect(back).toContain("UID:phone-card-1");
    expect(back).toContain("FN:Ava Ng");
    const noEmail = await ctx.app.request("/dav/card/contacts/x.vcf", { method: "PUT", headers: { host: "localhost", authorization: M(), "content-type": "text/vcard" }, body: "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:No Mail\r\nEND:VCARD\r\n" });
    expect(noEmail.status).toBe(403);
    expect((await ctx.app.request("/dav/card/contacts/x.vcf", { method: "PUT", headers: { host: "localhost", authorization: M(), "content-type": "text/calendar" }, body: "x" })).status).toBe(415);
    expect((await dav("/dav/card/contacts/phone-card-1.vcf", { method: "DELETE", auth: M() })).status).toBe(204);
    expect((await dav("/dav/card/contacts/phone-card-1.vcf", { method: "GET", auth: M() })).status).toBe(404);
    expect((await dav("/dav/card/contacts/", { method: "MKCOL", auth: M() })).status).toBe(403);
    const pp = await dav("/dav/card/contacts/", { method: "PROPPATCH", auth: M(), body: `<d:propertyupdate xmlns:d="DAV:"><d:set><d:prop><d:displayname>Mine</d:displayname></d:prop></d:set></d:propertyupdate>` });
    expect(pp.status).toBe(207);
    expect(await pp.text()).toContain("403 Forbidden");
  });

  it("stops at once when the password is revoked or the person leaves; records audit events", async () => {
    const r = await maya.post("/api/dav/passwords", { name: "Tablet" });
    const pw = r.body.password as string;
    expect((await dav("/dav/", { auth: auth("maya@acme.io", pw), depth: "0" })).status).toBe(207);
    expect((await maya.get("/api/dav/passwords")).body.passwords.find((p: { name: string }) => p.name === "Tablet").lastUsedAt).not.toBeNull();
    expect((await maya.del(`/api/dav/passwords/${r.body.item.id}`)).status).toBe(200);
    expect((await dav("/dav/", { auth: auth("maya@acme.io", pw), depth: "0" })).status).toBe(401);
    const actions = (await ctx.db.select({ a: auditLogs.action }).from(auditLogs)).map((r) => r.a);
    expect(actions).toEqual(expect.arrayContaining(["dav.app_password.created", "dav.app_password.revoked"]));
    expect((await dav("/dav/", { auth: M(), depth: "0" })).status).toBe(207);
    await ctx.db.delete(members).where(eq(members.userId, mayaId));
    expect((await dav("/dav/", { auth: M(), depth: "0" })).status).toBe(401);
  });

  it("downloads the iPhone and Mac profile for a signed in person", async () => {
    const res = await owner.get("/api/dav/profile.mobileconfig");
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain("owner@acme.io");
    expect((await ctx.app.request("/api/dav/profile.mobileconfig", { headers: { host: "localhost" } })).status).toBe(401);
  });
});
