import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { taskComments, tasks } from "@/server/db/schema";
import { pkceChallenge } from "@/server/services/developer/oauth";

/**
 * AIS1 (audit row 66): Triage is a human check. Only a person signed in to Multies accepts, declines, merges or
 * restores an item, or deletes one that still waits. A key or a connected AI app can still add items, read the
 * queue and snooze.
 */

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io");
});

async function api(key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
async function mcpWith(token: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${token}` } }, fetch: fetchViaApp }));
  return client;
}
/** A connected AI app (OAuth), signed in as the owner: the flow from tests/mcp-oauth.test.ts. */
async function oauthToken() {
  const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
  const verifier = "v".repeat(20) + "-verifier-for-pkce-tests-0123456789";
  const reg = await ctx.app.request("/api/oauth/register", { method: "POST", headers: { "content-type": "application/json", host: "localhost", origin: "https://claude.ai" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }) });
  const clientId = ((await reg.json()) as { client_id: string }).client_id;
  const request = { client_id: clientId, redirect_uri: REDIRECT, response_type: "code", code_challenge: await pkceChallenge(verifier), code_challenge_method: "S256", state: "st-1", scope: "mcp:read mcp:write" };
  const r = await c.post("/api/oauth/authorize", { decision: "allow", scope: "full", request });
  expect(r.status).toBe(200);
  const code = new URL(r.body.redirectTo).searchParams.get("code")!;
  const tok = await ctx.app.request("/api/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", host: "localhost" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier }).toString() });
  return ((await tok.json()) as { access_token: string }).access_token;
}
const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;
const key = async (name = "Bot") => (await c.post("/api/developer/keys", { name })).body.secret as string;
const row = (id: string) => ctx.deps.db.select().from(tasks).where(eq(tasks.id, id)).get();
const commentsOf = (id: string) => ctx.deps.db.select().from(taskComments).where(eq(taskComments.taskId, id)).all();

async function triageProject() {
  const project = (await c.post("/api/projects", { name: "Support" })).body.project;
  await c.patch(`/api/projects/${project.id}`, { triage: true });
  return project as { id: string };
}
async function item(title: string, projectId: string) {
  const r = await c.post("/api/triage", { title, projectId, source: "form", from: "grace@harbourcoffee.com.au" });
  expect(r.status).toBe(201);
  return r.body.item.id as string;
}
const pending = async (id: string) => (await row(id))?.triageState === "pending" && !(await row(id))?.deletedAt;

describe("AIS1 row 66: only a person decides Triage", () => {
  it("a workspace key can add, list and snooze, but accepting, declining, merging and bulk deciding answer 403 person_only", async () => {
    const p = await triageProject();
    const k = await key();
    const made = await api(k, "POST", "/triage", { title: "Call back Priya", projectId: p.id });
    expect(made.status).toBe(201);
    const id = made.body.item.id as string;
    expect((await api(k, "GET", "/triage")).body.count).toBe(1);
    const target = (await c.post("/api/tasks", { title: "Existing", projectId: p.id })).body.task;

    for (const [path, body] of [[`/triage/${id}/accept`, {}], [`/triage/${id}/decline`, { reason: "junk" }], [`/triage/${id}/merge`, { targetId: target.id }]] as const) {
      const r = await api(k, "POST", path, body);
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("person_only");
      expect(r.body.error.message).toContain("needs a person signed in to Multies");
    }
    const bulk = await api(k, "POST", "/triage/bulk", { ids: [id], action: "accept" });
    expect(bulk.status).toBe(403);
    expect(bulk.body.error.code).toBe("person_only");
    expect(await pending(id)).toBe(true);

    // Snooze stays open to keys.
    const until = new Date(Date.now() + 2 * 86_400_000).toISOString();
    expect((await api(k, "POST", `/tasks/${id}/triage`, { action: "snooze", until })).status).toBe(200);
    expect((await api(k, "POST", `/tasks/${id}/triage`, { action: "unsnooze" })).status).toBe(200);
  });

  it("a key or an AI app snoozes an item for at most 7 days; a person may snooze longer", async () => {
    const p = await triageProject();
    const k = await key();
    const id = await item("Quote for new menu boards", p.id);
    const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
    const long = await api(k, "POST", `/tasks/${id}/triage`, { action: "snooze", until: inDays(8) });
    expect(long.status).toBe(403);
    expect(long.body.error.code).toBe("person_only");
    expect(long.body.error.message).toContain("7 days");
    const m = await mcpWith(k);
    const viaMcp = await m.callTool({ name: "task_triage_action", arguments: { id, action: "snooze", until: inDays(30) } });
    expect((viaMcp as { isError?: boolean }).isError).toBe(true);
    await m.close();
    expect((await row(id))?.triageSnoozedUntil).toBeNull();
    expect((await api(k, "POST", `/tasks/${id}/triage`, { action: "snooze", until: inDays(6) })).status).toBe(200);
    expect((await c.post(`/api/triage/${id}/action`, { action: "snooze", until: inDays(30) })).status).toBe(200);
  });

  it("snoozing again doesn't stretch a key's 7 days: the item is back in the queue a week after it came in", async () => {
    const p = await triageProject();
    const id = await item("Refund request from Grace", p.id);
    const k = await key();
    const DAY = 86_400_000;
    const t0 = Date.now();
    let now = t0;
    ctx.deps.now = () => new Date(now);
    const snooze = async (day: number, days: number) => { now = t0 + day * DAY; return api(k, "POST", `/tasks/${id}/triage`, { action: "snooze", until: new Date(now + days * DAY).toISOString() }); };
    expect((await snooze(0, 6)).status).toBe(200);
    // Day 6: snoozing to day 12 reaches past a week after the item came in.
    const again = await snooze(6, 6);
    expect(again.status).toBe(403);
    expect(again.body.error.code).toBe("person_only");
    // Unsnooze, then snooze, doesn't reset it either.
    expect((await api(k, "POST", `/tasks/${id}/triage`, { action: "unsnooze" })).status).toBe(200);
    expect((await snooze(6, 6)).status).toBe(403);
    expect((await snooze(6, 0.5)).status).toBe(200); // still inside the week
    for (const day of [12, 18]) expect((await snooze(day, 6)).status).toBe(403);
    now = t0 + 20 * DAY;
    expect((await c.get("/api/triage/count")).body.count).toBe(1);
    // A person may still snooze it.
    expect((await c.post(`/api/triage/${id}/action`, { action: "snooze", until: new Date(now + 6 * DAY).toISOString() })).status).toBe(200);
  });

  it("the one action door refuses accept, decline, duplicate and restore for a key, and a refused decline writes no comment", async () => {
    const p = await triageProject();
    const k = await key();
    const id = await item("Espresso machine leaks", p.id);
    const target = (await c.post("/api/tasks", { title: "Existing", projectId: p.id })).body.task;
    for (const body of [{ action: "accept" }, { action: "decline", comment: "Not for us" }, { action: "duplicate", duplicateOf: target.id }, { action: "restore" }]) {
      const r = await api(k, "POST", `/tasks/${id}/triage`, body);
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("person_only");
    }
    expect(await commentsOf(id)).toHaveLength(0);
    expect(await pending(id)).toBe(true);

    // A person declines; the key can't undo it.
    expect((await c.post(`/api/triage/${id}/action`, { action: "decline" })).status).toBe(200);
    const undo = await api(k, "POST", `/tasks/${id}/triage`, { action: "restore" });
    expect(undo.status).toBe(403);
    expect((await row(id))?.deletedAt).toBeTruthy();
    // The person can.
    expect((await c.post(`/api/triage/${id}/action`, { action: "restore" })).status).toBe(200);
    expect(await pending(id)).toBe(true);
  });

  it("an agent key is refused too", async () => {
    const p = await triageProject();
    await c.post("/api/domains", { name: "acme.io" });
    const ws = await key("Agents");
    const agent = (await api(ws, "POST", "/agents", { name: "Inbox helper" })).body;
    expect(agent.apiKey?.secret).toBeTruthy();
    const id = await item("From the form", p.id);
    const r = await api(agent.apiKey.secret, "POST", `/triage/${id}/accept`, {});
    expect(r.status).toBe(403);
    expect(await pending(id)).toBe(true);
  });

  it("MCP with a workspace key: create_triage_item and list_triage work, the decision tools answer person_only", async () => {
    const p = await triageProject();
    const m = await mcpWith(await key("MCP"));
    const made = data(await m.callTool({ name: "create_triage_item", arguments: { title: "From the agent", projectId: p.id } }));
    expect(data(await m.callTool({ name: "list_triage", arguments: {} })).count).toBe(1);
    const target = (await c.post("/api/tasks", { title: "Existing", projectId: p.id })).body.task;
    for (const [name, args] of [
      ["triage_accept", { id: made.item.id }],
      ["triage_decline", { id: made.item.id, reason: "junk" }],
      ["triage_merge", { id: made.item.id, targetId: target.id }],
      ["task_triage_action", { id: made.item.id, action: "accept" }],
      ["task_triage_action", { id: made.item.id, action: "restore" }],
    ] as const) {
      const out = await m.callTool({ name, arguments: args });
      expect(out.isError).toBe(true);
      expect(text(out)).toMatch(/^person_only: /);
    }
    expect(await pending(made.item.id)).toBe(true);
    await m.close();
  });

  it("a connected AI app (OAuth) can't accept the item it made, though it acts as the owner", async () => {
    const p = await triageProject();
    const m = await mcpWith(await oauthToken());
    const made = data(await m.callTool({ name: "create_task", arguments: { title: "Made by Claude", projectId: p.id } }));
    expect(made.task.triage).toMatchObject({ state: "pending" });
    const out = await m.callTool({ name: "task_triage_action", arguments: { id: made.task.id, action: "accept" } });
    expect(out.isError).toBe(true);
    expect(text(out)).toMatch(/^person_only: /);
    expect(await pending(made.task.id)).toBe(true);
    await m.close();
  });

  it("a key can't delete an item that waits in Triage, one at a time or in bulk; it still deletes normal tasks", async () => {
    const p = await triageProject();
    const k = await key();
    const id = await item("Waiting", p.id);
    const normal = (await c.post("/api/tasks", { title: "Normal", projectId: p.id })).body.task;
    const one = await api(k, "DELETE", `/tasks/${id}`);
    expect(one.status).toBe(403);
    expect(one.body.error.code).toBe("person_only");
    const bulk = await api(k, "POST", "/tasks/bulk-delete", { ids: [normal.id, id] });
    expect(bulk.status).toBe(403);
    expect(await pending(id)).toBe(true);
    expect((await row(normal.id))?.deletedAt).toBeFalsy(); // nothing changed
    expect((await api(k, "DELETE", `/tasks/${normal.id}`)).status).toBe(200);
    // A person in the app may delete a waiting item.
    expect((await c.del(`/api/tasks/${id}`)).status).toBe(200);
  });

  it("a key can't delete an accepted parent whose subtask waits in Triage, one at a time or in bulk", async () => {
    const p = await triageProject();
    const parent = (await c.post("/api/tasks", { title: "Accepted parent", projectId: p.id })).body.task;
    const k = await key();
    const sub = (await api(k, "POST", "/tasks", { title: "Waiting subtask", projectId: p.id, parentId: parent.id })).body.task;
    expect(sub.triage).toMatchObject({ state: "pending" });
    const one = await api(k, "DELETE", `/tasks/${parent.id}`);
    expect(one.status).toBe(403);
    expect(one.body.error.code).toBe("person_only");
    const bulk = await api(k, "POST", "/tasks/bulk-delete", { ids: [parent.id] });
    expect(bulk.status).toBe(403);
    expect(bulk.body.error.code).toBe("person_only");
    const rows = await ctx.deps.db.select().from(tasks).where(eq(tasks.projectId, p.id)).all();
    expect(rows.filter((r) => r.deletedAt)).toHaveLength(0);
  });

  it("a key can't delete a project while items wait in its Triage; a person can", async () => {
    const p = await triageProject();
    const k = await key();
    const id = await item("Waiting", p.id);
    const r = await api(k, "DELETE", `/projects/${p.id}`);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("person_only");
    expect(await pending(id)).toBe(true);
    const empty = (await c.post("/api/projects", { name: "Empty" })).body.project;
    expect((await api(k, "DELETE", `/projects/${empty.id}`)).status).toBe(200);
    expect((await c.del(`/api/projects/${p.id}`)).status).toBe(200);
  });

  it("a person in the app still accepts, declines, merges and bulk decides", async () => {
    const p = await triageProject();
    const a = await item("Accept me", p.id);
    const d = await item("Decline me", p.id);
    const b = await item("Bulk me", p.id);
    const target = (await c.post("/api/tasks", { title: "Existing", projectId: p.id })).body.task;
    const mg = await item("Merge me", p.id);
    expect((await c.post(`/api/triage/${a}/accept`, {})).status).toBe(200);
    expect((await c.post(`/api/triage/${d}/decline`, {})).status).toBe(200);
    expect((await c.post(`/api/triage/${mg}/merge`, { targetId: target.id })).status).toBe(200);
    expect((await c.post("/api/triage/bulk", { ids: [b], action: "accept" })).body.done).toBe(1);
    expect((await c.get("/api/triage/count")).body.count).toBe(0);
  });
});
