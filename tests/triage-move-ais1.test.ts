import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { tasks } from "@/server/db/schema";

/**
 * AIS1 review (row 35): a key or an AI app could make a task in a project with Triage off (every project made before
 * AIS1 has it off) and then move it into one with Triage on, so it landed on that board unchecked. Such a move now
 * answers 403 person_only and changes nothing; a person may move it, and the key can still make the task in the
 * Triage-on project, where it waits.
 */

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io");
});

async function api(key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", "content-type": "application/json" }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function mcpWith(token: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${token}` } }, fetch: fetchViaApp }));
  return client;
}
const key = async () => (await c.post("/api/developer/keys", { name: "Bot" })).body.secret as string;
const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;
const boardTitles = async (projectId: string) => ((await c.get(`/api/tasks?projectId=${projectId}`)).body.tasks as { title: string }[]).map((t) => t.title);
const row = (id: string) => ctx.deps.db.select().from(tasks).where(eq(tasks.id, id)).get();

async function projects() {
  // An existing project with Triage off (as every project made before AIS1), and one a person keeps under Triage.
  const old = (await c.post("/api/projects", { name: "Old", triage: false })).body.project.id as string;
  const guarded = (await c.post("/api/projects", { name: "Payments" })).body.project;
  expect(guarded.triage).toBe(true);
  return { old, guarded: guarded.id as string };
}

describe("AIS1 review: a key can't move a task past Triage", () => {
  it("v1 PATCH /tasks/{id} projectId into a Triage-on project answers 403 and moves nothing", async () => {
    const { old, guarded } = await projects();
    const k = await key();
    // Control: made straight in the guarded project, it waits.
    expect((await api(k, "POST", "/tasks", { title: "Direct", projectId: guarded })).body.task.triage).toMatchObject({ state: "pending" });
    const t = (await api(k, "POST", "/tasks", { title: "Pay the new supplier account", projectId: old })).body.task;
    const before = await row(t.id);
    const moved = await api(k, "PATCH", `/tasks/${t.id}`, { projectId: guarded });
    expect(moved.status).toBe(403);
    expect(moved.body.error.code).toBe("person_only");
    expect(await boardTitles(guarded)).not.toContain("Pay the new supplier account");
    const after = await row(t.id);
    expect([after?.projectId, after?.number, after?.version]).toEqual([old, before?.number, before?.version]);
    // A person may move it.
    expect((await c.patch(`/api/tasks/${t.id}`, { projectId: guarded })).status).toBe(200);
    expect(await boardTitles(guarded)).toContain("Pay the new supplier account");
  });

  it("MCP bulk_update_tasks projectId answers person_only and moves nothing", async () => {
    const { old, guarded } = await projects();
    const k = await key();
    const m = await mcpWith(k);
    const t = data(await m.callTool({ name: "create_task", arguments: { title: "Grant admin to contractor", projectId: old } })).task;
    expect(t.triage).toBeNull();
    const out = await m.callTool({ name: "bulk_update_tasks", arguments: { ids: [t.id], projectId: guarded } });
    expect((out as { isError?: boolean }).isError).toBe(true);
    expect(text(out)).toMatch(/^person_only: /);
    await m.close();
    expect(await boardTitles(guarded)).not.toContain("Grant admin to contractor");
    expect((await row(t.id))?.projectId).toBe(old);
    // v1 bulk too, and a person may.
    expect((await api(k, "POST", "/tasks/bulk", { ids: [t.id], patch: { projectId: guarded } })).status).toBe(403);
    expect((await c.post("/api/tasks/bulk", { ids: [t.id], patch: { projectId: guarded } })).status).toBe(200);
    expect(await boardTitles(guarded)).toContain("Grant admin to contractor");
  });

  it("a key still moves tasks between projects with Triage off, between projects with Triage on, and its own waiting item", async () => {
    const { old, guarded } = await projects();
    const other = (await c.post("/api/projects", { name: "Other", triage: false })).body.project.id as string;
    const second = (await c.post("/api/projects", { name: "Payroll" })).body.project.id as string;
    const k = await key();
    const plain = (await api(k, "POST", "/tasks", { title: "Plain", projectId: old })).body.task;
    expect((await api(k, "PATCH", `/tasks/${plain.id}`, { projectId: other })).status).toBe(200);
    const onBoard = (await c.post("/api/tasks", { title: "Person's task", projectId: guarded })).body.task;
    expect((await api(k, "PATCH", `/tasks/${onBoard.id}`, { projectId: second })).status).toBe(200);
    const waiting = (await api(k, "POST", "/tasks", { title: "Waits", projectId: guarded })).body.task;
    const moved = await api(k, "PATCH", `/tasks/${waiting.id}`, { projectId: second });
    expect(moved.status).toBe(200);
    expect(moved.body.task.triage).toMatchObject({ state: "pending" });
    // A task a person accepted in Triage before may move into a Triage-on project.
    const item = (await c.post("/api/triage", { title: "Accepted before", projectId: guarded, source: "form" })).body.item.id as string;
    expect((await c.post(`/api/triage/${item}/accept`, { projectId: old })).status).toBe(200);
    expect((await api(k, "PATCH", `/tasks/${item}`, { projectId: second })).status).toBe(200);
  });
});
