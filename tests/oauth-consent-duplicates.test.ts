import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { pkceChallenge } from "@/server/services/developer/oauth";

/**
 * The consent screen must approve exactly what it showed. A link that repeats client_id or redirect_uri
 * used to show the first app (the server reads the first value) while the page posted the last one.
 */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
const verifier = "v".repeat(20) + "-verifier-for-pkce-tests-0123456789";
const LEGIT_CB = "https://legit.example/cb";
const EVIL_CB = "https://evil.example/cb";

async function register(name: string, redirect: string) {
  const res = await ctx.app.request("/api/oauth/register", { method: "POST", headers: { "content-type": "application/json", host: "localhost" }, body: JSON.stringify({ client_name: name, redirect_uris: [redirect] }) });
  return (await res.json() as { client_id: string }).client_id;
}

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io");
});

async function attackLink() {
  const legit = await register("Legit App", LEGIT_CB);
  const evil = await register("Evil App", EVIL_CB);
  const q = new URLSearchParams();
  q.append("client_id", legit);
  q.append("redirect_uri", LEGIT_CB);
  q.append("client_id", evil);
  q.append("redirect_uri", EVIL_CB);
  q.append("response_type", "code");
  q.append("code_challenge", await pkceChallenge(verifier));
  q.append("code_challenge_method", "S256");
  q.append("code_challenge", await pkceChallenge("attacker-" + verifier));
  return { legit, evil, q };
}

describe("OAuth consent: repeated parameters", () => {
  it("refuses a link that repeats client_id, redirect_uri or code_challenge", async () => {
    const { q } = await attackLink();
    const info = await c.get(`/api/oauth/authorize?${q}`);
    expect(info.status).toBe(400);
    expect(info.body.error.code).toBe("invalid_request");
  });

  for (const key of ["client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "response_type", "resource"]) {
    it(`refuses a repeated ${key} on the consent screen and on Allow`, async () => {
      const id = await register("Legit App", LEGIT_CB);
      const q = new URLSearchParams({ client_id: id, redirect_uri: LEGIT_CB, response_type: "code", code_challenge: await pkceChallenge(verifier), code_challenge_method: "S256", state: "s1", resource: "http://localhost/api/v1/mcp" });
      q.append(key, q.get(key)!);
      expect((await c.get(`/api/oauth/authorize?${q}`)).status).toBe(400);
      const post = await c.post("/api/oauth/authorize", { decision: "allow", scope: "full", query: q.toString() });
      expect(post.status).toBe(400);
    });
  }

  it("Allow with the raw link never approves the second app", async () => {
    const { q } = await attackLink();
    const post = await c.post("/api/oauth/authorize", { decision: "allow", scope: "full", query: q.toString() });
    expect(post.status).toBe(400);
    expect(JSON.stringify(post.body)).not.toContain("evil.example");
  });

  it("still joins a repeated scope and approves the link that was shown", async () => {
    const id = await register("Legit App", LEGIT_CB);
    const q = new URLSearchParams({ client_id: id, redirect_uri: LEGIT_CB, response_type: "code", code_challenge: await pkceChallenge(verifier), code_challenge_method: "S256", state: "s1" });
    q.append("scope", "mcp:read");
    q.append("scope", "mcp:write");
    const info = await c.get(`/api/oauth/authorize?${q}`);
    expect(info.status).toBe(200);
    expect(info.body.client.name).toBe("Legit App");
    expect(info.body.requestedScope).toBe("full");
    const post = await c.post("/api/oauth/authorize", { decision: "allow", scope: "full", query: q.toString() });
    expect(post.status).toBe(200);
    const url = new URL(post.body.redirectTo);
    expect(url.origin + url.pathname).toBe(LEGIT_CB);
    expect(url.searchParams.get("state")).toBe("s1");
    const deny = await c.post("/api/oauth/authorize", { decision: "deny", query: q.toString() });
    expect(new URL(deny.body.redirectTo).searchParams.get("error")).toBe("access_denied");
  });
});
