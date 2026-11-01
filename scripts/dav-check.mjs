#!/usr/bin/env node
/**
 * R99: a scripted CalDAV and CardDAV client check the verifier can rerun against staging or prod.
 *   DAV_USER=<email> DAV_PASSWORD=<app password> node scripts/dav-check.mjs https://preview.multies.si
 * Discovery, three calendars and the address book, a sync token, create, read, a stale ETag (412), sync shows
 * the change, delete, sync shows the removal. It makes one test meeting and deletes it. Prints no secrets.
 */
const base = (process.argv[2] ?? "").replace(/\/$/, "");
const user = process.env.DAV_USER, pass = process.env.DAV_PASSWORD;
if (!base || !user || !pass) { console.error("usage: DAV_USER=... DAV_PASSWORD=... node scripts/dav-check.mjs <base url>"); process.exit(2); }
const auth = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
let failed = 0;
const ok = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` (${extra})` : ""}`); if (!cond) failed++; };
const req = (path, method, { body, depth, headers = {} } = {}) => fetch(`${base}${path}`, { method, redirect: "manual", headers: { authorization: auth, ...(depth ? { depth } : {}), ...(body ? { "content-type": method === "PUT" ? "text/calendar; charset=utf-8" : "application/xml; charset=utf-8" } : {}), ...headers }, body });
const hrefs = (xml) => [...xml.matchAll(/<d:response><d:href>([^<]*)<\/d:href>/g)].map((m) => m[1]);
const token = (xml) => xml.match(/<d:sync-token>([^<]+)<\/d:sync-token>/)?.[1] ?? "";
const sync = (t) => `<d:sync-collection xmlns:d="DAV:"><d:sync-token>${t}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`;

const wk = await fetch(`${base}/.well-known/caldav`, { redirect: "manual" });
ok("well known caldav redirects to /dav/", wk.status === 301 && wk.headers.get("location") === "/dav/", String(wk.status));
const anon = await fetch(`${base}/dav/`, { method: "PROPFIND" });
ok("no password answers 401 with Basic", anon.status === 401 && /Basic/.test(anon.headers.get("www-authenticate") ?? ""), String(anon.status));
const pr = await req("/dav/principal/", "PROPFIND", { depth: "0", body: `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><d:current-user-principal/><c:calendar-home-set/><card:addressbook-home-set/></d:prop></d:propfind>` });
const prx = await pr.text();
ok("principal names both homes", pr.status === 207 && prx.includes("/dav/cal/") && prx.includes("/dav/card/"), String(pr.status));
const cal = await (await req("/dav/cal/", "PROPFIND", { depth: "1" })).text();
ok("three calendars", ["/dav/cal/meetings/", "/dav/cal/tasks/", "/dav/cal/bookings/"].every((h) => hrefs(cal).includes(h)));
const card = await req("/dav/card/contacts/", "PROPFIND", { depth: "1", body: `<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>` });
ok("address book lists contacts", card.status === 207, `${hrefs(await card.text()).length - 1} contacts`);
const t0 = token(await (await req("/dav/cal/meetings/", "REPORT", { body: sync("") })).text());
ok("initial sync token", !!t0);
const name = `dav-check-${Date.now()}.ics`;
const at = new Date(Date.now() + 7 * 86_400_000); at.setUTCHours(1, 0, 0, 0);
const ics = (d, title) => { const f = (x) => x.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z"; return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Multies//dav-check//EN\r\nBEGIN:VEVENT\r\nUID:${name}\r\nDTSTAMP:${f(new Date())}\r\nDTSTART:${f(d)}\r\nDTEND:${f(new Date(d.getTime() + 30 * 60_000))}\r\nSUMMARY:${title}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`; };
const put = await req(`/dav/cal/meetings/${name}`, "PUT", { body: ics(at, "Sync check"), headers: { "if-none-match": "*" } });
ok("create a meeting (PUT)", put.status === 201, String(put.status));
const get = await req(`/dav/cal/meetings/${name}`, "GET");
const etag = get.headers.get("etag");
ok("read it back with an ETag and the same UID", get.status === 200 && !!etag && (await get.text()).includes(`UID:${name}`));
const stale = await req(`/dav/cal/meetings/${name}`, "PUT", { body: ics(at, "Stale"), headers: { "if-match": '"stale"' } });
ok("stale ETag answers 412", stale.status === 412, String(stale.status));
const s1 = await (await req("/dav/cal/meetings/", "REPORT", { body: sync(t0) })).text();
ok("sync shows the new meeting", hrefs(s1).some((h) => h.endsWith(name)));
const del = await req(`/dav/cal/meetings/${name}`, "DELETE", { headers: { "if-match": etag ?? "*" } });
ok("delete it", del.status === 204, String(del.status));
const s2 = await (await req("/dav/cal/meetings/", "REPORT", { body: sync(token(s1)) })).text();
ok("sync shows the removal as 404", new RegExp(`${name.replace(/\./g, "\\.")}</d:href><d:status>HTTP/1.1 404`).test(s2));
console.log(failed ? `DAV CHECK FAILED: ${failed}` : "DAV CHECK PASS");
process.exit(failed ? 1 : 0);
