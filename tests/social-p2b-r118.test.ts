/**
 * R118: Social P2b. Pure rules (what each network allows, the 24 hour reply window, saved replies, results and best
 * times, the test network guard) and the API on the staging only test network: the inbox (pull, assign, notes,
 * replies, done, contact, task), saved replies, health in the bell, analytics, and prod refusing the test network.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { members, notifications, sessions, socialInboxItems, socialPostStats, users } from "../src/server/db/schema";
import { loadConfig } from "../src/server/config";
import {
  bestTimes, byAccount, capList, capsOf, engagementRate, fillSavedReply, fmtCount, fmtLeft, hasInbox, parseInboxQuery, replyWindow, testNetworkAllowed, totalsOf,
} from "../src/shared/social-p2b";
import { testStats } from "../src/server/services/integrations/social-p2b";

const H = 3_600_000;

describe("R118 pure rules", () => {
  it("says what each network can do; LinkedIn is posting only, honestly", () => {
    expect(capList("facebook")).toEqual(["Posts", "Comments", "Messages", "Analytics"]);
    expect(capList("linkedin")).toEqual(["Posts"]);
    expect(capsOf("linkedin").note).toMatch(/^Posting only/);
    expect(capList("instagram")).toContain("Mentions");
    expect(hasInbox("reddit")).toBe(true);
    expect(hasInbox("linkedin")).toBe(false);
    expect(hasInbox("unknown_network")).toBe(false);
    expect(capsOf("unknown_network").posts).toBe(true);
  });

  it("counts the 24 hour reply window on Meta messages only", () => {
    const now = Date.parse("2026-10-31T12:00:00Z");
    expect(replyWindow("facebook", "message", new Date(now - 2 * H), now)).toMatchObject({ state: "open", text: "Reply within 22 h" });
    expect(replyWindow("instagram", "message", new Date(now - 23.5 * H), now)).toMatchObject({ state: "open", text: "Reply within 30 min" });
    expect(replyWindow("facebook", "message", new Date(now - 25 * H), now)).toMatchObject({ state: "closed" });
    expect((replyWindow("facebook", "message", new Date(now - 25 * H), now) as { text: string }).text).toMatch(/Facebook only takes replies within 24 hours/);
    expect(replyWindow("facebook", "comment", new Date(now - 48 * H), now)).toEqual({ state: "none" });
    expect(replyWindow("reddit", "message", new Date(now - 48 * H), now)).toEqual({ state: "none" });
    expect(replyWindow("facebook", "message", null, now)).toEqual({ state: "none" });
    expect(fmtLeft(10)).toBe("1 min");
  });

  it("reads the list query and fills saved replies", () => {
    expect(parseInboxQuery({})).toEqual({ status: "open", view: "all", app: null, search: null });
    expect(parseInboxQuery({ status: "done", view: "mine", app: "facebook", q: "  hi " })).toEqual({ status: "done", view: "mine", app: "facebook", search: "hi" });
    expect(parseInboxQuery({ app: "drop table", view: "x" })).toMatchObject({ app: null, view: "all" });
    expect(fillSavedReply("Hi {name}, thanks!", "Mia Chen")).toBe("Hi Mia, thanks!");
    expect(fillSavedReply("Hi {name}, thanks!", null)).toBe("Hi, thanks!");
  });

  it("adds up results and finds the best times in the viewer's time zone", () => {
    const rows = [
      { postId: "a", accountId: "f", app: "facebook", label: "Facebook", text: "", url: null, sentAt: "2026-10-26T22:00:00Z", reach: 1000, engagement: 100, clicks: 10 },
      { postId: "a", accountId: "i", app: "instagram", label: "Instagram", text: "", url: null, sentAt: "2026-10-26T22:00:00Z", reach: 500, engagement: 10, clicks: null },
      { postId: "b", accountId: "f", app: "facebook", label: "Facebook", text: "", url: null, sentAt: "2026-10-27T05:00:00Z", reach: null, engagement: null, clicks: null },
    ];
    expect(totalsOf(rows)).toEqual({ posts: 2, reach: 1500, engagement: 110, clicks: 10, rate: 110 / 1500 });
    expect(byAccount(rows)[0]).toMatchObject({ accountId: "f", posts: 2, engagement: 100 });
    expect(engagementRate(0, 5)).toBeNull();
    // Sydney (UTC+11): 22:00 UTC Monday is 9 am Tuesday.
    const b = bestTimes(rows, -660);
    expect(b.ready).toBe(false);
    expect(b.need).toBe(3);
    expect(b.top[0]).toMatchObject({ day: 1, hour: 9 });
    const many = Array.from({ length: 6 }, (_, i) => ({ sentAt: `2026-10-2${i}T09:00:00Z`, reach: 100, engagement: i }));
    expect(bestTimes(many, 0).ready).toBe(true);
    expect(fmtCount(1234)).toBe("1.2k");
    expect(fmtCount(null)).toBe("No data");
  });

  it("allows the test network only on staging or a local machine, never on multies.si", () => {
    expect(testNetworkAllowed({ SOCIAL_TEST_NETWORK: "on", APP_URL: "https://preview.multies.si", SENTRY_ENVIRONMENT: "staging" })).toBe(true);
    expect(testNetworkAllowed({ SOCIAL_TEST_NETWORK: "on", APP_URL: "http://localhost:8787" })).toBe(true);
    expect(testNetworkAllowed({ SOCIAL_TEST_NETWORK: "on", APP_URL: "https://mymail-staging.mymail-app.workers.dev" })).toBe(true);
    expect(testNetworkAllowed({ SOCIAL_TEST_NETWORK: "on", APP_URL: "https://multies.si" })).toBe(false);
    expect(testNetworkAllowed({ SOCIAL_TEST_NETWORK: "on", APP_URL: "https://www.multies.si" })).toBe(false);
    expect(testNetworkAllowed({ SOCIAL_TEST_NETWORK: "on", APP_URL: "https://preview.multies.si", SENTRY_ENVIRONMENT: "production" })).toBe(false);
    expect(testNetworkAllowed({ SOCIAL_TEST_NETWORK: "on", APP_URL: "https://evil.example.com" })).toBe(false);
    expect(testNetworkAllowed({ APP_URL: "http://localhost:8787" })).toBe(false);
  });

  it("prod config refuses the test network even with the switch on", () => {
    const prod = loadConfig({ APP_URL: "https://multies.si", SENTRY_ENVIRONMENT: "production", SOCIAL_TEST_NETWORK: "on" });
    expect(prod.socialTestNetwork).toBe(false);
    const staging = loadConfig({ APP_URL: "https://preview.multies.si", SENTRY_ENVIRONMENT: "staging", SOCIAL_TEST_NETWORK: "on" });
    expect(staging.socialTestNetwork).toBe(true);
    expect(loadConfig({ APP_URL: "https://preview.multies.si" }).socialTestNetwork).toBe(false);
    expect(loadConfig({}).socialP2b).toBe(true);
    expect(loadConfig({ SOCIAL_P2B: "off" }).socialP2b).toBe(false);
  });

  it("makes stable test results that grow for two days", () => {
    const sent = new Date("2026-10-30T09:00:00Z");
    const a = testStats("sp_1", sent, new Date("2026-10-30T10:00:00Z"));
    const b = testStats("sp_1", sent, new Date("2026-11-02T10:00:00Z"));
    expect(b.reach).toBeGreaterThan(a.reach);
    expect(testStats("sp_1", sent, new Date("2026-11-02T10:00:00Z"))).toEqual(b);
  });
});

const ENV = { APP_URL: "http://localhost:8787", SOCIAL_TEST_NETWORK: "on" };
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;
const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));

async function joinAs(email: string, role: "member" | "admin" = "member") {
  const c = new Client(ctx.app);
  const o = (await ctx.db.select().from(users).where(eq(users.email, "owner-p2b@acme.io")).get())!;
  const orgId = (await ctx.db.select().from(members).where(eq(members.userId, o.id)).get())!.organizationId;
  await c.signup(email, "Kiran Rao", "");
  const u = (await ctx.db.select().from(users).where(eq(users.email, email)).get())!;
  await ctx.db.insert(members).values({ id: `mem_${u.id}`, organizationId: orgId, userId: u.id, role });
  await ctx.db.update(sessions).set({ activeOrganizationId: orgId }).where(eq(sessions.userId, u.id));
  return { c, userId: u.id, orgId };
}
async function ownerId() { return (await ctx.db.select().from(users).where(eq(users.email, "owner-p2b@acme.io")).get())!.id; }
async function postToTest(text: string) {
  const r = await owner.post("/api/social/posts", { text, targets: [{ accountId: "direct:testnet" }] });
  await wait(150);
  return r;
}
async function items(c: Client = owner, q = "") { return (await c.get(`/api/social/inbox${q}`)).body; }

beforeEach(async () => {
  ctx = await makeTestApp(ENV);
  owner = new Client(ctx.app);
  await owner.signup("owner-p2b@acme.io");
});

describe("R118 test network (staging only)", () => {
  it("an admin adds it; it shows in the composer's accounts and takes posts like a real network", async () => {
    const { c: member } = await joinAs("member-p2b@acme.io");
    expect((await member.post("/api/social/test-network")).status).toBe(403);
    expect((await owner.get("/api/social/test-network")).body).toEqual({ available: true, account: null });
    expect((await owner.post("/api/social/test-network")).status).toBe(201);
    expect((await owner.get("/api/direct/status")).body.test).toMatchObject({ id: "direct:testnet", name: "Test network", broken: false });
    const ok = await postToTest("Hello test network");
    expect(ok.status).toBe(201);
    const post = (await owner.get(`/api/social/posts/${ok.body.post.id}`)).body.post;
    expect(post.status).toBe("done");
    expect(post.targets[0]).toMatchObject({ app: "testnet", status: "sent" });
    const bad = await postToTest("Please FAIL this one");
    expect((await owner.get(`/api/social/posts/${bad.body.post.id}`)).body.post.status).toBe("failed");
  });

  it("signed out: the post can't be made, health says reconnect, and the bell rings once", async () => {
    await owner.post("/api/social/test-network");
    await owner.post("/api/social/test-network/signed-out", { broken: true });
    const h = (await owner.get("/api/social/health?fresh=1")).body.accounts;
    expect(h).toContainEqual(expect.objectContaining({ accountId: "direct:testnet", ok: false, code: "reconnect" }));
    await owner.get("/api/social/health?fresh=1");
    const me = await ownerId();
    const rang = await ctx.db.select().from(notifications).where(and(eq(notifications.userId, me), eq(notifications.type, "social.account_broken"))).all();
    expect(rang).toHaveLength(1);
    const r = await owner.post("/api/social/posts", { text: "while signed out", targets: [{ accountId: "direct:testnet" }] });
    expect(r.status).toBe(422);
    await owner.post("/api/social/test-network/signed-out", { broken: false });
    expect((await owner.get("/api/social/health?fresh=1")).body.accounts).toContainEqual(expect.objectContaining({ accountId: "direct:testnet", ok: true }));
  });

  it("prod refuses it: no test network, no routes, nothing in the composer", async () => {
    const prod = await makeTestApp({ APP_URL: "https://multies.si", SENTRY_ENVIRONMENT: "production", SOCIAL_TEST_NETWORK: "on" });
    const c = new Client(prod.app);
    await c.signup("prod-p2b@acme.io");
    expect((await c.get("/api/social/test-network")).body).toEqual({ available: false, account: null });
    expect((await c.post("/api/social/test-network")).status).toBe(404);
    expect((await c.get("/api/direct/status")).body.test ?? null).toBeNull();
    const r = await c.post("/api/social/posts", { text: "sneaky", targets: [{ accountId: "direct:testnet" }] });
    expect(r.status).toBe(422);
  });
});

describe("R118 inbox", () => {
  beforeEach(async () => { await owner.post("/api/social/test-network"); });

  it("pulls comments, messages and mentions; the first pull rings no bell, later ones do", async () => {
    const first = await items();
    expect(first.stale).toBe(true);
    expect((await owner.post("/api/social/inbox/sync")).body).toMatchObject({ added: 4, skipped: false });
    const list = await items();
    expect(list.items.map((i: { kind: string }) => i.kind).sort()).toEqual(["comment", "mention", "message", "message"]);
    expect(list.counts).toMatchObject({ open: 4, unassigned: 4, mine: 0, done: 0 });
    expect(list.sources).toContainEqual(expect.objectContaining({ app: "testnet", state: "ok" }));
    const me = await ownerId();
    expect(await ctx.db.select().from(notifications).where(and(eq(notifications.userId, me), eq(notifications.type, "social.inbox_new"))).all()).toHaveLength(0);
    await postToTest("A new post");
    ctx.deps.now = () => new Date(Date.now() + 60_000);
    expect((await owner.post("/api/social/inbox/sync")).body.added).toBe(1);
    expect(await ctx.db.select().from(notifications).where(and(eq(notifications.userId, me), eq(notifications.type, "social.inbox_new"))).all()).toHaveLength(1);
    // A second ask inside 30 seconds is held back.
    expect((await owner.post("/api/social/inbox/sync")).body.skipped).toBe(true);
    expect((await items(owner, "?q=workshop")).items).toHaveLength(1);
    expect((await items(owner, "?app=facebook")).items).toHaveLength(0);
  });

  it("replies go to the network, failures say why, and a closed window refuses", async () => {
    await owner.post("/api/social/inbox/sync");
    const list = (await items()).items as { id: string; kind: string; authorName: string }[];
    const comment = list.find((i) => i.kind === "comment")!;
    const open = list.find((i) => i.authorName === "Jordan Lee")!;
    const closed = list.find((i) => i.authorName === "Priya Patel")!;
    const r = await owner.post(`/api/social/inbox/${comment.id}/reply`, { text: "Next week!" });
    expect(r.status).toBe(201);
    expect(r.body.note).toMatchObject({ kind: "reply", status: "sent" });
    expect(r.body.item.repliedAt).toBeTruthy();
    expect(r.body.item.assigneeId).toBe(await ownerId());
    const f = await owner.post(`/api/social/inbox/${comment.id}/reply`, { text: "please FAIL" });
    expect(f.body.note).toMatchObject({ status: "failed" });
    expect(f.body.note.error).toMatch(/turned the reply down/);
    expect((await owner.post(`/api/social/inbox/${open.id}/reply`, { text: "Yes, see you then" })).body.note.status).toBe("sent");
    const c = await owner.post(`/api/social/inbox/${closed.id}/reply`, { text: "Here you go" });
    expect(c.status).toBe(422);
    expect(c.body.error.code ?? c.body.code).toBe("window_closed");
    expect((await owner.post(`/api/social/inbox/${comment.id}/reply`, { text: "   " })).status).toBe(400);
    const thread = (await owner.get(`/api/social/inbox/${comment.id}`)).body;
    expect(thread.notes.map((n: { status: string }) => n.status)).toEqual(["sent", "failed"]);
  });

  it("members take or let go; only admins assign others; notes, done, contact and task", async () => {
    await owner.post("/api/social/inbox/sync");
    const { c: member, userId: memberId } = await joinAs("member-p2b@acme.io");
    const it0 = (await items(member)).items[0] as { id: string };
    expect((await member.call("PATCH", `/api/social/inbox/${it0.id}`, { assigneeId: await ownerId() })).status).toBe(403);
    expect((await member.call("PATCH", `/api/social/inbox/${it0.id}`, { assigneeId: memberId })).body.item.assigneeId).toBe(memberId);
    expect((await items(member, "?view=mine")).items).toHaveLength(1);
    expect((await member.call("PATCH", `/api/social/inbox/${it0.id}`, { assigneeId: null })).status).toBe(200);
    const it1 = (await items()).items[1] as { id: string };
    expect((await owner.call("PATCH", `/api/social/inbox/${it1.id}`, { assigneeId: memberId })).status).toBe(200);
    expect(await ctx.db.select().from(notifications).where(and(eq(notifications.userId, memberId), eq(notifications.type, "social.inbox_assigned"))).all()).toHaveLength(1);
    expect((await owner.call("PATCH", `/api/social/inbox/${it1.id}`, { assigneeId: "usr_nobody" })).status).toBe(422);
    const note = await member.post(`/api/social/inbox/${it1.id}/notes`, { text: "Customer since 2020" });
    expect(note.status).toBe(201);
    expect(note.body.note).toMatchObject({ kind: "note", text: "Customer since 2020" });
    expect((await member.call("PATCH", `/api/social/inbox/${it1.id}`, { status: "done" })).body.item.status).toBe("done");
    expect((await items(owner, "?status=done")).items).toHaveLength(1);
    expect((await items()).counts.done).toBe(1);
    const contact = await owner.post("/api/contacts", { name: "Mia Chen", email: "mia@example.com" });
    expect(contact.status).toBe(201);
    const linked = await owner.call("PATCH", `/api/social/inbox/${it1.id}`, { contactId: contact.body.contact.id });
    expect(linked.body.item.contactName).toBe("Mia Chen");
    expect((await owner.call("PATCH", `/api/social/inbox/${it1.id}`, { contactId: "ct_missing" })).status).toBe(404);
    const t1 = await owner.post(`/api/social/inbox/${it1.id}/task`);
    expect(t1.status).toBe(201);
    const t2 = await owner.post(`/api/social/inbox/${it1.id}/task`);
    expect(t2.body.taskId).toBe(t1.body.taskId);
  });

  it("another workspace sees none of it", async () => {
    await owner.post("/api/social/inbox/sync");
    const id = ((await items()).items[0] as { id: string }).id;
    const other = new Client(ctx.app);
    await other.signup("other-p2b@else.io");
    expect((await other.get(`/api/social/inbox/${id}`)).status).toBe(404);
    expect((await other.call("PATCH", `/api/social/inbox/${id}`, { status: "done" })).status).toBe(404);
    expect((await other.get("/api/social/inbox")).body.items).toHaveLength(0);
    const row = await ctx.db.select().from(socialInboxItems).where(eq(socialInboxItems.id, id)).get();
    expect(row?.status).toBe("open");
  });
});

describe("R118 saved replies, analytics and the flag", () => {
  it("owners and admins change saved replies; members read them", async () => {
    const { c: member } = await joinAs("member-p2b@acme.io");
    expect((await member.post("/api/social/saved-replies", { title: "Hours", body: "We open at 9" })).status).toBe(403);
    const r = await owner.post("/api/social/saved-replies", { title: "Hours", body: "Hi {name}, we open at 9." });
    expect(r.status).toBe(201);
    expect((await owner.post("/api/social/saved-replies", { title: " ", body: "x" })).status).toBe(400);
    expect((await member.get("/api/social/saved-replies")).body.replies).toEqual([{ id: r.body.reply.id, title: "Hours", body: "Hi {name}, we open at 9." }]);
    expect((await owner.call("PATCH", `/api/social/saved-replies/${r.body.reply.id}`, { title: "Opening hours", body: "Hi {name}, 9 to 5." })).body.reply.title).toBe("Opening hours");
    expect((await member.call("DELETE", `/api/social/saved-replies/${r.body.reply.id}`)).status).toBe(403);
    expect((await owner.call("DELETE", `/api/social/saved-replies/${r.body.reply.id}`)).status).toBe(200);
    expect((await owner.get("/api/social/saved-replies")).body.replies).toHaveLength(0);
  });

  it("results come in for sent posts and show per post and account", async () => {
    await owner.post("/api/social/test-network");
    expect((await owner.get("/api/social/analytics")).body).toMatchObject({ rows: [], sent: 0 });
    await postToTest("Results please");
    await postToTest("Another one");
    const before = (await owner.get("/api/social/analytics?range=7")).body;
    expect(before.sent).toBe(2);
    expect(before.stale).toBe(true);
    expect(before.rows[0].reach).toBeNull();
    expect((await owner.post("/api/social/analytics/sync")).body.fetched).toBe(2);
    expect(await ctx.db.select().from(socialPostStats).all()).toHaveLength(2);
    const after = (await owner.get("/api/social/analytics?range=7")).body;
    expect(after.rows[0].reach).toBeGreaterThan(0);
    expect(after.stale).toBe(false);
    expect(after.accounts).toEqual([expect.objectContaining({ app: "testnet", supported: true })]);
    expect((await owner.get("/api/social/analytics?range=13")).body.range).toBe(30);
  });

  it("SOCIAL_P2B off hides the inbox and analytics", async () => {
    const off = await makeTestApp({ SOCIAL_P2B: "off" });
    const c = new Client(off.app);
    await c.signup("off-p2b@acme.io");
    expect((await c.get("/api/social/inbox")).status).toBe(404);
    expect((await c.get("/api/social/analytics")).status).toBe(404);
    expect((await c.get("/api/config")).body.socialP2b).toBe(false);
  });
});
