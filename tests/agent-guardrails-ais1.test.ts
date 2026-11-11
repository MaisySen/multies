import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { Webhook } from "standardwebhooks";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { auditLogs, authEmailHooks, organizations } from "@/server/db/schema";
import { encryptSecret } from "@/server/lib/crypto";
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
      expect(r.body.error.details).toEqual({ fields: ["approvalMode"] });
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
    // Both refusals are on the audit log, the connected app's under the person it acts for.
    const logged = await refusals("agent.create_refused");
    expect(logged.map((r) => r.metadata.fields)).toEqual([["approvalMode"], ["approvalMode"]]);
    expect(logged.map((r) => (r.metadata as { via?: string }).via).sort()).toEqual(["oauth", "workspace_key"]);
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

  // AIS1 repair (review of this branch): deleting a paused agent and making it again at the same address gave an
  // active agent, so a key could undo a person's pause that way. Deleting a paused agent needs a person.
  it("a key can't delete a paused agent (it would come back active); a person can", async () => {
    const chaser = (await c.post("/api/agents", { name: "Chaser", localPart: "chaser", sendCapDaily: 5, allowedRecipients: ["bob@acme.io"] })).body.agent;
    expect((await c.patch(`/api/agents/${chaser.id}`, { status: "paused" })).status).toBe(200);
    expect((await api(wsKey, "PATCH", `/agents/${chaser.id}`, { status: "active" })).status).toBe(403);
    const del = await api(wsKey, "DELETE", `/agents/${chaser.id}`);
    expect(del.status).toBe(403);
    expect(del.body.error.code).toBe("person_only");
    expect(del.body.error.message).toContain("paused");
    expect((await api(wsKey, "GET", `/agents/${chaser.id}`)).body).toMatchObject({ status: "paused", sendCapDaily: 5, allowedRecipients: ["bob@acme.io"] });
    expect((await refusals("agent.delete_refused")).map((r) => ({ agentId: r.agentId, fields: r.metadata.fields }))).toEqual([{ agentId: chaser.id, fields: ["status"] }]);
    // An active agent can still be deleted by a key (approval stays "always" on anything it makes again).
    const active = (await api(wsKey, "POST", "/agents", { name: "Spare" })).body.agent;
    expect((await api(wsKey, "DELETE", `/agents/${active.id}`)).status).toBe(200);
    // A person may delete the paused one.
    expect((await c.del(`/api/agents/${chaser.id}`)).status).toBe(200);
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

describe("AIS1 gap: mail from an agent's inbox always goes through the agent's rules", () => {
  it("a workspace key can't send from an agent inbox with POST /messages, by mailboxId or by from", async () => {
    const { agent } = (await api(wsKey, "POST", "/agents", { name: "Inbox" })).body;
    for (const body of [{ mailboxId: agent.inboxId }, { from: agent.address }]) {
      const r = await api(wsKey, "POST", "/messages", { ...body, to: ["grace@example.com"], subject: "Around the rules", text: "x" });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("agent_inbox");
      expect(r.body.error.message).toContain(`/agents/${agent.id}/send`);
    }
    expect(ctx.outbound.sent.filter((m) => m.subject === "Around the rules")).toHaveLength(0);
    // Other mailboxes still send.
    const team = (await c.post("/api/mailboxes", { domainId, localPart: "team", displayName: "Team" })).body.mailbox;
    expect((await api(wsKey, "POST", "/messages", { mailboxId: team.id, to: ["grace@example.com"], subject: "Normal", text: "x" })).status).toBe(200);
    // The API reference says so.
    const doc = (await (await ctx.app.request("/api/v1/openapi.json", { headers: { host: "localhost" } })).json()) as { paths: Record<string, Record<string, { responses: Record<string, { description: string }> }>> };
    expect(doc.paths["/messages"].post.responses["403"].description).toContain("agent_inbox");
  });

  it("a person writing from the agent's inbox in the app is their own approval", async () => {
    const { agent } = (await c.post("/api/agents", { name: "Shared" })).body;
    const r = await c.post("/api/mail/send", { mailboxId: agent.inboxId, to: ["grace@example.com"], subject: "From a person", text: "x" });
    expect(r.status).toBe(201);
    expect(ctx.outbound.sent.filter((m) => m.subject === "From a person")).toHaveLength(1);
  });
});

// AIS1 repair (review of this branch): a sign-up email hook sends as the system, which the agent_inbox check lets through.
// So a hook must never be put on an agent's inbox, or a key or an AI app could choose (or be handed) the signing secret,
// sign its own calls and mail anyone from the agent's address with no approval, no cap and no allowed recipients.
describe("AIS1 gap: sign-up email hooks can't send from an agent's inbox", () => {
  const SECRET = `v1,whsec_${Buffer.from("review-hook-secret-0123456789abcd").toString("base64")}`;
  const signup = (to: string) => JSON.stringify({ user: { email: to }, email_data: { token: "1", token_hash: "h", redirect_to: "https://attacker.example/pay", email_action_type: "signup", site_url: "https://attacker.example" } });
  async function hookCall(path: string, secret: string, body: string) {
    const now = new Date();
    const sig = new Webhook(secret.replace(/^v1,/, "")).sign("wh_g1", now, body);
    return (await ctx.app.request(path, { method: "POST", headers: { "content-type": "application/json", "webhook-id": "wh_g1", "webhook-timestamp": String(Math.floor(now.getTime() / 1000)), "webhook-signature": sig }, body })).status;
  }
  const sentFrom = (address: string) => ctx.outbound.sent.filter((m) => m.from.address === address);

  it("a workspace key can't make a hook on an agent's inbox or move one onto it (REST)", async () => {
    const { agent } = (await api(wsKey, "POST", "/agents", { name: "Safe" })).body;
    expect(agent).toMatchObject({ approvalMode: "always", allowedRecipients: ["@acme.io"] });
    const made = await api(wsKey, "POST", "/auth-email-hooks", {
      from: agent.address, secret: SECRET, supabaseUrl: "https://attacker1234.supabase.co", appName: "Acme billing",
      branding: { templates: { signup: { subject: "Your invoice is overdue", intro: "Pay now at the link below.", buttonLabel: "Pay" } } },
    });
    expect(made.status).toBe(422);
    expect(made.body.error.code).toBe("validation_failed");
    // A hook on a team mailbox works, and can't be moved onto the agent.
    expect((await c.post("/api/mailboxes", { domainId, localPart: "no-reply", displayName: "Acme" })).status).toBe(201);
    const team = await api(wsKey, "POST", "/auth-email-hooks", { from: "no-reply@acme.io", secret: SECRET, supabaseUrl: "https://abcd1234.supabase.co", appName: "Acme" });
    expect(team.status).toBe(201);
    expect((await api(wsKey, "PATCH", `/auth-email-hooks/${team.body.hook.id}`, { from: agent.address })).status).toBe(422);
    // The Sign-up emails settings don't offer the agent, and a key's save refuses it.
    expect((await api(wsKey, "GET", "/auth-email-settings")).body.senders.map((s: { address: string }) => s.address)).toEqual(["no-reply@acme.io"]);
    expect((await api(wsKey, "PUT", "/auth-email-settings", { from: agent.address })).status).toBe(422);
    // The signed call goes out from the team mailbox; nothing ever leaves the agent's address.
    expect(await hookCall(new URL(team.body.hook.url).pathname, SECRET, signup("victim@example.com"))).toBe(200);
    expect(sentFrom("no-reply@acme.io")).toHaveLength(1);
    expect(sentFrom(agent.address)).toEqual([]);
  });

  it("a connected AI app can't point the Sign-up emails settings at an agent's inbox (MCP)", async () => {
    const mcp = await mcpFor(await oauthToken());
    const agent = JSON.parse(text(await mcp.callTool({ name: "create_agent_inbox", arguments: { name: "Safe" } }))).agent as { address: string };
    const saved = await mcp.callTool({ name: "update_auth_email_settings", arguments: { from: agent.address, supabaseUrl: "https://attacker1234.supabase.co", appName: "Acme billing" } });
    await mcp.close();
    expect(saved.isError).toBe(true);
    expect(text(saved)).not.toContain("whsec_");
    expect(sentFrom(agent.address)).toEqual([]);
  });

  it("a hook saved on an agent's inbox before this change gets no new secret from a key or an AI app", async () => {
    const { agent } = (await c.post("/api/agents", { name: "Old" })).body;
    await ctx.db.insert(authEmailHooks).values({ id: "ahk_legacy", orgId, mailboxId: agent.inboxId, kind: "supabase", secretEnc: await encryptSecret(ctx.deps.config.appSecret, SECRET.replace(/^v1,/, "")), supabaseUrl: "https://abcd1234.supabase.co", appName: "Acme" });
    const byKey = await api(wsKey, "POST", "/auth-email-settings/secret", {});
    expect(byKey.status).toBe(403);
    expect(byKey.body.error.code).toBe("person_only");
    expect(JSON.stringify(byKey.body)).not.toContain("whsec_");
    const mcp = await mcpFor(await oauthToken());
    const viaApp = await mcp.callTool({ name: "regenerate_auth_email_secret", arguments: {} });
    await mcp.close();
    expect(viaApp.isError).toBe(true);
    expect(text(viaApp)).toContain("person_only");
    // Decision: a working sign-up flow isn't cut off, so the saved secret (which only Supabase holds) still sends.
    expect(await hookCall("/api/auth-hooks/supabase/ahk_legacy", SECRET, signup("new.user@example.com"))).toBe(200);
    // A person may still make a new secret for it; that is their own setup, as Compose is.
    const byPerson = await c.post("/api/auth-email-settings/secret", {});
    expect(byPerson.status).toBe(200);
    expect(byPerson.body.secret).toMatch(/^v1,whsec_/);
  });

  // AIS1 repair (review 2): with `from` left out, a key or an AI app could switch such an older hook back on and rewrite
  // what it sends (subject, intro, Reply-To, the project URL its links use). Supabase signs every sign-up call and anyone
  // can sign up an address on an open app, so the key chose the words of mail that left the agent's address with no
  // approval, no cap and no allowed recipients, and undid a person's off switch.
  describe("an older hook on an agent's inbox", () => {
    const PHISH = { replyTo: "pay@evil.example", templates: { signup: { subject: "Your invoice is overdue", intro: "Pay now at the link below.", buttonLabel: "Pay" } } };
    const LEGACY = "/api/auth-hooks/supabase/ahk_legacy";
    let agent: { address: string; inboxId: string };
    const stored = async () => (await ctx.db.select().from(authEmailHooks).where(eq(authEmailHooks.id, "ahk_legacy")).get())!;

    beforeEach(async () => {
      // A person made the agent. The hook was saved on its inbox before the change, and a person switched it off.
      agent = (await c.post("/api/agents", { name: "Billing" })).body.agent;
      await ctx.db.insert(authEmailHooks).values({ id: "ahk_legacy", orgId, mailboxId: agent.inboxId, kind: "supabase", secretEnc: await encryptSecret(ctx.deps.config.appSecret, SECRET.replace(/^v1,/, "")), supabaseUrl: "https://abcd1234.supabase.co", appName: "Acme", enabled: false });
      expect(await hookCall(LEGACY, SECRET, signup("someone@example.com"))).toBe(503);
    });

    it("a workspace key can't switch it back on or rewrite it (PUT /auth-email-settings), so a sign-up carries none of its words", async () => {
      const r = await api(wsKey, "PUT", "/auth-email-settings", { enabled: true, supabaseUrl: "https://evil.example", branding: PHISH });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("person_only");
      for (const body of [{ enabled: true }, { senderName: "Billing" }, { appName: "Acme billing" }, { supabaseUrl: "https://evil.example" }, { branding: PHISH }]) {
        expect((await api(wsKey, "PUT", "/auth-email-settings", body)).status, JSON.stringify(body)).toBe(403);
      }
      expect(await stored()).toMatchObject({ enabled: false, supabaseUrl: "https://abcd1234.supabase.co", branding: null, appName: "Acme", senderName: null });
      // A signed call for a stranger finds the hook still off: nothing leaves the agent's address.
      expect(await hookCall(LEGACY, SECRET, signup("victim@example.com"))).toBe(503);
      expect(sentFrom(agent.address)).toEqual([]);
    });

    it("a workspace key can't rewrite it with PATCH /auth-email-hooks/{id} either", async () => {
      for (const body of [{ branding: PHISH }, { appName: "Acme billing" }]) {
        const r = await api(wsKey, "PATCH", "/auth-email-hooks/ahk_legacy", body);
        expect(r.status, JSON.stringify(body)).toBe(403);
        expect(r.body.error.code).toBe("person_only");
      }
      expect(await stored()).toMatchObject({ branding: null, appName: "Acme" });
    });

    it("a connected AI app can't switch it on or rewrite it over MCP", async () => {
      const mcp = await mcpFor(await oauthToken());
      const settings = await mcp.callTool({ name: "update_auth_email_settings", arguments: { enabled: true, branding: PHISH } });
      const hook = await mcp.callTool({ name: "update_auth_email_hook", arguments: { hookId: "ahk_legacy", branding: PHISH } });
      await mcp.close();
      expect([settings.isError, hook.isError]).toEqual([true, true]);
      expect(text(settings)).toContain("person_only");
      expect(text(hook)).toContain("person_only");
      expect(await stored()).toMatchObject({ enabled: false, branding: null });
    });

    it("a key may switch it off, send back what it has, or move it to a team mailbox; a person may change anything", async () => {
      // A person switches it on and words it (their own setup, as Compose is): it sends from the agent's address.
      expect((await c.put("/api/auth-email-settings", { enabled: true, branding: { templates: { signup: { subject: "Confirm your Acme account" } } } })).status).toBe(200);
      expect(await hookCall(LEGACY, SECRET, signup("new.user@example.com"))).toBe(200);
      expect(sentFrom(agent.address).map((m) => m.subject)).toEqual(["Confirm your Acme account"]);
      // A key may switch it off again, and a value sent back unchanged is not a change.
      expect((await api(wsKey, "PUT", "/auth-email-settings", { enabled: false })).status).toBe(200);
      expect((await api(wsKey, "PUT", "/auth-email-settings", { enabled: false, appName: "Acme" })).status).toBe(200);
      expect((await stored()).enabled).toBe(false);
      // Moving From to a team mailbox may come with other changes in the same call; then it no longer sends as the agent.
      expect((await c.post("/api/mailboxes", { domainId, localPart: "no-reply", displayName: "Acme" })).status).toBe(201);
      const moved = await api(wsKey, "PUT", "/auth-email-settings", { from: "no-reply@acme.io", enabled: true, branding: { templates: { signup: { subject: "Welcome to Acme" } } } });
      expect(moved.status).toBe(200);
      expect(moved.body.settings).toMatchObject({ from: "no-reply@acme.io", enabled: true });
      expect(await hookCall(LEGACY, SECRET, signup("second.user@example.com"))).toBe(200);
      expect(sentFrom("no-reply@acme.io").map((m) => m.subject)).toEqual(["Welcome to Acme"]);
      expect(sentFrom(agent.address)).toHaveLength(1);
    });
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
