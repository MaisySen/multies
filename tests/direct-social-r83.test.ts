/**
 * R83: own TikTok and Threads connections, against the in memory stand in (services/direct-social/mock.ts).
 * Sign in (state and PKCE), tokens encrypted at rest, refresh on 401, revoke on disconnect, the role split, Direct Post
 * with creator info rules, video list, Threads post and profile, the signed TikTok webhook and the signed_request
 * delete callback.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { directSocialLinks, directSocialPublishes, members, sessions, users } from "../src/server/db/schema";
import { mockDirectFetch, newMockDirectState, type MockDirectState } from "../src/server/services/direct-social/mock";
import { verifyTikTokSignature } from "../src/server/services/direct-social";
import { verifySignedRequest } from "../src/server/services/direct-social/threads";
import { challengeHex } from "../src/server/services/direct-social/store";
import { hmacSha256Hex } from "../src/server/lib/crypto";

const ENV = {
  APP_URL: "https://app.example.com",
  TIKTOK_CLIENT_KEY: "ck_prod_test", TIKTOK_CLIENT_SECRET: "cs_prod_test_never_shown",
  TIKTOK_SANDBOX_CLIENT_KEY: "ck_sbx_test", TIKTOK_SANDBOX_CLIENT_SECRET: "cs_sbx_test_never_shown",
  TIKTOK_API_BASE: "https://tiktok.mock", TIKTOK_AUTH_URL: "https://www.tiktok.com/v2/auth/authorize/",
  THREADS_APP_ID: "th_app_test", THREADS_APP_SECRET: "th_secret_never_shown",
  THREADS_API_BASE: "https://threads.mock", THREADS_AUTH_URL: "https://threads.net/oauth/authorize",
};

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let mock: MockDirectState;
let owner: Client;

async function orgIdOf(email: string) {
  const u = (await ctx.db.select().from(users).where(eq(users.email, email)).get())!;
  return (await ctx.db.select().from(members).where(eq(members.userId, u.id)).get())!.organizationId;
}

async function raw(c: Client, method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}) {
  const res = await ctx.app.request(path, { method, headers: { cookie: c.cookie, host: "localhost", ...(init.body instanceof FormData ? { "x-multies-upload": "1" } : {}), ...(init.headers ?? {}) }, body: init.body });
  // Keep the sign in nonce cookie the way a browser would (set at start, cleared at the return).
  for (const sc of res.headers.getSetCookie()) {
    const [pair, ...attrs] = sc.split(/;\s*/);
    const i = pair.indexOf("=");
    const name = pair.slice(0, i), value = pair.slice(i + 1);
    if (!name.startsWith("mm_oauth_")) continue;
    if (!value || attrs.some((a) => /^max-age=0$/i.test(a))) c.jar.delete(name); else c.jar.set(name, value);
  }
  return res;
}

/** Starts the sign in, checks the network URL, then comes back the way the network would. */
async function connect(c: Client, p: "tiktok" | "threads", code = "good-code") {
  const start = await raw(c, "GET", `/api/connections/oauth/${p}/start`);
  expect(start.status).toBe(302);
  const to = new URL(start.headers.get("location")!);
  const state = to.searchParams.get("state")!;
  const back = await raw(c, "GET", `/api/connections/oauth/${p}/callback?${new URLSearchParams({ code, state })}`);
  expect(back.status).toBe(302);
  return { to, back: new URL(back.headers.get("location")!, "https://app.example.com") };
}

beforeEach(async () => {
  mock = newMockDirectState();
  ctx = await makeTestApp(ENV, { fetch: mockDirectFetch(async () => { throw new Error("network disabled in tests"); }, mock) });
  owner = new Client(ctx.app);
  await owner.signup("owner-r83@acme.io");
});

describe("R83 TikTok", () => {
  it("is off without keys: status says so and start answers 503", async () => {
    const off = await makeTestApp({});
    const c = new Client(off.app);
    await c.signup("off-r83@acme.io");
    const s = await c.get("/api/direct/status");
    expect(s.status).toBe(200);
    expect(s.body.accounts.map((a: { provider: string; available: boolean }) => [a.provider, a.available])).toEqual([["tiktok", false], ["threads", false]]);
    const res = await off.app.request("/api/connections/oauth/tiktok/start", { headers: { cookie: c.cookie, host: "localhost" } });
    expect(res.status).toBe(503);
  });

  it("signs in with PKCE and state, stores tokens encrypted, shows the account, no secret in any answer", async () => {
    const { to, back } = await connect(owner, "tiktok");
    expect(to.origin + to.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(to.searchParams.get("client_key")).toBe("ck_prod_test");
    expect(to.searchParams.get("scope")).toBe("user.info.basic,video.upload,video.publish,video.list");
    expect(to.searchParams.get("redirect_uri")).toBe("https://app.example.com/api/connections/oauth/tiktok/callback");
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    // The verifier the token call sent matches the challenge in the sign in URL (hex, as TikTok wants).
    expect(await challengeHex(mock.verifier!)).toBe(to.searchParams.get("code_challenge"));
    expect(back.pathname).toBe("/app/social/accounts"); // P1 layout
    expect(back.searchParams.get("connected")).toBe("tiktok");
    const row = (await ctx.db.select().from(directSocialLinks).get())!;
    expect(row.provider).toBe("tiktok");
    expect(row.providerUserId).toBe("oid_mock_creator");
    expect(row.username).toBe("multiesdemo");
    expect(row.accessTokenEnc).not.toContain("tt-access");
    expect(row.refreshTokenEnc).not.toContain("tt-refresh");
    const s = await owner.get("/api/direct/status");
    const tt = s.body.accounts.find((a: { provider: string }) => a.provider === "tiktok");
    expect(tt).toMatchObject({ connected: true, username: "multiesdemo", displayName: "Multies Demo", profileUrl: "https://www.tiktok.com/@multiesdemo", testMode: false });
    const all = JSON.stringify(s.body);
    for (const secret of ["tt-access", "tt-refresh", "cs_prod_test_never_shown", "cs_sbx_test_never_shown"]) expect(all).not.toContain(secret);
  });

  it.each([
    ["production", ENV.TIKTOK_CLIENT_KEY, ENV.TIKTOK_CLIENT_SECRET, ENV.TIKTOK_SANDBOX_CLIENT_SECRET],
    ["sandbox", ENV.TIKTOK_SANDBOX_CLIENT_KEY, ENV.TIKTOK_SANDBOX_CLIENT_SECRET, ENV.TIKTOK_CLIENT_SECRET],
  ])("TIKTOK_MODE=%s uses only its own credentials", async (mode, key, secret, otherSecret) => {
    const app = await makeTestApp({ ...ENV, TIKTOK_MODE: mode }, { fetch: mockDirectFetch(async () => { throw new Error("network disabled in tests"); }, mock) });
    const c = new Client(app.app);
    await c.signup("mode-r83@acme.io");
    const res = await app.app.request("/api/connections/oauth/tiktok/start", { headers: { cookie: c.cookie, host: "localhost" } });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("client_key")).toBe(key);
    expect((await c.get("/api/direct/status")).body.accounts[0]).toMatchObject({ available: true, testMode: mode === "sandbox" });

    const body = JSON.stringify({ event: "something.new" });
    const t = Math.floor(Date.now() / 1000);
    const send = async (clientSecret: string) => {
      const sig = `t=${t},s=${await hmacSha256Hex(clientSecret, `${t}.${body}`)}`;
      return app.app.request("/api/connections/webhooks/tiktok", { method: "POST", headers: { "content-type": "application/json", "tiktok-signature": sig, host: "localhost" }, body });
    };
    expect((await send(secret)).status).toBe(200);
    expect((await send(otherSecret)).status).toBe(401);
  });

  it.each([
    ["production", { TIKTOK_CLIENT_KEY: undefined, TIKTOK_CLIENT_SECRET: undefined }],
    ["production", { TIKTOK_CLIENT_SECRET: "   " }],
    ["sandbox", { TIKTOK_SANDBOX_CLIENT_KEY: undefined, TIKTOK_SANDBOX_CLIENT_SECRET: undefined }],
    ["sandbox", { TIKTOK_SANDBOX_CLIENT_KEY: "   " }],
  ])("TIKTOK_MODE=%s is unavailable without its complete pair (%j)", async (mode, omit) => {
    const app = await makeTestApp({ ...ENV, ...omit, TIKTOK_MODE: mode }, { fetch: async () => { throw new Error("network disabled in tests"); } });
    const c = new Client(app.app);
    await c.signup("mode-off-r83@acme.io");
    const status = await c.get("/api/direct/status");
    expect(status.body.accounts).toEqual([
      expect.objectContaining({ provider: "tiktok", available: false }),
      expect.objectContaining({ provider: "threads", available: true }),
    ]);
    const res = await c.get("/api/connections/oauth/tiktok/start");
    expect(res.status).toBe(503);
  });

  it("refuses a state from someone else, a bad code, and a cancel, with plain words", async () => {
    const start = await raw(owner, "GET", "/api/connections/oauth/tiktok/start");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const other = new Client(ctx.app);
    await other.signup("other-r83@acme.io");
    const r1 = await raw(other, "GET", `/api/connections/oauth/tiktok/callback?code=x&state=${encodeURIComponent(state)}`);
    expect(new URL(r1.headers.get("location")!, "https://x").searchParams.get("error")).toMatch(/expired or belongs to someone else/);
    const r2 = await raw(owner, "GET", `/api/connections/oauth/tiktok/callback?code=bad&state=${encodeURIComponent(state)}`);
    expect(new URL(r2.headers.get("location")!, "https://x").searchParams.get("error")).toMatch(/Connect TikTok again/);
    const r3 = await raw(owner, "GET", "/api/connections/oauth/tiktok/callback?error=access_denied");
    expect(new URL(r3.headers.get("location")!, "https://x").searchParams.get("error")).toBe("You cancelled the sign in.");
    // The same state a second time (its browser cookie was used up by the return above) is refused.
    const r4 = await raw(owner, "GET", `/api/connections/oauth/tiktok/callback?code=good-code&state=${encodeURIComponent(state)}`);
    expect(new URL(r4.headers.get("location")!, "https://x").searchParams.get("error")).toMatch(/already used or started in another browser/);
    expect(await ctx.db.select().from(directSocialLinks).all()).toHaveLength(0);
  });

  it("members can read but not connect, post or disconnect", async () => {
    await connect(owner, "tiktok");
    const orgId = await orgIdOf("owner-r83@acme.io");
    const m = new Client(ctx.app);
    await m.signup("member-r83@acme.io");
    const u = (await ctx.db.select().from(users).where(eq(users.email, "member-r83@acme.io")).get())!;
    await ctx.db.insert(members).values({ id: `mem_${u.id}`, organizationId: orgId, userId: u.id, role: "member" });
    await ctx.db.update(sessions).set({ activeOrganizationId: orgId }).where(eq(sessions.userId, u.id));
    const st = await m.get("/api/direct/status");
    expect(st.body.canManage).toBe(false);
    expect(st.body.accounts[0].connected).toBe(true);
    expect((await raw(m, "GET", "/api/connections/oauth/tiktok/start")).status).toBe(403);
    expect((await m.del("/api/direct/tiktok")).status).toBe(403);
    expect((await m.post("/api/direct/threads/posts", { text: "hi" })).status).toBe(403);
  });

  it("reads creator info and posts a video with only an offered privacy level; refresh on 401; list shows it", async () => {
    await connect(owner, "tiktok");
    const ci = await owner.get("/api/direct/tiktok/creator");
    expect(ci.status).toBe(200);
    expect(ci.body.creator).toMatchObject({ nickname: "Multies Demo", username: "multiesdemo", stitchDisabled: true });
    expect(ci.body.creator.privacyOptions).toEqual(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"]);

    const form = (over: Record<string, string> = {}) => {
      const f = new FormData();
      f.set("video", new Blob([new Uint8Array(2048)], { type: "video/mp4" }), "clip.mp4");
      const v = { title: "Hello from Multies", privacy: "SELF_ONLY", allowComment: "true", allowDuet: "false", allowStitch: "true", yourBrand: "false", brandedContent: "false", consent: "true", ...over };
      for (const [k, val] of Object.entries(v)) f.set(k, val);
      return f;
    };
    // Needs consent, an offered level, and branded content can't be private.
    expect((await raw(owner, "POST", "/api/direct/tiktok/videos", { body: form({ consent: "false" }) })).status).toBe(400);
    expect((await raw(owner, "POST", "/api/direct/tiktok/videos", { body: form({ privacy: "FOLLOWER_OF_CREATOR" }) })).status).toBe(400);
    expect((await raw(owner, "POST", "/api/direct/tiktok/videos", { body: form({ brandedContent: "true" }) })).status).toBe(400);
    mock.expireNextTikTok = true; // the stored token answers 401 once: the server refreshes and goes on
    const ok = await raw(owner, "POST", "/api/direct/tiktok/videos", { body: form() });
    expect(ok.status).toBe(201);
    const pub = (await ok.json()) as { publish: { publishId: string; status: string } };
    expect(pub.publish.status).toBe("processing");
    const sent = [...mock.publishes.values()][0]!;
    expect(sent).toMatchObject({ title: "Hello from Multies", privacy: "SELF_ONLY", uploaded: 2048 });
    expect(mock.calls).toContain("POST tiktok.mock/v2/post/publish/creator_info/query/");
    const list = await owner.get("/api/direct/tiktok/videos");
    expect(list.status).toBe(200);
    expect(list.body.videos[0].title).toBe("Hello from Multies");
    expect(list.body.publishes[0].status).toBe("published");
    // The refresh wrote new encrypted tokens.
    const row = (await ctx.db.select().from(directSocialLinks).get())!;
    expect(row.status).toBe("active");
  });

  it("disconnect revokes at TikTok and removes the link", async () => {
    await connect(owner, "tiktok");
    expect(mock.tiktokTokens.size).toBe(1);
    const r = await owner.del("/api/direct/tiktok");
    expect(r.body).toEqual({ removed: true, revoked: true });
    expect(mock.tiktokTokens.size).toBe(0);
    expect(await ctx.db.select().from(directSocialLinks).all()).toHaveLength(0);
    expect((await owner.get("/api/direct/tiktok/videos")).status).toBe(409);
  });

  it("webhook: bad or old signature 401, authorization.removed deletes the link, publish events settle the post", async () => {
    await connect(owner, "tiktok");
    const now = Math.floor(Date.now() / 1000);
    const send = async (body: object, secret = "cs_prod_test_never_shown", t = now) => {
      const text = JSON.stringify(body);
      const sig = `t=${t},s=${await hmacSha256Hex(secret, `${t}.${text}`)}`;
      return ctx.app.request("/api/connections/webhooks/tiktok", { method: "POST", headers: { "content-type": "application/json", "tiktok-signature": sig, host: "localhost" }, body: text });
    };
    expect((await send({ event: "authorization.removed", user_openid: "oid_mock_creator" }, "wrong")).status).toBe(401);
    expect((await send({ event: "authorization.removed", user_openid: "oid_mock_creator" }, "cs_prod_test_never_shown", now - 3600)).status).toBe(401);
    const orgId = await orgIdOf("owner-r83@acme.io");
    await ctx.db.insert(directSocialPublishes).values({ id: "dsp_1", orgId, provider: "tiktok", publishId: "pub_1", title: "x", status: "processing", createdAt: new Date(), updatedAt: new Date() });
    // Signed by the sandbox app also counts.
    expect((await send({ event: "post.publish.complete", content: JSON.stringify({ publish_id: "pub_1", post_id: "123" }) }, "cs_sbx_test_never_shown")).status).toBe(200);
    expect((await ctx.db.select().from(directSocialPublishes).get())!.status).toBe("published");
    expect((await send({ event: "post.publish.failed", content: JSON.stringify({ publish_id: "pub_1", reason: "file_format_check_failed" }) })).status).toBe(200);
    expect((await ctx.db.select().from(directSocialPublishes).get())!.status).toBe("failed");
    expect((await send({ event: "authorization.removed", user_openid: "oid_mock_creator", content: JSON.stringify({ reason: 1 }) })).status).toBe(200);
    expect(await ctx.db.select().from(directSocialLinks).all()).toHaveLength(0);
    expect((await send({ event: "something.new" })).status).toBe(200);
  });

  it("signature check is exact", async () => {
    const t = 1_800_000_000;
    const s = await hmacSha256Hex("k", `${t}.body`);
    expect(await verifyTikTokSignature(`t=${t},s=${s}`, "body", ["k"], t * 1000)).toBe(true);
    expect(await verifyTikTokSignature(`t=${t},s=${s}`, "body2", ["k"], t * 1000)).toBe(false);
    expect(await verifyTikTokSignature(undefined, "body", ["k"], t * 1000)).toBe(false);
  });
});

describe("R83 Threads", () => {
  it("signs in, swaps for a long lived token, shows the profile and posts text", async () => {
    const { to, back } = await connect(owner, "threads");
    expect(to.origin + to.pathname).toBe("https://threads.net/oauth/authorize");
    expect(to.searchParams.get("client_id")).toBe("th_app_test");
    expect(to.searchParams.get("scope")).toBe("threads_basic,threads_content_publish");
    expect(back.searchParams.get("connected")).toBe("threads");
    const row = (await ctx.db.select().from(directSocialLinks).where(eq(directSocialLinks.provider, "threads")).get())!;
    expect(row.providerUserId).toBe("th_user_mock");
    expect(row.accessTokenEnc).not.toContain("th-long");
    expect(row.accessExpiresAt!.getTime() - Date.now()).toBeGreaterThan(50 * 86400_000);
    const prof = await owner.get("/api/direct/threads/profile");
    expect(prof.body.profile).toMatchObject({ username: "multies.demo", name: "Multies Demo" });
    const post = await owner.post("/api/direct/threads/posts", { text: "First post from Multies" });
    expect(post.status).toBe(201);
    expect(post.body.post.permalink).toMatch(/threads\.net\/@multies\.demo\/post\//);
    const prof2 = await owner.get("/api/direct/threads/profile");
    expect(prof2.body.posts[0].text).toBe("First post from Multies");
    const bad = await owner.post("/api/direct/threads/posts", { text: "FAIL this" });
    expect(bad.status).toBe(400);
    expect((await owner.post("/api/direct/threads/posts", { text: "x".repeat(501) })).status).toBe(400);
    expect(JSON.stringify(prof2.body)).not.toContain("th-long");
  });

  it("posts with an image through our public media link", async () => {
    await connect(owner, "threads");
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const r = await owner.post("/api/direct/threads/posts", { text: "With a picture", image: { contentType: "image/png", dataB64: PNG } });
    expect(r.status).toBe(201);
    expect(mock.threadsPosts[0]!.media_type).toBe("IMAGE");
  });

  it("uninstall and delete callbacks: signed_request verified, the link removed, a confirmation code answered", async () => {
    await connect(owner, "threads");
    const b64u = (s: string | Uint8Array) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const sign = async (payload: object, secret = "th_secret_never_shown") => {
      const p = b64u(JSON.stringify(payload));
      const hex = await hmacSha256Hex(secret, p);
      return `${b64u(Buffer.from(hex, "hex"))}.${p}`;
    };
    const post = (signed: string) => ctx.app.request("/delete-account", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", host: "localhost" }, body: new URLSearchParams({ signed_request: signed }) });
    expect((await post(await sign({ algorithm: "HMAC-SHA256", user_id: "th_user_mock" }, "wrong"))).status).toBe(400);
    expect((await post("")).status).toBe(400);
    expect(await verifySignedRequest(await sign({ algorithm: "HMAC-SHA256", user_id: "u1" }), "th_secret_never_shown")).toMatchObject({ user_id: "u1" });
    const ok = await post(await sign({ algorithm: "HMAC-SHA256", user_id: "th_user_mock", issued_at: 1 }));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { url: string; confirmation_code: string };
    expect(body.url).toBe(`https://app.example.com/delete-account?code=${body.confirmation_code}`);
    expect(await ctx.db.select().from(directSocialLinks).all()).toHaveLength(0);
  });
});


describe("R83 catalog: TikTok and Threads are ready, Snapchat copy", () => {
  it("lists TikTok and Threads as ready everywhere and Snapchat as sharing, still coming soon", async () => {
    const top = (await import("../src/shared/connections-catalog-top.json")).default as { apps: { slug: string; availability: string; description: string }[] };
    const all = (await import("../src/shared/connections-catalog.json")).default as { apps: { slug: string; availability: string; description: string }[] };
    for (const list of [top.apps, all.apps]) {
      const by = new Map(list.map((a) => [a.slug, a]));
      expect(by.get("tiktok")?.availability).toBe("ready");
      expect(by.get("threads")?.availability).toBe("ready");
      expect(by.get("snapchat")?.availability).toBe("soon");
      expect(by.get("snapchat")?.description).toBe("Share photos and videos to Snapchat.");
      if (by.has("twitter")) expect(by.get("twitter")?.availability).toBe("soon");
      if (by.has("google_business_profile")) expect(by.get("google_business_profile")?.availability).toBe("soon");
    }
  });
});

describe("R83 sign in errors come back in plain words", () => {
  it("names TikTok test mode, missing permissions and a cancel", async () => {
    const { signInError } = await import("../src/server/routes/direct-social");
    expect(signInError("tiktok", "access_denied", "non_sandbox_target")).toMatch(/test mode/);
    expect(signInError("tiktok", "access_denied", "scope_not_authorized")).toMatch(/permission/);
    expect(signInError("tiktok", "access_denied")).toBe("You cancelled the sign in.");
    expect(signInError("threads", "access_denied", undefined, "user_denied")).toBe("You cancelled the sign in.");
    expect(signInError("tiktok", "server_error")).toMatch(/didn't finish/);
  });
  it("asks only for the scopes the host lists in TIKTOK_SCOPES", async () => {
    const { tiktokScopes, TIKTOK_SCOPES } = await import("../src/server/services/direct-social/tiktok");
    const base = { config: { direct: { tiktok: { scopes: ["user.info.basic", "video.upload", "video.publish"] } } } } as never;
    expect(tiktokScopes(base)).toEqual(["user.info.basic", "video.upload", "video.publish"]);
    expect(tiktokScopes({ config: { direct: { tiktok: {} } } } as never)).toEqual(TIKTOK_SCOPES);
  });
});
