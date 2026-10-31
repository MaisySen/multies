/**
 * Oct 31: posts checked against their network and deleted there from Multies, on the R80C setup. R80C: Connections hub (/api/apps) and social posts (/api/social), against the in memory stand in for the
 * integration platform. Covers the role split, workspace isolation, audit, no secrets in answers, the post
 * queue (now and later), per account results, retry and cancel, the cron step and the public image.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { auditLogs, members, sessions, socialPostTargets, socialPosts, users } from "../src/server/db/schema";
import { mockComposioFetch, newMockState, type MockComposioState } from "../src/server/services/integrations/mock";
import { remoteIdOf } from "../src/server/services/integrations/social"; // gitleaks:allow (function names, no key)

const ENV = { COMPOSIO_API_KEY: "ak_test_key_never_shown", COMPOSIO_BASE_URL: "https://composio.mock", APP_URL: "https://app.example.com" };

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let mock: MockComposioState;
let owner: Client;

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
  await owner.signup("owner-sync@acme.io");
});

async function joinAs(c: Client, email: string, role: "member" | "admin" = "member") {
  const owner = (await ctx.db.select().from(users).where(eq(users.email, "owner-sync@acme.io")).get())!;
  const orgId = (await ctx.db.select().from(members).where(eq(members.userId, owner.id)).get())!.organizationId;
  await c.signup(email, "Kiran Rao", "");
  const u = (await ctx.db.select().from(users).where(eq(users.email, email)).get())!;
  await ctx.db.insert(members).values({ id: `mem_${u.id}`, organizationId: orgId, userId: u.id, role });
  await ctx.db.update(sessions).set({ activeOrganizationId: orgId }).where(eq(sessions.userId, u.id));
}

/** Posts now to a Facebook Page and LinkedIn and waits for the send. */
async function postBoth(text = "Spring launch is live") {
  const fb = await connect(owner, "facebook");
  const li = await connect(owner, "linkedin");
  const r = await owner.post("/api/social/posts", { text, targets: [{ accountId: fb, target: "pg_100" }, { accountId: li }] });
  expect(r.status).toBe(201);
  await new Promise((res) => setTimeout(res, 60));
  const post = (await owner.get(`/api/social/posts/${r.body.post.id}`)).body.post;
  const byApp = (app: string) => post.targets.find((t: { app: string }) => t.app === app);
  return { id: r.body.post.id as string, fb, li, post, byApp };
}

/** Pretends the last check was long ago, so the 5 minute hold does not apply. */
async function age(postId: string) {
  await ctx.db.update(socialPostTargets).set({ checkedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(socialPostTargets.postId, postId));
}

describe("Oct 31: network state and delete", () => {
  it("stores the network's id and says what can be checked and deleted", async () => {
    const { byApp } = await postBoth();
    expect(byApp("facebook")).toMatchObject({ status: "sent", networkState: "live", canCheck: true, canDelete: true });
    expect(byApp("linkedin")).toMatchObject({ status: "sent", networkState: "live", canCheck: false, canDelete: true });
    const rows = await ctx.db.select().from(socialPostTargets).all();
    expect(rows.find((r) => r.app === "facebook")!.remoteId).toMatch(/^pg_post_/);
    expect(rows.find((r) => r.app === "linkedin")!.remoteId).toMatch(/^urn:li:share:/);
  });

  it("sync marks a Facebook post removed on the network, hides Open post, and holds 5 minutes between checks", async () => {
    const { id, post } = await postBoth();
    // Checked just now (at send), so nothing is asked yet.
    const before = mock.proxied.length;
    await owner.post("/api/social/posts/sync", { ids: [id] });
    expect(mock.proxied.length).toBe(before);
    // Deleted on Facebook by the person.
    const fbRow = (await ctx.db.select().from(socialPostTargets).all()).find((r) => r.app === "facebook")!;
    mock.goneRemote = new Set([fbRow.remoteId!]);
    await age(id);
    const s = await owner.post("/api/social/posts/sync", { ids: [id] });
    expect(s.status).toBe(200);
    const fb = s.body.posts[0].targets.find((t: { app: string }) => t.app === "facebook");
    expect(fb).toMatchObject({ networkState: "removed", url: null });
    // LinkedIn is never asked (it does not let us read posts back), and keeps its link.
    const li = s.body.posts[0].targets.find((t: { app: string }) => t.app === "linkedin");
    expect(li.url).toBe(post.targets.find((t: { app: string }) => t.app === "linkedin").url);
    expect(mock.proxied.some((p) => p.method === "GET" && p.endpoint.includes("/rest/posts/"))).toBe(false);
    // Asked again within 5 minutes: no network call.
    const n = mock.proxied.length;
    await owner.post("/api/social/posts/sync", { ids: [id] });
    expect(mock.proxied.length).toBe(n);
  });

  it("sync leaves a live post live and ignores posts of another workspace", async () => {
    const { id } = await postBoth();
    await age(id);
    const s = await owner.post("/api/social/posts/sync", { ids: [id] });
    expect(s.body.posts[0].targets.find((t: { app: string }) => t.app === "facebook").networkState).toBe("live");
    const other = new Client(ctx.app);
    await other.signup("other-sync@else.io");
    expect((await other.post("/api/social/posts/sync", { ids: [id] })).body.posts).toEqual([]);
  });

  it("sync works for older posts that only have the page_post address", async () => {
    const { id } = await postBoth();
    const fbRow = (await ctx.db.select().from(socialPostTargets).all()).find((r) => r.app === "facebook")!;
    await ctx.db.update(socialPostTargets).set({ remoteId: null, networkState: null, checkedAt: null, url: "https://www.facebook.com/450288358178844_122177096648704528" })
      .where(eq(socialPostTargets.accountId, fbRow.accountId));
    mock.goneRemote = new Set(["450288358178844_122177096648704528"]);
    const s = await owner.post("/api/social/posts/sync", { ids: [id] });
    expect(s.body.posts[0].targets.find((t: { app: string }) => t.app === "facebook").networkState).toBe("removed");
    expect(remoteIdOf({ app: "facebook", url: "https://www.facebook.com/122177096888704528/posts/122177096648704528", target: "450288358178844" })).toBe("450288358178844_122177096648704528");
    expect(remoteIdOf({ app: "linkedin", url: "https://www.linkedin.com/feed/update/urn:li:share:7522227262482456576", target: null })).toBe("urn:li:share:7522227262482456576");
    expect(remoteIdOf({ app: "instagram", url: "https://www.instagram.com/p/x", target: null })).toBeNull();
  });

  it("delete removes the post on Facebook and LinkedIn, then from Multies, with an audit row", async () => {
    const { id } = await postBoth();
    const d = await owner.del(`/api/social/posts/${id}`);
    expect(d.status).toBe(200);
    expect(d.body.deleted).toBe(true);
    expect(d.body.results.map((r: { outcome: string }) => r.outcome).sort()).toEqual(["deleted", "deleted"]);
    expect(mock.proxied.some((p) => p.method === "DELETE" && p.endpoint.includes("graph.facebook.com"))).toBe(true);
    expect(mock.proxied.some((p) => p.method === "DELETE" && p.endpoint.includes("/rest/posts/urn%3Ali%3Ashare%3A"))).toBe(true);
    expect(await ctx.db.select().from(socialPosts).where(eq(socialPosts.id, id)).all()).toHaveLength(0);
    expect((await owner.get("/api/social/posts")).body.posts).toHaveLength(0);
    const a = await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "social.post_deleted")).all();
    expect(a).toHaveLength(1);
  });

  it("a post already deleted on LinkedIn counts as deleted (his case)", async () => {
    const { id } = await postBoth();
    const liRow = (await ctx.db.select().from(socialPostTargets).all()).find((r) => r.app === "linkedin")!;
    mock.goneRemote = new Set([liRow.remoteId!]);
    const d = await owner.del(`/api/social/posts/${id}`);
    expect(d.body.deleted).toBe(true);
    expect(d.body.results.find((r: { app: string }) => r.app === "linkedin").outcome).toBe("already_gone");
  });

  it("a network that will not delete keeps the post, marks what went, and says which", async () => {
    const { id } = await postBoth();
    mock.deleteRefused = true;
    const d = await owner.del(`/api/social/posts/${id}`);
    expect(d.status).toBe(200);
    expect(d.body.deleted).toBe(false);
    expect(d.body.results.find((r: { app: string }) => r.app === "facebook").outcome).toBe("failed");
    expect(d.body.results.find((r: { app: string }) => r.app === "linkedin").outcome).toBe("deleted");
    const li = d.body.post.targets.find((t: { app: string }) => t.app === "linkedin");
    expect(li).toMatchObject({ networkState: "removed", url: null });
    // Trying again once the network is back finishes the job.
    mock.deleteRefused = false;
    const again = await owner.del(`/api/social/posts/${id}`);
    expect(again.body.deleted).toBe(true);
    expect(again.body.results.find((r: { app: string }) => r.app === "linkedin").outcome).toBe("already_gone");
  });

  it("a scheduled post is just removed; members cannot delete; another workspace gets 404", async () => {
    const fb = await connect(owner, "facebook");
    const later = new Date(Date.now() + 86_400_000).toISOString();
    const r = await owner.post("/api/social/posts", { text: "Later", runAt: later, targets: [{ accountId: fb, target: "pg_100" }] });
    expect(r.status).toBe(201);
    const member = new Client(ctx.app);
    await joinAs(member, "kiran-sync@acme.io");
    expect((await member.del(`/api/social/posts/${r.body.post.id}`)).status).toBe(403);
    const other = new Client(ctx.app);
    await other.signup("other2-sync@else.io");
    expect((await other.del(`/api/social/posts/${r.body.post.id}`)).status).toBe(404);
    const d = await owner.del(`/api/social/posts/${r.body.post.id}`);
    expect(d.body).toMatchObject({ deleted: true, results: [{ outcome: "not_sent" }] });
    expect(mock.proxied.some((p) => p.method === "DELETE")).toBe(false);
  });

  it("an account disconnected since posting does not block delete: the post stays there and leaves Multies", async () => {
    const { id, li } = await postBoth();
    expect((await owner.del(`/api/apps/accounts/${li}`)).status).toBe(200);
    const d = await owner.del(`/api/social/posts/${id}`);
    expect(d.body.deleted).toBe(true);
    expect(d.body.results.find((r: { app: string }) => r.app === "linkedin").outcome).toBe("not_supported");
    expect(d.body.results.find((r: { app: string }) => r.app === "facebook").outcome).toBe("deleted");
  });

  it("a Facebook permission error is not read as removed", async () => {
    const { id } = await postBoth();
    await age(id);
    mock.fbGetError = "(#100) Unsupported get request. Please read the Graph API documentation";
    const s = await owner.post("/api/social/posts/sync", { ids: [id] });
    expect(s.status).toBe(200);
    const fb = s.body.posts[0].targets.find((t: { app: string }) => t.app === "facebook");
    expect(fb.networkState).not.toBe("removed");
    expect(fb.url).toMatch(/facebook\.com/);
  });

  it("Instagram cannot be deleted from Multies: not_supported, still removed from the list", async () => {
    const ig = await connect(owner, "instagram");
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const r = await owner.post("/api/social/posts", { text: "Pic", image: { contentType: "image/png", dataB64: PNG }, targets: [{ accountId: ig }] });
    await new Promise((res) => setTimeout(res, 60));
    const d = await owner.del(`/api/social/posts/${r.body.post.id}`);
    expect(d.body).toMatchObject({ deleted: true, results: [{ app: "instagram", outcome: "not_supported" }] });
  });
});
