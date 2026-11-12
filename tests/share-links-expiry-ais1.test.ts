import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { createShareLink, listShareLinks, SHARE_DEFAULT_EXPIRY_DAYS } from "@/server/services/suite/share-links";
import { pkceChallenge } from "@/server/services/developer/oauth";

/**
 * AIS1 (audit row 67): a public share link made by an API key or a connected AI app always ends. No end date given
 * means 30 days; "never" (null) is refused for them. A person in the app may still pick no end date.
 */

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let docId = "";
let me: { user: { id: string; email: string; name: string }; organization: { id: string } };

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("olive@harbour.test", "Olive Owner", "Harbour Coffee");
  me = (await c.get("/api/account/me")).body;
  docId = (await c.post("/api/docs", { title: "Client brief", text: "The plan" })).body.doc.id;
});

const DAY = 86_400_000;
const daysFromNow = (iso: string | null) => (iso ? Math.round((Date.parse(iso) - Date.now()) / DAY) : null);
async function v1(key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { host: "localhost", authorization: `Bearer ${key}`, "content-type": "application/json" }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}
async function mcpWith(token: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${token}` } }, fetch: fetchViaApp }));
  return client;
}
async function oauthToken() {
  const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
  const verifier = "v".repeat(20) + "-verifier-for-pkce-tests-0123456789";
  const reg = await ctx.app.request("/api/oauth/register", { method: "POST", headers: { "content-type": "application/json", host: "localhost", origin: "https://claude.ai" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }) });
  const clientId = ((await reg.json()) as { client_id: string }).client_id;
  const request = { client_id: clientId, redirect_uri: REDIRECT, response_type: "code", code_challenge: await pkceChallenge(verifier), code_challenge_method: "S256", state: "st-1", scope: "mcp:read mcp:write" };
  const r = await c.post("/api/oauth/authorize", { decision: "allow", scope: "full", request });
  const code = new URL(r.body.redirectTo).searchParams.get("code")!;
  const tok = await ctx.app.request("/api/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", host: "localhost" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier }).toString() });
  return ((await tok.json()) as { access_token: string }).access_token;
}
const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

describe("AIS1 row 67: public links made by keys and AI apps end", () => {
  it("v1: no expiresInDays gives 30 days, 7 stays 7, and null (never) answers 403 person_only", async () => {
    expect(SHARE_DEFAULT_EXPIRY_DAYS).toBe(30);
    const key = (await c.post("/api/developer/keys", { name: "Full" })).body.secret as string;
    const plain = await v1(key, "POST", "/share-links", { kind: "doc", targetId: docId });
    expect(plain.status).toBe(201);
    expect(daysFromNow(plain.body.link.expiresAt)).toBe(30);
    const week = await v1(key, "POST", "/share-links", { kind: "doc", targetId: docId, expiresInDays: 7 });
    expect(daysFromNow(week.body.link.expiresAt)).toBe(7);
    const never = await v1(key, "POST", "/share-links", { kind: "doc", targetId: docId, expiresInDays: null });
    expect(never.status).toBe(403);
    expect(never.body.error.code).toBe("person_only");
    expect(never.body.error.message).toContain("never expires");
    // Listing stays open to a workspace key.
    expect((await v1(key, "GET", `/share-links?kind=doc&targetId=${docId}`)).body.links).toHaveLength(2);
  });

  it("MCP with a key: no expiry gives 30 days, null is refused with person_only", async () => {
    const key = (await c.post("/api/developer/keys", { name: "MCP" })).body.secret as string;
    const m = await mcpWith(key);
    const made = data(await m.callTool({ name: "create_share_link", arguments: { kind: "doc", targetId: docId } }));
    expect(daysFromNow(made.link.expiresAt)).toBe(30);
    const out = await m.callTool({ name: "create_share_link", arguments: { kind: "doc", targetId: docId, expiresInDays: null } });
    expect(out.isError).toBe(true);
    expect(text(out)).toMatch(/^person_only: /);
    await m.close();
  });

  it("a connected AI app (OAuth) acting as the owner can't make a link that never ends", async () => {
    const m = await mcpWith(await oauthToken());
    const out = await m.callTool({ name: "create_share_link", arguments: { kind: "doc", targetId: docId, expiresInDays: null } });
    expect(out.isError).toBe(true);
    expect(text(out)).toMatch(/^person_only: /);
    const made = data(await m.callTool({ name: "create_share_link", arguments: { kind: "doc", targetId: docId } }));
    expect(daysFromNow(made.link.expiresAt)).toBe(30);
    await m.close();
  });

  it("a person in the app may still choose no end date; leaving it out gives 30 days", async () => {
    const never = await c.post("/api/share-links", { kind: "doc", targetId: docId, expiresInDays: null });
    expect(never.status).toBe(201);
    expect(never.body.link.expiresAt).toBeNull();
    const plain = await c.post("/api/share-links", { kind: "doc", targetId: docId });
    expect(daysFromNow(plain.body.link.expiresAt)).toBe(30);
  });

  it("the service refuses null for any caller that isn't a person, and keeps the old guest and agent rules", async () => {
    const base = { orgId: me.organization.id, userId: me.user.id, email: me.user.email, name: me.user.name, role: "owner" as const };
    for (const caller of [{ ...base, apiKeyId: "key_1" }, { ...base, apiKeyId: "oauth:grant_1" }]) {
      await expect(createShareLink(ctx.deps, caller, { kind: "doc", targetId: docId, expiresInDays: null })).rejects.toMatchObject({ status: 403, code: "person_only" });
      expect(daysFromNow((await createShareLink(ctx.deps, caller, { kind: "doc", targetId: docId })).link.expiresAt)).toBe(30);
    }
    expect((await createShareLink(ctx.deps, base, { kind: "doc", targetId: docId, expiresInDays: null })).link.expiresAt).toBeNull();
    await expect(createShareLink(ctx.deps, { ...base, guest: true }, { kind: "doc", targetId: docId })).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(createShareLink(ctx.deps, { ...base, agentId: "agt_x" }, { kind: "doc", targetId: docId })).rejects.toMatchObject({ status: 403, code: "agent_key_scope" });
    await expect(listShareLinks(ctx.deps, { ...base, apiKeyId: "key_1" }, {})).resolves.toMatchObject({ allowShareLinks: true });
  });
});
