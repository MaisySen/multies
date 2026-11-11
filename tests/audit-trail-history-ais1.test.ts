/**
 * AIS1 (audit row 50), after review: every history line, not only the ones recordWrite writes, says when an API key or
 * a connected AI app made the change (data.caller). The lines written straight into `activity` or `changes` (add_to_epic,
 * the bulk update and delete summaries, a sprint's scope change, a contact import) used to read exactly like the
 * person's own change in the app. A person's own change still has no caller.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { and, eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { activity, changes } from "@/server/db/schema";
import { pkceChallenge } from "@/server/services/developer/oauth";
import { importBatch } from "@/server/services/suite/crm-r94";
import { withCaller } from "@/server/services/suite/common";
import { noteRequestCaller, runWithRequestCaller } from "@/server/lib/request-caller";

const IP = "203.0.113.7";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const verifier = "v".repeat(20) + "-verifier-for-pkce-tests-0123456789";
const CLAUDE = { kind: "oauth", app: "Claude" };

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
const viaApp = (p: string, init?: RequestInit) => ctx.app.request(p, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost", "cf-connecting-ip": IP } });

async function connectClaude(): Promise<string> {
  const reg = await ctx.app.request("/api/oauth/register", { method: "POST", headers: { "content-type": "application/json", host: "localhost", origin: "https://claude.ai" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }) });
  const clientId = ((await reg.json()) as { client_id: string }).client_id;
  const request = { client_id: clientId, redirect_uri: REDIRECT, response_type: "code", code_challenge: await pkceChallenge(verifier), code_challenge_method: "S256", state: "st-1", scope: "mcp:read mcp:write" };
  const r = await c.post("/api/oauth/authorize", { decision: "allow", scope: "full", request });
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
const data = (r: unknown) => {
  const x = r as { content: { text: string }[]; isError?: boolean };
  if (x.isError) throw new Error(x.content[0].text);
  return JSON.parse(x.content[0].text);
};
const activityData = async (verb: string) => (await ctx.db.select().from(activity).where(eq(activity.verb, verb))).map((r) => JSON.parse(r.data) as Record<string, unknown>);

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io");
});

describe("AIS1: history lines written outside recordWrite name the key or connected app", () => {
  it("a connected app adding a task to an epic is named in the epic's history; the person's own move is not", async () => {
    const epic = (await c.post("/api/tasks", { title: "Launch", type: "epic" })).body.task;
    const item = (await c.post("/api/tasks", { title: "Write copy" })).body.task;
    const mine = (await c.post("/api/tasks", { title: "Pick a date" })).body.task;
    expect((await c.post(`/api/epics/${epic.id}/items`, { ids: [mine.id] })).status).toBe(200);
    const m = await mcp(await connectClaude());
    data(await m.callTool({ name: "add_to_epic", arguments: { epicId: epic.id, ids: [item.id] } }));
    const history = (await c.get(`/api/tasks/${epic.id}`)).body.activity as { verb: string; data: { ids?: string[]; caller?: unknown } }[];
    const lines = history.filter((a) => a.verb === "added_to_epic");
    expect(lines).toHaveLength(2);
    // Claude did it, not the person in the app: the line says so, as create and update lines do.
    expect(lines.find((l) => l.data.ids?.includes(item.id))?.data.caller).toEqual(CLAUDE);
    expect(lines.find((l) => l.data.ids?.includes(mine.id))?.data.caller).toBeUndefined();
  });

  it("a connected app's bulk change is named in the history summary", async () => {
    const a = (await c.post("/api/tasks", { title: "One" })).body.task;
    const b = (await c.post("/api/tasks", { title: "Two" })).body.task;
    const m = await mcp(await connectClaude());
    data(await m.callTool({ name: "bulk_update_tasks", arguments: { ids: [a.id, b.id], priority: "high" } }));
    const [row] = await ctx.db.select().from(activity).where(eq(activity.verb, "tasks.bulk_updated"));
    expect(row).toBeDefined();
    expect(row.actorName).toBeTruthy();
    expect((JSON.parse(row.data) as Record<string, unknown>).caller).toEqual(CLAUDE);
  });

  it("a workspace key's bulk delete names the key; the person's own bulk delete does not", async () => {
    const made = await c.post("/api/developer/keys", { name: "Cleanup bot" });
    expect(made.status).toBe(201);
    const t1 = (await c.post("/api/tasks", { title: "Old one" })).body.task;
    const t2 = (await c.post("/api/tasks", { title: "Old two" })).body.task;
    const res = await viaApp("/api/v1/tasks/bulk-delete", { method: "POST", headers: { authorization: `Bearer ${made.body.secret}`, "content-type": "application/json" }, body: JSON.stringify({ ids: [t1.id] }) });
    expect(res.status).toBe(200);
    expect((await c.post("/api/tasks/bulk-delete", { ids: [t2.id] })).status).toBe(200);
    const rows = await activityData("tasks.bulk_deleted");
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => (r.ids as string[]).includes(t1.id))?.caller).toEqual({ kind: "workspace_key", key: "Cleanup bot", prefix: made.body.apiKey.prefix });
    expect(rows.find((r) => (r.ids as string[]).includes(t2.id))?.caller).toBeUndefined();
  });

  it("a connected app adding tasks to an active sprint is named in the sprint's scope history", async () => {
    const projectId = (await c.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id as string;
    const t = (await c.post("/api/tasks", { title: "Ship it", projectId })).body.task;
    const sprint = (await c.post("/api/sprints", { projectId, name: "S1" })).body.sprint as { id: string };
    expect((await c.post(`/api/sprints/${sprint.id}/start`)).status).toBe(200);
    const m = await mcp(await connectClaude());
    data(await m.callTool({ name: "add_to_sprint", arguments: { id: sprint.id, taskIds: [t.id] } }));
    const [scope] = await activityData("sprint_scope");
    expect(scope).toMatchObject({ added: [t.id], caller: CLAUDE });
  });

  it("a contact import made through a key names the key on each contact's history line", async () => {
    const me = (await c.get("/api/account/me")).body;
    const orgId = me.organization.id as string;
    const userId = me.user.id as string;
    const key = { userId, email: "api-key:mm_live_impt", role: "admin" as const, sessionId: "apikey:key_imp", apiKeyId: "key_imp", agentId: null, keyName: "CRM sync", keyPrefix: "mm_live_impt" };
    await runWithRequestCaller(IP, async () => {
      noteRequestCaller(key);
      await importBatch(ctx.deps, { orgId, userId, email: key.email, name: "CRM sync", role: "admin", apiKeyId: "key_imp" }, [{ email: "sam@harbour.com.au", name: "Sam" }], "skip");
    });
    const [line] = await ctx.db.select().from(changes).where(and(eq(changes.entityType, "contact"), eq(changes.verb, "imported")));
    expect(JSON.parse(line.data ?? "{}")).toEqual({ caller: { kind: "workspace_key", key: "CRM sync", prefix: "mm_live_impt" } });
  });
});

describe("AIS1: withCaller", () => {
  const key = { userId: "usr_maker", email: "api-key:mm_live_abcd", role: "admin" as const, sessionId: "apikey:key_1", apiKeyId: "key_1", agentId: null, keyName: "Bot", keyPrefix: "mm_live_abcd" };
  const stamp = { kind: "workspace_key", key: "Bot", prefix: "mm_live_abcd" };
  const inRequest = <T>(caller: Parameters<typeof noteRequestCaller>[0] | null, fn: () => T) => runWithRequestCaller(IP, () => { if (caller) noteRequestCaller(caller); return fn(); });

  it("adds the key to the caller's own line and to what the key caused, never to another person's line", () => {
    expect(inRequest(key, () => withCaller({ type: "member", id: "usr_maker" }, { ids: ["t1"] }))).toEqual({ ids: ["t1"], caller: stamp });
    expect(inRequest(key, () => withCaller({ type: "agent", id: "agt_1" }))).toEqual({ caller: stamp });
    expect(inRequest(key, () => withCaller({ type: "system", id: null }))).toEqual({ caller: stamp });
    expect(inRequest(key, () => withCaller({ type: "member", id: "usr_other" }, { ids: ["t1"] }))).toEqual({ ids: ["t1"] });
  });

  it("adds nothing for a person in the app or outside a request, and a stamp replaces a caller already in the data", () => {
    expect(inRequest({ userId: "usr_p", email: "p@acme.io", role: "owner", sessionId: "abc" }, () => withCaller({ type: "member", id: "usr_p" }, { x: 1 }))).toEqual({ x: 1 });
    expect(withCaller({ type: "member", id: "usr_maker" }, { x: 1 })).toEqual({ x: 1 });
    expect(inRequest(key, () => withCaller({ type: "member", id: "usr_maker" }, { caller: { kind: "oauth", app: "Forged" } }))).toEqual({ caller: stamp });
  });
});
