import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { findConflicts, planShift, span, type SchedTask } from "@/server/services/suite/dependency-schedule-r37";
import { toolScope } from "@/server/lib/api-scopes";

/** R37: dependencies that plan for you (finish to start clashes, and moving a task with the tasks that wait on it). */
const T = (id: string, start: string | null, due: string | null, status = "todo"): SchedTask => ({ id, start, due, status });

describe("schedule planner (pure)", () => {
  it("treats a one date task as one day", () => {
    expect(span(T("a", null, "2026-11-03"))).toEqual(span(T("a", "2026-11-03", null)));
    expect(span(T("a", null, null))).toBeNull();
  });

  it("finds a clash when the blocked task starts on or before the blocker's last day, with a fix", () => {
    const list = [T("a", "2026-11-02", "2026-11-05"), T("b", "2026-11-05", "2026-11-06"), T("c", "2026-11-06", "2026-11-07")];
    const c = findConflicts(list, [{ from: "a", to: "b" }, { from: "a", to: "c" }]);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ from: "a", to: "b", overlapDays: 1, fix: { taskId: "b", start: "2026-11-06", due: "2026-11-07" } });
  });

  it("ignores done tasks and undated tasks", () => {
    const list = [T("a", "2026-11-02", "2026-11-05", "done"), T("b", "2026-11-03", "2026-11-04"), T("c", null, null)];
    expect(findConflicts(list, [{ from: "a", to: "b" }, { from: "b", to: "c" }])).toEqual([]);
  });

  it("pushes the whole chain later by just enough and keeps each length", () => {
    const list = [T("a", "2026-11-02", "2026-11-04"), T("b", "2026-11-05", "2026-11-07"), T("c", "2026-11-08", "2026-11-08"), T("x", "2026-12-01", "2026-12-02")];
    const links = [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "a", to: "x" }];
    const plan = planShift(list, links, "a", { start: "2026-11-04", due: "2026-11-06" });
    expect(plan[0]).toMatchObject({ id: "a", to: { start: "2026-11-04", due: "2026-11-06" }, days: 2 });
    expect(plan.slice(1)).toEqual([
      { id: "b", from: { start: "2026-11-05", due: "2026-11-07" }, to: { start: "2026-11-07", due: "2026-11-09" }, days: 2 },
      { id: "c", from: { start: "2026-11-08", due: "2026-11-08" }, to: { start: "2026-11-10", due: "2026-11-10" }, days: 2 },
    ]); // x already starts well after: it stays
  });

  it("never pulls tasks earlier, and waits for the latest of several blockers", () => {
    const list = [T("a", "2026-11-02", "2026-11-04"), T("b", "2026-11-02", "2026-11-09"), T("c", "2026-11-10", "2026-11-11")];
    const links = [{ from: "a", to: "c" }, { from: "b", to: "c" }];
    expect(planShift(list, links, "a", { start: "2026-10-20", due: "2026-10-21" }).slice(1)).toEqual([]);
    const later = planShift(list, links, "a", { start: "2026-11-08", due: "2026-11-12" });
    expect(later.slice(1)).toEqual([{ id: "c", from: { start: "2026-11-10", due: "2026-11-11" }, to: { start: "2026-11-13", due: "2026-11-14" }, days: 3 }]);
  });

  it("leaves done tasks where they are", () => {
    const list = [T("a", "2026-11-02", "2026-11-04"), T("b", "2026-11-05", "2026-11-06", "done")];
    expect(planShift(list, [{ from: "a", to: "b" }], "a", { start: "2026-11-05", due: "2026-11-08" }).slice(1)).toEqual([]);
  });

  it("refuses a move that would shift more than 50 tasks", () => {
    const list = Array.from({ length: 60 }, (_, i) => T(`t${i}`, "2026-11-02", "2026-11-02"));
    const links = list.slice(1).map((t, i) => ({ from: `t${i}`, to: t.id }));
    expect(() => planShift(list, links, "t0", { start: "2026-11-03", due: "2026-11-03" })).toThrow(/more than 50/);
  });

  it("needs tasks scope for both MCP tools", () => {
    expect(toolScope("check_task_schedule", true)).toBe("tasks:read");
    expect(toolScope("reschedule_task", false)).toBe("tasks:write");
  });
});

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let project: string;
let key: string;
const mk = async (title: string, start: string | null, due: string | null) => (await c.post("/api/tasks", { projectId: project, title, start, due })).body.task;
async function v1(method: string, path: string, body?: unknown, k = key) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${k}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@plan.test");
  project = (await c.post("/api/projects", { name: "Launch", key: "LCH" })).body.project.id;
  key = (await c.post("/api/developer/keys", { name: "rw" })).body.secret;
});

describe("schedule along dependencies (API)", () => {
  it("checks clashes, previews a move without writing, then moves the chain", async () => {
    const design = await mk("Design", "2026-11-02", "2026-11-04");
    const build = await mk("Build", "2026-11-05", "2026-11-09");
    const ship = await mk("Ship", "2026-11-10", "2026-11-10");
    await c.post(`/api/tasks/${build.id}/dependencies`, { blockedBy: design.id });
    await c.post(`/api/tasks/${ship.id}/dependencies`, { blockedBy: build.id });

    let check = await c.get(`/api/tasks/dependencies/check?projectId=${project}`);
    expect(check.status).toBe(200);
    expect(check.body.links).toHaveLength(2);
    expect(check.body.conflicts).toEqual([]);

    const preview = await c.post(`/api/tasks/${design.id}/reschedule`, { start: "2026-11-03", due: "2026-11-06", preview: true });
    expect(preview.status).toBe(200);
    expect(preview.body.preview).toBe(true);
    expect(preview.body.moved.map((m: { ref: string; days: number }) => [m.ref, m.days])).toEqual([["LCH-2", 2], ["LCH-3", 2]]);
    expect((await c.get(`/api/tasks/${build.id}`)).body.task.start.slice(0, 10)).toBe("2026-11-05"); // nothing written

    const done = await c.post(`/api/tasks/${design.id}/reschedule`, { start: "2026-11-03", due: "2026-11-06" });
    expect(done.status).toBe(200);
    expect(done.body.task.due.slice(0, 10)).toBe("2026-11-06");
    const b = (await c.get(`/api/tasks/${build.id}`)).body.task, s = (await c.get(`/api/tasks/${ship.id}`)).body.task;
    expect([b.start.slice(0, 10), b.due.slice(0, 10), s.start.slice(0, 10), s.due.slice(0, 10)]).toEqual(["2026-11-07", "2026-11-11", "2026-11-12", "2026-11-12"]);

    // Only this one: the clash then shows up in the check, with the fix that clears it.
    await c.post(`/api/tasks/${design.id}/reschedule`, { due: "2026-11-08", moveDependents: false });
    check = await c.get(`/api/tasks/dependencies/check`);
    expect(check.body.conflicts).toHaveLength(1);
    expect(check.body.conflicts[0]).toMatchObject({ blocker: { ref: "LCH-1" }, blocked: { ref: "LCH-2" }, overlapDays: 2, fix: { taskId: build.id, start: "2026-11-09", due: "2026-11-13" } });
  });

  it("refuses a due date before the start, and an unknown task", async () => {
    const t = await mk("Alone", "2026-11-05", "2026-11-06");
    expect((await c.post(`/api/tasks/${t.id}/reschedule`, { due: "2026-11-01" })).status).toBe(422);
    expect((await c.post(`/api/tasks/nope/reschedule`, { due: "2026-11-01" })).status).toBe(404);
  });

  it("works over /api/v1 with scopes: read only keys can preview but not move", async () => {
    const a = await mk("A", "2026-11-02", "2026-11-03");
    const b = await mk("B", "2026-11-04", "2026-11-04");
    await c.post(`/api/tasks/${b.id}/dependencies`, { blockedBy: a.id });
    const check = await v1("GET", `/tasks/dependencies/check?projectId=${project}`);
    expect(check.status).toBe(200);
    expect(check.body.links).toHaveLength(1);
    const moved = await v1("POST", `/tasks/LCH-1/reschedule`, { due: "2026-11-05" });
    expect(moved.status).toBe(200);
    expect(moved.body.moved).toEqual([expect.objectContaining({ ref: "LCH-2", to: { start: "2026-11-06", due: "2026-11-06" }, days: 2 })]);
    const ro = (await c.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret;
    expect((await v1("POST", `/tasks/LCH-1/reschedule`, { due: "2026-11-09" }, ro)).status).toBe(403);
    expect((await v1("GET", `/tasks/dependencies/check`, undefined, ro)).status).toBe(200);
  });

  it("works over MCP: check_task_schedule and reschedule_task", async () => {
    const a = await mk("A", "2026-11-02", "2026-11-03");
    const b = await mk("B", "2026-11-03", "2026-11-04");
    await c.post(`/api/tasks/${b.id}/dependencies`, { blockedBy: a.id });
    const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
    const mcp = new McpClient({ name: "t", version: "1" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
    const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
    const check = data(await mcp.callTool({ name: "check_task_schedule", arguments: { projectId: project } }));
    expect(check.conflicts).toHaveLength(1);
    expect(check.conflicts[0].fix).toEqual({ taskId: b.id, start: "2026-11-04", due: "2026-11-05" });
    const fixed = data(await mcp.callTool({ name: "reschedule_task", arguments: { taskId: "LCH-2", start: "2026-11-04", due: "2026-11-05" } }));
    expect(fixed.task).toMatchObject({ ref: "LCH-2" });
    expect(data(await mcp.callTool({ name: "check_task_schedule", arguments: {} })).conflicts).toEqual([]);
  });
});
