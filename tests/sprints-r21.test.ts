import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { addToSprint, burndownFor, completeSprint, createSprint, getSprint, removeFromSprint, startSprint } from "@/server/services/suite/sprints";
import { createTask, updateTask } from "@/server/services/suite/tasks";
import type { SuiteActor } from "@/server/services/suite/common";
import { sprints } from "@/server/db/schema";
import { eq } from "drizzle-orm";

type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
let ctx: Ctx;
let c: Client;
let actor: SuiteActor;
let projectId: string;

const at = (iso: string) => { ctx.deps.now = () => new Date(iso); };

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io");
  const me = (await c.get("/api/account/me")).body;
  actor = { orgId: me.organization.id, userId: me.user.id, email: me.user.email, name: me.user.name, role: "owner" };
  projectId = (await c.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id;
});

async function task(title: string, points?: number | null, sprintId?: string) {
  return createTask(ctx.deps, actor, { title, projectId, points, sprintId });
}

describe("sprints: plan, start, complete", () => {
  it("plans sprints back to back, starts one at a time and refuses a sprint that ends before it starts", async () => {
    const s1 = (await c.post("/api/sprints", { projectId, startAt: "2026-11-02", endAt: "2026-11-15T23:59:59Z", goal: "Ship beta" })).body.sprint;
    expect(s1.name).toBe("Sprint 1");
    expect(s1.status).toBe("planned");
    const s2 = (await c.post("/api/sprints", { projectId })).body.sprint;
    // The next sprint starts the day after the previous one ends and runs two weeks.
    expect(s2.startAt).toBe("2026-11-16T00:00:00.000Z");
    expect(s2.endAt).toBe("2026-11-29T23:59:59.999Z");
    expect(s2.name).toBe("Sprint 2");
    const bad = await c.post("/api/sprints", { projectId, startAt: "2026-12-10", endAt: "2026-12-01" });
    expect(bad.status).toBe(422);
    expect((await c.patch(`/api/sprints/${s1.id}`, { endAt: "2026-11-01" })).status).toBe(422);
    expect((await c.post(`/api/sprints/${s1.id}/start`)).body.sprint.status).toBe("active");
    const second = await c.post(`/api/sprints/${s2.id}/start`);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("sprint_already_active");
    expect((await c.post(`/api/sprints/${s1.id}/start`)).status).toBe(409);
    const list = (await c.get(`/api/sprints?projectId=${projectId}`)).body;
    expect(list.unit).toBe("points");
    expect(list.sprints.map((s: { status: string }) => s.status)).toEqual(["active", "planned"]);
  });

  it("carries unfinished tasks to the next planned sprint, keeps done ones and records the count", async () => {
    const s1 = (await c.post("/api/sprints", { projectId })).body.sprint;
    const s2 = (await c.post("/api/sprints", { projectId, name: "Polish" })).body.sprint;
    const a = (await c.post("/api/tasks", { title: "Design", projectId, points: 3 })).body.task;
    const b = (await c.post("/api/tasks", { title: "Build", projectId, points: 5 })).body.task;
    const d = (await c.post("/api/tasks", { title: "Docs", projectId })).body.task;
    expect((await c.post(`/api/sprints/${s1.id}/tasks`, { taskIds: [a.id, b.id, "LAU-3"] })).body.moved).toBe(3);
    expect((await c.get(`/api/sprints/backlog?projectId=${projectId}`)).body.tasks).toHaveLength(0);
    await c.post(`/api/sprints/${s1.id}/start`);
    await c.patch(`/api/tasks/${a.id}`, { status: "done" });
    const done = await c.post(`/api/sprints/${s1.id}/complete`, { carryOver: "next" });
    expect(done.status).toBe(200);
    expect(done.body.carriedOver).toBe(2);
    expect(done.body.carriedTo.sprint.id).toBe(s2.id);
    const one = (await c.get(`/api/sprints/${s1.id}`)).body;
    expect(one.sprint.status).toBe("completed");
    expect(one.sprint.carriedOver).toBe(2);
    expect(one.tasks.map((t: { id: string }) => t.id)).toEqual([a.id]);
    const two = (await c.get(`/api/sprints/${s2.id}`)).body;
    expect(two.tasks.map((t: { id: string }) => t.id).sort()).toEqual([b.id, d.id].sort());
    // A completed sprint takes no more tasks and can't be completed again.
    expect((await c.post(`/api/sprints/${s1.id}/tasks`, { taskIds: [b.id] })).status).toBe(409);
    expect((await c.post(`/api/sprints/${s1.id}/complete`, {})).status).toBe(409);
    expect((await c.patch(`/api/tasks/${b.id}`, { sprintId: s1.id })).status).toBe(409);
  });

  it("makes a next sprint when none is planned, or sends unfinished work back to the backlog", async () => {
    const s1 = (await c.post("/api/sprints", { projectId })).body.sprint;
    const x = await task("Left over", 2, s1.id);
    await c.post(`/api/sprints/${s1.id}/start`);
    const r = (await c.post(`/api/sprints/${s1.id}/complete`, { carry_over: "next" })).body;
    expect(r.carriedTo.type).toBe("sprint");
    expect(r.carriedTo.sprint.name).toBe("Sprint 2");
    expect(r.carriedTo.sprint.startAt > s1.endAt).toBe(true);
    const s2 = r.carriedTo.sprint;
    await c.post(`/api/sprints/${s2.id}/start`);
    const back = (await c.post(`/api/sprints/${s2.id}/complete`, { carryOver: "backlog" })).body;
    expect(back.carriedTo).toEqual({ type: "backlog" });
    expect(back.carriedOver).toBe(1);
    const bl = (await c.get(`/api/sprints/backlog?projectId=${projectId}`)).body.tasks;
    expect(bl.map((t: { id: string }) => t.id)).toEqual([x.id]);
    expect(bl[0].sprintId).toBeNull();
    expect(bl[0].points).toBe(2);
  });

  it("validates estimates and keeps sprints inside their project", async () => {
    const s1 = (await c.post("/api/sprints", { projectId })).body.sprint;
    const other = (await c.post("/api/projects", { name: "Other", key: "OTH" })).body.project.id;
    const t = (await c.post("/api/tasks", { title: "Elsewhere", projectId: other })).body.task;
    expect((await c.post(`/api/sprints/${s1.id}/tasks`, { taskIds: [t.id] })).status).toBe(422);
    expect((await c.patch(`/api/tasks/${t.id}`, { sprintId: s1.id })).status).toBe(422);
    expect((await c.patch(`/api/tasks/${t.id}`, { points: -1 })).status).toBe(422);
    expect((await c.patch(`/api/tasks/${t.id}`, { points: 2.5 })).body.task.points).toBe(2.5);
    expect((await c.post(`/api/sprints/${s1.id}/tasks`, { taskIds: Array.from({ length: 501 }, (_, i) => `t${i}`) })).status).toBe(422);
    // Moving a task to another project takes it out of its sprint.
    const u = await task("Mover", 1, s1.id);
    const moved = (await c.patch(`/api/tasks/${u.id}`, { projectId: other })).body.task;
    expect(moved.sprintId).toBeNull();
    expect((await c.put("/api/sprints/estimate-unit", { projectId, unit: "hours" })).body.unit).toBe("hours");
    expect((await c.get(`/api/sprints?projectId=${projectId}`)).body.unit).toBe("hours");
  });
});

describe("burndown", () => {
  it("follows a partial sprint: a task done on day 2, one added mid sprint, a re-estimate, a bulk add and a removal", async () => {
    at("2026-11-01T08:00:00Z");
    const s = await createSprint(ctx.deps, actor, projectId, { startAt: "2026-11-02T00:00:00Z", endAt: "2026-11-06T23:59:59Z" });
    const a = await task("A", 3, s.id);
    const b = await task("B", 5, s.id);
    const cc = await task("C", 2, s.id);
    const d = await task("D", 4);
    const e = await task("E", 1);
    at("2026-11-02T09:00:00Z");
    await startSprint(ctx.deps, actor, s.id);
    at("2026-11-03T10:00:00Z");
    await updateTask(ctx.deps, actor, a.id, { status: "done" });
    at("2026-11-04T11:00:00Z");
    await updateTask(ctx.deps, actor, d.id, { sprintId: s.id });
    at("2026-11-04T12:00:00Z");
    await updateTask(ctx.deps, actor, b.id, { points: 8 });
    at("2026-11-05T09:00:00Z");
    await addToSprint(ctx.deps, actor, s.id, [e.id]);
    await removeFromSprint(ctx.deps, actor, s.id, [cc.id]);
    at("2026-11-05T15:00:00Z");
    const row = (await ctx.db.select().from(sprints).where(eq(sprints.id, s.id)).get())!;
    const bd = await burndownFor(ctx.deps, actor, row, { timeZone: "UTC" });
    expect(bd.unit).toBe("points");
    expect(bd.start).toBe(10);
    expect(bd.days.map((x) => x.date)).toEqual(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"]);
    expect(bd.days.map((x) => x.remaining)).toEqual([10, 7, 14, 13, null]);
    expect(bd.days.map((x) => x.ideal)).toEqual([8, 6, 4, 2, 0]);
    expect(bd.scope).toBe(16); // A 3 (done), B 8, D 4, E 1
    expect(bd.done).toBe(3);
    expect(bd.remaining).toBe(13);
    // Completing freezes the chart in the sprint row; later task changes don't move it.
    at("2026-11-06T18:00:00Z");
    await updateTask(ctx.deps, actor, b.id, { status: "done" });
    await completeSprint(ctx.deps, actor, s.id, { carryOver: "backlog", timeZone: "UTC" });
    await updateTask(ctx.deps, actor, a.id, { points: 20 });
    const frozen = (await getSprint(ctx.deps, actor, s.id)).burndown;
    expect(frozen.days.map((x) => x.remaining)).toEqual([10, 7, 14, 13, 5]);
  });

  it("counts tasks when nothing is estimated", async () => {
    at("2026-11-02T01:00:00Z");
    const s = await createSprint(ctx.deps, actor, projectId, { startAt: "2026-11-02T00:00:00Z", endAt: "2026-11-04T23:00:00Z" });
    const a = await task("A", null, s.id);
    await task("B", null, s.id);
    await startSprint(ctx.deps, actor, s.id);
    at("2026-11-03T05:00:00Z");
    await updateTask(ctx.deps, actor, a.id, { status: "done" });
    const bd = (await getSprint(ctx.deps, actor, s.id, { timeZone: "UTC" })).burndown;
    expect(bd.unit).toBe("tasks");
    expect(bd.days.map((x) => x.remaining)).toEqual([2, 1, null]);
  });

  it("draws day lines in the person's zone: done at 23:30 local is that day, 00:30 the next", async () => {
    // Sydney is UTC+11 in November. 2 November local midnight is 1 November 13:00 UTC.
    at("2026-11-01T13:00:00Z");
    const s = await createSprint(ctx.deps, actor, projectId, { startAt: "2026-11-01T13:00:00Z", endAt: "2026-11-05T12:59:59Z" });
    const x = await task("Late night", 1, s.id);
    const y = await task("Just after midnight", 1, s.id);
    await startSprint(ctx.deps, actor, s.id);
    at("2026-11-03T12:30:00Z"); // 23:30 on 3 November in Sydney
    await updateTask(ctx.deps, actor, x.id, { status: "done" });
    at("2026-11-03T13:30:00Z"); // 00:30 on 4 November in Sydney, still 3 November in UTC
    await updateTask(ctx.deps, actor, y.id, { status: "done" });
    at("2026-11-04T20:00:00Z");
    const syd = (await getSprint(ctx.deps, actor, s.id, { timeZone: "Australia/Sydney" })).burndown;
    expect(syd.days.map((d) => d.date)).toEqual(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"]);
    expect(syd.days.map((d) => d.remaining)).toEqual([2, 1, 0, 0]);
    const utc = (await getSprint(ctx.deps, actor, s.id, { timeZone: "UTC" })).burndown;
    expect(utc.days.map((d) => d.date)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"]);
    expect(utc.days.map((d) => d.remaining)).toEqual([2, 2, 0, 0, null]);
  });
});

describe("permissions", () => {
  it("refuses another workspace's sprints and tasks, and read only keys can read but not write", async () => {
    const s = (await c.post("/api/sprints", { projectId })).body.sprint;
    const t = await task("Mine", 1);
    const other = new Client(ctx.app);
    await other.signup("other@else.io", "Bo", "Else");
    expect((await other.get(`/api/sprints/${s.id}`)).status).toBe(404);
    expect((await other.get(`/api/sprints?projectId=${projectId}`)).status).toBe(404);
    expect((await other.post(`/api/sprints/${s.id}/start`)).status).toBe(404);
    expect((await other.post("/api/sprints", { projectId })).status).toBe(404);
    const otherProject = (await other.post("/api/projects", { name: "Theirs" })).body.project.id;
    const os = (await other.post("/api/sprints", { projectId: otherProject })).body.sprint;
    expect((await other.post(`/api/sprints/${os.id}/tasks`, { taskIds: [t.id] })).status).toBe(404);
    expect((await c.patch(`/api/tasks/${t.id}`, { sprintId: os.id })).status).toBe(404);

    const ro = (await c.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret;
    const h = { authorization: `Bearer ${ro}` };
    const call = (method: string, path: string, body?: unknown) => ctx.app.request(path, { method, headers: { ...h, host: "localhost", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    expect((await call("GET", `/api/v1/projects/${projectId}/sprints`)).status).toBe(200);
    expect((await call("GET", `/api/v1/sprints/${s.id}`)).status).toBe(200);
    expect((await call("POST", `/api/v1/projects/${projectId}/sprints`, {})).status).toBe(403);
    expect((await call("POST", `/api/v1/sprints/${s.id}/start`, {})).status).toBe(403);
    expect((await call("POST", `/api/v1/sprints/${s.id}/tasks`, { taskIds: [t.id] })).status).toBe(403);
    expect((await call("PUT", `/api/v1/tasks/${t.id}/points`, { points: 3 })).status).toBe(403);

    const full = (await c.post("/api/developer/keys", { name: "full" })).body.secret;
    const fh = { authorization: `Bearer ${full}`, host: "localhost", "content-type": "application/json" };
    const made = await ctx.app.request(`/api/v1/projects/${projectId}/sprints`, { method: "POST", headers: fh, body: JSON.stringify({ name: "API sprint" }) });
    expect(made.status).toBe(201);
    const sid = ((await made.json()) as { sprint: { id: string } }).sprint.id;
    const added = await ctx.app.request(`/api/v1/sprints/${sid}/tasks`, { method: "POST", headers: fh, body: JSON.stringify({ taskIds: [t.id] }) });
    expect(((await added.json()) as { moved: number }).moved).toBe(1);
    const pts = await ctx.app.request(`/api/v1/tasks/${t.id}/points`, { method: "PUT", headers: fh, body: JSON.stringify({ points: 3 }) });
    expect(((await pts.json()) as { task: { points: number } }).task.points).toBe(3);
    const started = await ctx.app.request(`/api/v1/sprints/${sid}/start`, { method: "POST", headers: fh, body: "{}" });
    expect(started.status).toBe(200);
    const completed = await ctx.app.request(`/api/v1/sprints/${sid}/complete`, { method: "POST", headers: fh, body: JSON.stringify({ carry_over: "backlog" }) });
    expect(((await completed.json()) as { carriedOver: number }).carriedOver).toBe(1);
  });
});

describe("MCP: sprint tools", () => {
  async function mcpConnect(key: string) {
    const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
    const client = new McpClient({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
    return client;
  }
  const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);

  it("plans, fills, starts, reads and completes a sprint; a read only key can only read", async () => {
    const t1 = await task("One", 2);
    const t2 = await task("Two", 3);
    const key = (await c.post("/api/developer/keys", { name: "MCP" })).body.secret;
    const mcp = await mcpConnect(key);
    const names = (await mcp.listTools()).tools.map((x) => x.name);
    for (const n of ["list_sprints", "get_sprint", "create_sprint", "start_sprint", "complete_sprint", "add_to_sprint", "remove_from_sprint"]) expect(names).toContain(n);
    const s = data(await mcp.callTool({ name: "create_sprint", arguments: { projectId, goal: "Agent sprint" } })).sprint;
    expect(data(await mcp.callTool({ name: "add_to_sprint", arguments: { id: s.id, taskIds: [t1.id, "LAU-2"] } })).moved).toBe(2);
    expect(data(await mcp.callTool({ name: "remove_from_sprint", arguments: { id: s.id, taskIds: [t2.id] } })).moved).toBe(1);
    expect(data(await mcp.callTool({ name: "start_sprint", arguments: { id: s.id } })).sprint.status).toBe("active");
    const got = data(await mcp.callTool({ name: "get_sprint", arguments: { id: s.id, timeZone: "UTC" } }));
    expect(got.tasks).toHaveLength(1);
    expect(got.burndown.start).toBe(2);
    expect(data(await mcp.callTool({ name: "list_sprints", arguments: { projectId } })).sprints).toHaveLength(1);

    const ro = (await c.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret;
    const rmcp = await mcpConnect(ro);
    expect(data(await rmcp.callTool({ name: "get_sprint", arguments: { id: s.id } })).sprint.id).toBe(s.id);
    for (const [name, args] of [["create_sprint", { projectId }], ["start_sprint", { id: s.id }], ["complete_sprint", { id: s.id }], ["add_to_sprint", { id: s.id, taskIds: [t2.id] }], ["remove_from_sprint", { id: s.id, taskIds: [t1.id] }]] as const) {
      const r = await rmcp.callTool({ name, arguments: args });
      expect(r.isError).toBe(true);
      expect((r.content as { text: string }[])[0].text).toContain("read_only_key");
    }
    const done = data(await mcp.callTool({ name: "complete_sprint", arguments: { id: s.id, carryOver: "next" } }));
    expect(done.carriedOver).toBe(1);
    expect(done.carriedTo.type).toBe("sprint");
  });
});
