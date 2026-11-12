import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { tasks } from "@/server/db/schema";

/**
 * AIS1 review (row 35): a task import by an API key or a connected AI app (v1 POST /work-imports/run, MCP import_file)
 * into a project with Triage on waits there for a person, as the key's own tasks do. Before the fix the import wrote
 * the rows straight onto the board. A person's import in the app still goes straight to the board.
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
const boardTitles = async (projectId: string) => ((await c.get(`/api/tasks?projectId=${projectId}`)).body.tasks as { title: string }[]).map((t) => t.title);
const rowsIn = (projectId: string) => ctx.deps.db.select().from(tasks).where(eq(tasks.projectId, projectId)).all();

describe("AIS1 review: a key's or an AI app's import waits in Triage", () => {
  it("v1 POST /work-imports/run into a Triage-on project leaves the key's tasks waiting, subtasks too", async () => {
    const p = (await c.post("/api/projects", { name: "Payments" })).body.project;
    expect(p.triage).toBe(true);
    const k = await key();
    // Control: the same key's plain task waits.
    expect((await api(k, "POST", "/tasks", { title: "Plain key task", projectId: p.id })).body.task.triage).toMatchObject({ state: "pending" });
    const csv = "ID,Title,Status,Parent\n1,Pay invoice 4471 to new bank account,To do,\n2,Check the bank details,To do,1\n";
    const run = await api(k, "POST", "/work-imports/run", { fileName: "plan.csv", content: csv, projectId: p.id });
    expect(run.status).toBe(200);
    expect(run.body.created).toBe(2);
    expect(run.body.triage).toBe(true);
    expect(await boardTitles(p.id)).not.toContain("Pay invoice 4471 to new bank account");
    const rows = await rowsIn(p.id);
    const parent = rows.find((r) => r.title === "Pay invoice 4471 to new bank account")!;
    const sub = rows.find((r) => r.title === "Check the bank details")!;
    expect([parent.triageState, parent.triageSource, sub.triageState, sub.parentId]).toEqual(["pending", "api", "pending", parent.id]);
    expect((await c.get("/api/triage/count")).body.count).toBe(3);
    // A person accepts the imported task, and its subtask comes with it.
    expect((await c.post(`/api/triage/${parent.id}/accept`, {})).status).toBe(200);
    expect((await c.get("/api/triage/count")).body.count).toBe(1);
    expect(await boardTitles(p.id)).toContain("Pay invoice 4471 to new bank account");
  });

  it("MCP import_file by a key does the same", async () => {
    const p = (await c.post("/api/projects", { name: "Ops" })).body.project;
    const m = await mcpWith(await key());
    const out = await m.callTool({ name: "import_file", arguments: { kind: "tasks", fileName: "ops.csv", content: "Title,Status\nGive contractor admin access,To do\n", projectId: p.id } });
    expect((out as { isError?: boolean }).isError).toBeFalsy();
    await m.close();
    expect(await boardTitles(p.id)).not.toContain("Give contractor admin access");
    expect((await rowsIn(p.id)).map((r) => [r.title, r.triageState, r.triageSource])).toEqual([["Give contractor admin access", "pending", "agent"]]);
  });

  it("a key's import into a new project it makes waits too; into a project with Triage off it goes to the board", async () => {
    const k = await key();
    const fresh = await api(k, "POST", "/work-imports/run", { fileName: "trello.csv", content: "Title,Status\nRing the landlord,To do\n", projectName: "From Trello" });
    expect(fresh.status).toBe(200);
    expect(fresh.body.projectCreated).toBe(true);
    expect(fresh.body.triage).toBe(true);
    expect((await rowsIn(fresh.body.projectId)).map((r) => r.triageState)).toEqual(["pending"]);

    const off = (await c.post("/api/projects", { name: "Old", triage: false })).body.project;
    const plain = await api(k, "POST", "/work-imports/run", { fileName: "old.csv", content: "Title,Status\nOrder paper,To do\n", projectId: off.id });
    expect(plain.status).toBe(200);
    expect(plain.body.triage).toBe(false);
    expect(await boardTitles(off.id)).toEqual(["Order paper"]);
  });

  it("a person's import in the app goes straight to the board of a Triage-on project", async () => {
    const p = (await c.post("/api/projects", { name: "Payments" })).body.project;
    const r = await c.post("/api/work-imports/run", { fileName: "mine.csv", content: "Title,Status\nPay the rent,To do\n", projectId: p.id });
    expect(r.status).toBe(200);
    expect(r.body.triage).toBe(false);
    expect(await boardTitles(p.id)).toEqual(["Pay the rent"]);
  });
});
