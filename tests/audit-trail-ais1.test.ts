/**
 * AIS1 (audit of 11 Nov 2026, rows 50 and 15): the audit log says what acted and what it touched.
 * An entry made through an API key or a connected AI app names the kind of caller, the key (name and prefix) or the app,
 * and the request's IP; a person's own action in the app has no caller stamp. Task history says the same. A thread read
 * names the thread, a deleted key's entries keep its name and prefix, and the Team AI run log is kept for a year.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { auditLogs } from "@/server/db/schema";
import { pkceChallenge } from "@/server/services/developer/oauth";
import { audit } from "@/server/services/audit";
import { noteRequestCaller, runWithRequestCaller } from "@/server/lib/request-caller";
import { auditWho, callerStampOf, viaLabel } from "@/shared/audit-caller";

const IP = "203.0.113.7";
const APP_IP = "198.51.100.4";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const verifier = "v".repeat(20) + "-verifier-for-pkce-tests-0123456789";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;

const viaApp = (p: string, init?: RequestInit) => ctx.app.request(p, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost", "cf-connecting-ip": IP } });

async function connectClaude(): Promise<string> {
  const reg = await ctx.app.request("/api/oauth/register", { method: "POST", headers: { "content-type": "application/json", host: "localhost", origin: "https://claude.ai" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }) });
  const clientId = ((await reg.json()) as { client_id: string }).client_id;
  const request = { client_id: clientId, redirect_uri: REDIRECT, response_type: "code", code_challenge: await pkceChallenge(verifier), code_challenge_method: "S256", state: "st-1", scope: "mcp:read mcp:write" };
  const r = await c.post("/api/oauth/authorize", { decision: "allow", scope: "full", request });
  expect(r.status).toBe(200);
  const code = new URL(r.body.redirectTo).searchParams.get("code")!;
  const tok = await ctx.app.request("/api/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", host: "localhost" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier }).toString() });
  return ((await tok.json()) as { access_token: string }).access_token;
}

async function mcp(token: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => viaApp(new URL(url).pathname, init)) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${token}` } }, fetch: fetchViaApp }));
  return client;
}
const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);

async function v1(key: string, method: string, path: string, body?: unknown) {
  const res = await viaApp(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

type Row = typeof auditLogs.$inferSelect & { meta: Record<string, unknown> | null };
async function rows(action: string): Promise<Row[]> {
  const all = await ctx.db.select().from(auditLogs).where(eq(auditLogs.action, action));
  return all.map((r) => ({ ...r, meta: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null }));
}

async function verifiedDomain() {
  const domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
  const { body } = await c.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  expect((await c.post(`/api/domains/${domainId}/verify`)).body.domain.status).toBe("verified");
}

async function newKey(name: string) {
  const made = await c.post("/api/developer/keys", { name });
  expect(made.status).toBe(201);
  return { secret: made.body.secret as string, id: made.body.apiKey.id as string, prefix: made.body.apiKey.prefix as string };
}

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io");
  await verifiedDomain();
});

describe("AIS1 row 50: an entry made through a key or a connected AI app says so", () => {
  it("a connected app names itself and keeps the IP; the same person's own action in the app has no caller", async () => {
    expect((await c.call("POST", "/api/agents", { name: "By hand", localPart: "byhand" }, { "cf-connecting-ip": APP_IP })).status).toBe(201);
    const m = await mcp(await connectClaude());
    const made = data(await m.callTool({ name: "create_agent_inbox", arguments: { name: "Via Claude", localPart: "viaclaude" } }));
    expect(made.agent.name).toBe("Via Claude");

    const created = await rows("agent.created");
    const byHand = created.find((r) => r.meta?.name === "By hand")!;
    const viaClaude = created.find((r) => r.meta?.name === "Via Claude")!;
    // Both read as the same person...
    expect(byHand.actorEmail).toBe("owner@acme.io");
    expect(viaClaude.actorEmail).toBe("owner@acme.io");
    expect(viaClaude.actorUserId).toBe(byHand.actorUserId);
    // ...but only the connected app's entry says it was the app, and both keep the request's IP.
    expect(byHand.meta?.caller).toBeUndefined();
    expect(byHand.ip).toBe(APP_IP);
    expect(viaClaude.meta?.caller).toEqual({ kind: "oauth", app: "Claude" });
    expect(viaClaude.ip).toBe(IP);
    // The audit view (admins) gets the same entry with its stamp.
    const view = (await c.get("/api/org/audit")).body.entries.find((e: { action: string; metadata: { name?: string } }) => e.action === "agent.created" && e.metadata?.name === "Via Claude");
    expect(view.metadata.caller).toEqual({ kind: "oauth", app: "Claude" });
    expect(auditWho(view)).toEqual({ actor: "owner@acme.io", via: "via Claude (connected app)" });
  });

  it("a workspace key names the key and its prefix on REST and MCP, with the IP", async () => {
    const key = await newKey("Billing bot");
    expect((await v1(key.secret, "POST", "/agents", { name: "Over REST", localPart: "overrest" })).status).toBe(201);
    const m = await mcp(key.secret);
    data(await m.callTool({ name: "create_agent_inbox", arguments: { name: "Over MCP", localPart: "overmcp" } }));
    const created = await rows("agent.created");
    for (const name of ["Over REST", "Over MCP"]) {
      const r = created.find((x) => x.meta?.name === name)!;
      expect(r.meta?.caller).toEqual({ kind: "workspace_key", key: "Billing bot", prefix: key.prefix });
      expect(r.ip).toBe(IP);
      expect(r.actorEmail).toBe(`api-key:${key.prefix}`);
    }
  });
});

describe("AIS1 the stamping rule", () => {
  type E = { action: string; actorUserId?: string | null; actorEmail?: string | null; ip?: string | null; agentId?: string | null };
  async function written(caller: Parameters<typeof noteRequestCaller>[0] | null, ip: string, entries: E[]) {
    const orgId = (await c.get("/api/account/me")).body.organization.id as string;
    await runWithRequestCaller(ip, async () => {
      if (caller) noteRequestCaller(caller);
      for (const e of entries) await audit(ctx.db, { orgId, ...e });
    });
    const out = new Map<string, Row>();
    for (const e of entries) out.set(e.action, (await rows(e.action))[0]);
    return out;
  }

  it("a person's request stamps only rows that name them, and never with a caller", async () => {
    const r = await written({ userId: "usr_p", email: "p@acme.io", role: "owner", sessionId: "abc" }, IP, [
      { action: "t.person", actorUserId: "usr_p", actorEmail: "p@acme.io" },
      { action: "t.agent", actorUserId: null, actorEmail: "agent:bot@acme.io", agentId: "agt_1" },
      { action: "t.system" },
      { action: "t.explicit", actorUserId: "usr_p", actorEmail: "p@acme.io", ip: "192.0.2.1" },
    ]);
    expect(r.get("t.person")).toMatchObject({ ip: IP, meta: null });
    expect(r.get("t.agent")).toMatchObject({ ip: null, meta: null });
    expect(r.get("t.system")).toMatchObject({ ip: null, meta: null });
    expect(r.get("t.explicit")?.ip).toBe("192.0.2.1");
  });

  it("a key's request stamps what it caused, but not a row that names another person", async () => {
    const key = { userId: "usr_maker", email: "api-key:mm_live_abcd", role: "admin" as const, sessionId: "apikey:key_1", apiKeyId: "key_1", agentId: null, keyName: "Bot", keyPrefix: "mm_live_abcd" };
    const r = await written(key, IP, [
      { action: "t.key", actorUserId: "usr_maker", actorEmail: "api-key:mm_live_abcd" },
      { action: "t.agent", actorUserId: null, actorEmail: "agent:bot@acme.io", agentId: "agt_1" },
      { action: "t.other", actorUserId: "usr_other", actorEmail: "o@acme.io" },
    ]);
    const stamp = { caller: { kind: "workspace_key", key: "Bot", prefix: "mm_live_abcd" } };
    expect(r.get("t.key")).toMatchObject({ ip: IP, meta: stamp });
    expect(r.get("t.agent")).toMatchObject({ ip: IP, meta: stamp });
    expect(r.get("t.other")).toMatchObject({ ip: null, meta: null });
  });

  it("a request with nobody signed in yet keeps the IP of rows that name someone; an unknown IP is not stored", async () => {
    const r = await written(null, IP, [{ action: "t.signin", actorUserId: "usr_p", actorEmail: "p@acme.io" }, { action: "t.none" }]);
    expect(r.get("t.signin")).toMatchObject({ ip: IP, meta: null });
    expect(r.get("t.none")?.ip).toBeNull();
    const u = await written({ userId: "usr_p", email: "p@acme.io", role: "owner", sessionId: "abc" }, "unknown", [{ action: "t.unknown", actorUserId: "usr_p" }]);
    expect(u.get("t.unknown")?.ip).toBeNull();
  });

  it("outside a request nothing changes", async () => {
    const orgId = (await c.get("/api/account/me")).body.organization.id as string;
    await audit(ctx.db, { orgId, action: "t.outside", actorUserId: "usr_p", actorEmail: "p@acme.io" });
    expect((await rows("t.outside"))[0]).toMatchObject({ ip: null, meta: null });
  });
});

describe("AIS1 audit labels", () => {
  it("reads each kind of caller in plain words", () => {
    expect(viaLabel({ kind: "oauth", app: "Claude" })).toBe("via Claude (connected app)");
    expect(viaLabel({ kind: "oauth" })).toBe("via a connected app");
    expect(viaLabel({ kind: "workspace_key", key: "Bot", prefix: "mm_live_abcd" })).toBe("via API key Bot (mm_live_abcd)");
    expect(viaLabel({ kind: "agent_key", key: "Reader key", prefix: "mm_live_efgh" })).toBe("via agent key Reader key (mm_live_efgh)");
    expect(viaLabel({ kind: "agent_member_key", key: "Builder", prefix: "mm_live_ijkl" })).toBe("via agent member key Builder (mm_live_ijkl)");
    expect(callerStampOf({ kind: "person" })).toBeNull();
    expect(callerStampOf("oauth")).toBeNull();
    expect(callerStampOf({ kind: "oauth", app: 3 })).toEqual({ kind: "oauth" });
  });

  it("names a key by its name and prefix, and an old key entry by its prefix", () => {
    expect(auditWho({ actorEmail: "api-key:mm_live_S6PZ", metadata: null })).toEqual({ actor: "API key (mm_live_S6PZ)", via: null });
    expect(auditWho({ actorEmail: "api-key:mm_live_abcd", metadata: { caller: { kind: "workspace_key", key: "Bot", prefix: "mm_live_abcd" } } })).toEqual({ actor: "API key Bot (mm_live_abcd)", via: null });
    expect(auditWho({ actorEmail: "api-key:mm_live_abcd", metadata: { caller: { kind: "agent_member_key", key: "Builder", prefix: "mm_live_abcd" } } })).toEqual({ actor: "Agent member key Builder (mm_live_abcd)", via: null });
    expect(auditWho({ actorEmail: "ada@acme.io", metadata: { caller: { kind: "oauth", app: "Claude" } } })).toEqual({ actor: "ada@acme.io", via: "via Claude (connected app)" });
    expect(auditWho({ actorEmail: null, metadata: null })).toEqual({ actor: null, via: null });
  });
});
