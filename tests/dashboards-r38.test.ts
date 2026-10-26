import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { createTask, updateTask } from "@/server/services/suite/tasks";
import { addEntry } from "@/server/services/suite/time";
import { createDashboard, dashboardData, WIDGET_TYPES, WidgetInput } from "@/server/services/suite/dashboards";
import { R38_WIDGET_TYPES } from "@/server/services/suite/dashboards-r38-schema";
import { tasks } from "@/server/db/schema";
import type { SuiteActor } from "@/server/services/suite/common";

/** R38 dashboard widgets: calculation, battery, pivot, created vs completed, task list, time tracked and note. */
type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
let ctx: Ctx;
let c: Client;
let actor: SuiteActor;
let me: string;
let mate: string;
let launch: string;
let support: string;
const NOW = "2026-11-04T02:00:00Z"; // a Wednesday

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  const body = (await c.get("/api/account/me")).body;
  actor = { orgId: body.organization.id, userId: body.user.id, email: body.user.email, name: body.user.name, role: "owner" };
  me = body.user.id;
  const invite = await c.post("/api/team/invites", { email: "max@acme.io", role: "member" });
  const m = new Client(ctx.app);
  await m.signup("max@acme.io", "Max Member", "");
  expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  mate = (await m.get("/api/account/me")).body.user.id;
  launch = (await c.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id;
  support = (await c.post("/api/projects", { name: "Support", key: "SUP" })).body.project.id;
  ctx.deps.now = () => new Date(NOW);
});

const olive = () => ({ type: "member" as const, id: me });
const maxA = () => ({ type: "member" as const, id: mate });
const task = (title: string, extra: Record<string, unknown> = {}) => createTask(ctx.deps, actor, { title, projectId: launch, ...extra });
const doneAt = async (id: string, at: string, points: number) => {
  ctx.deps.now = () => new Date(at); await updateTask(ctx.deps, actor, id, { status: "done" }); ctx.deps.now = () => new Date(NOW);
  await ctx.deps.db.update(tasks).set({ points }).where(eq(tasks.id, id));
};

/** 7 tasks in Launch and 2 in Support (as in R24), 3 done with points, and 3 hours of time. */
async function seed() {
  const o1 = await task("Overdue one", { due: "2026-10-28T10:00:00Z", priority: "high", assignee: olive() });
  await task("Overdue two", { due: "2026-11-03T10:00:00Z", assignee: maxA() });
  await task("Due Friday", { due: "2026-11-06T10:00:00Z", priority: "high", assignee: olive() });
  await task("Due next week", { due: "2026-11-10T10:00:00Z", assignee: maxA(), type: "bug" });
  await task("No date", { priority: "urgent" });
  const d1 = await task("Done last week", { assignee: olive() });
  const d2 = await task("Done this week", { assignee: maxA(), due: "2026-11-04T10:00:00Z" });
  await createTask(ctx.deps, actor, { title: "Support case", projectId: support, assignee: olive() });
  const d3 = await createTask(ctx.deps, actor, { title: "Old support", projectId: support });
  await doneAt(d1.id, "2026-10-29T12:00:00Z", 3);
  await doneAt(d2.id, "2026-11-03T12:00:00Z", 5);
  await doneAt(d3.id, "2026-09-16T12:00:00Z", 2); // the previous 30 days
  await addEntry(ctx.deps, actor, { taskId: o1.id, minutes: 90, startedAt: "2026-11-02T09:00:00Z" });
  await addEntry(ctx.deps, actor, { taskId: o1.id, minutes: 30, startedAt: "2026-11-03T09:00:00Z" });
  await addEntry(ctx.deps, actor, { taskId: d3.id, minutes: 60, startedAt: "2026-10-01T09:00:00Z" });
}

async function dataFor(widgets: WidgetInput[]) {
  const d = await createDashboard(ctx.deps, actor, { name: "R38", widgets });
  const r = await dashboardData(ctx.deps, actor, d.id, { tz: "UTC" });
  for (const x of r.widgets) expect(x.error).toBeNull();
  return { d, data: r.widgets.map((x) => x.data as Record<string, any>) }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe("R38 widget types: schema", () => {
  it("adds seven types and keeps only the settings each type uses", async () => {
    expect(WIDGET_TYPES).toEqual(expect.arrayContaining([...R38_WIDGET_TYPES]));
    expect(R38_WIDGET_TYPES).toHaveLength(7);
    const { d } = await dataFor([
      { type: "calculation", metric: "points", goal: 20, text: "dropped" },
      { type: "pivot", groupBy: "status", columnBy: "status" },
      { type: "note", text: "  Ship it  ", range: "7d" },
      { type: "task_list" },
      { type: "created_completed" },
    ]);
    expect(d.widgets[0]).toMatchObject({ title: "Points done", metric: "points", op: "sum", range: "30d", goal: 20, chart: "number", size: 1 });
    expect(d.widgets[0]).not.toHaveProperty("text");
    expect(d.widgets[1]).toMatchObject({ groupBy: "status", columnBy: "priority", size: 2, title: "Tasks by status and priority" });
    expect(d.widgets[2]).toMatchObject({ text: "Ship it", title: "Note" });
    expect(d.widgets[2]).not.toHaveProperty("range");
    expect(d.widgets[3]).toMatchObject({ sort: "due", title: "Tasks" });
    expect(d.widgets[4]).toMatchObject({ range: "30d", size: 2, title: "Created vs completed" });
    expect(WidgetInput.safeParse({ type: "note", text: "x".repeat(2001) }).success).toBe(false);
    expect(WidgetInput.safeParse({ type: "calculation", range: "1y" }).success).toBe(false);
    expect(WidgetInput.safeParse({ type: "pivot", columnBy: "label" }).success).toBe(false);
    expect(WidgetInput.safeParse({ type: "calculation", goal: -1 }).success).toBe(false);
  });
});

describe("R38 widget types: data on seeded tasks", () => {
  it("calculation: done, created, points and hours, with the change against the previous range and the goal", async () => {
    await seed();
    const { data } = await dataFor([
      { type: "calculation", metric: "done", goal: 4 },
      { type: "calculation", metric: "points" },
      { type: "calculation", metric: "hours" },
      { type: "calculation", metric: "created", range: "7d" },
      { type: "calculation", metric: "done", op: "avg", range: "7d" },
      { type: "calculation", metric: "done", source: { projectId: support } },
    ]);
    expect(data[0]).toMatchObject({ value: 2, previous: 1, change: 100, goal: 4, progress: 50, unit: "tasks" });
    expect(data[1]).toMatchObject({ value: 8, previous: 2, change: 300, unit: "points" });
    expect(data[2]).toMatchObject({ value: 2, previous: 1, change: 100, unit: "hours" });
    expect(data[3]).toMatchObject({ value: 9, previous: 0, change: null });
    expect(data[4]).toMatchObject({ value: 0.3, op: "avg" }); // 2 done in 7 days
    expect(data[5]).toMatchObject({ value: 0, previous: 1, change: -100 });
  });

  it("battery: one bar of done, in progress and to do with the done percent", async () => {
    await seed();
    const { data } = await dataFor([{ type: "battery", source: { projectId: launch } }, { type: "battery", source: { filters: { priority: "urgent" } } }]);
    expect(data[0]).toMatchObject({ total: 7, done: 2, donePercent: 29 });
    expect(data[0].segments.map((s: { key: string; count: number }) => `${s.key}:${s.count}`)).toEqual(["done:2", "doing:0", "todo:5"]);
    expect(data[1]).toMatchObject({ total: 1, done: 0, donePercent: 0 });
  });

  it("pivot: people by status with row and column totals, in one grouped read", async () => {
    await seed();
    const { data } = await dataFor([{ type: "pivot", groupBy: "assignee", columnBy: "status" }, { type: "pivot", groupBy: "project", columnBy: "priority" }]);
    const p = data[0];
    expect(p.total).toBe(9);
    expect(p.columns.map((x: { label: string; total: number }) => `${x.label}:${x.total}`)).toEqual(["To do:6", "Done:3"]);
    const row = (label: string) => p.rows.find((r: { label: string }) => r.label === label);
    expect(row("Olive Owner")).toMatchObject({ total: 4, cells: { todo: 3, done: 1 } });
    expect(row("Max Member")).toMatchObject({ total: 3, cells: { todo: 2, done: 1 } });
    expect(row("Unassigned")).toMatchObject({ total: 2, cells: { todo: 1, done: 1 } });
    expect(data[1].rows.map((r: { label: string; total: number }) => `${r.label}:${r.total}`)).toEqual(["Launch:7", "Support:2"]);
    expect(data[1].columns[0].label).toBe("Urgent");
  });

  it("created vs completed: days for 7 days, weeks for 90, with the net change", async () => {
    await seed();
    const { data } = await dataFor([{ type: "created_completed", range: "7d" }, { type: "created_completed", range: "90d" }]);
    expect(data[0]).toMatchObject({ bucket: "day", created: 9, completed: 2, net: 7 });
    expect(data[0].points).toHaveLength(7);
    expect(data[0].points[0]).toEqual({ start: "2026-10-29", created: 0, completed: 1 });
    expect(data[0].points[6]).toEqual({ start: "2026-11-04", created: 9, completed: 0 });
    expect(data[1]).toMatchObject({ bucket: "week", completed: 3 });
    expect(data[1].points).toHaveLength(13);
  });

  it("task list: sorted by priority, due or last change, at most 10, with the total", async () => {
    await seed();
    const { data } = await dataFor([{ type: "task_list", sort: "priority", source: { projectId: launch, filters: { status: "todo" } } }, { type: "task_list" }]);
    expect(data[0].total).toBe(5);
    expect(data[0].tasks.map((t: { title: string }) => t.title)).toEqual(["No date", "Overdue one", "Due Friday", "Overdue two", "Due next week"]);
    expect(data[0].tasks[1]).toMatchObject({ ref: "LAU-1", overdue: true, assignee: "Olive Owner", priority: "high" });
    expect(data[1].tasks[0].title).toBe("Overdue one");
    expect(data[1].total).toBe(9);
  });

  it("time tracked: hours per day in range and the top people; filters reach the entries through their tasks", async () => {
    await seed();
    const { data } = await dataFor([{ type: "time_tracked", range: "7d" }, { type: "time_tracked", range: "90d" }, { type: "time_tracked", source: { filters: { priority: "urgent" } } }]);
    expect(data[0]).toMatchObject({ bucket: "day", hours: 2 });
    expect(data[0].points.find((p: { start: string }) => p.start === "2026-11-02").hours).toBe(1.5);
    expect(data[0].people).toEqual([{ key: `member:${me}`, name: "Olive Owner", hours: 2 }]);
    expect(data[1]).toMatchObject({ bucket: "week", hours: 3 });
    expect(data[2]).toMatchObject({ hours: 0, people: [] });
  });

  it("note: shows its text and reads nothing", async () => {
    const { data } = await dataFor([{ type: "note", text: "Launch week: keep overdue at zero." }]);
    expect(data[0]).toEqual({ text: "Launch week: keep overdue at zero." });
  });
});

describe("R38 widget types: API and MCP", () => {
  it("a read only key reads every new type over v1; a full key adds them over v1 and MCP", async () => {
    await seed();
    const all: WidgetInput[] = R38_WIDGET_TYPES.map((type) => ({ type, ...(type === "note" ? { text: "Hi" } : {}) }));
    const d = (await c.post("/api/dashboards", { name: "All new", widgets: all })).body.dashboard;
    expect(d.widgets.map((x: { type: string }) => x.type)).toEqual([...R38_WIDGET_TYPES]);
    const ro = (await c.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret;
    const full = (await c.post("/api/developer/keys", { name: "full" })).body.secret;
    const h = (k: string) => ({ host: "localhost", authorization: `Bearer ${k}`, "content-type": "application/json" });
    const res = await ctx.app.request(`/api/v1/dashboards/${d.id}/data?tz=UTC`, { headers: h(ro) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { widgets: { type: string; error: string | null; data: Record<string, unknown> }[] };
    expect(body.widgets.every((x) => x.error === null)).toBe(true);
    expect(body.widgets[0].data).toMatchObject({ value: 2 });
    expect((await ctx.app.request(`/api/v1/dashboards/${d.id}/widgets`, { method: "POST", headers: h(ro), body: JSON.stringify({ type: "battery" }) })).status).toBe(403);
    const add = await ctx.app.request(`/api/v1/dashboards/${d.id}/widgets`, { method: "POST", headers: h(full), body: JSON.stringify({ type: "pivot", groupBy: "priority", columnBy: "type" }) });
    expect(add.status).toBe(201);
    expect(((await add.json()) as { dashboard: { widgets: { title: string }[] } }).dashboard.widgets.at(-1)!.title).toBe("Tasks by priority and type");
    expect((await ctx.app.request(`/api/v1/dashboards/${d.id}/widgets`, { method: "POST", headers: h(full), body: JSON.stringify({ type: "calculation", range: "2d" }) })).status).toBe(422);

    const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
    const m = new McpClient({ name: "test", version: "1.0.0" });
    await m.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${full}` } }, fetch: fetchViaApp }));
    const text = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content)[0].text);
    const cr = await m.callTool({ name: "create_dashboard", arguments: { name: "Agent", widgets: [{ type: "calculation", metric: "hours", range: "7d", goal: 4 }] } });
    expect(cr.isError).toBeFalsy();
    const id = text(cr).dashboard.id;
    const extra: Record<string, unknown>[] = [
      { type: "battery", projectId: launch }, { type: "pivot", groupBy: "assignee", columnBy: "priority" }, { type: "created_completed", range: "90d" },
      { type: "task_list", sort: "updated" }, { type: "time_tracked", range: "30d" }, { type: "note", text: "Agents wrote this" },
    ];
    for (const x of extra) expect((await m.callTool({ name: "add_dashboard_widget", arguments: { dashboardId: id, ...x } })).isError).toBeFalsy();
    const gd = text(await m.callTool({ name: "get_dashboard_data", arguments: { dashboardId: id, tz: "UTC" } }));
    expect(gd.widgets.map((x: { type: string }) => x.type)).toEqual([...R38_WIDGET_TYPES]);
    expect(gd.widgets[0].data).toMatchObject({ value: 2, progress: 50 });
    expect(gd.widgets[1].data).toMatchObject({ total: 7, done: 2 });
    expect(gd.widgets[6].data).toEqual({ text: "Agents wrote this" });
    expect((await m.callTool({ name: "add_dashboard_widget", arguments: { dashboardId: id, type: "note", text: "x".repeat(2001) } })).isError).toBe(true);
    await m.close();
  });
});
