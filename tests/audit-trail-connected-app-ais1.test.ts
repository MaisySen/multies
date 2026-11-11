/**
 * AIS1 review 2 (stampFor's rule for rows written for an agent): in a connected app's request, a row written for an
 * agent (its send, queued send or block) used to get only { kind: "oauth", app }, and the agent is the row's actor, so
 * nothing said whose connected app it was. The app's name is whatever it registered with, so on its own it names nobody.
 * Olive (owner) and Ada (admin) each connect an app named Claude and each has it send through the same agent: the two
 * rows now name the person who connected the app and the connection, in the log, in the label and in the export. The
 * same app acting as the person (create_agent_inbox) still names the person as the actor and keeps the plain stamp.
 */
import { describe, it, expect } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { and, eq } from "drizzle-orm";
import { privacyWorld } from "./priv1a-world";
import type { Client } from "./helpers";
import { auditLogs, sendApprovals } from "@/server/db/schema";
import { pkceChallenge } from "@/server/services/developer/oauth";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const verifier = "v".repeat(20) + "-verifier-for-pkce-tests-0123456789";

type W = Awaited<ReturnType<typeof privacyWorld>>;

function harness(w: W) {
  const app = w.ctx.app;
  const connectClaude = async (person: Client) => {
    const reg = await app.request("/api/oauth/register", { method: "POST", headers: { "content-type": "application/json", host: "localhost", origin: "https://claude.ai" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }) });
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    const request = { client_id: clientId, redirect_uri: REDIRECT, response_type: "code", code_challenge: await pkceChallenge(verifier), code_challenge_method: "S256", state: "st-1", scope: "mcp:read mcp:write" };
    const r = await person.post("/api/oauth/authorize", { decision: "allow", scope: "full", request });
    expect(r.status).toBe(200);
    const code = new URL(r.body.redirectTo).searchParams.get("code")!;
    const tok = await app.request("/api/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", host: "localhost" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier }).toString() });
    return ((await tok.json()) as { access_token: string }).access_token;
  };
  const mcp = async (token: string, ip: string) => {
    const viaApp = ((url: string | URL, init?: RequestInit) => app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost", "cf-connecting-ip": ip } })) as typeof fetch;
    const client = new McpClient({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${token}` } }, fetch: viaApp }));
    return client;
  };
  // Everything in a row that names who acted, with the send's own words (to, subject) left out.
  const who = (r: typeof auditLogs.$inferSelect) => {
    const m = JSON.parse(r.metadata ?? "{}") as Record<string, unknown>;
    return JSON.stringify({ actorUserId: r.actorUserId, actorEmail: r.actorEmail, caller: m.caller });
  };
  const callerOf = (r: typeof auditLogs.$inferSelect) => (JSON.parse(r.metadata ?? "{}") as { caller?: Record<string, unknown> }).caller;
  // The connection each person made, as Settings, Developers lists it.
  const grantOf = async (person: Client) => ((await person.get("/api/oauth/grants")).body.grants as { id: string; mine: boolean }[]).filter((g) => g.mine).map((g) => g.id);
  return { connectClaude, mcp, who, callerOf, grantOf };
}

describe("AIS1 review 2: an agent's send through a person's connected app names that person", () => {
  it("Olive's Claude and Ada's Claude sending as the same agent write rows that say whose app it was", async () => {
    const w = await privacyWorld();
    const { connectClaude, mcp, who, callerOf, grantOf } = harness(w);

    const made = await w.owner.post("/api/agents", { name: "Desk", localPart: `desk${w.n}`, approvalMode: "always" });
    expect(made.status).toBe(201);
    const agentId = made.body.agent.id as string;
    const olive = (await w.owner.get("/api/account/me")).body.user.id as string;

    const cast = [[w.owner, "198.51.100.10", "FROM-OLIVES-CLAUDE", "olive"], [w.admin.c, "198.51.100.20", "FROM-ADAS-CLAUDE", "ada"]] as const;
    for (const [person, ip, subject, tag] of cast) {
      const client = await mcp(await connectClaude(person), ip);
      const r = await client.callTool({ name: "send_email", arguments: { agentId, to: ["customer@example.com"], subject, text: "Hello" } });
      expect(r.isError ?? false).toBe(false);
      // The same connected app acting as the person writes a row that names the person as its actor.
      const own = await client.callTool({ name: "create_agent_inbox", arguments: { name: `Made by ${tag}`, localPart: `made${tag}${w.n}` } });
      expect(own.isError ?? false).toBe(false);
      await client.close();
    }
    const createdRows = await w.ctx.db.select().from(auditLogs).where(eq(auditLogs.action, "agent.created"));
    const byName = (name: string) => createdRows.find((r) => (r.metadata ?? "").includes(name))!;
    expect(byName("Made by ada").actorUserId).toBe(w.admin.id);
    expect(callerOf(byName("Made by ada"))).toEqual({ kind: "oauth", app: "Claude" });

    const queued = await w.ctx.db.select().from(auditLogs).where(and(eq(auditLogs.action, "agent.send_queued"), eq(auditLogs.agentId, agentId)));
    expect(queued).toHaveLength(2);
    expect(new Set(queued.map((r) => r.ip)).size).toBe(2);
    expect(new Set(queued.map(who)).size).toBe(2);
    const byIp = (ip: string) => callerOf(queued.find((r) => r.ip === ip)!);
    expect(byIp("198.51.100.10")).toEqual({ kind: "oauth", app: "Claude", user: olive, person: "Olive Owner", grant: (await grantOf(w.owner))[0] });
    expect(byIp("198.51.100.20")).toEqual({ kind: "oauth", app: "Claude", user: w.admin.id, person: "Ada Admin", grant: (await grantOf(w.admin.c))[0] });

    // The agent page and the Activity log read the label from the same stamp.
    const entries = (await w.owner.get(`/api/agents/${agentId}/audit`)).body.entries as { action: string; metadata: { caller?: { person?: string } } | null }[];
    expect(entries.filter((e) => e.action === "agent.send_queued").map((e) => e.metadata?.caller?.person).sort()).toEqual(["Ada Admin", "Olive Owner"]);
  }, 120_000);

  it("with approvalMode never there is no approval row: the two people's sends still read apart in the log and the export", async () => {
    const w = await privacyWorld();
    const { connectClaude, mcp, who } = harness(w);

    const made = await w.owner.post("/api/agents", { name: "Fast desk", localPart: `fastdesk${w.n}`, approvalMode: "never" });
    expect(made.status).toBe(201);
    const agentId = made.body.agent.id as string;

    const cast = [[w.owner, "198.51.100.30", "NOW-FROM-OLIVE"], [w.admin.c, "198.51.100.40", "NOW-FROM-ADA"]] as const;
    for (const [person, ip, subject] of cast) {
      const client = await mcp(await connectClaude(person), ip);
      const r = await client.callTool({ name: "send_email", arguments: { agentId, to: ["customer@example.com"], subject, text: "Hello" } });
      expect(r.isError ?? false).toBe(false);
      await client.close();
    }
    const sent = await w.ctx.db.select().from(auditLogs).where(and(eq(auditLogs.action, "agent.message_sent"), eq(auditLogs.agentId, agentId)));
    expect(sent).toHaveLength(2);
    expect(await w.ctx.db.select().from(sendApprovals).where(eq(sendApprovals.agentId, agentId))).toHaveLength(0);

    // The export: the two rows' who-columns (actor, actorUserId, callerKind, via) differ by whose app it was.
    const body = (await w.owner.get("/api/org/audit/export?format=json")).body as unknown;
    const rows = ((typeof body === "string" ? JSON.parse(body) : body) as Record<string, string>[]).filter((r) => r.action === "agent.message_sent" && /NOW-FROM-/.test(r.metadata));
    expect(rows).toHaveLength(2);
    const exportWho = new Set(rows.map((r) => JSON.stringify([r.actor, r.actorUserId, r.callerKind, r.via])));
    expect(rows.map((r) => r.via).sort()).toEqual(["via Ada Admin's Claude (connected app)", "via Olive Owner's Claude (connected app)"]);

    expect({ logRowsTellApart: new Set(sent.map(who)).size === 2, exportRowsTellApart: exportWho.size === 2 })
      .toEqual({ logRowsTellApart: true, exportRowsTellApart: true });
  }, 120_000);
});
