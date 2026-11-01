/**
 * R80C: Connections hub (/api/apps) and social posts (/api/social), against the in memory stand in for the
 * integration platform. Covers the role split, workspace isolation, audit, no secrets in answers, the post
 * queue (now and later), per account results, retry and cancel, the cron step and the public image.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { auditLogs, members, sessions, socialMedia, socialPosts, users } from "../src/server/db/schema";
import { mockComposioFetch, newMockState, type MockComposioState } from "../src/server/services/integrations/mock";
import { checkTarget, runDueSocialPosts, pruneSocialMedia, dig, firstUrl, linkedinText, linkedinVersions, facebookError, linkedinError, platformDetail } from "../src/server/services/integrations/social"; // gitleaks:allow (function names, no key)
import { schemeFor, statusOf } from "../src/server/services/integrations/service";
import { groupFor, socialErrorText, SOCIAL_RECONNECT_ERRORS } from "../src/shared/integrations";

const ENV = { COMPOSIO_API_KEY: "ak_test_key_never_shown", COMPOSIO_BASE_URL: "https://composio.mock", APP_URL: "https://app.example.com" };
// A 1x1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let mock: MockComposioState;
let owner: Client;

async function orgIdOf(email: string) {
  const u = (await ctx.db.select().from(users).where(eq(users.email, email)).get())!;
  return (await ctx.db.select().from(members).where(eq(members.userId, u.id)).get())!.organizationId;
}

async function joinAs(c: Client, email: string, orgId: string, role: "member" | "admin" = "member") {
  await c.signup(email, "Kiran Rao", "");
  const u = (await ctx.db.select().from(users).where(eq(users.email, email)).get())!;
  await ctx.db.insert(members).values({ id: `mem_${u.id}`, organizationId: orgId, userId: u.id, role });
  await ctx.db.update(sessions).set({ activeOrganizationId: orgId }).where(eq(sessions.userId, u.id));
}

/** Connects an app the way the page does: start, follow the link back, confirm. */
async function connect(c: Client, app: string) {
  const r = await c.post("/api/apps/connect", { app });
  expect(r.status).toBe(201);
  const back = new URL(r.body.redirectUrl);
  const id = back.searchParams.get("connected_account_id")!;
  const conf = await c.post(`/api/apps/accounts/${id}/confirm`);
  expect(conf.status).toBe(200);
  return id;
}

beforeEach(async () => {
  mock = newMockState();
  ctx = await makeTestApp(ENV, { fetch: mockComposioFetch(async () => { throw new Error("network disabled in tests"); }, mock) });
  owner = new Client(ctx.app);
  await owner.signup("owner-r80c@acme.io");
});

describe("R80C Connections", () => {
  it("is off without a key: status says so and writes answer 503", async () => {
    const off = await makeTestApp({});
    const c = new Client(off.app);
    await c.signup("off-r80c@acme.io");
    expect((await c.get("/api/apps/status")).body).toEqual({ available: false, canManage: true });
    expect((await c.post("/api/apps/connect", { app: "linkedin" })).status).toBe(503);
  });

  it("connects, lists, reconnects and disconnects, with an audit row each way and no secret in any answer", async () => {
    const id = await connect(owner, "linkedin");
    const list = await owner.get("/api/apps/accounts");
    expect(list.status).toBe(200);
    expect(list.body.accounts).toHaveLength(1);
    expect(list.body.accounts[0]).toMatchObject({ id, app: "linkedin", appName: "LinkedIn", status: "active" });
    const raw = JSON.stringify(list.body);
    expect(raw).not.toContain("mock-secret-token");
    expect(raw).not.toContain("ak_test_key_never_shown");
    expect(mock.keyMissing).toBe(0);

    // SA1: the same account again is still one row; a different account for the same app is its own row.
    await connect(owner, "linkedin");
    expect((await owner.get("/api/apps/accounts")).body.accounts).toHaveLength(1);
    const kept = (await owner.get("/api/apps/accounts")).body.accounts[0].id as string;
    const r2 = await owner.post("/api/apps/connect", { app: "linkedin" });
    const other = new URL(r2.body.redirectUrl).searchParams.get("connected_account_id")!;
    mock.accounts.get(other)!.data.sub = "someone-else";
    expect((await owner.post(`/api/apps/accounts/${other}/confirm`)).status).toBe(200);
    expect((await owner.get("/api/apps/accounts")).body.accounts).toHaveLength(2);
    // The managed sign in setup was made once and reused.
    expect(mock.authConfigs.filter((a) => a.toolkit === "linkedin")).toHaveLength(1);

    const re = await owner.post(`/api/apps/accounts/${kept}/reconnect`);
    expect(re.status).toBe(200);
    expect(re.body.redirectUrl).toContain("/app/social/accounts?app=linkedin"); // P1 layout: a network you post to comes back to Social

    expect((await owner.del(`/api/apps/accounts/${kept}`)).status).toBe(200);
    expect((await owner.get("/api/apps/accounts")).body.accounts).toHaveLength(1);

    const orgId = await orgIdOf("owner-r80c@acme.io");
    const actions = (await ctx.db.select().from(auditLogs).where(eq(auditLogs.orgId, orgId)).all()).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["integration.connect_started", "integration.connected", "integration.reconnect_started", "integration.disconnected"]));
    // Platform users are one per workspace and host.
    expect([...mock.accounts.values()].every((a) => a.user_id === `app.example.com:${orgId}`)).toBe(true);
  });

  it("key based apps use the person's own key; apps with no sign in setup answer needs_setup", async () => {
    const r = await owner.post("/api/apps/connect", { app: "telegram" });
    expect(r.status).toBe(201);
    expect(mock.authConfigs.find((a) => a.toolkit === "telegram")).toMatchObject({ managed: false, scheme: "API_KEY" });
    const x = await owner.post("/api/apps/connect", { app: "twitter" });
    expect(x.status).toBe(409);
    expect(x.body.error.code).toBe("needs_setup");
    expect((await owner.post("/api/apps/connect", { app: "../etc" })).status).toBe(422);
  });

  it("members read, never write; another workspace cannot see or touch the accounts", async () => {
    const id = await connect(owner, "facebook");
    const orgId = await orgIdOf("owner-r80c@acme.io");
    const member = new Client(ctx.app);
    await joinAs(member, "kiran-r80c@acme.io", orgId);
    expect((await member.get("/api/apps/accounts")).body.accounts).toHaveLength(1);
    expect((await member.get("/api/apps/status")).body.canManage).toBe(false);
    expect((await member.post("/api/apps/connect", { app: "linkedin" })).status).toBe(403);
    expect((await member.del(`/api/apps/accounts/${id}`)).status).toBe(403);
    expect((await member.post("/api/social/posts", { text: "hi", targets: [{ accountId: id, target: "pg_100" }] })).status).toBe(403);

    const other = new Client(ctx.app);
    await other.signup("other-r80c@else.io");
    expect((await other.get("/api/apps/accounts")).body.accounts).toHaveLength(0);
    expect((await other.del(`/api/apps/accounts/${id}`)).status).toBe(404);
    expect((await other.get(`/api/apps/accounts/${id}/targets`)).status).toBe(404);
    expect(mock.accounts.has(id)).toBe(true);
  });

  it("lists Facebook pages and Pinterest boards to post to", async () => {
    const fb = await connect(owner, "facebook");
    const t = await owner.get(`/api/apps/accounts/${fb}/targets`);
    expect(t.body.targets).toEqual([{ id: "pg_100", name: "Acme Studio" }, { id: "pg_200", name: "Acme Shop" }]);
    const pin = await connect(owner, "pinterest");
    expect((await owner.get(`/api/apps/accounts/${pin}/targets`)).body.targets).toEqual([{ id: "bd_1", name: "Launch ideas" }]);
  });

  it("needs a session", async () => {
    const anon = new Client(ctx.app);
    expect((await anon.get("/api/apps/accounts")).status).toBe(401);
    expect((await anon.get("/api/social/posts")).status).toBe(401);
  });
});

describe("R80C social posts", () => {
  it("posts now to several accounts, each with its own result", async () => {
    const li = await connect(owner, "linkedin");
    const fb = await connect(owner, "facebook");
    const ig = await connect(owner, "instagram");
    const r = await owner.post("/api/social/posts", {
      text: "Spring launch is live", image: { contentType: "image/png", dataB64: PNG },
      targets: [{ accountId: li }, { accountId: fb, target: "pg_100" }, { accountId: ig }],
    });
    expect(r.status).toBe(201);
    // The send runs right after the answer; the cron pass would take it too.
    await new Promise((res) => setTimeout(res, 50));
    const post = (await owner.get(`/api/social/posts/${r.body.post.id}`)).body.post;
    expect(post.status).toBe("done");
    expect(post.targets.map((t: { status: string }) => t.status)).toEqual(["sent", "sent", "sent"]);
    expect(mock.executed.map((e) => e.slug)).toEqual(expect.arrayContaining(["INSTAGRAM_CREATE_POST"]));
    // Hotfix Oct 31: LinkedIn and Facebook go straight to the networks through the proxy.
    const liCall = mock.proxied.find((e) => e.endpoint === "https://api.linkedin.com/rest/posts")!;
    expect(liCall.body).toMatchObject({ author: "urn:li:person:mock1", commentary: "Spring launch is live", lifecycleState: "PUBLISHED", distribution: { feedDistribution: "MAIN_FEED" } });
    expect(liCall.headers["LinkedIn-Version"]).toMatch(/^20\d{4}$/);
    const fbCall = { args: mock.proxied.find((e) => e.endpoint.endsWith("/pg_100/photos"))!.body };
    // Posted as the Page, with the Page's own token.
    expect(fbCall.args.access_token).toBe("mock-page-token");
    expect(String(fbCall.args.url)).toMatch(/^https:\/\/app\.example\.com\/api\/social\/media\/sm_/);
    // The image is public at its unguessable address, and only there.
    const img = await ctx.app.request(new URL(String(fbCall.args.url)).pathname, { headers: { host: "localhost" } });
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    const wrong = await ctx.app.request(new URL(String(fbCall.args.url)).pathname.replace(/\/[^/]+$/, "/wrongtoken123"), { headers: { host: "localhost" } });
    expect(wrong.status).toBe(404);
  });

  it("refuses targets a network cannot take, before saving anything", async () => {
    const ig = await connect(owner, "instagram");
    const fb = await connect(owner, "facebook");
    const r = await owner.post("/api/social/posts", { text: "No image here", targets: [{ accountId: ig }, { accountId: fb }] });
    expect(r.status).toBe(422);
    expect(r.body.error.details.problems).toEqual([{ accountId: ig, code: "needs_image" }, { accountId: fb, code: "needs_target" }]);
    expect(await ctx.db.select().from(socialPosts).all()).toHaveLength(0);
    // Not a JPEG or PNG.
    const bad = await owner.post("/api/social/posts", { text: "x", image: { contentType: "image/png", dataB64: "R0lGODlhAQABAAAAACw=" }, targets: [{ accountId: fb, target: "pg_100" }] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("bad_image");
  });

  it("schedules a post, sends it from the cron pass once, and keeps a failed account's error", async () => {
    const li = await connect(owner, "linkedin");
    const rd = await connect(owner, "reddit");
    const at = new Date(Date.now() + 3600_000).toISOString();
    const r = await owner.post("/api/social/posts", { text: "FAIL on purpose", targets: [{ accountId: li }, { accountId: rd, target: "r/test" }], runAt: at });
    expect(r.status).toBe(201);
    expect(r.body.post.status).toBe("scheduled");
    // Not due yet.
    expect((await runDueSocialPosts(ctx.deps)).sent).toBe(0);
    const later = new Date(Date.now() + 3601_000);
    expect((await runDueSocialPosts(ctx.deps, { now: later })).sent).toBe(1);
    expect((await runDueSocialPosts(ctx.deps, { now: later })).sent).toBe(0);
    const post = (await owner.get(`/api/social/posts/${r.body.post.id}`)).body.post;
    expect(post.status).toBe("failed");
    // The network's own words ride after the code, so the person sees the real reason.
    expect(post.targets.every((t: { error: string }) => t.error === "rejected:The network turned this post down.")).toBe(true);
    // Try again sends only the failed accounts.
    const again = await owner.post(`/api/social/posts/${r.body.post.id}/retry`);
    expect(again.status).toBe(200);
    expect(again.body.post.targets.every((t: { status: string }) => t.status === "pending")).toBe(true);
  });

  it("cancels a scheduled post; a sent one cannot be canceled", async () => {
    const li = await connect(owner, "linkedin");
    const r = await owner.post("/api/social/posts", { text: "Later", targets: [{ accountId: li }], runAt: new Date(Date.now() + 86_400_000).toISOString() });
    const c = await owner.post(`/api/social/posts/${r.body.post.id}/cancel`);
    expect(c.body.post.status).toBe("canceled");
    expect((await owner.post(`/api/social/posts/${r.body.post.id}/cancel`)).status).toBe(409);
    expect((await runDueSocialPosts(ctx.deps, { now: new Date(Date.now() + 2 * 86_400_000) })).sent).toBe(0);
  });

  it("refuses a time too far ahead and an account from another workspace", async () => {
    const li = await connect(owner, "linkedin");
    const far = await owner.post("/api/social/posts", { text: "x", targets: [{ accountId: li }], runAt: new Date(Date.now() + 200 * 86_400_000).toISOString() });
    expect(far.body.error.code).toBe("too_far");
    const other = new Client(ctx.app);
    await other.signup("other2-r80c@else.io");
    const r = await other.post("/api/social/posts", { text: "x", targets: [{ accountId: li }] });
    expect(r.status).toBe(422);
    expect(r.body.error.details.problems[0].code).toBe("account_gone");
  });

  it("drops post images a week after the post is done", async () => {
    const fb = await connect(owner, "facebook");
    const r = await owner.post("/api/social/posts", { text: "Pic", image: { contentType: "image/png", dataB64: PNG }, targets: [{ accountId: fb, target: "pg_100" }] });
    await new Promise((res) => setTimeout(res, 50));
    expect(await ctx.db.select().from(socialMedia).all()).toHaveLength(1);
    expect((await pruneSocialMedia(ctx.deps)).mediaPruned).toBe(0);
    expect((await pruneSocialMedia(ctx.deps, { now: new Date(Date.now() + 8 * 86_400_000) })).mediaPruned).toBe(1);
    expect(await ctx.db.select().from(socialMedia).all()).toHaveLength(0);
    expect((await owner.get(`/api/social/posts/${r.body.post.id}`)).body.post.imageUrl).toBeNull();
  });
});

describe("R80C pure parts", () => {
  it("picks how an app connects", () => {
    expect(schemeFor({ auth_schemes: ["OAUTH2"], composio_managed_auth_schemes: ["OAUTH2"] })).toEqual({ managed: true });
    expect(schemeFor({ auth_schemes: ["OAUTH2", "API_KEY"], composio_managed_auth_schemes: [] })).toEqual({ scheme: "API_KEY" });
    expect(schemeFor({ auth_schemes: ["OAUTH2"], composio_managed_auth_schemes: [] })).toBeNull();
    expect(schemeFor({ auth_schemes: ["NO_AUTH"] })).toBeNull();
    // The live single toolkit read has no auth_schemes field (LinkedIn answered 409 needs_setup on staging before this).
    expect(schemeFor({ composio_managed_auth_schemes: ["OAUTH2"], auth_config_details: [{ mode: "OAUTH2" }] })).toEqual({ managed: true });
    expect(schemeFor({ composio_managed_auth_schemes: [], auth_config_details: [{ mode: "API_KEY" }] })).toEqual({ scheme: "API_KEY" });
    expect(schemeFor({ composio_managed_auth_schemes: [], auth_config_details: [{ mode: "OAUTH2" }] })).toBeNull();
  });
  it("maps status words and checks targets", () => {
    expect(statusOf("ACTIVE")).toBe("active");
    expect(statusOf("INITIATED")).toBe("pending");
    expect(statusOf("EXPIRED")).toBe("expired");
    expect(checkTarget("instagram", "x", false, null)).toBe("needs_image");
    expect(checkTarget("facebook", "x", false, null)).toBe("needs_target");
    expect(checkTarget("linkedin", "x".repeat(3001), false, null)).toBe("too_long");
    expect(checkTarget("tiktok", "x", true, null)).toBe("not_supported");
    expect(checkTarget("linkedin", "x", false, null)).toBeNull();
  });
  it("finds ids inside nested answers and groups apps Social first", () => {
    expect(dig({ data: { response: { id: "42" } } }, ["id"])).toBe("42");
    expect(groupFor(["Social Media"])).toBe("social");
  });
});

describe("Hotfix Oct 31: Facebook and LinkedIn posting and clear errors", () => {
  it("posts text with a link to a Facebook Page as the Page, with the link for its preview", async () => {
    const fb = await connect(owner, "facebook");
    const li = await connect(owner, "linkedin");
    const r = await owner.post("/api/social/posts", { text: "Testing.\nhttps://fintex.au", targets: [{ accountId: fb, target: "pg_100" }, { accountId: li }] });
    expect(r.status).toBe(201);
    await new Promise((res) => setTimeout(res, 50));
    const post = (await owner.get(`/api/social/posts/${r.body.post.id}`)).body.post;
    expect(post.status).toBe("done");
    const feed = mock.proxied.find((e) => e.endpoint.endsWith("/pg_100/feed"))!;
    expect(feed.body).toMatchObject({ message: "Testing.\nhttps://fintex.au", link: "https://fintex.au", access_token: "mock-page-token", published: true });
    expect(post.targets.find((t: { app: string }) => t.app === "linkedin").url).toMatch(/^https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:share:/);
    // The page token never reaches the browser.
    expect(JSON.stringify(post)).not.toContain("mock-page-token");
  });

  it("an expired sign in says Reconnect, on both networks", async () => {
    const fb = await connect(owner, "facebook");
    const li = await connect(owner, "linkedin");
    const r = await owner.post("/api/social/posts", { text: "EXPIRED token", targets: [{ accountId: fb, target: "pg_100" }, { accountId: li }] });
    await new Promise((res) => setTimeout(res, 50));
    const post = (await owner.get(`/api/social/posts/${r.body.post.id}`)).body.post;
    expect(post.targets.map((t: { error: string }) => t.error)).toEqual(["reconnect", "reconnect"]);
    expect(SOCIAL_RECONNECT_ERRORS.has("reconnect")).toBe(true);
  });

  it("a Page the profile can't post to says so", async () => {
    const fb = await connect(owner, "facebook");
    const r = await owner.post("/api/social/posts", { text: "Hello", targets: [{ accountId: fb, target: "pg_noadmin" }] });
    await new Promise((res) => setTimeout(res, 50));
    const post = (await owner.get(`/api/social/posts/${r.body.post.id}`)).body.post;
    expect(post.targets[0].error).toBe("not_page_admin");
    expect(socialErrorText(post.targets[0].error).text).toMatch(/admin of the Page/);
  });

  it("maps network errors to our own codes", () => {
    expect(facebookError(400, { code: 190, message: "Session has expired" }).code).toBe("reconnect");
    expect(facebookError(403, { code: 200, message: "(#200) Unpublished posts must be posted to a page as the page itself." }).code).toBe("not_page_admin");
    expect(facebookError(403, { code: 200, message: "(#200) Requires pages_manage_posts permission" }).code).toBe("no_permission");
    expect(facebookError(400, { code: 506, message: "Duplicate status message" }).code).toBe("duplicate");
    expect(facebookError(400, { code: 32, message: "Page request limit reached" }).code).toBe("rate_limited");
    expect(facebookError(400, { code: 324, message: "Missing or invalid image file" }).code).toBe("bad_image");
    expect(facebookError(400, { code: 100, message: "Invalid parameter" }).code).toBe("rejected");
    expect(linkedinError(401, { message: "revoked", code: "REVOKED_ACCESS_TOKEN" }).code).toBe("reconnect");
    expect(linkedinError(403, { message: "Not enough permissions" }).code).toBe("no_permission");
    expect(linkedinError(422, { message: "Content is a duplicate of urn:li:share:1" }).code).toBe("duplicate");
    expect(linkedinError(426, { message: "Requested version 20241101 is not active", code: "NONEXISTENT_VERSION" }).code).toBe("network_changed");
    expect(linkedinError(429, null).code).toBe("rate_limited");
  });

  it("steps LinkedIn versions back a month at a time, and escapes LinkedIn markup", () => {
    expect(linkedinVersions(new Date("2026-10-31T08:00:00Z"))).toEqual(["202609", "202608", "202610"]);
    expect(linkedinVersions(new Date("2027-01-05T08:00:00Z"))).toEqual(["202612", "202611", "202701"]);
    expect(linkedinText("Hi (team) #launch @you_2 *new*")).toBe("Hi \\(team\\) \\#launch \\@you\\_2 \\*new\\*");
    expect(firstUrl("Testing.\nhttps://fintex.au.")).toBe("https://fintex.au");
    expect(firstUrl("no link")).toBeNull();
  });

  it("shows the network's own words for a plain refusal, short and without long ids", () => {
    expect(platformDetail('{"error":{"message":"(#100) Bad thing","code":100}}')).toBe("(#100) Bad thing");
    expect(platformDetail('{"status":426,"message":"Requested version 20241101 is not active"}')).toBe("Requested version 20241101 is not active");
    expect(platformDetail(`token ${"x".repeat(40)} bad`)).toBe("token … bad");
    expect(socialErrorText("rejected:Bad thing").text).toBe("The network turned the post down: “Bad thing”");
    expect(socialErrorText("reconnect").text).toMatch(/Reconnect it/);
    expect(socialErrorText(null).text).toBe("The network turned the post down.");
    expect(socialErrorText("something_new").code).toBe("something_new");
  });
});

describe("Oct 31: account health before posting", () => {
  it("checks each social account without posting, and says what to fix", async () => {
    const fb = await connect(owner, "facebook");
    const li = await connect(owner, "linkedin");
    // SA1: a second LinkedIn is a different member (the same member again would fold into one row).
    const r2 = await owner.post("/api/apps/connect", { app: "linkedin" });
    const li2 = new URL(r2.body.redirectUrl).searchParams.get("connected_account_id")!;
    mock.accounts.get(li2)!.data.sub = "someone-else";
    expect((await owner.post(`/api/apps/accounts/${li2}/confirm`)).status).toBe(200);
    mock.accounts.get(li2)!.data.expired = true;
    const before = mock.proxied.length;
    const r = await owner.get("/api/social/health");
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.accounts.map((a: { accountId: string }) => [a.accountId, a]));
    expect(byId[fb]).toMatchObject({ app: "facebook", ok: true, code: null });
    expect(byId[li]).toMatchObject({ app: "linkedin", ok: true });
    expect(byId[li2]).toMatchObject({ app: "linkedin", ok: false, code: "reconnect" });
    expect(byId[li2].text).toMatch(/Reconnect/);
    // Nothing was posted: only reads.
    expect(mock.proxied.slice(before).every((p) => p.method === "GET")).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain("mock-page-token");
    // Kept for a while: a second read asks no network.
    const n = mock.proxied.length;
    await owner.get("/api/social/health");
    expect(mock.proxied.length).toBe(n);
  });

  it("a Facebook sign in without posting permission says so", async () => {
    const fb = await connect(owner, "facebook");
    mock.accounts.get(fb)!.data.noPostPerm = true;
    const r = await owner.get("/api/social/health?fresh=1");
    expect(r.body.accounts[0]).toMatchObject({ ok: false, code: "no_permission" });
  });

  it("needs a session", async () => {
    expect((await new Client(ctx.app).get("/api/social/health")).status).toBe(401);
  });
});
