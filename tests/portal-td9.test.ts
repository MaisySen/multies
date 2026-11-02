/**
 * TD9 (PORTAL_TD9): client portal access per area (None, View, Comment) with audit, the live project view,
 * and private comments to one person (author, target and admins only; nobody else gets the row or a count).
 * Client reads stay inside their own portal and the workspace; other workspaces get 404; sign in links expire.
 */
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { MemoryToolFileStore } from "@/server/services/tools/p2-bindings";
import { DEFAULT_LEVELS, areaOf, privateLabel } from "@/shared/portal-td9";
import { LIVE_JS } from "@/server/routes/portal-td9-pages";

const ON = { CLIENT_PORTAL: "on", PORTAL_TD9: "on", APP_URL: "http://localhost" };
const R120 = { CLIENT_PORTAL: "on", APP_URL: "http://localhost" };
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


/** A teammate in Ada's workspace (seat limits in tests are skipped by adding the member row directly). */
async function member(t: T, email: string, name: string, role: "member" | "admin" = "member") {
  const m = new Client(t.app);
  await m.signup(email, name, "");
  const uid = (await t.db.get<{ id: string }>(sql`select id from users where email = ${email}`))!.id;
  const orgId = (await t.db.get<{ organization_id: string }>(sql`select m.organization_id from members m join users u on u.id = m.user_id where u.email = 'ada@acme.io'`))!.organization_id;
  await t.db.run(sql`insert into members (id, organization_id, user_id, role, kind, created_at) values (${`mem_${uid}`}, ${orgId}, ${uid}, ${role}, 'human', ${Date.now()})`);
  expect((await m.post(`/api/account/workspaces/${orgId}/switch`)).status).toBeLessThan(300);
  const me = await t.db.get<{ id: string }>(sql`select id from users where email = ${email}`);
  return { c: m, id: me!.id };
}
async function orgOf(t: T, portalId: string) { return (await t.db.get<{ org_id: string }>(sql`select org_id from client_portals where id = ${portalId}`))!.org_id; }
async function task(t: T, title: string) {
  const r = await t.c.post("/api/tasks", { title });
  expect(r.status).toBeLessThan(300);
  const id = (r.body.task ?? r.body).id as string;
  const pid = (await t.db.get<{ project_id: string }>(sql`select project_id from tasks where id = ${id}`))!.project_id;
  return { id, projectId: pid };
}
const share = async (t: T, portalId: string, kind: string, refId: string) => {
  const r = await t.c.post(`/api/portals/${portalId}/items`, { kind, refId });
  expect(r.status).toBe(201);
  return r.body.id as string;
};
const setLevel = (t: T, p: { id: string; person: string }, area: string, level: string) => t.c.put(`/api/portals/${p.id}/people/${p.person}/access`, { area, level });

describe("TD9 helpers", () => {
  it("maps kinds to areas, keeps old areas visible by default and words the private line", () => {
    expect(areaOf("request")).toBe("files");
    expect(areaOf("project")).toBe("projects");
    expect(DEFAULT_LEVELS).toEqual({ projects: "none", tasks: "view", files: "view", docs: "view", invoices: "none", forms: "none" });
    expect(privateLabel({ meIsAuthor: true, meIsTarget: false, authorName: "Ada", targetName: "Sam" })).toBe("Only you and Sam");
    expect(privateLabel({ meIsAuthor: false, meIsTarget: true, authorName: "Ada", targetName: "Sam" })).toBe("Only you and Ada");
    expect(privateLabel({ meIsAuthor: false, meIsTarget: false, authorName: "Ada", targetName: "Sam" })).toBe("Private: Ada to Sam");
    expect(LIVE_JS).not.toMatch(/innerHTML|eval\(|new Function/);
  });
});

describe("TD9 portal access", () => {
  it("answers 404 on every new path and keeps R120 exactly while the flag is off", async () => {
    const t = await setup(R120);
    const p = await portal(t);
    const tk = await task(t, "Logo");
    expect((await t.c.get(`/api/portals/${p.id}/people/${p.person}/access`)).status).toBe(404);
    expect((await setLevel(t, p, "files", "none")).status).toBe(404);
    expect((await t.c.get(`/api/portals/${p.id}/pick?kind=project`)).status).toBe(404);
    expect((await t.c.get(`/api/item-comments/task/${tk.id}`)).status).toBe(404);
    expect((await t.c.post(`/api/portals/${p.id}/items`, { kind: "project", refId: tk.projectId })).status).toBe(422);
    const d = await t.c.get(`/api/portals/${p.id}`);
    expect(d.body.td9).toBeUndefined();
    const v = new Visitor(t);
    await signIn(t, v, p);
    expect((await v.get(`/p/${p.key}/project/x`)).status).toBe(404);
    expect((await v.get(`/p/_/live-td9.js`)).status).toBe(404);
    const home = await v.get(`/p/${p.key}`);
    expect(home.html).not.toContain("tab=projects");
    expect(home.html).toContain("tab=tasks");
  });

  it("sets None, View or Comment per area, enforces it on the server and audits every change", async () => {
    const t = await setup();
    const p = await portal(t);
    const up = await upload(t, p.id, new TextEncoder().encode("hello"), { "content-type": "text/plain", "x-file-name": "brief.txt" });
    const tk = await task(t, "Draft the logo");
    const taskItem = await share(t, p.id, "task", tk.id);
    const projItem = await share(t, p.id, "project", tk.projectId);
    const a0 = await t.c.get(`/api/portals/${p.id}/people/${p.person}/access`);
    expect(a0.body.levels).toEqual(DEFAULT_LEVELS);
    expect(a0.body.history).toEqual([]);

    const v = new Visitor(t);
    await signIn(t, v, p);
    // Defaults: files and tasks show, projects is hidden and its page is not found.
    let home = await v.get(`/p/${p.key}`);
    expect(home.html).toContain("tab=files");
    expect(home.html).not.toContain("tab=projects");
    expect((await v.get(`/p/${p.key}/project/${projItem}`)).status).toBe(404);
    expect((await v.get(`/p/${p.key}/project/${projItem}/live.json`)).status).toBe(404);

    // Files to None: no tab, the list falls back to the overview, the download is not found.
    expect((await setLevel(t, p, "files", "none")).status).toBe(200);
    home = await v.get(`/p/${p.key}?tab=files`);
    expect(home.html).not.toContain("tab=files");
    expect(home.html).not.toContain("brief.txt");
    expect((await v.get(`/p/${p.key}/f/${up.body.id}`)).status).toBe(404);
    // Tasks to None: the task page is not found.
    await setLevel(t, p, "tasks", "none");
    expect((await v.get(`/p/${p.key}/t/${taskItem}`)).status).toBe(404);
    // Projects to View: the project page opens, posting a comment is refused.
    await setLevel(t, p, "projects", "view");
    const page = await v.get(`/p/${p.key}/project/${projItem}`);
    expect(page.status).toBe(200);
    expect(page.html).toContain('src="/p/_/live-td9.js"');
    expect(page.html).not.toContain("<script>");
    expect(page.html).not.toContain('name="body"');
    expect((await v.post(`/p/${p.key}/c/${projItem}`, { ft: page.ft, body: "Hi" })).status).toBe(403);
    // Comment: the post lands and shows in the thread.
    await setLevel(t, p, "projects", "comment");
    const page2 = await v.get(`/p/${p.key}/project/${projItem}`);
    expect(page2.html).toContain('name="body"');
    expect((await v.post(`/p/${p.key}/c/${projItem}`, { ft: page2.ft, body: "Looks good" })).status).toBe(303);
    expect((await v.get(`/p/${p.key}/project/${projItem}`)).html).toContain("Looks good");
    // Bad values are refused; the audit holds who, when and what.
    expect((await setLevel(t, p, "files", "edit")).status).toBe(422);
    expect((await setLevel(t, p, "billing", "view")).status).toBe(422);
    const before = (await t.db.get<{ n: number }>(sql`select count(*) as n from audit_logs where action = 'portal.access.set'`))!.n;
    expect((await setLevel(t, p, "projects", "comment")).status).toBe(200); // unchanged: no new row
    expect((await t.db.get<{ n: number }>(sql`select count(*) as n from audit_logs where action = 'portal.access.set'`))!.n).toBe(before);
    expect(Number(before)).toBe(4);
    const row = await t.db.get<{ actor_email: string; metadata: string; target_id: string }>(sql`select actor_email, metadata, target_id from audit_logs where action = 'portal.access.set' order by created_at limit 1`);
    expect(row!.actor_email).toBe("ada@acme.io");
    expect(row!.target_id).toBe(p.person);
    expect(JSON.parse(row!.metadata)).toMatchObject({ area: "files", from: "view", to: "none" });
    const a1 = await t.c.get(`/api/portals/${p.id}/people/${p.person}/access`);
    expect(a1.body.levels).toMatchObject({ files: "none", tasks: "none", projects: "comment" });
    expect(a1.body.history.length).toBe(4);
    expect(a1.body.history[0].by).toBe("Ada Lovelace");
  });

  it("lets only portal managers change access", async () => {
    const t = await setup();
    const p = await portal(t);
    const mate = await member(t, "mate@acme.io", "Mate");
    expect((await mate.c.get(`/api/portals/${p.id}/people/${p.person}/access`)).status).toBe(200);
    expect((await mate.c.put(`/api/portals/${p.id}/people/${p.person}/access`, { area: "files", level: "none" })).status).toBe(403);
  });

  it("keeps clients inside their own portal and other workspaces out", async () => {
    const t = await setup();
    const a = await portal(t, "sam@client.co", "Sam");
    const b = await portal(t, "rio@other.co", "Rio");
    const tk = await task(t, "Secret");
    const projB = await share(t, b.id, "project", tk.projectId);
    await setLevel(t, b, "projects", "comment");
    await setLevel(t, a, "projects", "comment");
    const v = new Visitor(t);
    await signIn(t, v, a);
    expect((await v.get(`/p/${a.key}/project/${projB}`)).status).toBe(404);
    expect((await v.get(`/p/${a.key}/project/${projB}/live.json`)).status).toBe(404);
    const pg = await v.get(`/p/${a.key}`);
    expect((await v.post(`/p/${a.key}/c/${projB}`, { ft: pg.ft, body: "x" })).status).toBe(404);
    // No session: JSON asks to sign in, the page sends to sign in.
    const anon = new Visitor(t, "10.3.3.3");
    expect((await anon.get(`/p/${b.key}/project/${projB}/live.json`)).status).toBe(401);
    expect((await anon.get(`/p/${b.key}/project/${projB}`)).status).toBe(303);
    // Another workspace: every team path is not found.
    const eve = new Client(t.app);
    await eve.signup("eve@evil.io", "Eve", "Evil");
    expect((await eve.get(`/api/portals/${b.id}/people/${b.person}/access`)).status).toBe(404);
    expect((await eve.put(`/api/portals/${b.id}/people/${b.person}/access`, { area: "files", level: "comment" })).status).toBe(404);
    expect((await eve.get(`/api/portals/${b.id}/items/${projB}/comments`)).status).toBe(404);
    expect((await eve.get(`/api/portals/${b.id}/items/${projB}/milestones`)).status).toBe(404);
    expect((await eve.get(`/api/item-comments/task/${tk.id}`)).status).toBe(404);
    expect((await eve.post(`/api/item-comments/project/${tk.projectId}`, { body: "x", toUserId: "u" })).status).toBe(404);
    expect((await eve.get(`/api/portals/${b.id}/pick?kind=project`)).status).toBe(404);
  });

  it("expires sign in links after 15 minutes", async () => {
    const t = await setup();
    const p = await portal(t);
    const l = await t.c.post(`/api/portals/${p.id}/people/${p.person}/link`);
    const path = pathOf(l.body.url);
    const v = new Visitor(t);
    const page = await v.get(path);
    t.advance(16 * 60_000);
    expect((await v.post(path, { ft: page.ft })).status).toBe(410);
  });
});

describe("TD9 live project view", () => {
  it("shows progress, milestones, shared tasks and linked files, and the JSON follows the work", async () => {
    const t = await setup();
    const p = await portal(t);
    const t1 = await task(t, "Logo concepts");
    await task(t, "Brand guide");
    const projItem = await share(t, p.id, "project", t1.projectId);
    await share(t, p.id, "task", t1.id);
    const up = await upload(t, p.id, new TextEncoder().encode("pdf"), { "content-type": "text/plain", "x-file-name": "moodboard.txt" });
    expect((await t.c.patch(`/api/portals/${p.id}/items/${up.body.id}`, { projectItemId: projItem })).status).toBe(200);
    const m = await t.c.post(`/api/portals/${p.id}/items/${projItem}/milestones`, { title: "First draft", due: "2026-11-20" });
    expect(m.status).toBe(201);
    expect((await t.c.post(`/api/portals/${p.id}/items/${projItem}/milestones`, { title: "Bad", due: "20/11/2026" })).status).toBe(400);
    await setLevel(t, p, "projects", "view");
    const v = new Visitor(t);
    await signIn(t, v, p);
    const list = await v.get(`/p/${p.key}?tab=projects`);
    expect(list.html).toContain("data-testid=\"portal-projects\"");
    const page = await v.get(`/p/${p.key}/project/${projItem}`);
    expect(page.html).toContain("First draft");
    expect(page.html).toContain("Logo concepts");
    expect(page.html).not.toContain("Brand guide"); // not shared as a task
    expect(page.html).toContain("moodboard.txt");
    let j = await (await t.app.request(`/p/${p.key}/project/${projItem}/live.json`, { headers: { host: "localhost", cookie: `mp_portal=${[...v.jar.values()][0].value}` } })).json() as { progress: { done: number; total: number; pct: number }; milestones: { done: boolean }[]; tasks: { stateLabel: string }[] };
    const total = j.progress.total;
    expect(total).toBeGreaterThanOrEqual(2);
    expect(j.progress.done).toBe(0);
    await t.db.run(sql`update tasks set status = 'done' where id = ${t1.id}`);
    const mid = m.body.milestones[0].id;
    expect((await t.c.patch(`/api/portals/${p.id}/items/${projItem}/milestones/${mid}`, { done: true })).status).toBe(200);
    j = await (await t.app.request(`/p/${p.key}/project/${projItem}/live.json`, { headers: { host: "localhost", cookie: `mp_portal=${[...v.jar.values()][0].value}` } })).json() as typeof j;
    expect(j.progress.done).toBe(1);
    expect(j.milestones[0].done).toBe(true);
    expect(j.tasks[0].stateLabel).toBe("Done");
    // Files at None: the project page drops its files list; tasks at None drops shared tasks.
    await setLevel(t, p, "files", "none");
    await setLevel(t, p, "tasks", "none");
    const page2 = await v.get(`/p/${p.key}/project/${projItem}`);
    expect(page2.html).not.toContain("moodboard.txt");
    expect(page2.html).not.toContain("Logo concepts");
    const js = await v.get(`/p/_/live-td9.js`);
    expect(js.status).toBe(200);
    expect(js.res.headers.get("content-type")).toContain("javascript");
  });

  it("shares issued invoices and forms only, behind their own areas", async () => {
    const t = await setup();
    const p = await portal(t);
    const org = await orgOf(t, p.id);
    const now = Date.now();
    await t.db.run(sql`insert into invoice_docs (id, org_id, kind, status, number, total_cents, currency, view_token, created_by, created_at, updated_at) values ('inv_td9', ${org}, 'invoice', 'issued', 'INV-0001', 12345, 'AUD', 'tok_td9_view', 'u', ${now}, ${now})`);
    await t.db.run(sql`insert into invoice_docs (id, org_id, kind, status, number, total_cents, currency, view_token, created_by, created_at, updated_at) values ('inv_draft', ${org}, 'invoice', 'draft', null, 100, 'AUD', null, 'u', ${now}, ${now})`);
    const picked = await t.c.get(`/api/portals/${p.id}/pick?kind=invoice`);
    expect(picked.body.items.map((x: { id: string }) => x.id)).toEqual(["inv_td9"]);
    expect((await t.c.get(`/api/portals/${p.id}/pick?kind=invoice&q=0001`)).body.items.length).toBe(1);
    expect((await t.c.get(`/api/portals/${p.id}/pick?kind=invoice&q=${encodeURIComponent("%")}`)).body.items.length).toBe(0);
    expect((await t.c.post(`/api/portals/${p.id}/items`, { kind: "invoice", refId: "inv_draft" })).status).toBe(404);
    await share(t, p.id, "invoice", "inv_td9");
    const v = new Visitor(t);
    await signIn(t, v, p);
    expect((await v.get(`/p/${p.key}?tab=invoices`)).html).not.toContain("INV-0001");
    await setLevel(t, p, "invoices", "view");
    const inv = await v.get(`/p/${p.key}?tab=invoices`);
    expect(inv.html).toContain("INV-0001");
    expect(inv.html).toContain("/i/tok_td9_view");
  });
});

describe("TD9 private comments", () => {
  it("shows a private comment only to its author, its target and admins, with no count leak", async () => {
    const t = await setup();
    await portal(t);
    const mate = await member(t, "mate@acme.io", "Mate");
    const bo = await member(t, "bo@acme.io", "Bo");
    const cy = await member(t, "cy@acme.io", "Cy");
    const tk = await task(t, "Pricing page");
    const r = await mate.c.post(`/api/item-comments/task/${tk.id}`, { body: "Bo, the price is wrong", toUserId: bo.id });
    expect(r.status).toBe(201);
    expect(r.body.comments[0].privateLabel).toBe("Only you and Bo");
    const seenBo = await bo.c.get(`/api/item-comments/task/${tk.id}`);
    expect(seenBo.body.comments[0].privateLabel).toBe("Only you and Mate");
    expect(seenBo.body.comments[0].canDelete).toBe(false);
    const seenAda = await t.c.get(`/api/item-comments/task/${tk.id}`);
    expect(seenAda.body.comments[0].privateLabel).toBe("Private: Mate to Bo");
    const seenCy = await cy.c.get(`/api/item-comments/task/${tk.id}`);
    expect(seenCy.status).toBe(200);
    expect(seenCy.body).toEqual({ comments: [] });
    expect(JSON.stringify(seenCy.body)).not.toContain("price");
    // Someone who cannot see it cannot delete it either: not found, not forbidden.
    const id = r.body.comments[0].id;
    expect((await cy.c.del(`/api/item-comments/${id}`)).status).toBe(404);
    expect((await bo.c.del(`/api/item-comments/${id}`)).status).toBe(403);
    // The ordinary task comments never carry it.
    const tc = await t.c.get(`/api/tasks/${tk.id}/comments`);
    expect(JSON.stringify(tc.body)).not.toContain("price is wrong");
    // It must name exactly one person.
    expect((await mate.c.post(`/api/item-comments/task/${tk.id}`, { body: "x" })).status).toBe(400);
    expect((await mate.c.post(`/api/item-comments/task/${tk.id}`, { body: "x", toUserId: mate.id })).status).toBe(400);
    expect((await mate.c.post(`/api/item-comments/task/${tk.id}`, { body: "x", toUserId: "usr_nobody" })).status).toBe(404);
    expect((await mate.c.del(`/api/item-comments/${id}`)).status).toBe(200);
    expect((await bo.c.get(`/api/item-comments/task/${tk.id}`)).body.comments).toEqual([]);
  });

  it("reaches one client and nobody else on the portal", async () => {
    const t = await setup();
    const p = await portal(t, "sam@client.co", "Sam");
    const other = await t.c.post(`/api/portals/${p.id}/people`, { email: "kim@client.co", name: "Kim" });
    const kim = other.body.person.id as string;
    const tk = await task(t, "Homepage copy");
    const item = await share(t, p.id, "task", tk.id);
    const rec = await t.c.get(`/api/item-comments/task/${tk.id}/recipients`);
    expect(rec.body.recipients.filter((x: { kind: string }) => x.kind === "client").map((x: { name: string }) => x.name).sort()).toEqual(["Kim", "Sam"]);
    const r = await t.c.post(`/api/item-comments/task/${tk.id}`, { body: "Sam, only for you", toPersonId: p.person });
    expect(r.status).toBe(201);
    expect(r.body.comments[0].privateLabel).toBe("Only you and Sam");
    // Public thread note on the same item from the portal page.
    expect((await t.c.post(`/api/portals/${p.id}/items/${item}/comments`, { body: "For everyone" })).status).toBe(201);
    const vs = new Visitor(t);
    await signIn(t, vs, p);
    const sam = await vs.get(`/p/${p.key}/t/${item}`);
    expect(sam.html).toContain("Sam, only for you");
    expect(sam.html).toContain("Only you and Ada Lovelace");
    expect(sam.html).toContain("For everyone");
    const vk = new Visitor(t, "10.4.4.4");
    await signIn(t, vk, { id: p.id, person: kim });
    const k = await vk.get(`/p/${p.key}/t/${item}`);
    expect(k.status).toBe(200);
    expect(k.html).toContain("For everyone");
    expect(k.html).not.toContain("only for you");
    expect(k.html).not.toContain("data-testid=\"portal-private\"");
    // A client who cannot see tasks cannot be addressed.
    await t.c.put(`/api/portals/${p.id}/people/${kim}/access`, { area: "tasks", level: "none" });
    const no = await t.c.post(`/api/item-comments/task/${tk.id}`, { body: "Kim?", toPersonId: kim });
    expect(no.status).toBe(409);
    const rec2 = await t.c.get(`/api/item-comments/task/${tk.id}/recipients`);
    expect(rec2.body.recipients.some((x: { name: string }) => x.name === "Kim")).toBe(false);
  });
});
