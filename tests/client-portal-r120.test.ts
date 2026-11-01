/**
 * R120: client portals. Team API (create, people, sharing, roles), the public space at /p/<key> with one time
 * email link sign in, and the scoped client session: a session for one portal never opens another portal, an item
 * of another portal, or anything after the person is removed or the portal archived.
 */
import { describe, it, expect, vi } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { MemoryToolFileStore } from "@/server/services/tools/p2-bindings";
import { PORTAL_COPY_LINKS_PER_HOUR, PORTAL_LINKS_PER_HOUR, cleanFolder, emailOk, portalInviteThrottledNote, taskStateLabel } from "@/shared/client-portal";
import { keyShapeOk, linkShapeOk } from "@/server/services/portal/client-portal";

const ON = { CLIENT_PORTAL: "on", APP_URL: "http://localhost" };
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

async function setup(env: Record<string, string> = ON) {
  const ctx = await makeTestApp(env);
  let clock = Date.parse("2026-11-01T02:00:00Z");
  ctx.deps.now = () => new Date(clock);
  ctx.deps.toolFiles = new MemoryToolFileStore(() => clock);
  const c = new Client(ctx.app);
  await c.signup("ada@acme.io", "Ada Lovelace", "Acme");
  return { ...ctx, c, advance: (ms: number) => { clock += ms; } };
}
type T = Awaited<ReturnType<typeof setup>>;

/** A browser for the client: keeps its own cookies (only the portal cookie is ever set). */
class Visitor {
  jar = new Map<string, { value: string; path: string }>();
  constructor(private t: T, private ip = "10.9.9.9") {}
  private cookieFor(path: string) { return [...this.jar].filter(([, v]) => path.startsWith(v.path)).map(([k, v]) => `${k}=${v.value}`).join("; "); }
  private keep(res: Response) {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = raw.split(";");
      const [k, v] = pair.split("=");
      const path = attrs.map((a) => a.trim()).find((a) => a.toLowerCase().startsWith("path="))?.slice(5) ?? "/";
      if (!v || /max-age=0/i.test(raw)) this.jar.delete(k.trim()); else this.jar.set(k.trim(), { value: v, path });
    }
  }
  async get(path: string) {
    const res = await this.t.app.request(path, { headers: { host: "localhost", "user-agent": UA, "x-forwarded-for": this.ip, cookie: this.cookieFor(path) } });
    this.keep(res);
    const body = res.headers.get("content-type")?.includes("text/html") ? await res.text() : "";
    return { status: res.status, html: body, res, ft: body.match(/name="ft" value="([a-f0-9]+)"/)?.[1] ?? "" };
  }
  async post(path: string, form: Record<string, string>, headers: Record<string, string> = {}) {
    const res = await this.t.app.request(path, {
      method: "POST", body: new URLSearchParams(form).toString(),
      headers: { host: "localhost", origin: "http://localhost", "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded", "user-agent": UA, "x-forwarded-for": this.ip, cookie: this.cookieFor(path), ...headers },
    });
    this.keep(res);
    return { status: res.status, location: res.headers.get("location"), html: res.headers.get("content-type")?.includes("text/html") ? await res.text() : "" };
  }
}

const pathOf = (url: string) => new URL(url).pathname;

/** A team upload: raw bytes with the upload header, on the signed in team member's session. */
async function upload(t: T, portalId: string, bytes: Uint8Array, headers: Record<string, string>) {
  const res = await t.app.request(`/api/portals/${portalId}/files`, {
    method: "POST", body: bytes as Uint8Array<ArrayBuffer>,
    headers: { host: "localhost", cookie: (t.c as unknown as { cookie: string }).cookie, "x-multies-upload": "1", "content-length": String(bytes.byteLength), ...headers },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as { id: string } };
}

async function contact(t: T, email = "sam@client.co", name = "Sam Client") {
  const r = await t.c.post("/api/contacts", { email, name });
  expect(r.status).toBeLessThan(300);
  return r.body.contact.id as string;
}
async function portal(t: T, email?: string, name?: string) {
  const r = await t.c.post("/api/portals", { contactId: await contact(t, email, name) });
  expect(r.status).toBe(201);
  const d = await t.c.get(`/api/portals/${r.body.portal.id}`);
  return { id: r.body.portal.id as string, url: r.body.portal.url as string, key: pathOf(r.body.portal.url).split("/")[2], person: d.body.people[0].id as string };
}
/** Team copies a one time link; the client opens it and presses Continue. */
async function signIn(t: T, v: Visitor, p: { id: string; person: string }) {
  const l = await t.c.post(`/api/portals/${p.id}/people/${p.person}/link`);
  expect(l.status).toBe(200);
  const path = pathOf(l.body.url);
  const page = await v.get(path);
  expect(page.status).toBe(200);
  const r = await v.post(path, { ft: page.ft });
  return { r, path };
}

describe("R120 client portal helpers", () => {
  it("cleans folders, checks emails and labels task states", () => {
    expect(cleanFolder("  Tax / 2026  ")).toBe("Tax 2026");
    expect(cleanFolder("   ")).toBeNull();
    expect(cleanFolder("x".repeat(90))!.length).toBe(60);
    expect(emailOk("sam@client.co")).toBe(true);
    expect(emailOk("sam@client")).toBe(false);
    expect(emailOk("a b@c.co")).toBe(false);
    expect(taskStateLabel("doing")).toBe("In progress");
    expect(taskStateLabel(null)).toBe("To do");
    expect(keyShapeOk("a".repeat(22))).toBe(true);
    expect(keyShapeOk("a".repeat(22) + "/")).toBe(false);
    expect(linkShapeOk("b".repeat(43))).toBe(true);
    expect(linkShapeOk("b".repeat(42))).toBe(false);
  });
});

describe("R120 client portal", () => {
  it("answers 404 everywhere while the flag is off", async () => {
    const t = await setup({ APP_URL: "http://localhost" });
    expect((await t.c.get("/api/portals")).status).toBe(404);
    expect((await new Visitor(t).get(`/p/${"a".repeat(22)}`)).status).toBe(404);
  });

  it("makes one portal per contact, with the contact on its list", async () => {
    const t = await setup();
    const id = await contact(t);
    const a = await t.c.post("/api/portals", { contactId: id });
    expect(a.status).toBe(201);
    expect(a.body.portal.name).toBe("Sam Client");
    const again = await t.c.post("/api/portals", { contactId: id });
    expect(again.status).toBe(200);
    expect(again.body.existing).toBe(true);
    expect(again.body.portal.id).toBe(a.body.portal.id);
    const d = await t.c.get(`/api/portals/${a.body.portal.id}`);
    expect(d.body.people.map((p: { email: string }) => p.email)).toEqual(["sam@client.co"]);
    expect(d.body.canManage).toBe(true);
    expect((await t.c.post("/api/portals", {})).status).toBe(400);
    expect((await t.c.post("/api/portals", { contactId: "nope" })).status).toBe(404);
    const list = await t.c.get(`/api/portals?contactId=${id}`);
    expect(list.body.portals).toHaveLength(1);
  });

  it("makes a company portal with its people", async () => {
    const t = await setup();
    await contact(t, "lee@bigco.com", "Lee");
    await contact(t, "kim@bigco.com", "Kim");
    const co = await t.db.get<{ id: string }>(sql`select id from companies where domain = 'bigco.com'`);
    expect(co).toBeTruthy();
    const r = await t.c.post("/api/portals", { companyId: co!.id });
    expect(r.status).toBe(201);
    expect(r.body.portal.company.id).toBe(co!.id);
    expect(r.body.portal.people).toBe(2);
  });

  it("signs a client in with a one time link and shows their space", async () => {
    const t = await setup();
    const p = await portal(t);
    const v = new Visitor(t);
    const first = await v.get(`/p/${p.key}`);
    expect(first.status).toBe(200);
    expect(first.html).toContain("Email me a sign in link");
    expect(first.html).not.toContain("portal-space");
    const { r, path } = await signIn(t, v, p);
    expect(r.status).toBe(303);
    const cookie = [...v.jar.entries()][0];
    expect(cookie[0]).toBe("mp_portal");
    expect(cookie[1].path).toBe(`/p/${p.key}`);
    const space = await v.get(`/p/${p.key}`);
    expect(space.html).toContain('data-testid="portal-space"');
    expect(space.html).toContain("Signed in as sam@client.co");
    // The link works once.
    const again = await new Visitor(t, "10.9.9.10").post(path, { ft: (await new Visitor(t, "10.9.9.10").get(path)).ft });
    expect(again.status).toBe(410);
    // The app itself never opens with the portal cookie.
    const app = await t.app.request("/api/portals", { headers: { host: "localhost", cookie: `mp_portal=${cookie[1].value}` } });
    expect(app.status).toBe(401);
  });

  it("never says whether an email is on the list, and mails only listed people", async () => {
    const t = await setup();
    const p = await portal(t);
    const v = new Visitor(t);
    const page = await v.get(`/p/${p.key}`);
    const known = await v.post(`/p/${p.key}/login`, { ft: page.ft, email: "sam@client.co" });
    const unknown = await v.post(`/p/${p.key}/login`, { ft: page.ft, email: "who@else.co" });
    expect(known.status).toBe(303);
    expect(unknown.status).toBe(303);
    expect(known.location).toBe(unknown.location);
    const links = await t.db.all<{ person_id: string }>(sql`select person_id from client_portal_links`);
    expect(links).toHaveLength(1);
    expect(links[0].person_id).toBe(p.person);
    // A post without the page's form token is refused.
    expect((await v.post(`/p/${p.key}/login`, { email: "sam@client.co" })).status).toBe(403);
    // Another site cannot post.
    expect((await v.post(`/p/${p.key}/login`, { ft: page.ft, email: "sam@client.co" }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" })).status).toBe(403);
  });

  it("expires links after 15 minutes and caps links per person", async () => {
    const t = await setup();
    const p = await portal(t);
    const l = await t.c.post(`/api/portals/${p.id}/people/${p.person}/link`);
    t.advance(16 * 60_000);
    const v = new Visitor(t);
    const path = pathOf(l.body.url);
    expect((await v.post(path, { ft: (await v.get(path)).ft })).status).toBe(410);
    // R100b: Copy link has its own cap (20 an hour) and does not use up the email cap.
    for (let i = 0; i < PORTAL_COPY_LINKS_PER_HOUR - 1; i++) expect((await t.c.post(`/api/portals/${p.id}/people/${p.person}/link`)).status).toBe(200);
    expect((await t.c.post(`/api/portals/${p.id}/people/${p.person}/link`)).status).toBe(429);
  });

  it("R100b: Copy link does not count toward the email cap; a held back invite says so; the public form stays neutral", async () => {
    const t = await setup();
    const p = await portal(t);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (let i = 0; i < 6; i++) expect((await t.c.post(`/api/portals/${p.id}/people/${p.person}/link`)).status).toBe(200);
      for (let i = 0; i < PORTAL_LINKS_PER_HOUR; i++) {
        const r = await t.c.post(`/api/portals/${p.id}/people/${p.person}/invite`);
        expect(r.status).toBe(200);
        expect(r.body.throttled).toBe(false);
      }
      const held = await t.c.post(`/api/portals/${p.id}/people/${p.person}/invite`);
      expect(held.status).toBe(200);
      expect(held.body).toMatchObject({ sent: false, throttled: true });
      const before = Number((await t.db.all<{ n: number }>(sql`select count(*) as n from client_portal_links`))[0]!.n);
      // The client's own request at the cap: same neutral answer, nothing minted, a throttle line logged.
      const v = new Visitor(t);
      const page = await v.get(`/p/${p.key}`);
      const r = await v.post(`/p/${p.key}/login`, { ft: page.ft, email: "sam@client.co" });
      expect(r.status).toBe(303);
      expect(Number((await t.db.all<{ n: number }>(sql`select count(*) as n from client_portal_links`))[0]!.n)).toBe(before);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("portal.link_throttled"))).toBe(true);
      // An hour later the email cap is free again.
      t.advance(61 * 60_000);
      expect((await t.c.post(`/api/portals/${p.id}/people/${p.person}/invite`)).body.throttled).toBe(false);
      expect(portalInviteThrottledNote("sam@client.co")).toBe(`Not sent. sam@client.co already got ${PORTAL_LINKS_PER_HOUR} sign in emails in the last hour. Use Copy link, or try again later.`);
      expect(portalInviteThrottledNote("x@y.co")).not.toMatch(/[\u2013\u2014]/);
    } finally { warn.mockRestore(); }
  });

  it("keeps a client inside their own portal", async () => {
    const t = await setup();
    const a = await portal(t, "sam@client.co", "Sam");
    const b = await portal(t, "rio@other.co", "Rio");
    const file = await upload(t, b.id, new TextEncoder().encode("secret plan"), { "content-type": "text/plain", "x-multies-upload": "1", "x-file-name": "plan.txt" });
    expect(file.status).toBe(201);
    const v = new Visitor(t);
    await signIn(t, v, a);
    // Portal A's cookie on portal B: the sign in page, no data.
    const other = await t.app.request(`/p/${b.key}`, { headers: { host: "localhost", cookie: `mp_portal=${[...v.jar.values()][0].value}` } });
    const html = await other.text();
    expect(html).toContain("Email me a sign in link");
    expect(html).not.toContain("plan.txt");
    // Portal B's file id through portal A's path: not found.
    expect((await v.get(`/p/${a.key}/f/${file.body.id}`)).status).toBe(404);
    // Without a session the file is not served.
    const anon = await new Visitor(t, "10.1.1.1").get(`/p/${b.key}/f/${file.body.id}`);
    expect(anon.status).toBe(303);
    // A link for portal B's person cannot be used on portal A.
    const lb = await t.c.post(`/api/portals/${b.id}/people/${b.person}/link`);
    const token = lb.body.url.split("/in/")[1];
    const w = new Visitor(t, "10.2.2.2");
    const pg = await w.get(`/p/${a.key}/in/${token}`);
    expect((await w.post(`/p/${a.key}/in/${token}`, { ft: pg.ft })).status).toBe(410);
  });

  it("shares files, docs, tasks and shows them to the client", async () => {
    const t = await setup();
    const p = await portal(t);
    const up = await upload(t, p.id, new TextEncoder().encode("hello client"), { "content-type": "text/plain", "x-multies-upload": "1", "x-file-name": encodeURIComponent("Brief v2.txt"), "x-folder": "Contracts" });
    expect(up.status).toBe(201);
    const task = await t.c.post("/api/tasks", { title: "Draft the logo", due: "2026-11-20" });
    expect(task.status).toBeLessThan(300);
    const taskId = (task.body.task ?? task.body).id as string;
    expect((await t.c.post(`/api/portals/${p.id}/items`, { kind: "task", refId: taskId })).status).toBe(201);
    expect((await t.c.post(`/api/portals/${p.id}/items`, { kind: "task", refId: taskId })).status).toBe(400);
    const docId = "doc_r120test";
    const content = JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Welcome aboard" }] }] });
    const org = await t.db.get<{ org_id: string }>(sql`select org_id from client_portals where id = ${p.id}`);
    await t.db.run(sql`insert into docs (id, org_id, title, content, created_at, updated_at) values (${docId}, ${org!.org_id}, ${"Onboarding"}, ${content}, ${Date.now()}, ${Date.now()})`);
    expect((await t.c.post(`/api/portals/${p.id}/items`, { kind: "doc", refId: docId })).status).toBe(201);
    expect((await t.c.post(`/api/portals/${p.id}/items`, { kind: "doc", refId: "doc_other" })).status).toBe(404);
    const d = await t.c.get(`/api/portals/${p.id}`);
    expect(d.body.items.map((i: { kind: string }) => i.kind).sort()).toEqual(["doc", "file", "task"]);
    expect(d.body.items.find((i: { kind: string }) => i.kind === "file").folder).toBe("Contracts");

    const v = new Visitor(t);
    await signIn(t, v, p);
    const files = await v.get(`/p/${p.key}?tab=files`);
    expect(files.html).toContain("Contracts");
    expect(files.html).toContain("Brief v2.txt");
    const fid = d.body.items.find((i: { kind: string }) => i.kind === "file").id;
    const dl = await v.get(`/p/${p.key}/f/${fid}`);
    expect(dl.status).toBe(200);
    expect(await dl.res.text()).toBe("hello client");
    expect(dl.res.headers.get("content-disposition")).toContain("attachment");
    const tasks = await v.get(`/p/${p.key}?tab=tasks`);
    expect(tasks.html).toContain("Draft the logo");
    expect(tasks.html).toContain("To do");
    await t.db.run(sql`update tasks set status = 'done' where id = ${taskId}`);
    expect((await v.get(`/p/${p.key}?tab=tasks`)).html).toContain("Done");
    const did = d.body.items.find((i: { kind: string }) => i.kind === "doc").id;
    const doc = await v.get(`/p/${p.key}/d/${did}`);
    expect(doc.html).toContain("Welcome aboard");
    // Removing a file stops it at once.
    expect((await t.c.del(`/api/portals/${p.id}/items/${fid}`)).status).toBe(200);
    expect((await v.get(`/p/${p.key}/f/${fid}`)).status).toBe(404);
  });

  it("refuses an empty file and a file over 25 MB", async () => {
    const t = await setup();
    const p = await portal(t);
    expect((await upload(t, p.id, new Uint8Array(0), { "content-type": "text/plain", "x-multies-upload": "1", "x-file-name": "a.txt" })).status).toBe(400);
    expect((await upload(t, p.id, new Uint8Array(25 * 1024 * 1024 + 2048), { "content-type": "text/plain", "x-multies-upload": "1", "x-file-name": "big.bin" })).status).toBe(413);
  });

  it("carries messages both ways and tells the team", async () => {
    const t = await setup();
    const p = await portal(t);
    const v = new Visitor(t);
    await signIn(t, v, p);
    const page = await v.get(`/p/${p.key}?tab=messages`);
    expect(page.html).toContain("No messages yet");
    const sent = await v.post(`/p/${p.key}/messages`, { ft: page.ft, body: "Can we move the call to Friday?" });
    expect(sent.status).toBe(303);
    const list = await t.c.get("/api/portals");
    expect(list.body.portals[0].unread).toBe(true);
    const n = await t.db.get<{ n: number }>(sql`select count(*) as n from notifications where type = 'portal.message'`);
    expect(Number(n!.n)).toBe(1);
    const d = await t.c.get(`/api/portals/${p.id}`);
    expect(d.body.messages[0]).toMatchObject({ fromClient: true, body: "Can we move the call to Friday?" });
    expect((await t.c.get("/api/portals")).body.portals[0].unread).toBe(false);
    expect((await t.c.post(`/api/portals/${p.id}/messages`, { body: "Friday works." })).status).toBe(201);
    expect((await t.c.post(`/api/portals/${p.id}/messages`, { body: "   " })).status).toBe(400);
    const thread = await v.get(`/p/${p.key}?tab=messages`);
    expect(thread.html).toContain("Friday works.");
    expect(thread.html).toContain("You ·");
    // Escaped, never markup.
    await v.post(`/p/${p.key}/messages`, { ft: thread.ft, body: "<script>alert(1)</script>" });
    const esc = await v.get(`/p/${p.key}?tab=messages`);
    expect(esc.html).not.toContain("<script>alert(1)</script>");
    expect(esc.html).toContain("&lt;script&gt;");
  });

  it("signs a removed person out and ends every session when the portal is archived", async () => {
    const t = await setup();
    const p = await portal(t);
    const added = await t.c.post(`/api/portals/${p.id}/people`, { email: "Pat@Client.co", name: "Pat" });
    expect(added.status).toBe(201);
    expect(added.body.person.email).toBe("pat@client.co");
    expect((await t.c.post(`/api/portals/${p.id}/people`, { email: "pat@client.co" })).status).toBe(400);
    expect((await t.c.post(`/api/portals/${p.id}/people`, { email: "not an email" })).status).toBe(400);
    const v = new Visitor(t);
    await signIn(t, v, p);
    const w = new Visitor(t, "10.3.3.3");
    await signIn(t, w, { id: p.id, person: added.body.person.id });
    expect((await w.get(`/p/${p.key}`)).html).toContain("portal-space");
    expect((await t.c.del(`/api/portals/${p.id}/people/${added.body.person.id}`)).status).toBe(200);
    expect((await w.get(`/p/${p.key}`)).html).not.toContain("portal-space");
    expect((await v.get(`/p/${p.key}`)).html).toContain("portal-space");
    expect((await t.c.patch(`/api/portals/${p.id}`, { archived: true })).status).toBe(200);
    expect((await v.get(`/p/${p.key}`)).status).toBe(404);
    expect((await t.c.patch(`/api/portals/${p.id}`, { archived: false })).status).toBe(200);
    expect((await v.get(`/p/${p.key}`)).html).not.toContain("portal-space");
  });

  it("lets members read and reply, and change only their own portals", async () => {
    const t = await setup();
    const p = await portal(t);
    const invite = await t.c.post("/api/team/invites", { email: "mate@acme.io", role: "member" });
    const mate = new Client(t.app);
    await mate.signup("mate@acme.io", "Mate", "");
    expect((await mate.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
    const seen = await mate.get(`/api/portals/${p.id}`);
    if (seen.status !== 200) {
      const orgId = (await t.db.get<{ org_id: string }>(sql`select org_id from client_portals where id = ${p.id}`))!.org_id;
      await mate.post("/api/account/switch", { orgId });
    }
    const d = await mate.get(`/api/portals/${p.id}`);
    expect(d.status).toBe(200);
    expect(d.body.canManage).toBe(false);
    expect((await mate.post(`/api/portals/${p.id}/messages`, { body: "Hi from the team" })).status).toBe(201);
    expect((await mate.patch(`/api/portals/${p.id}`, { name: "Renamed" })).status).toBe(403);
    expect((await mate.post(`/api/portals/${p.id}/people/${p.person}/link`)).status).toBe(403);
    expect((await mate.post(`/api/portals/${p.id}/people`, { email: "x@y.co" })).status).toBe(403);
    const cid = (await mate.post("/api/contacts", { email: "own@client.co", name: "Own" })).body.contact.id;
    const own = await mate.post("/api/portals", { contactId: cid });
    expect(own.status).toBe(201);
    expect((await mate.patch(`/api/portals/${own.body.portal.id}`, { name: "Own space" })).status).toBe(200);
    // The admin manages every portal.
    expect((await t.c.patch(`/api/portals/${own.body.portal.id}`, { welcome: "Hello" })).status).toBe(200);
  });

  it("shows a file request from the portal and closes it when removed", async () => {
    const t = await setup({ ...ON, TOOLS_ENABLED: "true", DOC_ENGINE_URL: "https://engine.test", DOC_ENGINE_KEY_ID: "stg-1", DOC_ENGINE_KEY: "k".repeat(40), TOOLS_TOKEN_KEY: "t".repeat(40), TOOLS_FEATURES: "file_requests" });
    const p = await portal(t);
    const r = await t.c.post(`/api/portals/${p.id}/requests`, { title: "Signed contract", message: "Please upload the signed copy." });
    expect(r.status).toBe(201);
    const v = new Visitor(t);
    await signIn(t, v, p);
    const files = await v.get(`/p/${p.key}?tab=files`);
    expect(files.html).toContain("Signed contract");
    const href = files.html.match(/href="(http:\/\/localhost\/u\/[A-Za-z0-9_-]+)"/)?.[1];
    expect(href).toBeTruthy();
    expect((await v.get(pathOf(href!))).status).toBe(200);
    expect((await t.c.del(`/api/portals/${p.id}/items/${r.body.id}`)).status).toBe(200);
    expect((await v.get(`/p/${p.key}?tab=files`)).html).not.toContain("Signed contract");
    expect((await v.get(pathOf(href!))).status).not.toBe(200);
  });

  it("refuses a file request when Tools is off for the deployment", async () => {
    const t = await setup();
    const p = await portal(t);
    expect((await t.c.post(`/api/portals/${p.id}/requests`, { title: "Docs" })).status).toBe(400);
    expect((await t.c.get(`/api/portals/${p.id}`)).body.requestsOn).toBe(false);
  });
});

// R120 (staging finding): on Cloudflare the Worker must both run first for /p/* (wrangler run_worker_first) and hand
// /p/* to the app (src/entry/worker.ts), or the public portal answers the static 404 page.
describe("R120 /p/* reaches the app on Cloudflare", () => {
  it("is in run_worker_first and handed to the app by the worker entry", async () => {
    const { readFileSync } = await import("node:fs");
    const toml = readFileSync("wrangler.toml", "utf8");
    const rwf = toml.split("\n").find((l) => l.startsWith("run_worker_first")) ?? "";
    expect(rwf).toContain('"/p/*"');
    const entry = readFileSync("src/entry/worker.ts", "utf8");
    expect(entry).toContain('url.pathname.startsWith("/p/")');
  });
});
