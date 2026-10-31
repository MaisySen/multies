/**
 * Hotfix Oct 31 (Facebook Open post link), on the R80C setup. R80C: Connections hub (/api/apps) and social posts (/api/social), against the in memory stand in for the
 * integration platform. Covers the role split, workspace isolation, audit, no secrets in answers, the post
 * queue (now and later), per account results, retry and cancel, the cron step and the public image.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { socialPostTargets } from "../src/server/db/schema";
import { mockComposioFetch, newMockState, type MockComposioState } from "../src/server/services/integrations/mock";
import { facebookFallbackUrl, facebookPermalink, openableFacebookUrl } from "../src/server/services/integrations/social"; // gitleaks:allow (function names, no key)

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
  await owner.signup("owner-fblink@acme.io");
});

describe("Hotfix Oct 31: Facebook Open post link", () => {
  it("stores the post's own permalink after posting, never the page_post form", async () => {
    const fb = await connect(owner, "facebook");
    const r = await owner.post("/api/social/posts", { text: "Testing. https://fintex.au", targets: [{ accountId: fb, target: "pg_100" }] });
    expect(r.status).toBe(201);
    await new Promise((res) => setTimeout(res, 50));
    const post = (await owner.get(`/api/social/posts/${r.body.post.id}`)).body.post;
    expect(post.targets[0].status).toBe("sent");
    expect(post.targets[0].url).toMatch(/^https:\/\/www\.facebook\.com\/61500000000001\/posts\/pg_post_/);
    const read = mock.proxied.find((e) => e.endpoint.includes("fields=permalink_url"))!;
    expect(read.method).toBe("GET");
    expect(new URL(read.endpoint).searchParams.get("access_token")).toBe("mock-page-token");
  });

  it("falls back to /<page>/posts/<id> when the permalink read fails", async () => {
    mock.permalinkDown = true;
    const fb = await connect(owner, "facebook");
    const r = await owner.post("/api/social/posts", { text: "Fallback please", targets: [{ accountId: fb, target: "pg_100" }] });
    await new Promise((res) => setTimeout(res, 50));
    const post = (await owner.get(`/api/social/posts/${r.body.post.id}`)).body.post;
    expect(post.targets[0].status).toBe("sent");
    expect(post.targets[0].url).toMatch(/^https:\/\/www\.facebook\.com\/[^/_]+\/posts\/[^/]+$/);
  });

  it("permalink helper: real answer, failure and a bad answer never give the underscore form", async () => {
    const mk = (answer: () => Promise<{ status: number; data: unknown; headers: Record<string, string> }>) => ({
      cp: { proxy: answer } as never, userId: "u", accountId: "a", text: "", imageUrl: null, image: null, target: "450288358178844",
    });
    const ok = mk(async () => ({ status: 200, data: { permalink_url: "https://www.facebook.com/122177096888704528/posts/122177096648704528" }, headers: {} }));
    expect(await facebookPermalink(ok, "450288358178844", "450288358178844_122177096648704528", "pt")).toBe("https://www.facebook.com/122177096888704528/posts/122177096648704528");
    const down = mk(async () => ({ status: 400, data: { error: { message: "nope", code: 100 } }, headers: {} }));
    expect(await facebookPermalink(down, "450288358178844", "450288358178844_122177096648704528", "pt")).toBe("https://www.facebook.com/450288358178844/posts/122177096648704528");
    const thrown = mk(async () => { throw new Error("socket closed"); });
    expect(await facebookPermalink(thrown, "450288358178844", "450288358178844_122177096648704528", "pt")).toBe("https://www.facebook.com/450288358178844/posts/122177096648704528");
    const odd = mk(async () => ({ status: 200, data: { permalink_url: "javascript:alert(1)" }, headers: {} }));
    expect(await facebookPermalink(odd, "450288358178844", "450288358178844_122177096648704528", "pt")).toBe("https://www.facebook.com/450288358178844/posts/122177096648704528");
    expect(facebookFallbackUrl("450288358178844", "122177096648704528")).toBe("https://www.facebook.com/450288358178844/posts/122177096648704528");
  });

  it("rewrites stored page_post addresses when posts are read (web and phone read the same API)", async () => {
    expect(openableFacebookUrl("https://www.facebook.com/450288358178844_122177096648704528")).toBe("https://www.facebook.com/450288358178844/posts/122177096648704528");
    expect(openableFacebookUrl("https://facebook.com/1_2/")).toBe("https://www.facebook.com/1/posts/2");
    expect(openableFacebookUrl("https://www.facebook.com/122177096888704528/posts/122177096648704528")).toBe("https://www.facebook.com/122177096888704528/posts/122177096648704528");
    expect(openableFacebookUrl("https://www.linkedin.com/feed/update/urn:li:share:1_2")).toBe("https://www.linkedin.com/feed/update/urn:li:share:1_2");
    expect(openableFacebookUrl(null)).toBeNull();

    const fb = await connect(owner, "facebook");
    const r = await owner.post("/api/social/posts", { text: "Older post", targets: [{ accountId: fb, target: "pg_100" }] });
    await new Promise((res) => setTimeout(res, 50));
    // A post made before the fix kept the address Facebook will not open.
    await ctx.db.update(socialPostTargets).set({ url: "https://www.facebook.com/450288358178844_122177096648704528" }).where(eq(socialPostTargets.postId, r.body.post.id));
    const one = (await owner.get(`/api/social/posts/${r.body.post.id}`)).body.post;
    expect(one.targets[0].url).toBe("https://www.facebook.com/450288358178844/posts/122177096648704528");
    const list = (await owner.get("/api/social/posts")).body.posts;
    expect(list.find((p: { id: string }) => p.id === r.body.post.id).targets[0].url).toBe("https://www.facebook.com/450288358178844/posts/122177096648704528");
  });
});
