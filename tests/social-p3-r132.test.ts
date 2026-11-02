/**
 * R132: Social P3. Pure rules (pin, YouTube and Business Profile details, held sub flags, the Snapchat share link,
 * best times in a named time zone with the few posts fallback, writing help cleaning) and the API on mocks: pin
 * details reach the pin tool, YouTube comments come into the inbox and a reply goes back, health rows with Reconnect
 * codes, best times, writing help with its daily limit, the share page, and flag off answers 404.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { members, sessions, socialPostStats, socialPostTargets, socialPosts, users } from "../src/server/db/schema";
import { mockComposioFetch, newMockState, type MockComposioState } from "../src/server/services/integrations/mock";
import {
  bestSlots, cleanP3, cleanRewrite, detailsProblem, fitText, gbpBody, isHttpsLink, nextAt, p3PostApps, p3SourceApps, pinArgs, snapShareHref, youtubeArgs, zoned,
  BEST_MIN_POSTS, WRITE_DAILY, WRITE_LIMIT_MESSAGE,
} from "../src/shared/social-p3";
import { composerChecks } from "../src/shared/social-p2";
import { mapYoutubeThreads, snapSharePage, youtubeReplyBody } from "../src/server/services/integrations/social-p3";

describe("R132 pure rules", () => {
  it("keeps held networks hidden unless their own flag is on", () => {
    expect(p3PostApps({ p3: false, youtubeUpload: true, gbp: true })).toEqual([]);
    expect(p3PostApps({ p3: true })).toEqual([]);
    expect(p3PostApps({ p3: true, youtubeUpload: true })).toEqual(["youtube"]);
    expect(p3SourceApps({ p3: true })).toEqual(["youtube"]);
    expect(p3SourceApps({ p3: true, gbp: true })).toEqual(["youtube", "google_business_profile"]);
    expect(p3SourceApps({ p3: false, gbp: true })).toEqual([]);
  });

  it("checks pin details", () => {
    expect(detailsProblem("pinterest", "Hi", { pin: { title: "x".repeat(101) } })).toMatch(/Pin title is too long/);
    expect(detailsProblem("pinterest", "Hi", { pin: { link: "http://acme.com" } })).toMatch(/https/);
    expect(detailsProblem("pinterest", "Hi", { pin: { link: "https://acme.com/a" } })).toBeNull();
    expect(detailsProblem("pinterest", "Hi", { pin: { alt: "a".repeat(501) } })).toMatch(/Alt text/);
    expect(detailsProblem("pinterest", "Hi", null)).toBeNull();
    // The composer's own checks carry it, so Schedule is blocked before the server is asked.
    const c = composerChecks({ format: "image", main: "Spring", images: [{ w: 1, h: 1 }], extras: { pin: { link: "nope" } }, accounts: [{ id: "a1", app: "pinterest", target: "bd_1", needsTarget: true }] });
    expect(c[0]!.state).toBe("out");
    expect(c[0]!.notes[0]).toMatch(/https/);
  });

  it("checks YouTube and Business Profile details (held networks)", () => {
    expect(detailsProblem("youtube", "Desc", { youtube: { title: "T" } }, { hasVideo: false })).toBe("YouTube needs a video.");
    expect(detailsProblem("youtube", "Desc", { youtube: { title: "" } }, { hasVideo: true })).toMatch(/title/);
    expect(detailsProblem("youtube", "Desc", { youtube: { title: "a<b" } }, { hasVideo: true })).toMatch(/< or >/);
    expect(detailsProblem("youtube", "d".repeat(5001), { youtube: { title: "Ok" } }, { hasVideo: true })).toMatch(/5000/);
    expect(detailsProblem("youtube", "Desc", { youtube: { title: "Ok" } }, { hasVideo: true })).toBeNull();
    expect(detailsProblem("google_business_profile", "Call 02 9999 1234 today", null)).toMatch(/phone numbers/);
    expect(detailsProblem("google_business_profile", "Open late", { gbp: { type: "event", title: "Late night" } })).toMatch(/start and an end/);
    expect(detailsProblem("google_business_profile", "Open late", { gbp: { type: "event", title: "Late", start: "2026-11-05T08:00:00Z", end: "2026-11-04T08:00:00Z" } })).toMatch(/after the start/);
    expect(detailsProblem("google_business_profile", "Sale", { gbp: { type: "offer", title: "10% off", start: "2026-11-05T08:00:00Z", end: "2026-11-06T08:00:00Z", redeem: "http://x.com" } })).toMatch(/redeem/);
    expect(detailsProblem("google_business_profile", "x".repeat(1501), null)).toMatch(/1500/);
  });

  it("cleans details to known fields and maps them to each network", () => {
    expect(cleanP3({ pin: { title: " Hi ", link: "https://a.co", extra: "x" }, junk: 1 })).toEqual({ pin: { title: "Hi", link: "https://a.co", alt: null } });
    expect(cleanP3({ youtube: { title: "V", privacy: "everyone" } })!.youtube!.privacy).toBe("private");
    expect(cleanP3({})).toBeNull();
    const a = pinArgs("First line\nMore", "bd_1", { b64: "AAA", type: "image/png" }, { link: "https://acme.com", alt: "A red mug" });
    expect(a).toMatchObject({ board_id: "bd_1", title: "First line", link: "https://acme.com", alt_text: "A red mug" });
    expect(pinArgs("T", "bd", { b64: "A", type: "image/png" }, { link: "ftp://x" })).not.toHaveProperty("link");
    const y = youtubeArgs("Launch #Spring #news", { title: "Launch", privacy: null }, "https://m/v.mp4");
    expect(y).toMatchObject({ privacyStatus: "private", tags: ["Spring", "news"], title: "Launch" });
    const g = gbpBody("Sale on", { type: "offer", title: "Half off", start: "2026-11-05T08:00:00Z", end: "2026-11-06T09:30:00Z", coupon: "HALF" }, null);
    expect(g).toMatchObject({ topicType: "OFFER", offer: { couponCode: "HALF" }, event: { schedule: { endTime: { hours: 9, minutes: 30 } } } });
    expect(isHttpsLink("https://a")).toBe(false);
  });

  it("builds the Snapchat share link only for https links, and the page escapes it", () => {
    expect(snapShareHref("https://acme.com/a?b=1")).toBe("/share/snapchat?u=https%3A%2F%2Facme.com%2Fa%3Fb%3D1");
    expect(snapShareHref("javascript:alert(1)")).toBeNull();
    const ok = snapSharePage('https://acme.com/"><script>', null);
    expect(ok.status).toBe(200);
    expect(ok.html).not.toContain('"><script>');
    expect(snapSharePage("http://acme.com", null).status).toBe(400);
  });

  it("the share page has a plain Open in Snapchat link and Copy link, and no outside script or loosened policy", async () => {
    const page = snapSharePage("https://acme.com/a?b=1", null);
    expect(page.html).toContain('href="https://www.snapchat.com/scan?attachmentUrl=https%3A%2F%2Facme.com%2Fa%3Fb%3D1"');
    expect(page.html).toContain(">Open in Snapchat</a>");
    expect(page.html).toContain('<script src="/share/snapchat-copy.js"></script>');
    expect(page.html).not.toMatch(/<script[^>]+src="https?:/);
    const { snapShareCsp } = await import("../src/server/lib/security-headers");
    expect(snapShareCsp()).not.toContain("unsafe-eval");
    expect(snapShareCsp()).not.toContain("snapkit");
    expect(snapShareCsp()).toContain("script-src 'self';");
  });

  it("maps YouTube comment threads and the reply body", () => {
    const now = new Date("2026-11-01T10:00:00Z");
    const items = mapYoutubeThreads({ items: [
      { snippet: { topLevelComment: { id: "c1", snippet: { videoId: "v1", textOriginal: "Great", authorDisplayName: "Mia", authorChannelId: { value: "UCfan" }, publishedAt: "2026-11-01T09:00:00Z" } } } },
      { snippet: { topLevelComment: { id: "c2", snippet: { videoId: "v1", textDisplay: "<b>Thanks</b>", authorChannelId: { value: "UCme" } } } } },
      { snippet: { topLevelComment: { snippet: { textOriginal: "no id" } } } },
    ] }, "UCme", now);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ remoteId: "c1", authorName: "Mia", inbound: true, postUrl: "https://www.youtube.com/watch?v=v1&lc=c1" });
    expect(items[1]).toMatchObject({ text: "Thanks", inbound: false, receivedAt: now });
    expect(youtubeReplyBody("c1", "Thanks Mia")).toEqual({ snippet: { parentId: "c1", textOriginal: "Thanks Mia" } });
  });

  it("finds best times in a named time zone, daylight saving safe, with defaults under 20 posts", () => {
    const now = Date.parse("2026-11-02T00:00:00Z");
    // Sydney is UTC+11 in November: 22:00 UTC Monday is 9 am Tuesday there.
    expect(zoned(Date.parse("2026-11-02T22:00:00Z"), "Australia/Sydney")).toMatchObject({ day: 1, hour: 9 });
    const few = bestSlots([{ sentAt: "2026-10-01T00:00:00Z", reach: 100, engagement: 5 }], "Australia/Sydney", now);
    expect(few.defaults).toBe(true);
    expect(few.need).toBe(BEST_MIN_POSTS - 1);
    expect(few.slots.map((s) => s.label)).toEqual(["Tue 9 am", "Wed 12 pm", "Thu 6 pm"]);
    expect(few.slots[0]!.at).toBe("2026-11-02T22:00:00.000Z");
    const rows = [
      ...Array.from({ length: 12 }, (_, i) => ({ sentAt: `2026-10-${String(6 + (i % 3) * 7).padStart(2, "0")}T22:00:00Z`, reach: 100, engagement: 10 })), // Wed 9 am Sydney (DST from Oct 4)
      ...Array.from({ length: 10 }, (_, i) => ({ sentAt: `2026-10-${String(10 + (i % 2) * 7).padStart(2, "0")}T07:00:00Z`, reach: 100, engagement: 2 })), // Sat 6 pm
      { sentAt: "2026-10-12T01:00:00Z", reach: 0, engagement: 4 }, // no reach: not counted
    ];
    const r = bestSlots(rows, "Australia/Sydney", now);
    expect(r.defaults).toBe(false);
    expect(r.posts).toBe(22);
    expect(r.slots[0]).toMatchObject({ label: "Wed 9 am" });
    expect(r.slots[0]!.why).toMatch(/^10% engagement from 12 posts, 1\.\d times your average\.$/);
    expect(bestSlots([], "Not/AZone", now).tz).toBe("UTC");
    // Across the April change the same local hour maps to a different UTC hour.
    expect(nextAt(0, 9, "Australia/Sydney", Date.parse("2026-04-10T00:00:00Z"))).toBe("2026-04-12T23:00:00.000Z");
  });

  it("cleans what the AI wrote and fits text at a word", () => {
    expect(cleanRewrite('Here is the rewritten post: "Big news \u2014 we open Monday"', "x", "shorter", null)).toBe("Big news, we open Monday");
    expect(cleanRewrite("#a #b #c", "Open Monday", "hashtags", null)).toBe("Open Monday\n\n#a #b #c");
    expect(fitText("one two three four five", 12)).toBe("one two\u2026");
    expect([...fitText("x".repeat(300), 280)].length).toBeLessThanOrEqual(280);
    expect(fitText("short", 280)).toBe("short");
  });
});

const ENV = { COMPOSIO_API_KEY: "ak_test_key_never_shown", COMPOSIO_BASE_URL: "https://composio.mock", APP_URL: "https://app.example.com", SOCIAL_P3_R132: "on" };
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let mock: MockComposioState;
let owner: Client;

async function connect(c: Client, app: string) {
  const r = await c.post("/api/apps/connect", { app });
  const id = new URL(r.body.redirectUrl).searchParams.get("connected_account_id")!;
  await c.post(`/api/apps/accounts/${id}/confirm`);
  return id;
}
async function joinAs(email: string) {
  const c = new Client(ctx.app);
  const o = (await ctx.db.select().from(users).where(eq(users.email, "owner-p3@acme.io")).get())!;
  const orgId = (await ctx.db.select().from(members).where(eq(members.userId, o.id)).get())!.organizationId;
  await c.signup(email, "Kiran Rao", "");
  const u = (await ctx.db.select().from(users).where(eq(users.email, email)).get())!;
  await ctx.db.insert(members).values({ id: `mem_${u.id}`, organizationId: orgId, userId: u.id, role: "member" });
  await ctx.db.update(sessions).set({ activeOrganizationId: orgId }).where(eq(sessions.userId, u.id));
  return c;
}
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

beforeEach(async () => {
  mock = newMockState();
  ctx = await makeTestApp(ENV, { fetch: mockComposioFetch(async () => { throw new Error("network disabled in tests"); }, mock) });
  owner = new Client(ctx.app);
  await owner.signup("owner-p3@acme.io");
});

describe("R132 API on mocks", () => {
  it("sends pin title, link and alt text to the pin tool, and refuses a bad link before sending", async () => {
    const pi = await connect(owner, "pinterest");
    const bad = await owner.post("/api/social/posts", { text: "Mugs", images: [{ contentType: "image/png", dataB64: PNG }], targets: [{ accountId: pi, target: "bd_1" }], extras: { pin: { link: "acme.com" } } });
    expect(bad.status).toBe(422);
    const ok = await owner.post("/api/social/posts", { text: "Mugs are back", images: [{ contentType: "image/png", dataB64: PNG }], targets: [{ accountId: pi, target: "bd_1" }], extras: { pin: { title: "Red mug", link: "https://acme.com/mug", alt: "A red mug" } } });
    expect(ok.status).toBe(201);
    await new Promise((r) => setTimeout(r, 80));
    const call = mock.executed.find((e) => e.slug === "PINTEREST_CREATE_PIN");
    expect(call?.args).toMatchObject({ title: "Red mug", link: "https://acme.com/mug", alt_text: "A red mug", board_id: "bd_1" });
  });

  it("brings YouTube comments into the inbox and sends a reply on the thread; a refused reply says so", async () => {
    await connect(owner, "youtube");
    await owner.post("/api/social/inbox/sync");
    const list = await owner.get("/api/social/inbox");
    expect(list.status).toBe(200);
    const items = (list.body.items as { id: string; app: string; text: string }[]).filter((i) => i.app === "youtube");
    expect(items.map((i) => i.text)).toContain("Loved this video, when is part two?");
    const it1 = items.find((i) => i.text.startsWith("Loved"))!;
    const rep = await owner.post(`/api/social/inbox/${it1.id}/reply`, { text: "Part two is on Friday" });
    expect(rep.status).toBe(201);
    const sent = mock.proxied.find((p) => p.endpoint.includes("/youtube/v3/comments") && p.method === "POST")!;
    expect(sent.body).toEqual({ snippet: { parentId: "yt_c_1", textOriginal: "Part two is on Friday" } });
    const refused = await owner.post(`/api/social/inbox/${it1.id}/reply`, { text: "FAIL please" });
    expect(refused.status).toBe(201);
    expect(refused.body.note).toMatchObject({ status: "failed" });
  });

  it("shows YouTube and Pinterest health, with Reconnect codes when signed out or no channel", async () => {
    const yt = await connect(owner, "youtube");
    const pi = await connect(owner, "pinterest");
    let rows = (await owner.get("/api/social/health?fresh=1")).body.accounts as { accountId: string; ok: boolean; code: string | null }[];
    expect(rows.find((r) => r.accountId === yt)).toMatchObject({ ok: true });
    expect(rows.find((r) => r.accountId === pi)).toMatchObject({ ok: true });
    mock.accounts.get(yt)!.data.noChannel = true;
    mock.accounts.get(pi)!.data.expired = true;
    const cfgRows = async () => (await owner.get("/api/social/health?fresh=1")).body.accounts as typeof rows;
    // The cache holds 30 s for a fresh ask; clear it through the service to read again.
    const { clearHealthCache } = await import("../src/server/services/integrations/social");
    const orgId = (await ctx.db.select().from(members).where(eq(members.userId, (await ctx.db.select().from(users).where(eq(users.email, "owner-p3@acme.io")).get())!.id)).get())!.organizationId;
    clearHealthCache(orgId);
    rows = await cfgRows();
    expect(rows.find((r) => r.accountId === yt)).toMatchObject({ ok: false, code: "no_channel" });
    expect(rows.find((r) => r.accountId === pi)).toMatchObject({ ok: false, code: "reconnect" });
  }, 20_000);

  it("suggests best times: defaults with few posts, the workspace's own with 20 or more", async () => {
    const r1 = await owner.get("/api/social/best-times?tz=Australia/Sydney");
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ defaults: true, tz: "Australia/Sydney" });
    expect(r1.body.slots).toHaveLength(3);
    const orgId = (await ctx.db.select().from(members).where(eq(members.userId, (await ctx.db.select().from(users).where(eq(users.email, "owner-p3@acme.io")).get())!.id)).get())!.organizationId;
    const now = Date.now();
    for (let i = 0; i < 21; i++) {
      const id = `sp_${i}`; const sentAt = new Date(now - (i + 1) * 86_400_000);
      await ctx.db.insert(socialPosts).values({ id, orgId, text: "x", status: "done", runAt: sentAt, createdAt: sentAt } as typeof socialPosts.$inferInsert);
      await ctx.db.insert(socialPostTargets).values({ postId: id, accountId: "acc1", app: "facebook", status: "sent", sentAt } as typeof socialPostTargets.$inferInsert);
      await ctx.db.insert(socialPostStats).values({ postId: id, accountId: "acc1", orgId, app: "facebook", reach: 100, engagement: 5, clicks: 0, fetchedAt: sentAt });
    }
    const r2 = await owner.get("/api/social/best-times?apps=facebook&tz=Australia/Sydney");
    expect(r2.body.defaults).toBe(false);
    expect(r2.body.posts).toBe(21);
    const r3 = await owner.get("/api/social/best-times?apps=pinterest");
    expect(r3.body.defaults).toBe(true);
  });

  it("writing help rewrites on the free AI, fits per network, and stops at the daily limit", async () => {
    ctx.deps.askAi = { async run(_m: string, input: unknown) { const u = (input as { messages: { role: string; content: string }[] }).messages[1]!.content; return { response: `Hello! ${u.slice(0, 20)}` }; } };
    const r = await owner.post("/api/social/write-help", { action: "friendlier", text: "We open Monday." });
    expect(r.status).toBe(200);
    expect(r.body.text).toBe("Hello! We open Monday.");
    expect(r.body.left).toBe(WRITE_DAILY - 1);
    const fit = await owner.post("/api/social/write-help", { action: "fit", text: "word ".repeat(150), apps: ["threads", "facebook"] });
    expect(Object.keys(fit.body.texts)).toEqual(["threads"]);
    expect(fit.body.texts.threads.length).toBeLessThanOrEqual(500);
    expect((await owner.post("/api/social/write-help", { action: "shorter", text: "" })).status).toBe(422);
    for (let i = 0; i < WRITE_DAILY - 2; i++) await owner.post("/api/social/write-help", { action: "shorter", text: "Hi there" });
    const lim = await owner.post("/api/social/write-help", { action: "shorter", text: "Hi there" });
    expect(lim.status).toBe(429);
    expect(lim.body.error?.message ?? lim.body.message).toBe(WRITE_LIMIT_MESSAGE);
  }, 30_000);

  it("members use best times and writing help; people outside the workspace can't", async () => {
    ctx.deps.askAi = { async run() { return { response: "Hello all" }; } };
    const member = await joinAs("member-p3@acme.io");
    expect((await member.get("/api/social/best-times")).status).toBe(200);
    expect((await member.post("/api/social/write-help", { action: "friendlier", text: "Hi" })).status).toBe(200);
    const anon = new Client(ctx.app);
    expect((await anon.get("/api/social/best-times")).status).toBe(401);
    expect((await anon.post("/api/social/write-help", { action: "friendlier", text: "Hi" })).status).toBe(401);
  });

  it("serves the Snapchat share page with its own strict policy", async () => {
    const res = await ctx.app.request("/share/snapchat?u=" + encodeURIComponent("https://acme.com/spring"));
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    // Root rule (01:10 UTC Nov 2): no outside script and no loosened page policy on this page.
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("snapkit");
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("frame-ancestors 'none'");
    const html = await res.text();
    expect(html).toContain('value="https://acme.com/spring"');
    expect(html).toContain(">Copy link</button>");
    expect(html).not.toContain("snapkit");
    const js = await ctx.app.request("/share/snapchat-copy.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
  });
});

describe("R132 flag off", () => {
  it("answers 404 and keeps pin details out of saved posts", async () => {
    mock = newMockState();
    ctx = await makeTestApp({ ...ENV, SOCIAL_P3_R132: "" }, { fetch: mockComposioFetch(async () => { throw new Error("network disabled in tests"); }, mock) });
    owner = new Client(ctx.app);
    await owner.signup("owner-p3@acme.io");
    expect((await owner.get("/api/social/best-times")).status).toBe(404);
    expect((await owner.post("/api/social/write-help", { action: "shorter", text: "Hi" })).status).toBe(404);
    const d = await owner.post("/api/social/posts", { text: "Draft", targets: [], mode: "draft", extras: { pin: { title: "T" } } });
    expect(d.body.post.extras?.pin).toBeUndefined();
    const cfg = await owner.get("/api/config");
    expect(cfg.body.socialP3R132).toBeFalsy();
    expect(cfg.body.socialYoutubeUploadR132).toBeFalsy();
    expect(cfg.body.socialGbpR132).toBeFalsy();
  });
});

// R132 (staging find 00:06 UTC Nov 2): on Cloudflare the Worker hands only listed paths to the app; the rest get the
// app shell. The share page must be on that list or it answers the shell's 404 in production.
describe("R132 Snapchat share page reaches the app on the Worker", () => {
  it("lists /share/snapchat among the paths the Worker sends to the app", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/entry/worker.ts", import.meta.url), "utf8");
    expect(src).toContain('url.pathname.startsWith("/share/snapchat")');
  });
});
