import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client, d1Violations } from "./helpers";
import { describeAudit } from "../src/web/components/app-bits";
import { runDuration } from "../src/web/pages/app/work/task-runs";

/** R27 (DF-3 slice 2): AI agent members run tasks themselves, with a run log on the task and in the audit log. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let projectId: string;
let taskId: string;
let taskRef: string;
let wsKey: string;
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
const client = () => (ctx.db as unknown as { $client: { prepare: (q: string) => { all: (...a: unknown[]) => unknown[]; run: (...a: unknown[]) => unknown } } }).$client;
const raw = (q: string, ...a: unknown[]) => client().prepare(q).all(...a);
const agent = async (name: string) => {
  const made = (await c.post("/api/team/agents", { name })).body;
  return { id: made.member.userId as string, key: made.secret as string };
};

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
});

describe("agent runs: the happy path", () => {
  it("starts, logs steps, finishes with a comment and done, and both ends are audited in plain words", async () => {
    const start = await v1(builder.key, "POST", `/tasks/${taskRef}/runs`, { moveToDoing: true, note: "Reading the task" });
    expect(start.status).toBe(201);
    const run = start.body.run;
    expect(run).toMatchObject({ taskId, status: "running", stepCount: 1, agent: { userId: builder.id, name: "Builder", isAgent: true }, task: { ref: taskRef } });
    expect((await c.get(`/api/tasks/${taskId}`)).body.task.status).toBe("doing");
    expect((await v1(builder.key, "POST", `/runs/${run.id}/steps`, { kind: "tool", text: "ran npm test: 12 passed" })).status).toBe(201);
    expect((await v1(builder.key, "POST", `/runs/${run.id}/steps`, { kind: "status_change", text: "tests green" })).body.stepCount).toBe(3);
    const fin = await v1(builder.key, "POST", `/runs/${run.id}/finish`, { status: "succeeded", result: "Filter fixed, test added.", moveTo: "done", comment: true });
    expect(fin.status).toBe(200);
    expect(fin.body.run).toMatchObject({ status: "succeeded", result: "Filter fixed, test added.", stepCount: 3 });
    expect(fin.body.run.durationMs).toBeGreaterThanOrEqual(0);
    expect(fin.body.run.steps.map((s: { kind: string }) => s.kind)).toEqual(["note", "tool", "status_change"]);
    expect(fin.body.comment).toMatchObject({ body: "Filter fixed, test added.", author: { name: "Builder" } });
    expect((await c.get(`/api/tasks/${taskId}`)).body.task.status).toBe("done");
    // The app reads the runs on the task panel; REST reads one run.
    const list = (await c.get(`/api/tasks/${taskId}/runs`)).body;
    expect(list.runs).toHaveLength(1);
    expect((await v1(wsKey, "GET", `/runs/${run.id}`)).body.run.steps).toHaveLength(3);
    const audits = raw("select action, target_id, metadata from audit_logs where action like 'agent_run.%' order by created_at") as { action: string; target_id: string; metadata: string }[];
    expect(audits.map((x) => x.action)).toEqual(["agent_run.started", "agent_run.finished"]);
    expect(JSON.parse(audits[0].metadata)).toMatchObject({ agentName: "Builder", agentUserId: builder.id, taskRef, runId: run.id });
    expect(audits[1].target_id).toBe(taskId);
    const page = (await c.get("/api/org/audit")).body.entries as { action: string }[];
    expect(page.filter((e) => e.action.startsWith("agent_run.")).length).toBe(2);
    // After it finished, a new run can start.
    expect((await v1(builder.key, "POST", `/tasks/${taskId}/runs`, {})).status).toBe(201);
  });

  it("moves the task to the review status when asked", async () => {
    const run = (await v1(builder.key, "POST", `/tasks/${taskId}/runs`, {})).body.run;
    await v1(builder.key, "POST", `/runs/${run.id}/finish`, { status: "succeeded", result: "Ready for a look", moveTo: "review" });
    expect((await c.get(`/api/tasks/${taskId}`)).body.task.statusName).toBe("In review");
  });
});

describe("agent runs: who may run", () => {
  it("refuses a workspace key without an agent, a read key, a non agent target and a person as the agent", async () => {
    expect((await v1(wsKey, "POST", `/tasks/${taskId}/runs`, {})).status).toBe(422);
    const readKey = (await c.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret;
    expect((await v1(readKey, "POST", `/tasks/${taskId}/runs`, { agentUserId: builder.id })).status).toBe(403);
    expect((await v1(wsKey, "POST", `/tasks/${taskId}/runs`, { agentUserId: "usr_not_an_agent" })).status).toBe(422);
    // A person can't start a run as themselves: they are not an agent member.
    const owner = (raw("select user_id from members where kind = 'human'") as { user_id: string }[])[0].user_id;
    expect((await c.post(`/api/tasks/${taskId}/runs`, { agentUserId: owner })).status).toBe(422);
  });

  it("refuses an agent that is neither assigned nor mentioned, and the wrong agent on someone else's run", async () => {
    const r = await v1(qa.key, "POST", `/tasks/${taskId}/runs`, {});
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("agent_not_on_task");
    const run = (await v1(builder.key, "POST", `/tasks/${taskId}/runs`, {})).body.run;
    expect((await v1(qa.key, "POST", `/runs/${run.id}/steps`, { text: "not mine" })).status).toBe(403);
    expect((await v1(qa.key, "POST", `/runs/${run.id}/finish`, { status: "succeeded" })).status).toBe(403);
    expect((await v1(builder.key, "POST", `/tasks/${taskId}/runs`, { agentUserId: qa.id })).status).toBe(403);
  });

  it("lets a mentioned agent run, and a queued run be claimed by its agent", async () => {
    await c.post(`/api/tasks/${taskId}/comments`, { body: "@QA can you check this?" });
    const qaRun = await v1(qa.key, "POST", `/tasks/${taskId}/runs`, {});
    expect(qaRun.status).toBe(201);
    // A person queues a run for an unassigned agent on another task: the explicit allowance.
    const other = (await c.post("/api/tasks", { title: "Write the release note", projectId })).body.task.id;
    const queued = await c.post(`/api/tasks/${other}/runs`, { agentUserId: builder.id });
    expect(queued.status).toBe(201);
    expect(queued.body.run.status).toBe("queued");
    expect((await c.post(`/api/tasks/${other}/runs`, { agentUserId: builder.id })).status).toBe(409);
    const claimed = await v1(builder.key, "POST", `/tasks/${other}/runs`, { note: "on it" });
    expect(claimed.status).toBe(201);
    expect(claimed.body.run).toMatchObject({ id: queued.body.run.id, status: "running", stepCount: 1 });
    expect((raw("select action from audit_logs where action like 'agent_run.%' order by created_at") as { action: string }[]).map((x) => x.action))
      .toEqual(["agent_run.started", "agent_run.queued", "agent_run.started"]);
  });

  it("people and workspace keys can cancel but not finish; a paused agent is refused", async () => {
    const run = (await v1(builder.key, "POST", `/tasks/${taskId}/runs`, {})).body.run;
    expect((await v1(wsKey, "POST", `/runs/${run.id}/finish`, { status: "succeeded" })).status).toBe(403);
    const cancel = await c.post(`/api/agent-runs/${run.id}/cancel`);
    expect(cancel.status).toBe(200);
    expect(cancel.body.run.status).toBe("cancelled");
    expect((await v1(builder.key, "POST", `/runs/${run.id}/steps`, { text: "late" })).status).toBe(409);
    expect((await v1(builder.key, "POST", `/runs/${run.id}/finish`, { status: "succeeded" })).status).toBe(409);
    await c.patch(`/api/team/agents/${builder.id}`, { disabled: true });
    expect((await v1(builder.key, "POST", `/tasks/${taskId}/runs`, {})).status).toBe(401);
    expect((await c.post(`/api/tasks/${taskId}/runs`, { agentUserId: builder.id })).status).toBe(409);
  });

  it("another workspace sees nothing", async () => {
    const run = (await v1(builder.key, "POST", `/tasks/${taskId}/runs`, {})).body.run;
    const other = new Client(ctx.app);
    await other.signup("eve@else.io", "Eve Else");
    const evilKey = (await other.post("/api/developer/keys", { name: "x" })).body.secret;
    expect((await v1(evilKey, "GET", `/runs/${run.id}`)).status).toBe(404);
    expect((await v1(evilKey, "GET", `/tasks/${taskId}/runs`)).status).toBe(404);
    expect((await v1(evilKey, "POST", `/runs/${run.id}/finish`, { status: "cancelled" })).status).toBe(404);
  });
});

describe("agent runs: limits", () => {
  it("one running run per agent and task, step text and result length, and the 200 step cap", async () => {
    const run = (await v1(builder.key, "POST", `/tasks/${taskId}/runs`, {})).body.run;
    const again = await v1(builder.key, "POST", `/tasks/${taskId}/runs`, {});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("run_in_progress");
    expect((await v1(builder.key, "POST", `/runs/${run.id}/steps`, { text: "x".repeat(1001) })).status).toBe(422);
    expect((await v1(builder.key, "POST", `/runs/${run.id}/steps`, { kind: "dance", text: "x" })).status).toBe(422);
    expect((await v1(builder.key, "POST", `/runs/${run.id}/steps`, { text: "   " })).status).toBe(422);
    // Fill to the cap directly, then one more is refused.
    const steps = JSON.stringify(Array.from({ length: 199 }, (_, i) => ({ at: new Date().toISOString(), kind: "note", text: `s${i}` })));
    client().prepare("update agent_runs set steps = ?, step_count = 199 where id = ?").run(steps, run.id);
    expect((await v1(builder.key, "POST", `/runs/${run.id}/steps`, { text: "the 200th" })).status).toBe(201);
    const over = await v1(builder.key, "POST", `/runs/${run.id}/steps`, { text: "the 201st" });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe("run_step_limit");
    expect((await v1(builder.key, "GET", `/runs/${run.id}`)).body.run.steps).toHaveLength(200);
    expect((await v1(builder.key, "POST", `/runs/${run.id}/finish`, { status: "succeeded", result: "x".repeat(4001) })).status).toBe(422);
    expect((await v1(builder.key, "POST", `/runs/${run.id}/finish`, { status: "succeeded", comment: true })).status).toBe(422);
    expect((await v1(builder.key, "POST", `/runs/${run.id}/finish`, { status: "nope" })).status).toBe(422);
  });

  it("a step is one row write: the run row only, no index or activity row", async () => {
    const run = (await v1(builder.key, "POST", `/tasks/${taskId}/runs`, {})).body.run;
    const before = { act: raw("select count(*) n from activity"), aud: raw("select count(*) n from audit_logs") };
    await v1(builder.key, "POST", `/runs/${run.id}/steps`, { text: "one" });
    expect(raw("select count(*) n from activity")).toEqual(before.act);
    expect(raw("select count(*) n from audit_logs")).toEqual(before.aud);
  });

  it("lists runs across 150 tasks under D1's 100-variable limit", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 150; i++) ids.push(`tsk_bulk_${String(i).padStart(3, "0")}`);
    const now = Date.now();
    const pr = raw("select status_id from tasks where id = ?", taskId) as { status_id: string }[];
    for (const [i, id] of ids.entries()) {
      client().prepare("insert into tasks (id, org_id, project_id, number, title, status_id, status, position, created_at, updated_at, version, created_by_type) select ?, org_id, project_id, ?, ?, ?, 'todo', 0, ?, ?, 1, 'member' from tasks where id = ?")
        .run(id, 1000 + i, `Bulk ${i}`, pr[0].status_id, now, now, taskId);
      client().prepare("insert into agent_runs (id, org_id, task_id, agent_user_id, status, steps, step_count, created_at, updated_at) select ?, org_id, ?, ?, 'succeeded', '[]', 0, ?, ? from tasks where id = ?")
        .run(`run_bulk_${i}`, id, builder.id, now + i, now + i, taskId);
    }
    const all = await v1(wsKey, "GET", `/runs?agentUserId=${builder.id}&limit=200`);
    expect(all.status).toBe(200);
    expect(all.body.runs).toHaveLength(150);
    expect(all.body.runs[0].task.ref).toBe("MB-1149");
    expect(all.body.runs.every((r: { task: unknown; steps: unknown[] }) => r.task && r.steps.length === 0)).toBe(true);
    expect(d1Violations).toEqual([]);
    expect((await v1(wsKey, "GET", "/runs?status=nope")).status).toBe(422);
  });
});

describe("agent runs over MCP", () => {
  it("lists the four tools and runs a task end to end with the agent's key", async () => {
    const mcp = await mcpFor(builder.key);
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["start_task_run", "add_run_step", "finish_task_run", "list_task_runs"]));
    const run = data(await mcp.callTool({ name: "start_task_run", arguments: { taskId: taskRef } })).run;
    expect(run.status).toBe("running");
    const step = data(await mcp.callTool({ name: "add_run_step", arguments: { runId: run.id, kind: "tool", text: "opened the code" } }));
    expect(step.stepCount).toBe(1);
    const fin = data(await mcp.callTool({ name: "finish_task_run", arguments: { runId: run.id, status: "failed", result: "Needs a decision" } }));
    expect(fin.run.status).toBe("failed");
    const list = data(await mcp.callTool({ name: "list_task_runs", arguments: { taskId } }));
    expect(list.runs[0]).toMatchObject({ id: run.id, status: "failed", result: "Needs a decision" });
    const across = data(await mcp.callTool({ name: "list_task_runs", arguments: { agentUserId: builder.id } }));
    expect(across.runs).toHaveLength(1);
    await mcp.close();
  });

  it("refuses the wrong agent over MCP, and a read key can list but not start", async () => {
    const qaMcp = await mcpFor(qa.key);
    const r = await qaMcp.callTool({ name: "start_task_run", arguments: { taskId } });
    expect(r.isError).toBe(true);
    await qaMcp.close();
    const readKey = (await c.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret;
    const ro = await mcpFor(readKey);
    expect((await ro.callTool({ name: "start_task_run", arguments: { taskId, agentUserId: builder.id } })).isError).toBe(true);
    expect(data(await ro.callTool({ name: "list_task_runs", arguments: { taskId } })).runs).toEqual([]);
    await ro.close();
  });

  it("the openapi document has the run paths", async () => {
    const paths = Object.keys((await (await ctx.app.request("/api/v1/openapi.json")).json()).paths);
    expect(paths).toEqual(expect.arrayContaining(["/tasks/{id}/runs", "/runs", "/runs/{id}", "/runs/{id}/steps", "/runs/{id}/finish"]));
  });
});

describe("agent runs in the audit log page", () => {
  it("reads in plain words", async () => {
    const run = (await v1(builder.key, "POST", `/tasks/${taskId}/runs`, {})).body.run;
    await c.post(`/api/agent-runs/${run.id}/cancel`);
    const other = (await c.post("/api/tasks", { title: "Second", projectId })).body.task.id;
    await c.post(`/api/tasks/${other}/runs`, { agentUserId: qa.id });
    const entries = (await c.get("/api/org/audit")).body.entries as Parameters<typeof describeAudit>[0][];
    const words = entries.filter((e) => e.action.startsWith("agent_run.")).map((e) => { const d = describeAudit(e); return `${d.subject ?? e.actorEmail} ${d.verb} ${d.object}`; });
    expect(words).toEqual(expect.arrayContaining([
      `Builder started a run on ${taskRef}`,
      `owner@acme.io cancelled a run on ${taskRef}`, // R30: cancels are agent_run.cancelled
      "owner@acme.io queued a run on MB-2 for QA",
    ]));
    expect([runDuration(300), runDuration(4_000), runDuration(180_000), runDuration(3_900_000), runDuration(null)]).toEqual(["under 1 s", "4 s", "3 min", "1 h 5 min", ""]);
  });
});
