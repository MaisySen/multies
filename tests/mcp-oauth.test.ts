import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { eq } from "drizzle-orm";
import { members } from "@/server/db/schema";
import { checkRedirectUri, pkceChallenge, GRANT_LAST_USED_EVERY_MS } from "@/server/services/developer/oauth";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
const verifier = "v".repeat(20) + "-verifier-for-pkce-tests-0123456789";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

const form = (o: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", host: "localhost" }, body: new URLSearchParams(o).toString() });
async function register(body: unknown = { client_name: "Claude", redirect_uris: [REDIRECT] }) {
  const res = await ctx.app.request("/api/oauth/register", { method: "POST", headers: { "content-type": "application/json", host: "localhost", origin: "https://claude.ai" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
async function authorizeParams(clientId: string, extra: Record<string, string> = {}) {
  return { client_id: clientId, redirect_uri: REDIRECT, response_type: "code", code_challenge: await pkceChallenge(verifier), code_challenge_method: "S256", state: "st-1", scope: "mcp:read mcp:write", ...extra };
}
async function signIn(scope: "read" | "full" = "full", extra: Record<string, string> = {}, who = c, existingClientId?: string) {
  const clientId = existingClientId ?? (await register()).body.client_id as string;
  const request = await authorizeParams(clientId, extra);
  const r = await who.post("/api/oauth/authorize", { decision: "allow", scope, request });
  expect(r.status).toBe(200);
  const url = new URL(r.body.redirectTo);
  return { clientId, code: url.searchParams.get("code")!, url };
}
async function exchange(clientId: string, code: string, v = verifier) {
  const res = await ctx.app.request("/api/oauth/token", form({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: v }));
  return { status: res.status, body: await res.json() as Record<string, string> };
}
async function mcp(token: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${token}` } }, fetch: fetchViaApp }));
  return client;
}

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io");
});

describe("MCP OAuth: discovery", () => {
  it("answers an unauthenticated MCP call with 401 and where to sign in", async () => {
    const res = await ctx.app.request("/api/v1/mcp", { method: "POST", headers: { host: "localhost", "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('resource_metadata="http://localhost/.well-known/oauth-protected-resource/api/v1/mcp"');
    expect(res.headers.get("www-authenticate")).toContain('scope="mcp:read mcp:write"');
  });
  it("publishes protected resource and authorisation server metadata", async () => {
    const prm = await (await ctx.app.request("/.well-known/oauth-protected-resource/api/v1/mcp", { headers: { host: "localhost" } })).json();
    expect(prm).toMatchObject({ resource: "http://localhost/api/v1/mcp", authorization_servers: ["http://localhost"] });
    const res = await ctx.app.request("/.well-known/oauth-authorization-server", { headers: { host: "localhost", origin: "https://claude.ai" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const asm = await res.json();
    expect(asm).toMatchObject({ issuer: "http://localhost", authorization_endpoint: "http://localhost/oauth/authorize", token_endpoint: "http://localhost/api/oauth/token", registration_endpoint: "http://localhost/api/oauth/register", code_challenge_methods_supported: ["S256"] });
  });
});

describe("MCP OAuth: registration", () => {
  it("registers a public client and checks redirect URIs", async () => {
    const r = await register();
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ client_name: "Claude", token_endpoint_auth_method: "none", redirect_uris: [REDIRECT] });
    expect(String(r.body.client_id)).toMatch(/^mcpc_/);
    expect((await register({ redirect_uris: ["javascript:alert(1)"] })).status).toBe(400);
    expect((await register({ redirect_uris: ["http://evil.example/cb"] })).body.error).toBe("invalid_redirect_uri");
    expect((await register({ redirect_uris: [] })).status).toBe(400);
    expect((await register({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_basic" })).body.error).toBe("invalid_client_metadata");
  });
  it("accepts loopback http and app schemes, refuses fragments", () => {
    expect(checkRedirectUri("http://127.0.0.1:33418/callback")).toBeTruthy();
    expect(checkRedirectUri("cursor://anysphere.cursor-retrieval/oauth/callback")).toBeTruthy();
    expect(() => checkRedirectUri("https://a.example/cb#x")).toThrow();
    expect(() => checkRedirectUri("data:text/html,hi")).toThrow();
  });
});

describe("MCP OAuth: sign in and tokens", () => {
  it("signs in with PKCE, lists MCP tools with the token, and acts as the person", async () => {
    const info = await c.get(`/api/oauth/authorize?${new URLSearchParams(await authorizeParams((await register()).body.client_id as string))}`);
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ client: { name: "Claude" }, redirectHost: "claude.ai", requestedScope: "full" });
    expect(info.body.workspaces).toHaveLength(1);
    const { clientId, code, url } = await signIn();
    expect(url.searchParams.get("state")).toBe("st-1");
    expect(url.origin + url.pathname).toBe(REDIRECT);
    const t = await exchange(clientId, code);
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "mcp:read mcp:write" });
    expect(t.body.access_token).toMatch(/^mm_oat_/);
    const client = await mcp(t.body.access_token);
    const tools = (await client.listTools()).tools.map((x) => x.name);
    expect(tools.length).toBeGreaterThanOrEqual(57);
    const created = await client.callTool({ name: "create_task", arguments: { title: "From Claude" } });
    expect((created as { isError?: boolean }).isError).toBeFalsy();
    // The task reads as the person who signed in, not as the workspace. AIS1: an AI app's task waits in Triage
    // (the first project, made for it, starts with Triage on) until a person accepts it.
    const items = await c.get("/api/triage");
    const task = (items.body.items as { title: string; triage: { source: string }; createdByUserId?: string; createdBy?: { name?: string } }[]).find((x) => x.title === "From Claude");
    expect(task).toBeTruthy();
    expect(task!.triage.source).toBe("agent");
  });

  it("refuses a wrong PKCE verifier, a second use of a code, and a foreign client", async () => {
    const a = await signIn();
    expect((await exchange(a.clientId, a.code, "w".repeat(50))).body.error).toBe("invalid_grant");
    const b = await signIn();
    const other = (await register()).body.client_id as string;
    expect((await exchange(other, b.code)).body.error).toBe("invalid_grant");
    const ok = await exchange(b.clientId, b.code);
    expect(ok.status).toBe(200);
    // Reuse ends the grant, so even the first token stops working.
    expect((await exchange(b.clientId, b.code)).body.error).toBe("invalid_grant");
    const res = await ctx.app.request("/api/v1/mcp", { method: "POST", headers: { host: "localhost", authorization: `Bearer ${ok.body.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(res.status).toBe(401);
  });

  it("refuses an expired code", async () => {
    const a = await signIn();
    const real = ctx.deps.now;
    ctx.deps.now = () => new Date(real().getTime() + 120_000);
    try { expect((await exchange(a.clientId, a.code)).body.error).toBe("invalid_grant"); } finally { ctx.deps.now = real; }
  });

  it("requires PKCE S256 and known scopes on the sign in request", async () => {
    const clientId = (await register()).body.client_id as string;
    const noPkce = await c.get(`/api/oauth/authorize?${new URLSearchParams({ ...(await authorizeParams(clientId)), code_challenge_method: "plain" })}`);
    expect(noPkce.status).toBe(400);
    const badScope = await c.get(`/api/oauth/authorize?${new URLSearchParams({ ...(await authorizeParams(clientId)), scope: "admin" })}`);
    expect(badScope.body.error.code).toBe("invalid_scope");
    const onlyOpenId = await c.get(`/api/oauth/authorize?${new URLSearchParams({ ...(await authorizeParams(clientId)), scope: "openid profile" })}`);
    expect(onlyOpenId.body.error.code).toBe("invalid_scope");
    const badRedirect = await c.get(`/api/oauth/authorize?${new URLSearchParams({ ...(await authorizeParams(clientId)), redirect_uri: "https://evil.example/cb" })}`);
    expect(badRedirect.status).toBe(400);
  });

  it("a read only grant can read but not write, and never outgrows what the app asked for", async () => {
    const a = await signIn("read");
    const t = await exchange(a.clientId, a.code);
    expect(t.body.scope).toBe("mcp:read");
    const client = await mcp(t.body.access_token);
    expect((await client.callTool({ name: "list_tasks", arguments: {} }) as { isError?: boolean }).isError).toBeFalsy();
    const w = await client.callTool({ name: "create_task", arguments: { title: "nope" } }) as { isError?: boolean; content: { text: string }[] };
    expect(w.isError).toBe(true);
    expect(w.content[0].text).toContain("read_only_key");
    // The app asked only for mcp:read: choosing read and write on the page still gives read.
    const b = await signIn("full", { scope: "mcp:read" });
    expect((await exchange(b.clientId, b.code)).body.scope).toBe("mcp:read");
    // Repeated scope params and an OpenID word still keep read and write when mcp:write was asked.
    const clientId = (await register()).body.client_id as string;
    const both = new URLSearchParams(await authorizeParams(clientId));
    both.delete("scope");
    both.append("scope", "mcp:read");
    both.append("scope", "openid");
    both.append("scope", "mcp:write");
    const info = await c.get(`/api/oauth/authorize?${both}`);
    expect(info.body.requestedScope).toBe("full");
    const request = { ...Object.fromEntries(both.entries()), scope: both.getAll("scope").join(" ") };
    const kept = await c.post("/api/oauth/authorize", { decision: "allow", scope: "full", request });
    const url = new URL(kept.body.redirectTo);
    expect((await exchange(clientId, url.searchParams.get("code")!)).body.scope).toBe("mcp:read mcp:write");
  });

  it("refresh rotates the refresh token; the old one stops working", async () => {
    const a = await signIn();
    const t = await exchange(a.clientId, a.code);
    const r1 = await ctx.app.request("/api/oauth/token", form({ grant_type: "refresh_token", refresh_token: t.body.refresh_token, client_id: a.clientId }));
    expect(r1.status).toBe(200);
    const b1 = await r1.json() as Record<string, string>;
    expect(b1.refresh_token).not.toBe(t.body.refresh_token);
    // JSON bodies work too.
    const r3 = await ctx.app.request("/api/oauth/token", { method: "POST", headers: { "content-type": "application/json", host: "localhost" }, body: JSON.stringify({ grant_type: "refresh_token", refresh_token: b1.refresh_token }) });
    expect(r3.status).toBe(200);
    // PRIV1b (P70): the old token is refused; replaying it now also ends the grant, so it runs last.
    const r2 = await ctx.app.request("/api/oauth/token", form({ grant_type: "refresh_token", refresh_token: t.body.refresh_token }));
    expect(r2.status).toBe(400);
  });

  it("an access token works only on the MCP endpoint", async () => {
    const a = await signIn();
    const t = await exchange(a.clientId, a.code);
    const res = await ctx.app.request("/api/v1/tasks", { headers: { host: "localhost", authorization: `Bearer ${t.body.access_token}` } });
    expect(res.status).toBe(401);
    const forged = t.body.access_token.slice(0, -4) + "0000";
    const res2 = await ctx.app.request("/api/v1/mcp", { method: "POST", headers: { host: "localhost", authorization: `Bearer ${forged}`, "content-type": "application/json" }, body: "{}" });
    expect(res2.status).toBe(401);
  });
});

describe("MCP OAuth: Settings and revoke", () => {
  it("a second connect of the same app replaces the first, and only a human membership keeps the token", async () => {
    const first = await signIn();
    const t1 = await exchange(first.clientId, first.code);
    // The same client id signs in again (a look alike client with another id never replaces it: oauth-grants-replace.test.ts).
    const second = await signIn("full", {}, c, first.clientId);
    const t2 = await exchange(second.clientId, second.code);
    const list = await c.get("/api/oauth/grants");
    expect(list.body.grants).toHaveLength(1);
    expect(list.body.grants[0].client).toBe("Claude");
    const old = await ctx.app.request("/api/v1/mcp", { method: "POST", headers: { host: "localhost", authorization: `Bearer ${t1.body.access_token}`, "content-type": "application/json", accept: "application/json" }, body: "{}" });
    expect(old.status).toBe(401);
    const live = await ctx.app.request("/api/v1/mcp", { method: "POST", headers: { host: "localhost", authorization: `Bearer ${t2.body.access_token}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(live.status).toBe(200);
    const userId = (await c.get("/api/account/me")).body.user.id as string;
    await ctx.db.update(members).set({ kind: "agent" }).where(eq(members.userId, userId));
    const agent = await ctx.app.request("/api/v1/mcp", { method: "POST", headers: { host: "localhost", authorization: `Bearer ${t2.body.access_token}`, "content-type": "application/json", accept: "application/json" }, body: "{}" });
    expect(agent.status).toBe(401);
    await ctx.db.update(members).set({ kind: "human" }).where(eq(members.userId, userId));
    const human = await ctx.app.request("/api/v1/mcp", { method: "POST", headers: { host: "localhost", authorization: `Bearer ${t2.body.access_token}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(human.status).toBe(200);
  });

  it("an abandoned reconnect leaves the existing tokens working until a new code is exchanged", async () => {
    const first = await signIn();
    const t1 = await exchange(first.clientId, first.code);
    const mcpOk = async (token: string) => ctx.app.request("/api/v1/mcp", { method: "POST", headers: { host: "localhost", authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect((await mcpOk(t1.body.access_token)).status).toBe(200);

    // Consent again but never exchange: closed browser / abandoned reconnect.
    const abandoned = await signIn("full", {}, c, first.clientId);
    expect((await mcpOk(t1.body.access_token)).status).toBe(200);
    expect((await c.get("/api/oauth/grants")).body.grants).toHaveLength(1);

    // Bad PKCE and an expired code also leave the live grant alone.
    expect((await exchange(abandoned.clientId, abandoned.code, "w".repeat(50))).body.error).toBe("invalid_grant");
    expect((await mcpOk(t1.body.access_token)).status).toBe(200);
    const expired = await signIn("full", {}, c, first.clientId);
    const real = ctx.deps.now;
    ctx.deps.now = () => new Date(real().getTime() + 120_000);
    try { expect((await exchange(expired.clientId, expired.code)).body.error).toBe("invalid_grant"); }
    finally { ctx.deps.now = real; }
    expect((await mcpOk(t1.body.access_token)).status).toBe(200);

    // Only a successful exchange replaces the older grant.
    const next = await signIn("full", {}, c, first.clientId);
    const t2 = await exchange(next.clientId, next.code);
    expect(t2.status).toBe(200);
    expect((await mcpOk(t1.body.access_token)).status).toBe(401);
    expect((await mcpOk(t2.body.access_token)).status).toBe(200);
    expect((await c.get("/api/oauth/grants")).body.grants).toHaveLength(1);
  });

  it("lists connected apps, disconnects one, and the token stops at once", async () => {
    const a = await signIn();
    const t = await exchange(a.clientId, a.code);
    const list = await c.get("/api/oauth/grants");
    expect(list.body.grants).toHaveLength(1);
    expect(list.body.grants[0]).toMatchObject({ client: "Claude", scope: "full", mine: true });
    expect((await c.del(`/api/oauth/grants/${list.body.grants[0].id}`)).status).toBe(200);
    expect((await c.get("/api/oauth/grants")).body.grants).toHaveLength(0);
    const res = await ctx.app.request("/api/v1/mcp", { method: "POST", headers: { host: "localhost", authorization: `Bearer ${t.body.access_token}`, "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("RFC 7009 revoke ends the grant", async () => {
    const a = await signIn();
    const t = await exchange(a.clientId, a.code);
    expect((await ctx.app.request("/api/oauth/revoke", form({ token: t.body.refresh_token }))).status).toBe(200);
    expect((await ctx.app.request("/api/oauth/revoke", form({ token: "mm_ort_unknown" }))).status).toBe(200);
    const r = await ctx.app.request("/api/oauth/token", form({ grant_type: "refresh_token", refresh_token: t.body.refresh_token }));
    expect(r.status).toBe(400);
  });

  it("someone can't sign an app in to a workspace they are not in, and members see only their own apps", async () => {
    const outsider = new Client(ctx.app);
    await outsider.signup("eve@evil.io", "Eve", "Evil");
    const myOrg = (await c.get("/api/account/me")).body;
    const orgId = myOrg.org?.id ?? myOrg.orgId ?? myOrg.organization?.id;
    const clientId = (await register()).body.client_id as string;
    const r = await outsider.post("/api/oauth/authorize", { decision: "allow", scope: "full", orgId, request: await authorizeParams(clientId) });
    expect(r.status).toBe(403);
    // Eve's own app is invisible to Acme.
    await signIn("full", {}, outsider);
    expect((await c.get("/api/oauth/grants")).body.grants).toHaveLength(0);
  });

  it("deny sends access_denied back to the app", async () => {
    const clientId = (await register()).body.client_id as string;
    const r = await c.post("/api/oauth/authorize", { decision: "deny", request: await authorizeParams(clientId) });
    const url = new URL(r.body.redirectTo);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("st-1");
  });

  it("the consent step needs the signed in session and a same site JSON request", async () => {
    const clientId = (await register()).body.client_id as string;
    const anon = new Client(ctx.app);
    expect((await anon.get(`/api/oauth/authorize?${new URLSearchParams(await authorizeParams(clientId))}`)).status).toBe(401);
    const cross = await c.call("POST", "/api/oauth/authorize", { decision: "allow", request: await authorizeParams(clientId) }, { origin: "https://evil.example" });
    expect(cross.status).toBe(403);
  });

  it("writes last used at most once an hour per grant", () => {
    expect(GRANT_LAST_USED_EVERY_MS).toBe(3_600_000);
  });
});
