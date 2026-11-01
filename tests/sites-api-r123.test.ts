import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { flushViews } from "@/server/services/sites";

/** R123: Sites through the API and the public pages (signed out). */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;
const page = (path: string, init: RequestInit = {}) => ctx.app.request(path, { ...init, headers: { host: "localhost", ...(init.headers ?? {}) } });
const html = async (path: string, headers: Record<string, string> = {}) => { const r = await page(path, { headers }); return { status: r.status, text: await r.text() }; };
let offset = 0;
function later(ms = 10_000) { offset += ms; const base = Date.now() + offset; (ctx.deps as { now: () => Date }).now = () => new Date(base); }
async function member(email = "mate@acme.io") {
  const invite = await owner.post("/api/team/invites", { email, role: "member" });
  const mate = new Client(ctx.app);
  await mate.signup(email, "Mia Mate", "");
  expect((await mate.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  return mate;
}
async function start() {
  const r = await owner.post("/api/sites", { name: "Acme", slug: "acme" });
  expect(r.status).toBe(201);
  const pages = (await owner.get("/api/sites/pages")).body.pages;
  return { site: r.body.site, home: pages[0] };
}
async function comment(path: string, body: Record<string, unknown>) {
  const ch = await page(`/site/acme/_shield`);
  const challenge = (await ch.json()).challenge;
  later(5_000);
  return page(`/site/acme/${path}/comments`, { method: "POST", body: JSON.stringify({ shield: { challenge, nonce: 0, hp: "" }, ...body }), headers: { "content-type": "application/json" } });
}

beforeEach(async () => {
  offset = 0;
  ctx = await makeTestApp({ SITES_R123: "on", SHIELD_DIFFICULTY: "0" });
  owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
});

describe("R123 sites setup and pages", () => {
  it("starts with no site; only admins start one; addresses are checked", async () => {
    const g = await owner.get("/api/sites");
    expect(g.body.site).toBeNull();
    expect(g.body.canStart).toBe(true);
    expect((await owner.post("/api/sites", { name: "Acme", slug: "A B" })).status).toBe(400);
    const mate = await member();
    expect((await mate.post("/api/sites", { name: "Mia", slug: "mia-site" })).status).toBe(403);
    const { site, home } = await start();
    expect(site.url).toMatch(/\/site\/acme$/);
    expect(home.isHome).toBe(true);
    expect(home.status).toBe("draft");
    expect((await owner.post("/api/sites", { name: "Again", slug: "again" })).status).toBe(409);
  });

  it("keeps drafts private, publishes, versions and restores", async () => {
    const { home } = await start();
    expect((await html("/site/acme")).status).toBe(404);
    const saved = await owner.patch(`/api/sites/pages/${home.id}`, { blocks: [{ type: "heading", text: "First words", level: 2 }], seoTitle: "Welcome", description: "Acme builds things.", image: "https://img.test/og.png" });
    expect(saved.status).toBe(200);
    expect((await owner.patch(`/api/sites/pages/${home.id}`, { blocks: [{ type: "text", text: "x" }, { type: "script" }] })).status).toBe(400);
    expect((await owner.post(`/api/sites/pages/${home.id}/publish`, {})).status).toBe(200);
    const pub = await html("/site/acme");
    expect(pub.status).toBe(200);
    expect(pub.text).toContain("<title>Welcome | Acme</title>");
    expect(pub.text).toContain('property="og:image" content="https://img.test/og.png"');
    expect(pub.text).toContain("First words");
    // a later draft does not reach visitors until it is published
    await owner.patch(`/api/sites/pages/${home.id}`, { blocks: [{ type: "heading", text: "Second words", level: 2 }] });
    expect((await html("/site/acme")).text).toContain("First words");
    const v = await owner.get(`/api/sites/pages/${home.id}/versions`);
    expect(v.body.versions.length).toBeGreaterThanOrEqual(3);
    const firstPublished = v.body.versions.find((x: { kind: string }) => x.kind === "published");
    const restored = await owner.post(`/api/sites/pages/${home.id}/versions/${firstPublished.id}/restore`, {});
    expect(restored.body.page.blocks[0].text).toBe("First words");
    expect(restored.body.page.hasUnpublished).toBe(true);
  });

  it("schedules a page and shows it only once its time has come; sitemap lists live pages only", async () => {
    const { home } = await start();
    await owner.post(`/api/sites/pages/${home.id}/publish`, {});
    const about = (await owner.post("/api/sites/pages", { title: "About us" })).body.page;
    expect(about.slug).toBe("about-us");
    expect((await owner.post(`/api/sites/pages/${about.id}/publish`, { at: Date.now() - 1000 })).status).toBe(400);
    const at = Date.now() + 3_600_000;
    const s = await owner.post(`/api/sites/pages/${about.id}/publish`, { at });
    expect(s.body.page.status).toBe("scheduled");
    expect((await html("/site/acme/about-us")).status).toBe(404);
    expect((await html("/site/acme/sitemap.xml")).text).not.toContain("about-us");
    later(3_700_000);
    const live = await html("/site/acme/about-us");
    expect(live.status).toBe(200);
    expect(live.text).toContain("<title>About us | Acme</title>");
    const list = (await owner.get("/api/sites/pages")).body.pages;
    expect(list.find((p: { id: string }) => p.id === about.id).status).toBe("published");
  });

  it("lets members see only published pages and shared drafts, and never change anything", async () => {
    const { home } = await start();
    const draft = (await owner.post("/api/sites/pages", { title: "Plans" })).body.page;
    const mate = await member();
    expect((await mate.get("/api/sites/pages")).body.pages).toHaveLength(0);
    expect((await mate.get(`/api/sites/pages/${draft.id}`)).status).toBe(403);
    await owner.patch(`/api/sites/pages/${draft.id}`, { membersCanView: true });
    expect((await mate.get(`/api/sites/pages/${draft.id}`)).status).toBe(200);
    expect((await mate.patch(`/api/sites/pages/${draft.id}`, { title: "Mine" })).status).toBe(403);
    expect((await mate.post(`/api/sites/pages/${home.id}/publish`, {})).status).toBe(403);
    expect((await mate.get("/api/sites/comments")).status).toBe(403);
    // an admin makes the member a site editor
    const people = (await owner.get("/api/sites/linkables")).body.people as { id: string; name: string }[];
    const id = people.find((p) => p.name === "Mia Mate")!.id;
    expect((await owner.patch("/api/sites", { editors: [id] })).status).toBe(200);
    expect((await mate.patch(`/api/sites/pages/${draft.id}`, { title: "Plans for 2027" })).status).toBe(200);
    expect((await mate.patch("/api/sites", { editors: [] })).status).toBe(403);
  });

  it("needs a session and keeps workspaces apart", async () => {
    const { home } = await start();
    expect((await page("/api/sites")).status).toBe(401);
    const other = new Client(ctx.app);
    await other.signup("boss@other.io", "Bo Other");
    expect((await other.get(`/api/sites/pages/${home.id}`)).status).toBe(404);
    expect((await other.patch(`/api/sites/pages/${home.id}`, { title: "x" })).status).toBe(404);
  });
});

describe("R123 comments and stats", () => {
  it("takes comments through the spam shield into moderation and shows them after approval", async () => {
    const { home } = await start();
    await owner.patch(`/api/sites/pages/${home.id}`, { slug: "welcome" });
    await owner.post(`/api/sites/pages/${home.id}/publish`, {});
    const pub = await html("/site/acme");
    expect(pub.text).toContain('id="site-comment"');
    expect(pub.text).toContain('src="/site-assets/comments.js"');
    // no shield answer: refused
    const bad = await page(`/site/acme/welcome/comments`, { method: "POST", body: JSON.stringify({ name: "Sam", body: "Hi" }), headers: { "content-type": "application/json" } });
    expect(bad.status).toBe(422);
    // honeypot filled: refused
    const ch = (await (await page(`/site/acme/_shield`)).json()).challenge;
    later(5_000);
    const hp = await page(`/site/acme/welcome/comments`, { method: "POST", body: JSON.stringify({ name: "Bot", body: "Buy", shield: { challenge: ch, nonce: 0, hp: "x" } }), headers: { "content-type": "application/json" } });
    expect(hp.status).toBe(422);
    const ok = await comment("welcome", { name: "Sam <b>", body: "Nice <script>alert(1)</script>" });
    expect(ok.status).toBe(201);
    expect((await html("/site/acme")).text).not.toContain("Nice");
    const q = await owner.get("/api/sites/comments");
    expect(q.body.waiting).toBe(1);
    await owner.patch(`/api/sites/comments/${q.body.comments[0].id}`, { status: "approved" });
    const after = await html("/site/acme");
    expect(after.text).toContain("Nice &lt;script&gt;");
    expect(after.text).not.toContain("<script>alert");
  });

  it("limits comments per sender per day and respects comments off", async () => {
    const { home } = await start();
    await owner.post(`/api/sites/pages/${home.id}/publish`, {});
    for (let i = 0; i < 5; i++) expect((await comment("home", { name: "Sam", body: `Note ${i}` })).status).toBe(201);
    expect((await comment("home", { name: "Sam", body: "One more" })).status).toBe(429);
    await owner.patch("/api/sites", { commentsOn: false });
    expect((await html("/site/acme")).text).not.toContain('id="site-comment"');
  });

  it("counts views without bots and keeps no personal data", async () => {
    const { home } = await start();
    await owner.post(`/api/sites/pages/${home.id}/publish`, {});
    await html("/site/acme", { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", referer: "https://www.google.com/search" });
    await html("/site/acme", { "user-agent": "Mozilla/5.0 (Windows NT 10.0)" });
    await html("/site/acme", { "user-agent": "Googlebot/2.1" });
    await flushViews(ctx.deps);
    const s = await owner.get("/api/sites/stats?days=7");
    expect(s.body.total).toBe(2);
    expect(JSON.stringify(s.body)).not.toMatch(/127\.0\.0\.1|Mozilla/);
    const rows = await ctx.deps.db.all<Record<string, unknown>>("select * from site_page_stats" as never);
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(["day", "device", "id", "org_id", "page_id", "source", "views"]);
  });
});
