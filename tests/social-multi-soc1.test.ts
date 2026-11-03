/**
 * SOC1: several Facebook Pages and LinkedIn accounts per workspace (flag SOCIAL_MULTI_SOC1). An admin chooses Pages
 * from a login's full paged list; each Page is one row (deduped by Page id across logins) and its own post target;
 * publish, status check and delete work per Page; members, other workspaces and signed out callers are refused;
 * LinkedIn company Pages show an honest state unless organization access is granted; flag off = today.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { auditLogs, members, sessions, socialPages, socialPostTargets, users } from "../src/server/db/schema";
import { mockComposioFetch, newMockState, type MockComposioState } from "../src/server/services/integrations/mock";
import { filterPages, isPageKey, soc1KeyOf, SOC1_COPY } from "../src/shared/social-soc1";
import { SOCIAL_HEALTH_COPY } from "../src/shared/integrations";

const BASE = { COMPOSIO_API_KEY: "ak_test_key_never_shown", COMPOSIO_BASE_URL: "https://composio.mock", APP_URL: "https://app.example.com" };
const ON = { ...BASE, SOCIAL_MULTI_SOC1: "on" };
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let mock: MockComposioState;
let owner: Client;
const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));

async function boot(env: Record<string, string> = ON) {
  mock = newMockState();
  ctx = await makeTestApp(env, { fetch: mockComposioFetch(async () => { throw new Error("network disabled in tests"); }, mock) });
  owner = new Client(ctx.app);
  await owner.signup("owner-soc1@acme.io");
}
async function connect(c: Client, app: string, who: Record<string, unknown> = {}) {
  const r = await c.post("/api/apps/connect", { app });
  expect(r.status).toBe(201);
  const id = new URL(r.body.redirectUrl).searchParams.get("connected_account_id")!;
  Object.assign(mock.accounts.get(id)!.data, who);
  expect((await c.post(`/api/apps/accounts/${id}/confirm`)).status).toBe(200);
  return id;
}
async function joinAs(email: string, role: "member" | "admin" = "member") {
  const c = new Client(ctx.app);
  const o = (await ctx.db.select().from(users).where(eq(users.email, "owner-soc1@acme.io")).get())!;
  const orgId = (await ctx.db.select().from(members).where(eq(members.userId, o.id)).get())!.organizationId;
  await c.signup(email, "Kiran Rao", "");
  const u = (await ctx.db.select().from(users).where(eq(users.email, email)).get())!;
  await ctx.db.insert(members).values({ id: `mem_${u.id}`, organizationId: orgId, userId: u.id, role });
  await ctx.db.update(sessions).set({ activeOrganizationId: orgId }).where(eq(sessions.userId, u.id));
  return c;
}

describe("SOC1 several Facebook Pages", () => {
  beforeEach(() => boot());

  it("lists every Page past 100 by following the cursor, with names and pictures, marking the one that can't post", async () => {
    const fb = await connect(owner, "facebook", { fbPages: 250 });
    const r = await owner.get(`/api/apps/accounts/${fb}/pages`);
    expect(r.status).toBe(200);
    expect(r.body.pages).toHaveLength(250);
    expect(r.body.truncated).toBe(false);
    expect(r.body.pages[0]).toMatchObject({ id: "pg_100", name: "Acme Bakery", pictureUrl: "https://images.example.com/page-1.png", canPost: true, added: false });
    expect(r.body.pages[3].canPost).toBe(false);
    const calls = mock.proxied.filter((p) => p.endpoint.includes("/me/accounts"));
    expect(calls).toHaveLength(3);
    expect(calls[1]!.endpoint).toContain("after=100");
    expect(JSON.stringify(r.body)).not.toContain("mock-page-token");
  });

  it("an admin chooses Pages; each is its own row; leaving one out removes it; audit logged", async () => {
    const fb = await connect(owner, "facebook", { fbPages: 5 });
    const save = await owner.put(`/api/apps/accounts/${fb}/pages`, { pageIds: ["pg_100", "pg_200", "pg_1002"] });
    expect(save.status).toBe(200);
    expect(save.body.pages.map((p: { key: string }) => p.key).sort()).toEqual(["fbpage_pg_100", "fbpage_pg_1002", "fbpage_pg_200"]);
    const again = await owner.put(`/api/apps/accounts/${fb}/pages`, { pageIds: ["pg_100", "pg_200"] });
    expect(again.body.pages).toHaveLength(2);
    expect((await owner.get("/api/apps/pages")).body.pages).toHaveLength(2);
    expect((await owner.put(`/api/apps/accounts/${fb}/pages`, { pageIds: ["pg_1003"] })).status).toBe(422); // can't post there
    expect((await owner.put(`/api/apps/accounts/${fb}/pages`, { pageIds: ["pg_not_mine"] })).status).toBe(422);
    const audit = await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "social.pages_chosen")).all();
    expect(audit.length).toBe(2);
    expect((await owner.call("DELETE", "/api/apps/pages/fbpage_pg_200")).status).toBe(200);
    expect((await owner.get("/api/apps/pages")).body.pages.map((p: { key: string }) => p.key)).toEqual(["fbpage_pg_100"]);
    expect((await owner.call("DELETE", "/api/apps/pages/fbpage_pg_200")).status).toBe(404);
  });

  it("a second Facebook login (another person) dedupes by Page id: one row per Page", async () => {
    const a = await connect(owner, "facebook", { fbId: "fbu_a", name: "Ada", fbPages: 3 });
    const b = await connect(owner, "facebook", { fbId: "fbu_b", name: "Grace", fbPages: 3 });
    expect(a).not.toBe(b);
    await owner.put(`/api/apps/accounts/${a}/pages`, { pageIds: ["pg_100", "pg_200"] });
    const list = await owner.get(`/api/apps/accounts/${b}/pages`);
    expect(list.body.pages.find((p: { id: string }) => p.id === "pg_100")).toMatchObject({ added: true, addedElsewhere: true });
    await owner.put(`/api/apps/accounts/${b}/pages`, { pageIds: ["pg_100", "pg_1002"] });
    const rows = await ctx.db.select().from(socialPages).all();
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.pageId === "pg_100")!.viaAccountId).toBe(a); // a is still here: it keeps the Page
    expect(rows.find((r) => r.pageId === "pg_1002")!.viaAccountId).toBe(b);
    // Disconnecting a takes its Pages with it.
    expect((await owner.call("DELETE", `/api/apps/accounts/${a}`)).status).toBe(200);
    expect((await ctx.db.select().from(socialPages).all()).map((r) => r.pageId).sort()).toEqual(["pg_1002"]);
  });

  it("posts to two Pages of one login in one post, each with its own result; then status check and delete per Page", async () => {
    const fb = await connect(owner, "facebook", { fbPages: 3 });
    const li = await connect(owner, "linkedin");
    await owner.put(`/api/apps/accounts/${fb}/pages`, { pageIds: ["pg_100", "pg_200"] });
    const r = await owner.post("/api/social/posts", { text: "Two Pages at once", targets: [{ accountId: "fbpage_pg_100" }, { accountId: "fbpage_pg_200" }, { accountId: li }] });
    expect(r.status).toBe(201);
    await wait(120);
    const post = (await owner.get(`/api/social/posts/${r.body.post.id}`)).body.post;
    expect(post.status).toBe("done");
    expect(post.targets).toHaveLength(3);
    const fbT = post.targets.filter((t: { app: string }) => t.app === "facebook");
    expect(fbT.map((t: { target: string }) => t.target).sort()).toEqual(["pg_100", "pg_200"]);
    expect(fbT.map((t: { targetName: string }) => t.targetName).sort()).toEqual(["Acme Bakery", "Acme Bakery Melbourne"]);
    expect(fbT.every((t: { status: string }) => t.status === "sent")).toBe(true);
    // Feed posts went to each Page with the Page token, through the one login.
    const feeds = mock.proxied.filter((p) => p.method === "POST" && /\/feed$/.test(p.endpoint));
    expect(feeds.map((f) => f.endpoint.split("/").slice(-2)[0]).sort()).toEqual(["pg_100", "pg_200"]);
    expect(feeds.every((f) => f.accountId === fb && f.body.access_token === "mock-page-token")).toBe(true);
    // One Page list read gave both tokens (no per Page token read).
    expect(mock.proxied.filter((p) => p.endpoint.includes("fields=access_token") && !p.endpoint.includes("me/accounts"))).toHaveLength(0);
    // Status check per Page.
    await ctx.db.update(socialPostTargets).set({ checkedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(socialPostTargets.postId, post.id));
    const one = fbT[0].remoteId ?? null;
    const gone = (await ctx.db.select().from(socialPostTargets).where(and(eq(socialPostTargets.postId, post.id), eq(socialPostTargets.accountId, "fbpage_pg_200"))).get())!;
    mock.goneRemote = new Set([gone.remoteId!]);
    void one;
    const synced = await owner.post("/api/social/posts/sync", { ids: [post.id] });
    expect(synced.status).toBe(200);
    const after = synced.body.posts[0].targets;
    expect(after.find((t: { accountId: string }) => t.accountId === "fbpage_pg_200").networkState).toBe("removed");
    expect(after.find((t: { accountId: string }) => t.accountId === "fbpage_pg_100").networkState).toBe("live");
    // Delete per Page: one already gone there, the other deleted, LinkedIn deleted.
    const del = await owner.call("DELETE", `/api/social/posts/${post.id}`);
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);
    const outcome = Object.fromEntries(del.body.results.map((x: { accountId: string; outcome: string }) => [x.accountId, x.outcome]));
    expect(outcome).toMatchObject({ fbpage_pg_100: "deleted", fbpage_pg_200: "already_gone", [li]: "deleted" });
  });

  it("a scheduled post keeps its chosen Pages and sends to each when due", async () => {
    const fb = await connect(owner, "facebook", { fbPages: 3 });
    await owner.put(`/api/apps/accounts/${fb}/pages`, { pageIds: ["pg_100", "pg_1002"] });
    const later = new Date(Date.now() + 3_600_000).toISOString();
    const r = await owner.post("/api/social/posts", { text: "Later to both", runAt: later, targets: [{ accountId: "fbpage_pg_100" }, { accountId: "fbpage_pg_1002" }] });
    expect(r.status).toBe(201);
    expect(r.body.post.status).toBe("scheduled");
    expect(r.body.post.targets.map((t: { targetName: string }) => t.targetName).sort()).toEqual(["Acme Bakery", "Acme Bakery and Cafe Southbank Promenade Weekend Markets and Catering"]);
    const { runDueSocialPosts } = await import("../src/server/services/integrations/social");
    const res = await runDueSocialPosts(ctx.deps, { now: new Date(Date.now() + 2 * 3_600_000) });
    expect(res.sent).toBe(1);
    const post = (await owner.get(`/api/social/posts/${r.body.post.id}`)).body.post;
    expect(post.targets.map((t: { status: string }) => t.status)).toEqual(["sent", "sent"]);
  });

  it("a Page the login lost shows as lost in health and can't be posted to; a removed Page fails as gone", async () => {
    const fb = await connect(owner, "facebook", { fbPages: 3 });
    await owner.put(`/api/apps/accounts/${fb}/pages`, { pageIds: ["pg_100", "pg_1002"] });
    mock.accounts.get(fb)!.data.fbPages = 2; // pg_1002 is gone from the login's list
    const h = await owner.get("/api/social/health?fresh=1");
    const lost = h.body.accounts.find((x: { accountId: string }) => x.accountId === "fbpage_pg_1002");
    expect(lost).toMatchObject({ ok: false, code: "page_lost", text: SOCIAL_HEALTH_COPY.page_lost });
    expect(h.body.accounts.find((x: { accountId: string }) => x.accountId === "fbpage_pg_100")).toMatchObject({ ok: true });
    const avail = await owner.get(`/api/apps/accounts/${fb}/pages`);
    expect(avail.body.lost.map((p: { key: string }) => p.key)).toEqual(["fbpage_pg_1002"]);
    const r = await owner.post("/api/social/posts", { text: "To a lost Page", targets: [{ accountId: "fbpage_pg_1002" }] });
    expect(r.status).toBe(422);
    expect(r.body.error.details.problems[0].code).toBe("account_gone");
  });

  it("the phone's per login Page list offers only the chosen Pages once any are chosen, and its old shape still posts", async () => {
    const fb = await connect(owner, "facebook", { fbPages: 3 });
    mock.executed.length = 0;
    await owner.put(`/api/apps/accounts/${fb}/pages`, { pageIds: ["pg_200"] });
    const t = await owner.get(`/api/apps/accounts/${fb}/targets`);
    expect(t.body.targets).toEqual([{ id: "pg_200", name: "Acme Bakery Melbourne" }]);
    const r = await owner.post("/api/social/posts", { text: "From the phone", targets: [{ accountId: fb, target: "pg_200", targetName: "Acme Bakery Melbourne" }] });
    expect(r.status).toBe(201);
    await wait(100);
    expect((await owner.get(`/api/social/posts/${r.body.post.id}`)).body.post.status).toBe("done");
  });
});

describe("SOC1 access", () => {
  beforeEach(() => boot());

  it("members read chosen Pages but can't list, choose or remove (403); signed out 401", async () => {
    const fb = await connect(owner, "facebook", { fbPages: 3 });
    await owner.put(`/api/apps/accounts/${fb}/pages`, { pageIds: ["pg_100"] });
    const member = await joinAs("member-soc1@acme.io");
    expect((await member.get("/api/apps/pages")).status).toBe(200);
    expect((await member.get(`/api/apps/accounts/${fb}/pages`)).status).toBe(403);
    expect((await member.put(`/api/apps/accounts/${fb}/pages`, { pageIds: ["pg_200"] })).status).toBe(403);
    expect((await member.call("DELETE", "/api/apps/pages/fbpage_pg_100")).status).toBe(403);
    const admin = await joinAs("admin-soc1@acme.io", "admin");
    expect((await admin.get(`/api/apps/accounts/${fb}/pages`)).status).toBe(200);
    const anon = new Client(ctx.app);
    for (const [m, p] of [["GET", "/api/apps/pages"], ["GET", `/api/apps/accounts/${fb}/pages`], ["PUT", `/api/apps/accounts/${fb}/pages`], ["DELETE", "/api/apps/pages/fbpage_pg_100"]] as const) {
      expect((await anon.call(m, p, m === "PUT" ? { pageIds: [] } : undefined)).status).toBe(401);
    }
  });

  it("another workspace can't list, choose, remove or post to this workspace's Pages (404 or refused)", async () => {
    const fb = await connect(owner, "facebook", { fbPages: 3 });
    await owner.put(`/api/apps/accounts/${fb}/pages`, { pageIds: ["pg_100"] });
    const other = new Client(ctx.app);
    await other.signup("owner-other@zeta.io", "Zed", "Zeta");
    expect((await other.get(`/api/apps/accounts/${fb}/pages`)).status).toBe(404);
    expect((await other.put(`/api/apps/accounts/${fb}/pages`, { pageIds: ["pg_100"] })).status).toBe(404);
    expect((await other.call("DELETE", "/api/apps/pages/fbpage_pg_100")).status).toBe(404);
    expect((await other.get("/api/apps/pages")).body.pages).toEqual([]);
    const r = await other.post("/api/social/posts", { text: "Not mine", targets: [{ accountId: "fbpage_pg_100" }] });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toContain("account_gone");
    expect(await ctx.db.select().from(socialPages).all()).toHaveLength(1);
  });
});

describe("SOC1 LinkedIn several accounts and company Pages", () => {
  beforeEach(() => boot());

  it("two members connect as two rows (deduped by member id); company Pages need approval without the scope", async () => {
    const a = await connect(owner, "linkedin", { sub: "p1", name: "Ada Lovelace" });
    const b = await connect(owner, "linkedin", { sub: "p2", name: "Grace Hopper" });
    await connect(owner, "linkedin", { sub: "p1", name: "Ada Lovelace" }); // same member again: still two rows
    const list = (await owner.get("/api/apps/accounts")).body.accounts.filter((x: { app: string }) => x.app === "linkedin");
    expect(list.map((x: { name: string }) => x.name).sort()).toEqual(["Ada Lovelace", "Grace Hopper"]);
    const r = await owner.get(`/api/apps/accounts/${b}/pages`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ app: "linkedin", needsApproval: true, pages: [] });
    expect((await owner.put(`/api/apps/accounts/${b}/pages`, { pageIds: ["123"] })).status).toBe(409);
    expect(mock.proxied.some((p) => p.endpoint.includes("organizationAcls"))).toBe(false);
    // Posting to both members' profiles in one post.
    const ids = list.map((x: { id: string }) => x.id);
    const post = await owner.post("/api/social/posts", { text: "Both of us", targets: ids.map((accountId: string) => ({ accountId })) });
    expect(post.status).toBe(201);
    await wait(100);
    expect((await owner.get(`/api/social/posts/${post.body.post.id}`)).body.post.status).toBe("done");
    void a;
  });

  it("with organization access granted, company Pages are listed, chosen and posted to as the organization", async () => {
    const li = await connect(owner, "linkedin", { sub: "p9", name: "Ada", orgs: ["777", "888"] });
    (mock.accounts.get(li) as unknown as { state: unknown }).state = { val: { scope: "openid,profile,w_member_social,w_organization_social" } };
    const r = await owner.get(`/api/apps/accounts/${li}/pages`);
    expect(r.body.needsApproval).toBe(false);
    expect(r.body.pages.map((p: { id: string; name: string }) => [p.id, p.name])).toEqual([["777", "Acme company 777"], ["888", "Acme company 888"]]);
    await owner.put(`/api/apps/accounts/${li}/pages`, { pageIds: ["777"] });
    const post = await owner.post("/api/social/posts", { text: "From the company", targets: [{ accountId: "liorg_777" }] });
    expect(post.status).toBe(201);
    await wait(100);
    const sent = mock.proxied.filter((p) => p.method === "POST" && p.endpoint.endsWith("/rest/posts"));
    expect(sent.at(-1)!.body.author).toBe("urn:li:organization:777");
    // A login target naming an organization (not chosen by an admin) still posts as the member.
    const sly = await owner.post("/api/social/posts", { text: "Sneaky", targets: [{ accountId: li, target: "urn:li:organization:888" }] });
    expect(sly.status).toBe(201);
    await wait(100);
    const last = mock.proxied.filter((p) => p.method === "POST" && p.endpoint.endsWith("/rest/posts")).at(-1)!;
    expect(last.body.author).toBe("urn:li:person:p9");
  });
});

describe("SOC1 flag off = today", () => {
  beforeEach(() => boot(BASE));

  it("the new routes answer 404 and the old Page list is unchanged", async () => {
    const fb = await connect(owner, "facebook");
    expect((await owner.get(`/api/apps/accounts/${fb}/pages`)).status).toBe(404);
    expect((await owner.put(`/api/apps/accounts/${fb}/pages`, { pageIds: ["pg_100"] })).status).toBe(404);
    expect((await owner.get("/api/apps/pages")).status).toBe(404);
    expect((await owner.call("DELETE", "/api/apps/pages/fbpage_pg_100")).status).toBe(404);
    const cfg = await owner.get("/api/config");
    expect(cfg.body.socialMultiSoc1 ?? false).toBe(false);
    const h = await owner.get("/api/social/health?fresh=1");
    expect(h.body.accounts.every((x: { accountId: string }) => !isPageKey(x.accountId))).toBe(true);
    const r = await owner.post("/api/social/posts", { text: "As today", targets: [{ accountId: fb, target: "pg_100" }] });
    expect(r.status).toBe(201);
  });
});

describe("SOC1 shared helpers", () => {
  it("keys, search and copy", () => {
    expect(soc1KeyOf("facebook", "123")).toBe("fbpage_123");
    expect(soc1KeyOf("linkedin", "9")).toBe("liorg_9");
    expect(isPageKey("fbpage_123")).toBe(true);
    expect(isPageKey("ca_abc")).toBe(false);
    expect(isPageKey("fbpage_../x")).toBe(false);
    expect(filterPages([{ name: "Café Sydney" }, { name: "Acme" }], "cafe")).toEqual([{ name: "Café Sydney" }]);
    expect(SOC1_COPY.orgNeedsApproval).toBe("Company Pages need LinkedIn approval");
    for (const t of Object.values(SOC1_COPY)) expect(t).not.toMatch(/[\u2013\u2014]/);
  });
});
