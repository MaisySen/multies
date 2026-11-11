import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { parseSnoozeUntil } from "@/server/services/suite/triage-r32";

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
async function mcpFor(key: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
  return client;
}
const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
const days = (n: number) => new Date(Date.now() + n * 86400_000).toISOString();

async function triageProject() {
  const project = (await c.post("/api/projects", { name: "Support" })).body.project;
  await c.patch(`/api/projects/${project.id}`, { triage: true });
  return project;
}
async function item(title: string, projectId: string) {
  const r = await c.post("/api/triage", { title, projectId, source: "form", from: "grace@harbourcoffee.com.au" });
  expect(r.status).toBe(201);
  return r.body.item.id as string;
}

describe("R32 task triage: snooze, duplicate, undo", () => {
  it("snoozes an item out of the queue and its count, lists it under snoozed, and brings it back", async () => {
    const p = await triageProject();
    const id = await item("Quote for 6 mailboxes", p.id);
    const other = await item("Second", p.id);
    const s = await c.post(`/api/triage/${id}/action`, { action: "snooze", until: days(2) });
    expect(s.status).toBe(200);
    expect(s.body.task.triage.snoozedUntil).toBeTruthy();
    const q = (await c.get("/api/triage")).body;
    expect(q.items.map((t: { id: string }) => t.id)).toEqual([other]);
    expect(q.count).toBe(1);
    expect((await c.get("/api/triage/count")).body.count).toBe(1);
    expect((await c.get("/api/triage?view=snoozed")).body.items.map((t: { id: string }) => t.id)).toEqual([id]);
    // Still hidden from the board while snoozed.
    expect((await c.get(`/api/tasks?projectId=${p.id}`)).body.tasks).toHaveLength(0);
    // Time passes: it comes back by itself.
    const real = ctx.deps.now;
    ctx.deps.now = () => new Date(Date.now() + 3 * 86400_000);
    try {
      expect((await c.get("/api/triage/count")).body.count).toBe(2);
      expect((await c.get("/api/triage")).body.items).toHaveLength(2);
    } finally { ctx.deps.now = real; }
    const u = await c.post(`/api/triage/${id}/action`, { action: "unsnooze" });
    expect(u.body.task.triage.snoozedUntil).toBeNull();
    expect((await c.get("/api/triage/count")).body.count).toBe(2);
  });

  it("refuses a snooze in the past, too far out or without a date", async () => {
    const p = await triageProject();
    const id = await item("A", p.id);
    for (const until of [undefined, "yesterday", days(-1), days(400)]) {
      expect((await c.post(`/api/triage/${id}/action`, { action: "snooze", until })).status).toBe(422);
    }
    const now = new Date("2026-10-26T00:00:00Z");
    expect(parseSnoozeUntil("2026-11-02", now).toISOString()).toBe("2026-11-02T08:00:00.000Z");
  });

  it("accepting a snoozed item clears the snooze; decline keeps the reason; undo restores each", async () => {
    const p = await triageProject();
    const a = await item("Accept me", p.id);
    await c.post(`/api/triage/${a}/action`, { action: "snooze", until: days(1) });
    const acc = await c.post(`/api/triage/${a}/action`, { action: "accept" });
    expect(acc.body.task.triage).toBeNull();
    expect((await c.get(`/api/tasks?projectId=${p.id}`)).body.tasks.map((t: { id: string }) => t.id)).toEqual([a]);
    const back = await c.post(`/api/triage/${a}/action`, { action: "restore" });
    expect(back.body.task.triage).toMatchObject({ state: "pending", snoozedUntil: null });
    expect((await c.get(`/api/tasks?projectId=${p.id}`)).body.tasks).toHaveLength(0);

    const d = await c.post(`/api/triage/${a}/action`, { action: "decline", decline: { reason: "Spam" } });
    expect(d.body).toMatchObject({ action: "decline", ok: true });
    expect((await c.get("/api/triage/count")).body.count).toBe(0);
    expect((await c.post(`/api/triage/${a}/action`, { action: "restore" })).body.task.triage.state).toBe("pending");
    expect((await c.get("/api/triage/count")).body.count).toBe(1);
    const acts = JSON.stringify((await c.get(`/api/tasks/${a}`)).body);
    expect(acts).toContain("Accept me");
  });

  it("marks a duplicate of an existing task and refuses without a target", async () => {
    const p = await triageProject();
    const target = (await c.post("/api/tasks", { title: "Mailbox quote", projectId: p.id })).body.task;
    const id = await item("Quote again", p.id);
    expect((await c.post(`/api/triage/${id}/action`, { action: "duplicate" })).status).toBe(422);
    const r = await c.post(`/api/triage/${id}/action`, { action: "duplicate", duplicateOf: target.id });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ action: "duplicate", merged: id, task: { id: target.id } });
    expect((await c.get("/api/triage/count")).body.count).toBe(0);
  });

  it("routes API-key and agent (MCP) tasks into Triage when the project uses it, not otherwise", async () => {
    const p = await triageProject();
    const plain = (await c.post("/api/projects", { name: "Plain" })).body.project;
    const key = (await c.post("/api/developer/keys", { name: "Agent" })).body.secret;
    const viaApi = await api(key, "POST", "/tasks", { title: "From the API", projectId: p.id });
    expect(viaApi.status).toBe(201);
    expect(viaApi.body.task.triage).toMatchObject({ state: "pending", source: "api" });
    const direct = await api(key, "POST", "/tasks", { title: "Straight in", projectId: plain.id });
    expect(direct.body.task.triage).toBeNull();
    const m = await mcpFor(key);
    const made = data(await m.callTool({ name: "create_task", arguments: { title: "From an agent", projectId: p.id } }));
    expect(made.task.triage).toMatchObject({ state: "pending", source: "agent" });
    // The session app still creates straight on the board.
    expect((await c.post("/api/tasks", { title: "By hand", projectId: p.id })).body.task.triage).toBeNull();
    expect((await c.get("/api/triage/count")).body.count).toBe(2);
  });

  it("REST POST /tasks/{id}/triage and MCP task_triage_list / task_triage_action", async () => {
    const p = await triageProject();
    const key = (await c.post("/api/developer/keys", { name: "Bot" })).body.secret;
    const id = await item("Call back Priya", p.id);
    const sn = await api(key, "POST", `/tasks/${id}/triage`, { action: "snooze", until: days(3) });
    expect(sn.status).toBe(200);
    expect((await api(key, "GET", "/triage?view=snoozed")).body.items).toHaveLength(1);
    expect((await api(key, "POST", `/tasks/${id}/triage`, { action: "nope" })).status).toBe(422);
    const m = await mcpFor(key);
    expect(data(await m.callTool({ name: "task_triage_list", arguments: { view: "snoozed" } })).items).toHaveLength(1);
    // AIS1 (row 66): a key snoozes, but accepting needs a person signed in.
    const refused = await m.callTool({ name: "task_triage_action", arguments: { id, action: "accept", status: "doing" } });
    expect(refused.isError).toBe(true);
    expect((refused as { content: { text: string }[] }).content[0].text).toMatch(/^person_only: /);
    const acc = (await c.post(`/api/triage/${id}/action`, { action: "accept", accept: { status: "doing" } })).body;
    expect(acc.task).toMatchObject({ id, triage: null, status: "doing" });
    const ro = (await c.post("/api/developer/keys", { name: "Reader", scope: "read" })).body.secret;
    expect((await api(ro, "POST", `/tasks/${id}/triage`, { action: "restore" })).status).toBe(403);
    const spec = (await ctx.app.request("/api/v1/openapi.json", { headers: { host: "localhost" } }));
    expect(JSON.stringify(await spec.json())).toContain("/tasks/{id}/triage");
  });
});
