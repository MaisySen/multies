import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { auditLogs, organizations } from "@/server/db/schema";
import { pkceChallenge } from "@/server/services/developer/oauth";
import { AGENT_DEFAULT_DAILY_SENDS } from "@/server/services/agents";

// AIS1 (audit of 11 Nov 2026, rows 4 and 51 plus two gaps): an agent's guardrails (approval rule, daily cap, allowed
// recipients, pause, mailboxes) are lowered only by a person signed in to the app. A workspace key or a connected AI
// app may create an agent at "a person approves every message" and may tighten it, nothing more.

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let wsKey: string;
let domainId: string;
let orgId: string;

async function api(key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, {
    method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

async function mcpFor(token: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${token}` } }, fetch: fetchViaApp }));
  return client;
}
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

// The OAuth flow from tests/mcp-oauth.test.ts: the person allows Claude, Claude gets a token for /mcp.
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const verifier = "v".repeat(20) + "-verifier-for-pkce-tests-0123456789";
async function oauthToken() {
  const reg = await ctx.app.request("/api/oauth/register", { method: "POST", headers: { "content-type": "application/json", host: "localhost", origin: "https://claude.ai" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }) });
  const clientId = ((await reg.json()) as { client_id: string }).client_id;
  const request = { client_id: clientId, redirect_uri: REDIRECT, response_type: "code", code_challenge: await pkceChallenge(verifier), code_challenge_method: "S256", state: "st-1", scope: "mcp:read mcp:write" };
  const r = await c.post("/api/oauth/authorize", { decision: "allow", scope: "full", request });
  const code = new URL(r.body.redirectTo).searchParams.get("code")!;
  const res = await ctx.app.request("/api/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", host: "localhost" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier }).toString() });
  return ((await res.json()) as { access_token: string }).access_token;
}

async function verify(client: Client, id: string) {
  const { body } = await client.get(`/api/domains/${id}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  expect((await client.post(`/api/domains/${id}/verify`)).body.domain.status).toBe("verified");
}

const refusals = async (action: string) => (await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.action, action))))
  .map((r) => ({ agentId: r.agentId, metadata: JSON.parse(r.metadata ?? "{}") as { fields?: string[] } }));

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io");
  orgId = (await c.get("/api/account/me")).body.organization.id;
  domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
  await verify(c, domainId);
  wsKey = (await c.post("/api/developer/keys", { name: "Agents" })).body.secret;
});

describe("AIS1 row 4: a key or an AI app creates agents only at 'a person approves every message'", () => {
  it("refuses approvalMode never or external from a workspace key, names the field and logs the attempt", async () => {
    for (const mode of ["never", "external"]) {
      const r = await api(wsKey, "POST", "/agents", { name: `Bot ${mode}`, approvalMode: mode });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("person_only");
      expect(r.body.error.message).toContain("approvalMode");
    }
    expect((await api(wsKey, "GET", "/agents")).body.data).toEqual([]);
    const logged = await refusals("agent.create_refused");
    expect(logged).toHaveLength(2);
    expect(logged[0].metadata.fields).toEqual(["approvalMode"]);
    // "always", or nothing, is fine.
    expect((await api(wsKey, "POST", "/agents", { name: "Asked", approvalMode: "always" })).body.agent.approvalMode).toBe("always");
    expect((await api(wsKey, "POST", "/agents", { name: "Plain" })).body.agent.approvalMode).toBe("always");
  });

  it("refuses the same through MCP create_agent_inbox, with a workspace key and with a connected AI app (OAuth)", async () => {
    for (const token of [wsKey, await oauthToken()]) {
      const mcp = await mcpFor(token);
      const r = await mcp.callTool({ name: "create_agent_inbox", arguments: { name: "Loose", approvalMode: "never" } });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("person_only");
      const ok = await mcp.callTool({ name: "create_agent_inbox", arguments: { name: `Tight ${token.slice(0, 6)}` } });
      expect(ok.isError).toBeFalsy();
      expect(JSON.parse(text(ok)).agent).toMatchObject({ approvalMode: "always", sendCapDaily: AGENT_DEFAULT_DAILY_SENDS, allowedRecipients: ["@acme.io"] });
      await mcp.close();
    }
  });

  it("a person in the app may still create an agent with any approval mode", async () => {
    const r = await c.post("/api/agents", { name: "Trusted", approvalMode: "never" });
    expect(r.status).toBe(201);
    expect(r.body.agent.approvalMode).toBe("never");
  });
});

describe("AIS1 row 4: a key may only tighten an existing agent", () => {
  async function made() {
    const team = (await c.post("/api/mailboxes", { domainId, localPart: "support", displayName: "Support" })).body.mailbox;
    const other = (await c.post("/api/mailboxes", { domainId, localPart: "sales", displayName: "Sales" })).body.mailbox;
    const r = await c.post("/api/agents", { name: "Helper", approvalMode: "external", sendCapDaily: 50, allowedRecipients: ["@acme.io", "grace@example.com"], mailboxIds: [team.id] });
    expect(r.status).toBe(201);
    return { agent: r.body.agent as { id: string; inboxId: string }, team, other };
  }

  it("refuses every loosening, names the field and leaves the agent as it was", async () => {
    const { agent, team, other } = await made();
    const cases: [Record<string, unknown>, string][] = [
      [{ approvalMode: "never" }, "approvalMode"],
      [{ sendCapDaily: 51 }, "sendCapDaily"],
      [{ allowedRecipients: null }, "allowedRecipients"],
      [{ allowedRecipients: [] }, "allowedRecipients"],
      [{ allowedRecipients: ["@acme.io", "ceo@other.org"] }, "allowedRecipients"],
      [{ allowedRecipients: ["@example.com"] }, "allowedRecipients"],
      [{ mailboxIds: [team.id, other.id] }, "mailboxIds"],
    ];
    for (const [patch, field] of cases) {
      const r = await api(wsKey, "PATCH", `/agents/${agent.id}`, patch);
      expect(r.status, JSON.stringify(patch)).toBe(403);
      expect(r.body.error.code).toBe("person_only");
      expect(r.body.error.message).toContain(field);
    }
    // Two loosenings in one call name both, and a harmless name change in the same call doesn't go through either.
    const both = await api(wsKey, "PATCH", `/agents/${agent.id}`, { name: "Renamed", approvalMode: "never", sendCapDaily: 99 });
    expect(both.body.error.message).toContain("approvalMode");
    expect(both.body.error.message).toContain("sendCapDaily");
    const now = (await api(wsKey, "GET", `/agents/${agent.id}`)).body;
    expect(now).toMatchObject({ name: "Helper", approvalMode: "external", sendCapDaily: 50, allowedRecipients: ["@acme.io", "grace@example.com"], mailboxIds: [agent.inboxId, team.id] });
    // Each refusal is on the agent's own audit log, with the fields.
    const audit = (await api(wsKey, "GET", `/agents/${agent.id}/audit`)).body.data.filter((e: { action: string }) => e.action === "agent.update_refused");
    expect(audit).toHaveLength(cases.length + 1);
    expect(audit[0].metadata.fields).toEqual(["approvalMode", "sendCapDaily"]);
  });

  it("allows tightening and the same values sent back", async () => {
    const { agent, team } = await made();
    // A GET then PATCH of the same values is not a loosening.
    const same = await api(wsKey, "PATCH", `/agents/${agent.id}`, { approvalMode: "external", sendCapDaily: 50, allowedRecipients: ["grace@example.com", "@ACME.io"], mailboxIds: [team.id], status: "active" });
    expect(same.status).toBe(200);
    expect((await api(wsKey, "PATCH", `/agents/${agent.id}`, { name: "Renamed", description: "Answers support mail" })).status).toBe(200);
    expect((await api(wsKey, "PATCH", `/agents/${agent.id}`, { sendCapDaily: 20 })).body.sendCapDaily).toBe(20);
    // "bob@acme.io" is inside "@acme.io", so this narrows the list.
    expect((await api(wsKey, "PATCH", `/agents/${agent.id}`, { allowedRecipients: ["bob@acme.io"] })).body.allowedRecipients).toEqual(["bob@acme.io"]);
    // Going back to the whole domain widens it again: refused.
    expect((await api(wsKey, "PATCH", `/agents/${agent.id}`, { allowedRecipients: ["@acme.io"] })).status).toBe(403);
    expect((await api(wsKey, "PATCH", `/agents/${agent.id}`, { mailboxIds: [] })).body.mailboxIds).toEqual([agent.inboxId]);
    expect((await api(wsKey, "PATCH", `/agents/${agent.id}`, { approvalMode: "always" })).body.approvalMode).toBe("always");
    expect((await api(wsKey, "PATCH", `/agents/${agent.id}`, { status: "paused" })).body.status).toBe("paused");
    // Resuming is a person's call.
    const resume = await api(wsKey, "PATCH", `/agents/${agent.id}`, { status: "active" });
    expect(resume.status).toBe(403);
    expect(resume.body.error.message).toContain("status");
    // Lowering approval back down is too, even one step.
    expect((await api(wsKey, "PATCH", `/agents/${agent.id}`, { approvalMode: "external" })).status).toBe(403);
  });

  it("an agent whose list is 'anyone' may be given a list by a key", async () => {
    const r = await c.post("/api/agents", { name: "Open", allowedRecipients: null });
    expect(r.body.agent.allowedRecipients).toBeNull();
    expect((await api(wsKey, "PATCH", `/agents/${r.body.agent.id}`, { allowedRecipients: ["@acme.io"] })).body.allowedRecipients).toEqual(["@acme.io"]);
  });

  it("a person in the app may loosen anything", async () => {
    const { agent, team, other } = await made();
    await api(wsKey, "PATCH", `/agents/${agent.id}`, { status: "paused" });
    const r = await c.patch(`/api/agents/${agent.id}`, { approvalMode: "never", sendCapDaily: 100, allowedRecipients: null, mailboxIds: [team.id, other.id], status: "active" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ approvalMode: "never", sendCapDaily: 100, allowedRecipients: null, status: "active" });
    expect([...r.body.mailboxIds].sort()).toEqual([agent.inboxId, team.id, other.id].sort());
  });
});

describe("AIS1 gap: approving an agent's message is a person's decision", () => {
  it("a workspace key can list and reject but not approve; a person approves in the app", async () => {
    const { agent, apiKey } = (await api(wsKey, "POST", "/agents", { name: "Asker" })).body;
    const ask = async (subject: string) => (await api(apiKey.secret, "POST", `/agents/${agent.id}/send`, { to: ["owner@acme.io"], subject, text: "x" })).body.approval.id as string;
    const first = await ask("One");
    const approve = await api(wsKey, "POST", `/approvals/${first}/approve`, {});
    expect(approve.status).toBe(403);
    expect(approve.body.error.code).toBe("person_only");
    expect(ctx.outbound.sent.filter((m) => m.subject === "One")).toHaveLength(0);
    expect((await api(wsKey, "GET", "/approvals?status=pending")).body.data).toHaveLength(1);
    // Rejecting only stops mail, so a key may do it.
    expect((await api(wsKey, "POST", `/approvals/${first}/reject`, { note: "No" })).body.approval.status).toBe("rejected");
    const second = await ask("Two");
    const ok = await c.post(`/api/approvals/${second}/approve`, {});
    expect(ok.status).toBe(200);
    expect(ok.body.approval.status).toBe("sent");
  });
});

describe("AIS1 row 51: safe defaults for every new agent", () => {
  it("100 sends a day by default, never the plan ceiling, however the agent is made", async () => {
    await ctx.db.update(organizations).set({ plan: "business" }).where(eq(organizations.id, orgId));
    expect((await api(wsKey, "POST", "/agents", { name: "Key made" })).body.agent.sendCapDaily).toBe(100);
    expect((await c.post("/api/agents", { name: "App made" })).body.agent.sendCapDaily).toBe(100);
    // A person may ask for more, up to the plan's limit.
    expect((await c.post("/api/agents", { name: "Busy", sendCapDaily: 500 })).body.agent.sendCapDaily).toBe(500);
    expect((await c.post("/api/agents", { name: "Too busy", sendCapDaily: 5000 })).body.agent.sendCapDaily).toBe(2000);
    // A key may ask for less, not more.
    expect((await api(wsKey, "POST", "/agents", { name: "Quiet", sendCapDaily: 30 })).body.agent.sendCapDaily).toBe(30);
    const more = await api(wsKey, "POST", "/agents", { name: "Loud", sendCapDaily: 500 });
    expect(more.status).toBe(403);
    expect(more.body.error.message).toContain("sendCapDaily");
  });

  it("the default allow list is the workspace's own verified domains", async () => {
    await ctx.db.update(organizations).set({ plan: "business" }).where(eq(organizations.id, orgId)); // room for more domains
    const other = (await c.post("/api/domains", { name: "acme.com.au" })).body.domain;
    await verify(c, other.id);
    await c.post("/api/domains", { name: "notyet.io" }); // not verified, so not on the list
    const byKey = (await api(wsKey, "POST", "/agents", { name: "Key made" })).body.agent;
    expect([...byKey.allowedRecipients].sort()).toEqual(["@acme.com.au", "@acme.io"]);
    expect([...(await c.post("/api/agents", { name: "App made" })).body.agent.allowedRecipients].sort()).toEqual(["@acme.com.au", "@acme.io"]);
    // A key asking for "anyone" (null or an empty list) gets the default list too.
    for (const allowedRecipients of [null, []]) {
      expect([...(await api(wsKey, "POST", "/agents", { name: `Key ${JSON.stringify(allowedRecipients)}`, allowedRecipients })).body.agent.allowedRecipients].sort()).toEqual(["@acme.com.au", "@acme.io"]);
    }
    // A person may choose "anyone".
    for (const allowedRecipients of [null, []]) expect((await c.post("/api/agents", { name: `App ${JSON.stringify(allowedRecipients)}`, allowedRecipients })).body.agent.allowedRecipients).toBeNull();
    // A key may name its own list; approval stays with a person.
    expect((await api(wsKey, "POST", "/agents", { name: "Named", allowedRecipients: ["Grace@Example.com"] })).body.agent.allowedRecipients).toEqual(["grace@example.com"]);
    // A default agent can't even ask to mail an outside address.
    const { agent, apiKey } = (await api(wsKey, "POST", "/agents", { name: "Fenced" })).body;
    const r = await api(apiKey.secret, "POST", `/agents/${agent.id}/send`, { to: ["grace@example.com"], subject: "Hi", text: "x" });
    expect(r.body.error.code).toBe("recipient_not_allowed");
    expect((await api(apiKey.secret, "POST", `/agents/${agent.id}/send`, { to: ["owner@acme.io"], subject: "Hi", text: "x" })).status).toBe(202);
  });

  it("with no verified domain yet, the default list is the creator's own address", async () => {
    const d = new Client(ctx.app);
    await d.signup("solo@bakery.example");
    await d.post("/api/domains", { name: "bakery.example" }); // added, not verified
    const key = (await d.post("/api/developer/keys", { name: "Agents" })).body.secret;
    expect((await api(key, "POST", "/agents", { name: "Baker" })).body.agent.allowedRecipients).toEqual(["solo@bakery.example"]);
    expect((await d.post("/api/agents", { name: "Baker two" })).body.agent.allowedRecipients).toEqual(["solo@bakery.example"]);
  });
});
