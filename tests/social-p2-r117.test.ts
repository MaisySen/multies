/**
 * R117: Social P2a. Pure rules (per network limits and changes, crop, slots, evergreen, roles) and the API on the
 * in memory stand in for the platform: drafts and approvals by role, the phone's list unchanged, carousels, first
 * comment and LinkedIn polls, moving a post, slots, the library, evergreen copies, and a post never sent twice.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { members, sessions, socialPostTargets, socialPosts, users } from "../src/server/db/schema";
import { mockComposioFetch, newMockState, type MockComposioState } from "../src/server/services/integrations/mock";
import { runDueSocialPosts, linkedinPoll } from "../src/server/services/integrations/social";
import {
  canEditPost, canPublish, charCount, composerChecks, cropRect, formatFit, freeSlots, pickEvergreen, pollProblem, slotTimes, textFor, zonedInstant,
} from "../src/shared/social-p2";

const ENV = { COMPOSIO_API_KEY: "ak_test_key_never_shown", COMPOSIO_BASE_URL: "https://composio.mock", APP_URL: "https://app.example.com" };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("R117 pure rules", () => {
  it("per network limits use each network's own text", () => {
    const long = "a".repeat(600);
    const checks = composerChecks({ format: "text", main: "short", texts: { threads: long }, images: [], accounts: [{ id: "t", app: "threads" }, { id: "l", app: "linkedin" }] });
    expect(checks[0]).toMatchObject({ state: "out" });
    expect(checks[0]!.notes[0]).toMatch(/Too long for Threads: 600 of 500/);
    expect(checks[1]).toMatchObject({ state: "ready" });
    expect(textFor("main", { linkedin: "  " }, "linkedin")).toBe("main");
    expect(textFor("main", { linkedin: "own" }, "linkedin")).toBe("own");
    expect(charCount("😀ab")).toBe(3);
  });

  it("says what changes and what is left out, by format", () => {
    // SOCFIX: LinkedIn now takes images and Instagram a carousel; Reddit stays text only, Pinterest one image.
    expect(formatFit("linkedin", "image")).toEqual({ fit: "yes" });
    expect(formatFit("reddit", "image")).toEqual({ fit: "changed", how: "Text only, the image is left off" });
    expect(formatFit("instagram", "carousel")).toEqual({ fit: "yes" });
    expect(formatFit("pinterest", "carousel")).toEqual({ fit: "changed", how: "First image only" });
    expect(formatFit("instagram", "text")).toMatchObject({ fit: "no" });
    expect(formatFit("tiktok", "text")).toEqual({ fit: "no", why: "TikTok takes videos." });
    expect(formatFit("tiktok", "video")).toEqual({ fit: "yes" });
    expect(formatFit("facebook", "video")).toMatchObject({ fit: "no", why: "Multies can't post videos to Facebook yet." });
    const imgs = Array.from({ length: 12 }, () => ({ w: 1000, h: 1000 }));
    const [fb] = composerChecks({ format: "carousel", main: "hi", images: imgs, accounts: [{ id: "f", app: "facebook", target: "pg", needsTarget: true }] });
    expect(fb).toMatchObject({ state: "changed" });
    expect(fb!.notes).toContain("Takes 10 images, the last 2 are left off");
    const [ig] = composerChecks({ format: "image", main: "hi", images: [{ w: 900, h: 1600 }], accounts: [{ id: "i", app: "instagram" }] });
    expect(ig!.notes.join()).toMatch(/cropped by Instagram/);
    const [noPage] = composerChecks({ format: "text", main: "hi", images: [], accounts: [{ id: "f", app: "facebook", needsTarget: true }] });
    expect(noPage).toMatchObject({ state: "out", notes: ["Pick a Page."] });
    const [broken] = composerChecks({ format: "text", main: "hi", images: [], accounts: [{ id: "f", app: "linkedin", broken: "Sign in expired." }] });
    expect(broken).toMatchObject({ state: "out", notes: ["Sign in expired."] });
    const [tt] = composerChecks({ format: "video", main: "", images: [], scheduled: true, accounts: [{ id: "x", app: "tiktok" }] });
    expect(tt!.notes[0]).toMatch(/right away/);
    const [extras] = composerChecks({ format: "text", main: "hi", images: [], extras: { firstComment: "first!" }, accounts: [{ id: "l", app: "linkedin" }] });
    expect(extras).toMatchObject({ state: "changed", notes: ["First comment is left off here"] });
  });

  it("checks polls", () => {
    expect(pollProblem({ question: "Pick one", options: ["A"], days: 3 })).toMatch(/at least 2/);
    expect(pollProblem({ question: "Pick one", options: ["A", "a"], days: 3 })).toMatch(/different/);
    expect(pollProblem({ question: "", options: ["A", "B"], days: 3 })).toMatch(/question/);
    expect(pollProblem({ question: "Q", options: ["A", "B"], days: 5 })).toMatch(/how long/);
    expect(pollProblem({ question: "Q", options: ["A", "B"], days: 7 })).toBeNull();
    expect(linkedinPoll({ question: "Q", options: ["A", " B ", ""], days: 7 })).toEqual({ question: "Q", options: [{ text: "A" }, { text: "B" }], settings: { duration: "SEVEN_DAYS" } });
  });

  it("crops to each shape", () => {
    expect(cropRect(1000, 1000, "portrait")).toEqual({ x: 100, y: 0, w: 800, h: 1000 });
    expect(cropRect(1920, 1080, "square", "start")).toEqual({ x: 0, y: 0, w: 1080, h: 1080 });
    expect(cropRect(1080, 1920, "wide", "end")).toEqual({ x: 0, y: 1355, w: 1080, h: 565 });
    expect(cropRect(500, 400, "original")).toEqual({ x: 0, y: 0, w: 500, h: 400 });
  });

  it("finds the next free slot per account, in the slot's own zone", () => {
    const tz = "Australia/Sydney";
    // Monday 9:00 and 13:00 Sydney for all accounts, Tuesday 10:00 for account b only.
    const rules = [{ accountId: null, weekday: 1, minute: 540, tz }, { accountId: null, weekday: 1, minute: 780, tz }, { accountId: "b", weekday: 2, minute: 600, tz }];
    const now = zonedInstant(2026, 10, 1, 8 * 60, tz); // Sunday 1 Nov 8:00 Sydney
    const mon9 = zonedInstant(2026, 10, 2, 540, tz);
    const mon13 = zonedInstant(2026, 10, 2, 780, tz);
    const tue10 = zonedInstant(2026, 10, 3, 600, tz);
    expect(freeSlots(rules, [], ["a"], now)[0]!.toISOString()).toBe(mon9.toISOString());
    // A post for account a at 9:00 takes that slot for a, not for c.
    const busy = [{ runAt: mon9, accountIds: ["a"], status: "scheduled" }];
    expect(freeSlots(rules, busy, ["a"], now)[0]!.toISOString()).toBe(mon13.toISOString());
    expect(freeSlots(rules, busy, ["c"], now)[0]!.toISOString()).toBe(mon9.toISOString());
    // A canceled post does not take a slot.
    expect(freeSlots(rules, [{ ...busy[0]!, status: "canceled" }], ["a"], now)[0]!.toISOString()).toBe(mon9.toISOString());
    // Account b's own slot is offered to b and not to a.
    expect(freeSlots(rules, busy, ["b"], now, { limit: 3 }).map((d) => d.toISOString())).toContain(tue10.toISOString());
    expect(freeSlots(rules, busy, ["a"], now, { limit: 3 }).map((d) => d.toISOString())).not.toContain(tue10.toISOString());
    expect(slotTimes(rules, now, 7).length).toBe(3);
  });

  it("picks evergreen posts with a gap, a cap and no back to back repeat", () => {
    const now = new Date("2026-11-20T00:00:00Z");
    const old = new Date("2026-10-01T00:00:00Z");
    const c = [
      { id: "a", accountIds: ["x"], uses: 0, lastUsedAt: old },
      { id: "b", accountIds: ["x"], uses: 1, lastUsedAt: new Date("2026-10-02T00:00:00Z") },
      { id: "c", accountIds: ["x"], uses: 10, lastUsedAt: old },
      { id: "d", accountIds: ["x"], uses: 0, lastUsedAt: new Date("2026-11-15T00:00:00Z") },
    ];
    expect(pickEvergreen(c, { now, lastSourceId: null, slotAccountId: null })!.id).toBe("a");
    expect(pickEvergreen(c, { now, lastSourceId: "a", slotAccountId: null })!.id).toBe("b");
    expect(pickEvergreen(c, { now, lastSourceId: "a", slotAccountId: "y" })).toBeNull();
    expect(pickEvergreen([c[2]!, c[3]!], { now, lastSourceId: null, slotAccountId: null })).toBeNull();
  });

  it("roles: owners and admins post and approve, members draft and submit", () => {
    expect(canPublish("owner")).toBe(true);
    expect(canPublish("member")).toBe(false);
    expect(canEditPost("member", "u1", { status: "draft", createdBy: "u1" })).toBe(true);
    expect(canEditPost("member", "u1", { status: "draft", createdBy: "u2" })).toBe(false);
    expect(canEditPost("member", "u1", { status: "review", createdBy: "u1" })).toBe(false);
    expect(canEditPost("admin", "u9", { status: "review", createdBy: "u1" })).toBe(true);
    expect(canEditPost("admin", "u9", { status: "done", createdBy: "u1" })).toBe(false);
  });
});

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let mock: MockComposioState;
let owner: Client;

async function connect(c: Client, app: string) {
  const r = await c.post("/api/apps/connect", { app });
  const id = new URL(r.body.redirectUrl).searchParams.get("connected_account_id")!;
  await c.post(`/api/apps/accounts/${id}/confirm`);
  return id;
}
async function joinAs(email: string, role: "member" | "admin" = "member") {
  const c = new Client(ctx.app);
  const o = (await ctx.db.select().from(users).where(eq(users.email, "owner-p2@acme.io")).get())!;
  const orgId = (await ctx.db.select().from(members).where(eq(members.userId, o.id)).get())!.organizationId;
  await c.signup(email, "Kiran Rao", "");
  const u = (await ctx.db.select().from(users).where(eq(users.email, email)).get())!;
  await ctx.db.insert(members).values({ id: `mem_${u.id}`, organizationId: orgId, userId: u.id, role });
  await ctx.db.update(sessions).set({ activeOrganizationId: orgId }).where(eq(sessions.userId, u.id));
  return c;
}
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const feedPosts = () => mock.proxied.filter((p) => p.method === "POST" && /\/(feed|photos)$/.test(p.endpoint) && p.body.published !== false);

beforeEach(async () => {
  mock = newMockState();
  ctx = await makeTestApp(ENV, { fetch: mockComposioFetch(async () => { throw new Error("network disabled in tests"); }, mock) });
  owner = new Client(ctx.app);
  await owner.signup("owner-p2@acme.io");
});

describe("R117 drafts and approvals", () => {
  it("member drafts and submits; the phone's list stays the same; an approver approves and it goes out once", async () => {
    const fb = await connect(owner, "facebook");
    const li = await connect(owner, "linkedin");
    const member = await joinAs("member-p2@acme.io");
    const send = await member.post("/api/social/posts", { text: "Member post", targets: [{ accountId: fb, target: "pg_100" }] });
    expect(send.status).toBe(403);
    const draft = await member.post("/api/social/posts", { text: "Draft first", targets: [], mode: "draft" });
    expect(draft.status).toBe(201);
    expect(draft.body.post.status).toBe("draft");
    const sub = await member.call("PATCH", `/api/social/posts/${draft.body.post.id}`, { text: "Launch week", texts: { linkedin: "Launch week, for LinkedIn" }, targets: [{ accountId: fb, target: "pg_100" }, { accountId: li }], mode: "submit", campaign: " Spring  launch " });
    expect(sub.status).toBe(200);
    expect(sub.body.post).toMatchObject({ status: "review", campaign: "Spring launch", texts: { linkedin: "Launch week, for LinkedIn" } });
    // The phone app's list never shows drafts or waiting posts unless it asks.
    expect((await owner.get("/api/social/posts")).body.posts).toHaveLength(0);
    expect((await owner.get("/api/social/posts?all=1")).body.posts).toHaveLength(1);
    // Members can't approve.
    expect((await member.post(`/api/social/posts/${draft.body.post.id}/approve`)).status).toBe(403);
    expect((await owner.get("/api/social/approvals")).body.posts).toHaveLength(1);
    // Asking for changes needs a note.
    expect((await owner.post(`/api/social/posts/${draft.body.post.id}/changes`, {})).status).toBe(422);
    const ch = await owner.post(`/api/social/posts/${draft.body.post.id}/changes`, { note: "Add the date" });
    expect(ch.body.post).toMatchObject({ status: "changes", reviewNote: "Add the date" });
    await member.call("PATCH", `/api/social/posts/${draft.body.post.id}`, { text: "Launch week, Nov 3", texts: { linkedin: "Launch week, for LinkedIn" }, targets: [{ accountId: fb, target: "pg_100" }, { accountId: li }], mode: "submit" });
    const ok = await owner.post(`/api/social/posts/${draft.body.post.id}/approve`);
    expect(ok.status).toBe(200);
    await wait(80);
    // A second approve is refused; nothing goes twice.
    expect((await owner.post(`/api/social/posts/${draft.body.post.id}/approve`)).status).toBe(409);
    await runDueSocialPosts({ ...ctx.deps } as never);
    const post = (await owner.get(`/api/social/posts/${draft.body.post.id}`)).body.post;
    expect(post.status).toBe("done");
    expect(feedPosts()).toHaveLength(1);
    const liBody = mock.proxied.find((p) => p.endpoint.endsWith("/rest/posts") && p.method === "POST")!.body;
    expect(String(liBody.commentary)).toContain("for LinkedIn");
  });

  it("reject keeps the note; a member discards their own draft", async () => {
    const fb = await connect(owner, "facebook");
    const member = await joinAs("member-p2b@acme.io");
    const r = await member.post("/api/social/posts", { text: "Maybe", targets: [{ accountId: fb, target: "pg_100" }], mode: "submit" });
    expect(r.body.post.status).toBe("review");
    const rej = await owner.post(`/api/social/posts/${r.body.post.id}/reject`, { note: "Off brand" });
    expect(rej.body.post).toMatchObject({ status: "rejected", reviewNote: "Off brand" });
    const d = await member.post("/api/social/posts", { text: "Mine", targets: [], mode: "draft" });
    expect((await member.post(`/api/social/posts/${d.body.post.id}/discard`)).status).toBe(200);
    expect((await owner.get("/api/social/posts?all=1")).body.posts.map((p: { id: string }) => p.id)).not.toContain(d.body.post.id);
  });
});

describe("R117 publishing", () => {
  it("never sends a scheduled post twice, even with two passes at once", async () => {
    const fb = await connect(owner, "facebook");
    const at = new Date(Date.now() + 3600_000).toISOString();
    const r = await owner.post("/api/social/posts", { text: "Later", targets: [{ accountId: fb, target: "pg_100" }], runAt: at });
    expect(r.body.post.status).toBe("scheduled");
    const later = new Date(Date.now() + 2 * 3600_000);
    const deps = { ...ctx.deps, now: () => later } as never;
    const [a, b] = await Promise.all([runDueSocialPosts(deps, { now: later }), runDueSocialPosts(deps, { now: later })]);
    expect(a.sent + b.sent).toBe(1);
    expect(feedPosts()).toHaveLength(1);
    await runDueSocialPosts(deps, { now: new Date(later.getTime() + 3600_000) });
    expect(feedPosts()).toHaveLength(1);
  });

  it("a carousel goes to Facebook as one multi photo post with a first comment; LinkedIn gets the text and a poll", async () => {
    const fb = await connect(owner, "facebook");
    const li = await connect(owner, "linkedin");
    const imgs = [1, 2, 3].map(() => ({ contentType: "image/png", dataB64: PNG }));
    const r = await owner.post("/api/social/posts", {
      text: "Three photos", format: "carousel", images: imgs, targets: [{ accountId: fb, target: "pg_100" }, { accountId: li }],
      extras: { firstComment: "Link in bio", poll: { question: "Which one?", options: ["First", "Second"], days: 3 } },
    });
    expect(r.status).toBe(201);
    await wait(100);
    const unpublished = mock.proxied.filter((p) => /\/photos$/.test(p.endpoint) && p.body.published === false);
    expect(unpublished).toHaveLength(3);
    const feed = mock.proxied.find((p) => /\/feed$/.test(p.endpoint))!;
    expect((feed.body.attached_media as unknown[]).length).toBe(3);
    expect(mock.proxied.some((p) => /\/comments$/.test(p.endpoint) && p.body.message === "Link in bio")).toBe(true);
    const liBody = mock.proxied.find((p) => p.endpoint.endsWith("/rest/posts") && p.method === "POST")!.body as { content?: { poll?: { question: string } } };
    expect(liBody.content?.poll?.question).toBe("Which one?");
    const post = (await owner.get(`/api/social/posts/${r.body.post.id}`)).body.post;
    expect(post.status).toBe("done");
    expect(post.images).toHaveLength(3);
  });

  it("a first comment that is turned down is a note, not a failed post", async () => {
    mock.commentRefused = true;
    const fb = await connect(owner, "facebook");
    const r = await owner.post("/api/social/posts", { text: "Hello", targets: [{ accountId: fb, target: "pg_100" }], extras: { firstComment: "Hi" } });
    await wait(80);
    const post = (await owner.get(`/api/social/posts/${r.body.post.id}`)).body.post;
    expect(post.status).toBe("done");
    expect(post.targets[0].note).toMatch(/First comment didn't go/);
  });

  it("a failed scheduled post keeps its reason, can be tried again, and tells its author", async () => {
    const fb = await connect(owner, "facebook");
    const r = await owner.post("/api/social/posts", { text: "FAIL please", targets: [{ accountId: fb, target: "pg_100" }] });
    await wait(80);
    const post = (await owner.get(`/api/social/posts/${r.body.post.id}`)).body.post;
    expect(post.status).toBe("failed");
    expect(post.targets[0].error).toMatch(/^rejected/);
    const notes = (await owner.get("/api/notifications")).body;
    expect(JSON.stringify(notes)).toMatch(/Not posted: FAIL please/);
    expect((await owner.post(`/api/social/posts/${r.body.post.id}/retry`)).status).toBe(200);
  });

  it("server checks refuse what a network can't take", async () => {
    const ig = await connect(owner, "instagram");
    const r = await owner.post("/api/social/posts", { text: "No image", format: "text", targets: [{ accountId: ig }] });
    expect(r.status).toBe(422);
    expect(r.body.details?.problems?.[0]?.code ?? r.body.error?.details?.problems?.[0]?.code).toBeTruthy();
  });
});

describe("R117 planner, slots, library, evergreen", () => {
  it("moves a scheduled post and refuses one that has gone out", async () => {
    const fb = await connect(owner, "facebook");
    const r = await owner.post("/api/social/posts", { text: "Move me", targets: [{ accountId: fb, target: "pg_100" }], runAt: new Date(Date.now() + 3600_000).toISOString() });
    const to = new Date(Date.now() + 5 * 3600_000).toISOString();
    const m = await owner.post(`/api/social/posts/${r.body.post.id}/move`, { runAt: to });
    expect(m.status).toBe(200);
    expect(m.body.post.runAt).toBe(to);
    expect((await owner.post(`/api/social/posts/${r.body.post.id}/move`, { runAt: new Date(Date.now() - 1000).toISOString() })).status).toBe(422);
    const now = await owner.post("/api/social/posts", { text: "Now", targets: [{ accountId: fb, target: "pg_100" }] });
    await wait(80);
    expect((await owner.post(`/api/social/posts/${now.body.post.id}/move`, { runAt: to })).status).toBe(409);
  });

  it("saves slots (owners and admins) and offers the next free one", async () => {
    const fb = await connect(owner, "facebook");
    const member = await joinAs("member-p2c@acme.io");
    const slots = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, minute: 9 * 60 }));
    expect((await member.call("PUT", "/api/social/slots", { tz: "UTC", slots })).status).toBe(403);
    const s = await owner.call("PUT", "/api/social/slots", { tz: "UTC", slots: [...slots, ...slots] });
    expect(s.body.slots).toHaveLength(7);
    const n = await owner.get(`/api/social/slots/next?accounts=${fb}&limit=2`);
    expect(n.body.hasSlots).toBe(true);
    expect(n.body.slots).toHaveLength(2);
    expect(new Date(n.body.slots[0]).getUTCHours()).toBe(9);
  });

  it("library: add an image, caption and hashtags, count bytes, pick it in a post, remove it", async () => {
    const fb = await connect(owner, "facebook");
    const img = await owner.post("/api/social/library", { kind: "image", name: "Logo", image: { contentType: "image/png", dataB64: PNG }, campaign: "Spring" });
    expect(img.status).toBe(201);
    expect(img.body.item.imageUrl).toMatch(/\/api\/social\/media\//);
    await owner.post("/api/social/library", { kind: "hashtags", name: "Launch tags", body: "launch, multies #spring" });
    const lib = (await owner.get("/api/social/library")).body;
    expect(lib.items).toHaveLength(2);
    expect(lib.items.find((i: { kind: string }) => i.kind === "hashtags").body).toBe("#launch #multies #spring");
    expect(lib.usedBytes).toBeGreaterThan(0);
    const mediaId = img.body.item.mediaId as string;
    const r = await owner.post("/api/social/posts", { text: "With logo", images: [{ mediaId }], targets: [{ accountId: fb, target: "pg_100" }] });
    expect(r.status).toBe(201);
    await wait(80);
    expect(mock.proxied.some((p) => /\/photos$/.test(p.endpoint) && String(p.body.url).includes(mediaId))).toBe(true);
    expect((await owner.call("DELETE", `/api/social/library/${img.body.item.id}`)).status).toBe(200);
    const other = new Client(ctx.app);
    await other.signup("other-p2@else.io");
    expect((await other.post("/api/social/posts", { text: "x", images: [{ mediaId }], targets: [], mode: "draft" })).status).toBe(422);
  });

  it("evergreen posts fill free slots without repeating back to back", async () => {
    const fb = await connect(owner, "facebook");
    const r1 = await owner.post("/api/social/posts", { text: "Evergreen one", evergreen: true, targets: [{ accountId: fb, target: "pg_100" }] });
    const r2 = await owner.post("/api/social/posts", { text: "Evergreen two", evergreen: true, targets: [{ accountId: fb, target: "pg_100" }] });
    await wait(100);
    // Pretend both went out a month ago.
    const monthAgo = new Date(Date.now() - 30 * 86_400_000);
    for (const id of [r1.body.post.id, r2.body.post.id]) await ctx.db.update(socialPosts).set({ runAt: monthAgo }).where(eq(socialPosts.id, id));
    await owner.call("PUT", "/api/social/slots", { tz: "UTC", slots: [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) => [{ weekday, minute: 9 * 60 }, { weekday, minute: 15 * 60 }]) });
    const { runEvergreen } = await import("../src/server/services/integrations/social-p2");
    const res = await runEvergreen(ctx.deps as never);
    expect(res.made).toBeGreaterThanOrEqual(2);
    expect(res.made).toBeLessThanOrEqual(3);
    const copies = await ctx.db.select().from(socialPosts).where(eq(socialPosts.status, "scheduled")).all();
    const order = copies.sort((a, b) => a.runAt.getTime() - b.runAt.getTime()).map((c) => c.evergreenOf);
    for (let i = 1; i < order.length; i++) expect(order[i]).not.toBe(order[i - 1]);
    const targets = await ctx.db.select().from(socialPostTargets).all();
    expect(targets.filter((t) => t.status === "pending").length).toBe(copies.length);
    // A second pass inside the same week stays under the cap.
    const again = await runEvergreen(ctx.deps as never);
    expect(res.made + again.made).toBeLessThanOrEqual(3);
  });
});
