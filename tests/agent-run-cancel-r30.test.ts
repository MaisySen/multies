import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { describeAudit } from "../src/web/components/app-bits";
import { canCancelRun, withRun, withRunCancelled, type AgentRun } from "../src/web/pages/app/work/task-runs";

/** R30: cancel an agent run end to end: v1 POST /runs/{id}/cancel, the app route, MCP agent_run_cancel, audit, claim after cancel. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let projectId: string;
let taskId: string;
let taskRef: string;
let wsKey: string;
let readKey: string;
let builder: { id: string; key: string };
let qa: { id: string; key: string };

async function v1(key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}
async function mcpFor(key: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
  return client;
}
const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;
const client = () => (ctx.db as unknown as { $client: { prepare: (q: string) => { all: (...a: unknown[]) => unknown[] } } }).$client;
const raw = (q: string, ...a: unknown[]) => client().prepare(q).all(...a);
const cancels = () => raw("select actor_email, target_id, metadata from audit_logs where action = 'agent_run.cancelled' order by created_at") as { actor_email: string | null; target_id: string; metadata: string }[];
const agent = async (name: string) => {
  const made = (await c.post("/api/team/agents", { name })).body;
  return { id: made.member.userId as string, key: made.secret as string };
};
const queue = async (agentUserId = builder.id) => (await c.post(`/api/tasks/${taskId}/runs`, { agentUserId })).body.run as { id: string; status: string };

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  projectId = (await c.post("/api/projects", { name: "Build", key: "MB" })).body.project.id;
  builder = await agent("Builder");
  qa = await agent("QA");
  const t = (await c.post("/api/tasks", { title: "Fix the sprint filter", projectId, assignee: `member:${builder.id}` })).body.task;
  taskId = t.id; taskRef = t.ref;
  wsKey = (await c.post("/api/developer/keys", { name: "ops" })).body.secret;
  readKey = (await c.post("/api/developer/keys", { name: "reader", scope: "read" })).body.secret;
});

describe("v1 POST /runs/{id}/cancel", () => {
  it("a workspace key cancels a queued run; the answer has GET's shape, one audit row with the reason", async () => {
    const run = await queue();
    const r = await v1(wsKey, "POST", `/runs/${run.id}/cancel`, { reason: "Not needed any more" });
    expect(r.status).toBe(200);
    expect(r.body.run).toMatchObject({ id: run.id, status: "cancelled", result: "Not needed any more", task: { ref: taskRef } });
    const got = (await v1(wsKey, "GET", `/runs/${run.id}`)).body;
    expect(Object.keys(r.body)).toEqual(Object.keys(got));
    expect(Object.keys(r.body.run).sort()).toEqual(Object.keys(got.run).sort());
    expect(r.body.run.finishedAt).toBeTruthy();
    const rows = cancels();
    expect(rows).toHaveLength(1);
    expect(rows[0].target_id).toBe(taskId);
    expect(JSON.parse(rows[0].metadata)).toMatchObject({ runId: run.id, agentUserId: builder.id, taskRef, status: "cancelled", reason: "Not needed any more", from: "queued", via: "api" });
  });

  it("works with no body, and is idempotent: a second cancel answers 200 unchanged with no write and no audit row", async () => {
    const run = await queue();
    const res = await ctx.app.request(`/api/v1/runs/${run.id}/cancel`, { method: "POST", headers: { authorization: `Bearer ${wsKey}`, host: "localhost" } });
    expect(res.status).toBe(200);
    const first = (await res.json()).run;
    const again = await v1(wsKey, "POST", `/runs/${run.id}/cancel`, { reason: "again" });
    expect(again.status).toBe(200);
    expect(again.body.run).toEqual(first);
    expect(again.body.run.result).toBeNull();
    expect(cancels()).toHaveLength(1);
  });

  it("a finished run is 409 run_finished; another workspace is 404; a read only key is 403", async () => {
    const run = (await v1(builder.key, "POST", `/tasks/${taskId}/runs`, {})).body.run;
    expect((await v1(readKey, "POST", `/runs/${run.id}/cancel`, {})).status).toBe(403);
    const other = new Client(ctx.app);
    await other.signup("eve@else.io", "Eve Else");
    const evilKey = (await other.post("/api/developer/keys", { name: "x" })).body.secret;
    expect((await v1(evilKey, "POST", `/runs/${run.id}/cancel`, {})).status).toBe(404);
    await v1(builder.key, "POST", `/runs/${run.id}/finish`, { status: "succeeded", result: "done" });
    const late = await v1(wsKey, "POST", `/runs/${run.id}/cancel`, {});
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("run_finished");
    expect(cancels()).toHaveLength(0);
  });

  it("the run's own agent can cancel its running run; another agent can't", async () => {
    const run = (await v1(builder.key, "POST", `/tasks/${taskId}/runs`, {})).body.run;
    const other = await v1(qa.key, "POST", `/runs/${run.id}/cancel`, {});
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe("not_this_agent");
    const own = await v1(builder.key, "POST", `/runs/${run.id}/cancel`, { reason: "Blocked on a review" });
    expect(own.status).toBe(200);
    expect(own.body.run.status).toBe("cancelled");
    expect(JSON.parse(cancels()[0].metadata)).toMatchObject({ byAgent: true, from: "running" });
  });

  it("a reason over 500 characters is 422", async () => {
    const run = await queue();
    expect((await v1(wsKey, "POST", `/runs/${run.id}/cancel`, { reason: "x".repeat(501) })).status).toBe(422);
    expect((await c.post(`/api/agent-runs/${run.id}/cancel`, { reason: "x".repeat(501) })).status).toBe(422);
    expect(cancels()).toHaveLength(0);
  });

  it("is in the openapi document", async () => {
    const doc = await (await ctx.app.request("/api/v1/openapi.json")).json();
    expect(Object.keys(doc.paths)).toContain("/runs/{id}/cancel");
    expect(doc.paths["/runs/{id}/cancel"].post).toBeTruthy();
  });
});

describe("after a cancel the work stops", () => {
  it("a cancelled queued run can't be claimed, stepped or finished (409 run_cancelled)", async () => {
    const run = await queue();
    await c.post(`/api/agent-runs/${run.id}/cancel`, {});
    // Starting again makes a fresh run; the cancelled one stays cancelled.
    const started = await v1(builder.key, "POST", `/tasks/${taskId}/runs`, {});
    expect(started.status).toBe(201);
    expect(started.body.run.id).not.toBe(run.id);
    expect((await v1(wsKey, "GET", `/runs/${run.id}`)).body.run.status).toBe("cancelled");
    const step = await v1(builder.key, "POST", `/runs/${run.id}/steps`, { text: "late" });
    expect(step.status).toBe(409);
    expect(step.body.error.code).toBe("run_cancelled");
    const fin = await v1(builder.key, "POST", `/runs/${run.id}/finish`, { status: "succeeded" });
    expect(fin.status).toBe(409);
    expect(fin.body.error.code).toBe("run_cancelled");
    expect((await v1(builder.key, "GET", `/runs?status=queued`)).body.runs).toEqual([]);
  });

  it("a cancel through finish also writes agent_run.cancelled", async () => {
    const run = await queue();
    expect((await v1(wsKey, "POST", `/runs/${run.id}/finish`, { status: "cancelled", result: "wrong agent" })).status).toBe(200);
    expect(JSON.parse(cancels()[0].metadata)).toMatchObject({ runId: run.id, reason: "wrong agent" });
  });
});

describe("the app route", () => {
  it("a person cancels with the same audit entry, idempotently, and the audit page reads in plain words", async () => {
    const run = await queue();
    const r = await c.post(`/api/agent-runs/${run.id}/cancel`, { reason: "Duplicate" });
    expect(r.status).toBe(200);
    expect(r.body.run).toMatchObject({ status: "cancelled", result: "Duplicate" });
    expect((await c.post(`/api/agent-runs/${run.id}/cancel`)).status).toBe(200);
    const rows = cancels();
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_email).toBe("owner@acme.io");
    expect(JSON.parse(rows[0].metadata)).toMatchObject({ via: "app", byAgent: false, reason: "Duplicate" });
    const entries = (await c.get("/api/org/audit")).body.entries as Parameters<typeof describeAudit>[0][];
    const e = entries.find((x) => x.action === "agent_run.cancelled")!;
    const d = describeAudit(e);
    expect(`${d.subject ?? e.actorEmail} ${d.verb} ${d.object}`).toBe(`owner@acme.io cancelled a run on ${taskRef}`);
  });
});

describe("MCP agent_run_cancel", () => {
  it("is listed, cancels, is idempotent and follows the same rules", async () => {
    const run = await queue();
    const mcp = await mcpFor(wsKey);
    expect((await mcp.listTools()).tools.map((t) => t.name)).toContain("agent_run_cancel");
    const got = data(await mcp.callTool({ name: "agent_run_cancel", arguments: { runId: run.id, reason: "From MCP" } }));
    expect(got.run).toMatchObject({ id: run.id, status: "cancelled", result: "From MCP" });
    expect(data(await mcp.callTool({ name: "agent_run_cancel", arguments: { runId: run.id } })).run.status).toBe("cancelled");
    expect(cancels()).toHaveLength(1);
    await mcp.close();
    // Another agent is refused; the read only key is refused; the own agent can.
    const r2 = (await v1(builder.key, "POST", `/tasks/${taskId}/runs`, {})).body.run;
    const qaMcp = await mcpFor(qa.key);
    const refused = await qaMcp.callTool({ name: "agent_run_cancel", arguments: { runId: r2.id } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/own runs/);
    await qaMcp.close();
    const ro = await mcpFor(readKey);
    expect((await ro.callTool({ name: "agent_run_cancel", arguments: { runId: r2.id } })).isError).toBe(true);
    await ro.close();
    const own = await mcpFor(builder.key);
    expect(data(await own.callTool({ name: "agent_run_cancel", arguments: { runId: r2.id } })).run.status).toBe("cancelled");
    // A finished run is refused.
    const r3 = (await v1(builder.key, "POST", `/tasks/${taskId}/runs`, {})).body.run;
    await v1(builder.key, "POST", `/runs/${r3.id}/finish`, { status: "failed" });
    const fin = await own.callTool({ name: "agent_run_cancel", arguments: { runId: r3.id } });
    expect(fin.isError).toBe(true);
    expect(text(fin)).toMatch(/already failed|run_finished/);
    await own.close();
  });
});

describe("the run detail's optimistic cancel (web helpers)", () => {
  const run = (id: string, status: AgentRun["status"]) => ({ id, status, finishedAt: null, steps: [{ at: "x", kind: "note", text: "a" }] }) as unknown as AgentRun;
  it("marks only a live run cancelled, keeps the rest, and the server answer replaces it", () => {
    const data = { runs: [run("a", "queued"), run("b", "running"), run("c", "succeeded")] };
    const next = withRunCancelled(data, "a", "2026-10-26T04:00:00.000Z")!;
    expect(next.runs.map((r) => r.status)).toEqual(["cancelled", "running", "succeeded"]);
    expect(next.runs[0].finishedAt).toBe("2026-10-26T04:00:00.000Z");
    expect(data.runs[0].status).toBe("queued"); // the rollback copy is untouched
    expect(withRunCancelled(data, "c")!.runs[2].status).toBe("succeeded");
    expect(withRunCancelled(undefined, "a")).toBeUndefined();
    const replaced = withRun(next, { ...run("a", "cancelled"), result: "Duplicate" } as AgentRun)!;
    expect(replaced.runs[0]).toMatchObject({ status: "cancelled", result: "Duplicate" });
    expect([canCancelRun({ status: "queued" }), canCancelRun({ status: "running" }), canCancelRun({ status: "cancelled" }), canCancelRun({ status: "failed" })]).toEqual([true, true, false, false]);
  });
});
