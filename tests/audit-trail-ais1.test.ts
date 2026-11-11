/**
 * AIS1 (audit of 11 Nov 2026, rows 50 and 15): the audit log says what acted and what it touched.
 * An entry made through an API key or a connected AI app names the kind of caller, the key (name and prefix) or the app,
 * and the request's IP; a person's own action in the app has no caller stamp. Task history says the same. A thread read
 * names the thread, a deleted key's entries keep its name and prefix, and the Team AI run log is kept for a year.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq, sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { auditLogs } from "@/server/db/schema";
import { pkceChallenge } from "@/server/services/developer/oauth";
import { audit, memberSafeAudit } from "@/server/services/audit";
import { noteRequestCaller, runWithRequestCaller } from "@/server/lib/request-caller";
import { auditWho, callerStampOf, viaLabel } from "@/shared/audit-caller";
import { deliverInbound } from "@/server/services/mail/delivery";
import { describeAudit } from "@/web/components/app-bits";
import { TEAMAI_CAPS } from "@/shared/teamai-td8";

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

  it("the CSV and JSON export end with the kind of caller and a plain via label", async () => {
    const key = await newKey("Billing bot");
    expect((await v1(key.secret, "POST", "/agents", { name: "Over REST", localPart: "overrest" })).status).toBe(201);
    const m = await mcp(await connectClaude());
    data(await m.callTool({ name: "create_agent_inbox", arguments: { name: "Over Claude", localPart: "overclaude" } }));

    const csv = await c.get("/api/org/audit/export?format=csv");
    expect(csv.status).toBe(200);
    const [header, ...lines] = String(csv.body).split("\r\n");
    expect(header.split(",")).toEqual(["at", "action", "actor", "actorUserId", "targetType", "targetId", "ip", "metadata", "callerKind", "via"]);
    const line = lines.find((l) => l.includes("Over REST"))!;
    expect(line).toContain(IP);
    expect(line.endsWith(`workspace_key,via API key Billing bot (${key.prefix})`)).toBe(true);
    const json = (await c.get("/api/org/audit/export?format=json")).body as { action: string; metadata: string; callerKind: string; via: string }[];
    expect(json.find((r) => r.action === "agent.created" && r.metadata.includes("Over Claude"))).toMatchObject({ callerKind: "oauth", via: "via Claude (connected app)" });
    // A person's own row has empty caller columns.
    expect(json.find((r) => r.action === "api_key.created")).toMatchObject({ callerKind: "", via: "" });
  });

  it("task history says when a task was made or changed through a connected app or a key", async () => {
    const byHand = (await c.post("/api/tasks", { title: "By hand" })).body.task;
    const m = await mcp(await connectClaude());
    const viaClaude = data(await m.callTool({ name: "create_task", arguments: { title: "From Claude" } })).task;
    const key = await newKey("Sync script");
    const viaKey = (await v1(key.secret, "POST", "/tasks", { title: "From a script" })).body.task;
    expect((await v1(key.secret, "PATCH", `/tasks/${byHand.id}`, { status: "doing" })).status).toBe(200);

    const history = async (id: string) => (await c.get(`/api/tasks/${id}`)).body.activity as { verb: string; data: Record<string, unknown> }[];
    const handHistory = await history(byHand.id);
    expect(handHistory.find((a) => a.verb === "created")?.data.caller).toBeUndefined();
    const changed = handHistory.find((a) => a.verb !== "created")!;
    expect(changed.data.caller).toEqual({ kind: "workspace_key", key: "Sync script", prefix: key.prefix });
    expect((await history(viaClaude.id)).find((a) => a.verb === "created")?.data.caller).toEqual({ kind: "oauth", app: "Claude" });
    expect((await history(viaKey.id)).find((a) => a.verb === "created")?.data.caller).toEqual({ kind: "workspace_key", key: "Sync script", prefix: key.prefix });
    // The MCP and REST task detail carry the same line.
    const detail = (await v1(key.secret, "GET", `/tasks/${viaClaude.id}`)).body;
    expect(detail.activity.find((a: { verb: string }) => a.verb === "created").data.caller).toEqual({ kind: "oauth", app: "Claude" });
  });
});

describe("AIS1 row 15: thread reads, deleted keys and IPs", () => {
  it("an agent's thread read names the thread, its key and the IP, and keeps them after the key is deleted", async () => {
    const ws = await newKey("Agents");
    expect((await rows("api_key.created")).find((r) => r.targetId === ws.id)?.meta).toMatchObject({ name: "Agents", prefix: ws.prefix });
    const { agent, apiKey } = (await v1(ws.secret, "POST", "/agents", { name: "Reader", localPart: "reader" })).body;
    await deliverInbound(ctx.deps, {
      envelopeFrom: "grace@example.com", rcptTo: "reader@acme.io", sizeBytes: 300, via: "test",
      email: { messageId: "<r1@example.com>", from: { address: "grace@example.com", name: "Grace" }, to: [{ address: "reader@acme.io" }], cc: [], subject: "Invoice 42 is late", text: "Hi", date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
    });
    const threadId = (await v1(apiKey.secret, "GET", `/agents/${agent.id}/threads`)).body.data[0].id as string;
    expect((await v1(apiKey.secret, "GET", `/threads/${threadId}`)).status).toBe(200);
    const agentKeyName = (await c.get("/api/developer/keys")).body.apiKeys.find((k: { id: string }) => k.id === apiKey.id).name as string;
    const agentKeyPrefix = String(apiKey.secret).slice(0, 12);
    expect((await rows("agent.key_created")).find((r) => r.targetId === apiKey.id)?.meta).toMatchObject({ name: agentKeyName, prefix: agentKeyPrefix });

    const [read] = await rows("agent.message_read");
    expect(read.targetType).toBe("thread");
    expect(read.targetId).toBe(threadId);
    expect(read.meta).toMatchObject({ subject: "Invoice 42 is late", via: "api", caller: { kind: "agent_key", key: agentKeyName, prefix: agentKeyPrefix } });
    expect(read.ip).toBe(IP);

    // Revoking the agent's key and deleting the workspace key keep every entry readable.
    expect((await c.del(`/api/agents/${agent.id}/keys/${apiKey.id}`)).status).toBe(200);
    expect((await c.del(`/api/developer/keys/${ws.id}`)).status).toBe(200);
    const after = (await c.get("/api/org/audit")).body.entries as { id: string; action: string; metadata: Record<string, unknown> | null; actorEmail: string | null; targetType: string | null; targetId: string | null; ip: string | null; createdAt: string }[];
    const shown = after.find((e) => e.action === "agent.message_read")!;
    expect(auditWho(shown)).toEqual({ actor: "agent:reader@acme.io", via: `via agent key ${agentKeyName} (${agentKeyPrefix})` });
    expect(describeAudit(shown)).toEqual({ verb: "read a thread", object: '"Invoice 42 is late"' });
    expect(after.find((e) => e.action === "agent.key_revoked")?.metadata).toMatchObject({ name: agentKeyName, prefix: agentKeyPrefix });
    expect(after.find((e) => e.action === "api_key.deleted")?.metadata).toMatchObject({ name: "Agents", prefix: ws.prefix });
    expect(auditWho(after.find((e) => e.action === "agent.created")!)).toEqual({ actor: `API key Agents (${ws.prefix})`, via: null });
  });

  it("an agent member's key keeps its name and prefix in the log after it is revoked", async () => {
    const made = await c.post("/api/team/agents", { name: "Builder" });
    expect(made.status).toBe(201);
    const userId = made.body.member.userId as string;
    const key = await c.post(`/api/team/agents/${userId}/keys`, { name: "Builder laptop" });
    expect(key.status).toBe(201);
    const prefix = String(key.body.secret).slice(0, 12);
    expect((await rows("agent_member.key_created")).find((r) => r.targetId === key.body.apiKey.id)?.meta).toMatchObject({ member: userId, name: "Builder laptop", prefix });
    expect((await c.del(`/api/team/agents/${userId}/keys/${key.body.apiKey.id}`)).status).toBe(200);
    expect((await rows("agent_member.key_revoked"))[0].meta).toMatchObject({ member: userId, name: "Builder laptop", prefix });
  });

  it("a member's dashboard never shows a thread subject from the audit log", () => {
    expect(memberSafeAudit({ ip: "1.2.3.4", actorEmail: "agent:a@b.c", metadata: { subject: "Payroll", messages: 2 } })).toEqual({ ip: null, actorEmail: "agent:a@b.c", metadata: { messages: 2 } });
  });

  it("a member reading an agent's audit log sees no thread subjects and no IPs; an admin sees both", async () => {
    const ws = await newKey("Agents");
    const { agent, apiKey } = (await v1(ws.secret, "POST", "/agents", { name: "Reader", localPart: "reader" })).body;
    await deliverInbound(ctx.deps, {
      envelopeFrom: "grace@example.com", rcptTo: "reader@acme.io", sizeBytes: 300, via: "test",
      email: { messageId: "<r2@example.com>", from: { address: "grace@example.com", name: "Grace" }, to: [{ address: "reader@acme.io" }], cc: [], subject: "Salary review", text: "Hi", date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
    });
    const threadId = (await v1(apiKey.secret, "GET", `/agents/${agent.id}/threads`)).body.data[0].id as string;
    await v1(apiKey.secret, "GET", `/threads/${threadId}`);
    const inv = await c.post("/api/team/invites", { email: "mate@acme.io", role: "member" });
    const mate = new Client(ctx.app);
    await mate.signup("mate@acme.io");
    expect((await mate.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
    const seen = (who: Client) => who.get(`/api/agents/${agent.id}/audit`).then((r) => (r.body.entries as { action: string; ip: string | null; metadata: Record<string, unknown> | null }[]).find((e) => e.action === "agent.message_read")!);
    const asMember = await seen(mate);
    expect(asMember.metadata).not.toHaveProperty("subject");
    expect(asMember.ip).toBeNull();
    expect(asMember.metadata?.caller).toMatchObject({ kind: "agent_key" });
    const asAdmin = await seen(c);
    expect(asAdmin.metadata).toMatchObject({ subject: "Salary review" });
    expect(asAdmin.ip).toBe(IP);
  });

  it("signing up, a password change and a lockout keep the IP they came from", async () => {
    const SIGNIN_IP = "192.0.2.50";
    const h = { "cf-connecting-ip": SIGNIN_IP };
    const u = new Client(ctx.app);
    expect((await u.call("POST", "/api/auth/sign-up/email", { name: "Sam Lee", email: "sam@acme.io", password: "a-strong-password" }, h)).status).toBe(200);
    expect((await u.call("GET", "/api/account/me", undefined, h)).status).toBe(200);
    expect((await rows("account.created")).find((r) => r.actorEmail === "sam@acme.io")?.ip).toBe(SIGNIN_IP);
    expect((await u.call("POST", "/api/auth/change-password", { currentPassword: "a-strong-password", newPassword: "another-strong-one", revokeOtherSessions: false }, h)).status).toBe(200);
    expect((await rows("account.password_changed")).find((r) => r.actorEmail === "sam@acme.io")?.ip).toBe(SIGNIN_IP);
    const stranger = new Client(ctx.app);
    for (let i = 0; i < 10 && !(await rows("account.locked")).length; i++) await stranger.call("POST", "/api/auth/sign-in/email", { email: "sam@acme.io", password: "wrong-password-here" }, { "cf-connecting-ip": "198.51.100.99" });
    expect((await rows("account.locked"))[0]?.ip).toBe("198.51.100.99");
  });
});

describe("AIS1 row 15: the Team AI run log", () => {
  it("keeps the Team AI run log for a year, not 30 days", async () => {
    expect(TEAMAI_CAPS.keepRunsDays).toBe(365);
    const t = await makeTestApp({ TEAMAI_TD8: "on" });
    const u = new Client(t.app);
    await u.signup("ai@acme.io");
    const orgId = (await u.get("/api/account/me")).body.organization.id as string;
    const day = 86_400_000;
    const now = Date.now();
    // A run still going is never pruned, however old it is.
    for (const [id, age, status] of [["r40", 40, "done"], ["r300", 300, "failed"], ["r400", 400, "done"], ["s400", 400, "skipped"], ["g400", 400, "running"]] as const) {
      await t.deps.db.run(sql`insert into teamai_runs (id, org_id, kind, event_key, status, created_at, started_at) values (${id}, ${orgId}, 'try', ${id}, ${status}, ${now - age * day}, ${now})`);
    }
    const { runTeamAiPass } = await import("@/server/services/teamai-td8");
    await runTeamAiPass(t.deps);
    const left = await t.deps.db.all<{ id: string }>(sql`select id from teamai_runs order by id`);
    expect(left.map((r) => r.id)).toEqual(["g400", "r300", "r40"]);
  });

  it("deleting a run from the log is itself in the audit log", async () => {
    const t = await makeTestApp({ TEAMAI_TD8: "on" });
    const u = new Client(t.app);
    await u.signup("ai@acme.io");
    const orgId = (await u.get("/api/account/me")).body.organization.id as string;
    await t.deps.db.run(sql`insert into teamai_runs (id, org_id, kind, label, event_key, status, created_at) values ('run_1', ${orgId}, 'routine', 'Weekly summary', 'k1', 'done', ${Date.now()})`);
    expect((await u.call("DELETE", "/api/team-ai/runs/run_1", undefined, { "cf-connecting-ip": APP_IP })).status).toBe(200);
    const [row] = (await t.db.select().from(auditLogs).where(eq(auditLogs.action, "teamai.run_deleted")));
    expect(row).toMatchObject({ actorEmail: "ai@acme.io", targetType: "teamai_run", targetId: "run_1", ip: APP_IP });
    expect(JSON.parse(row.metadata!)).toMatchObject({ kind: "routine", name: "Weekly summary", status: "done" });
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

  it("a connected app's request names the person and the connection on what it caused, and keeps the plain stamp on the person's own rows", async () => {
    const app = { userId: "usr_ada", email: "ada@acme.io", name: "Ada Admin", role: "admin" as const, sessionId: "oauth:grant_9", apiKeyId: "oauth:grant_9", agentId: null, clientName: "Claude" };
    const r = await written(app, IP, [
      { action: "t.own", actorUserId: "usr_ada", actorEmail: "ada@acme.io" },
      { action: "t.agent", actorUserId: null, actorEmail: "agent:bot@acme.io", agentId: "agt_1" },
      { action: "t.system" },
      { action: "t.other", actorUserId: "usr_other", actorEmail: "o@acme.io" },
    ]);
    expect(r.get("t.own")).toMatchObject({ ip: IP, meta: { caller: { kind: "oauth", app: "Claude" } } });
    const caused = { caller: { kind: "oauth", app: "Claude", user: "usr_ada", person: "Ada Admin", grant: "grant_9" } };
    expect(r.get("t.agent")).toMatchObject({ ip: IP, meta: caused });
    expect(r.get("t.system")).toMatchObject({ ip: IP, meta: caused });
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
    // AIS1 review 2: a connected app's stamp on what it caused names whose app it was, and survives a round trip.
    const caused = { kind: "oauth", app: "Claude", user: "usr_ada", person: "Ada Admin", grant: "grant_9" } as const;
    expect(callerStampOf(JSON.parse(JSON.stringify(caused)))).toEqual(caused);
    expect(viaLabel(caused)).toBe("via Ada Admin's Claude (connected app)");
    expect(viaLabel({ kind: "oauth", person: "Ada Admin" })).toBe("via Ada Admin's connected app");
  });

  it("names a key by its name and prefix, and an old key entry by its prefix", () => {
    expect(auditWho({ actorEmail: "api-key:mm_live_S6PZ", metadata: null })).toEqual({ actor: "API key (mm_live_S6PZ)", via: null });
    expect(auditWho({ actorEmail: "api-key:mm_live_abcd", metadata: { caller: { kind: "workspace_key", key: "Bot", prefix: "mm_live_abcd" } } })).toEqual({ actor: "API key Bot (mm_live_abcd)", via: null });
    expect(auditWho({ actorEmail: "api-key:mm_live_abcd", metadata: { caller: { kind: "agent_member_key", key: "Builder", prefix: "mm_live_abcd" } } })).toEqual({ actor: "Agent member key Builder (mm_live_abcd)", via: null });
    expect(auditWho({ actorEmail: "ada@acme.io", metadata: { caller: { kind: "oauth", app: "Claude" } } })).toEqual({ actor: "ada@acme.io", via: "via Claude (connected app)" });
    expect(auditWho({ actorEmail: null, metadata: null })).toEqual({ actor: null, via: null });
  });
});
