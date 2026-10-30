import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { createTask, updateTask } from "@/server/services/suite/tasks";
import { createSprint, startSprint } from "@/server/services/suite/sprints";
import { createGoal } from "@/server/services/suite/goals";
import { createDashboard, dashboardData, MAX_DASHBOARDS, MAX_WIDGETS } from "@/server/services/suite/dashboards";
import type { SuiteActor } from "@/server/services/suite/common";

type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
let ctx: Ctx;
let c: Client;
let actor: SuiteActor;
let me: string;
let mate: { id: string; client: Client };
let launch: string;
let support: string;
const NOW = "2026-11-04T02:00:00Z"; // a Wednesday; weeks start Monday 2 November (UTC)

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
  mate = { id: (await m.get("/api/account/me")).body.user.id, client: m };
  launch = (await c.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id;
  support = (await c.post("/api/projects", { name: "Support", key: "SUP" })).body.project.id;
  ctx.deps.now = () => new Date(NOW);
});

const olive = () => ({ type: "member" as const, id: me });
const maxA = () => ({ type: "member" as const, id: mate.id });
const task = (title: string, extra: Record<string, unknown> = {}) => createTask(ctx.deps, actor, { title, projectId: launch, ...extra });
const doneAt = async (id: string, at: string) => { ctx.deps.now = () => new Date(at); await updateTask(ctx.deps, actor, id, { status: "done" }); ctx.deps.now = () => new Date(NOW); };
type Data = Awaited<ReturnType<typeof dashboardData>>;
const w = (d: Data, i: number) => d.widgets[i].data as Record<string, unknown> & { groups: { label: string; count: number }[] };
const groups = (d: Data, i: number) => Object.fromEntries(w(d, i).groups.map((g) => [g.label, g.count]));

/** The seed: 7 tasks in Launch and 2 in Support, two people, dates around the week of 2 November. */
async function seed() {
  await task("Overdue one", { due: "2026-10-28T10:00:00Z", priority: "high", assignee: olive(), labels: ["web"] });
  await task("Overdue two", { due: "2026-11-03T10:00:00Z", assignee: maxA(), labels: ["web", "api"] });
  await task("Due Friday", { due: "2026-11-06T10:00:00Z", priority: "high", assignee: olive() });
  await task("Due next week", { due: "2026-11-10T10:00:00Z", assignee: maxA(), type: "bug" });
  await task("No date", { priority: "urgent" });
  const d1 = await task("Done last week", { assignee: olive() });
  const d2 = await task("Done this week", { assignee: maxA(), due: "2026-11-04T10:00:00Z" });
  await createTask(ctx.deps, actor, { title: "Support case", projectId: support, assignee: olive(), labels: ["api"] });
  const d3 = await createTask(ctx.deps, actor, { title: "Old support", projectId: support });
  await doneAt(d1.id, "2026-10-29T12:00:00Z");
  await doneAt(d2.id, "2026-11-03T12:00:00Z");
  await doneAt(d3.id, "2026-09-16T12:00:00Z"); // 7 weeks back: the first week of 8
}

describe("dashboards: widget numbers on seeded data", () => {
  it("the starter dashboard answers by status, by person, due this week and completed per week", async () => {
    await seed();
    const res = await c.post("/api/dashboards", { starter: "team" });
    expect(res.status).toBe(201);
    const d = res.body.dashboard;
    expect(d.name).toBe("Team overview");
    expect(d.shared).toBe(true);
    expect(d.widgets.map((x: { type: string; groupBy: string | null }) => `${x.type}:${x.groupBy ?? ""}`)).toEqual(["breakdown:status", "breakdown:assignee", "due:", "completed:"]);
    const data = (await c.get(`/api/dashboards/${d.id}/data?tz=UTC`)).body as Data;
    expect(data.widgets.every((x) => x.error === null)).toBe(true);
    // 9 tasks: 3 done, 6 to do. Status names merge across projects.
    expect(w(data, 0).total).toBe(9);
    expect(groups(data, 0)).toEqual({ "To do": 6, Done: 3 });
    // Open tasks per person.
    expect(groups(data, 1)).toEqual({ "Olive Owner": 3, "Max Member": 2, Unassigned: 1 });
    const due = w(data, 2) as unknown as { overdue: number; dueThisWeek: number; tasks: { title: string; overdue: boolean; ref: string }[] };
    expect(due.overdue).toBe(2);
    expect(due.dueThisWeek).toBe(1);
    expect(due.tasks.map((t) => t.title)).toEqual(["Overdue one", "Overdue two", "Due Friday"]);
    expect(due.tasks[0]).toMatchObject({ ref: "LAU-1", overdue: true });
    const comp = w(data, 3) as unknown as { weeks: { week: string; count: number }[]; total: number };
    expect(comp.weeks).toHaveLength(8);
    expect(comp.weeks[0]).toEqual({ week: "2026-09-14", count: 1 });
    expect(comp.weeks.slice(-2)).toEqual([{ week: "2026-10-26", count: 1 }, { week: "2026-11-02", count: 1 }]);
    expect(comp.total).toBe(3);
    expect(data.weekStart).toBe("2026-11-02");
  });

  it("groups by priority, project, type, label and sprint, and counts with inline filters", async () => {
    await seed();
    const sp = await createSprint(ctx.deps, actor, launch, { name: "Sprint 1", startAt: "2026-11-02T00:00:00Z", endAt: "2026-11-13T00:00:00Z" });
    const t = await task("In the sprint", { sprintId: sp.id, points: 3 });
    void t;
    const d = await createDashboard(ctx.deps, actor, { name: "Mix", widgets: [
      { type: "breakdown", groupBy: "priority" },
      { type: "breakdown", groupBy: "project", chart: "donut" },
      { type: "breakdown", groupBy: "type" },
      { type: "breakdown", groupBy: "label" },
      { type: "breakdown", groupBy: "sprint", source: { projectId: launch } },
      { type: "count", source: { projectId: launch, filters: { status: "todo", priority: "high" } } },
      { type: "count", source: { filters: { assignee: "me", due: "overdue" } } },
      { type: "count", source: { filters: { label: "api" } } },
    ] });
    const data = await dashboardData(ctx.deps, actor, d.id, { tz: "UTC" });
    expect(groups(data, 0)).toEqual({ "No priority": 7, High: 2, Urgent: 1 });
    expect(groups(data, 1)).toEqual({ Launch: 8, Support: 2 });
    expect(groups(data, 2)).toEqual({ Task: 9, Bug: 1 });
    expect(groups(data, 3)).toEqual({ web: 2, api: 2, "No label": 7 });
    expect(groups(data, 4)).toEqual({ Backlog: 7, "Sprint 1": 1 });
    expect(w(data, 5).value).toBe(2);
    expect(w(data, 6).value).toBe(1);
    expect(w(data, 7)).toEqual({ value: 2, open: 2 });
  });

  it("applies a saved filter (its project and filters), alone or with inline filters on top", async () => {
    await seed();
    const view = (await c.post("/api/tasks/views", { name: "Urgent launch", view: "list", projectId: launch, filters: { priority: "high" } })).body;
    const viewId = (view.view ?? view).id as string;
    const mine = (await mate.client.post("/api/tasks/views", { name: "Max private", view: "list", filters: { assignee: `member:${mate.id}` } })).body;
    const d = await createDashboard(ctx.deps, actor, { name: "Saved", widgets: [
      { type: "count", source: { savedViewId: viewId } },
      { type: "count", source: { savedViewId: viewId, filters: { due: "overdue" } } },
      { type: "breakdown", groupBy: "assignee", source: { savedViewId: viewId } },
    ] });
    const data = await dashboardData(ctx.deps, actor, d.id, { tz: "UTC" });
    expect(w(data, 0).value).toBe(2);
    expect(w(data, 1).value).toBe(1);
    expect(groups(data, 2)).toEqual({ "Olive Owner": 2 });
    // Someone else's private saved view can't be used.
    await expect(createDashboard(ctx.deps, actor, { name: "x", widgets: [{ type: "count", source: { savedViewId: (mine.view ?? mine).id } }] })).rejects.toMatchObject({ status: 404 });
    // A saved view removed later: that widget says so, the others still answer.
    await c.del(`/api/tasks/views/${viewId}`);
    const after = await dashboardData(ctx.deps, actor, d.id, { tz: "UTC" });
    expect(after.widgets[0]).toMatchObject({ data: null, error: "This widget's saved filter was removed." });
  });

  it("sprint burndown, goal progress, workload, mail per day and reply times", async () => {
    const sp = await createSprint(ctx.deps, actor, launch, { name: "Sprint 1", startAt: "2026-11-02T00:00:00Z", endAt: "2026-11-06T00:00:00Z" });
    await task("Pointed", { sprintId: sp.id, points: 5, assignee: olive(), due: "2026-11-05T10:00:00Z" });
    await task("Pointed two", { sprintId: sp.id, points: 3, assignee: maxA(), due: "2026-11-05T10:00:00Z" });
    await startSprint(ctx.deps, actor, sp.id);
    await createGoal(ctx.deps, actor, { name: "Grow", keyResults: [{ name: "Signups", kind: "number", start: 0, target: 100, current: 40 }] });
    await c.post("/api/org/plan", { plan: "pro" });
    const dom = (await c.post("/api/domains", { name: "acme.io" })).body.domain;
    for (const r of dom.records) {
      if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
      else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
    }
    await c.post(`/api/domains/${dom.id}/verify`);
    expect((await c.post("/api/mailboxes", { domainId: dom.id, localPart: "sales", displayName: "Sales" })).status).toBe(201);
    const { deliverInbound } = await import("@/server/services/mail/delivery");
    await deliverInbound(ctx.deps, { envelopeFrom: "grace@example.com", rcptTo: "sales@acme.io", sizeBytes: 300, via: "test",
      email: { messageId: "<d1@example.com>", from: { address: "grace@example.com", name: "Grace" }, to: [{ address: "sales@acme.io" }], cc: [], subject: "Hi", text: "Hello", date: new Date(NOW), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} } });
    const d = await createDashboard(ctx.deps, actor, { name: "All", shared: true, widgets: [
      { type: "burndown", source: { projectId: launch } },
      { type: "goals" },
      { type: "workload" },
      { type: "mail_volume" },
      { type: "reply_times", groupBy: "mailbox" },
      { type: "burndown", source: { projectId: support } },
    ] });
    const data = await dashboardData(ctx.deps, actor, d.id, { tz: "UTC" });
    expect(data.widgets.map((x) => x.error)).toEqual([null, null, null, null, null, null]);
    const b = w(data, 0) as unknown as { sprint: { name: string }; burndown: { unit: string; scope: number; remaining: number; days: unknown[] } };
    expect(b.sprint.name).toBe("Sprint 1");
    expect(b.burndown).toMatchObject({ unit: "points", scope: 8, remaining: 8 });
    expect(b.burndown.days.length).toBeGreaterThan(0);
    expect(w(data, 1)).toMatchObject({ progress: 40, goals: [{ name: "Grow", progress: 40 }] });
    const wl = w(data, 2) as unknown as { people: { name: string; load: number }[] };
    expect(Object.fromEntries(wl.people.map((p) => [p.name, p.load]))).toEqual({ "Olive Owner": 5, "Max Member": 3 });
    const mv = w(data, 3) as unknown as { days: { day: string; received: number; sent: number }[]; received: number };
    expect(mv.days).toHaveLength(14);
    expect(mv.days.at(-1)).toEqual({ day: "2026-11-04", received: 1, sent: 0 });
    expect(mv.received).toBe(1);
    expect((w(data, 4) as unknown as { total: { threads: number } }).total.threads).toBe(1);
    expect(w(data, 5)).toEqual({ sprint: null, burndown: null });
    // An agent key reads only its own mailboxes: none here, so the mail widgets are empty for it.
    const { apiKey } = (await c.post("/api/agents", { name: "Outreach", localPart: "outreach" })).body;
    const res = await ctx.app.request(`/api/v1/dashboards/${d.id}/data?tz=UTC`, { headers: { host: "localhost", authorization: `Bearer ${apiKey.secret}` } });
    expect(res.status).toBe(200);
    const agent = await res.json() as Data;
    expect(agent.widgets.map((x) => x.error)).toEqual([null, null, null, null, null, null]);
    // An agent key acts as its agent, not as the person who made it: no private dashboards.
    const priv = await createDashboard(ctx.deps, actor, { name: "Olive only" });
    const listed = await (await ctx.app.request("/api/v1/dashboards", { headers: { host: "localhost", authorization: `Bearer ${apiKey.secret}` } })).json() as { dashboards: { name: string }[] };
    expect(listed.dashboards.map((x) => x.name)).toEqual(["All"]);
    expect((await ctx.app.request(`/api/v1/dashboards/${priv.id}/data`, { headers: { host: "localhost", authorization: `Bearer ${apiKey.secret}` } })).status).toBe(404);
    expect((agent.widgets[3].data as { received: number }).received).toBe(0);
    expect((agent.widgets[4].data as { rows: unknown[] }).rows).toEqual([]);
    expect((agent.widgets[2].data as { people: unknown[] }).people).toHaveLength(2); // tasks read like GET /tasks
  });
});

describe("dashboards: permissions, caps and the API", () => {
  it("keeps private dashboards to their owner and refuses other workspaces and guests", async () => {
    const mineP = (await c.post("/api/dashboards", { name: "Mine" })).body.dashboard;
    const shared = (await c.post("/api/dashboards", { name: "Team", shared: true, widgets: [{ type: "count" }] })).body.dashboard;
    expect(mineP.shared).toBe(false);
    expect((await mate.client.get("/api/dashboards")).body.dashboards.map((x: { name: string }) => x.name)).toEqual(["Team"]);
    expect((await mate.client.get(`/api/dashboards/${mineP.id}`)).status).toBe(404);
    expect((await mate.client.get(`/api/dashboards/${mineP.id}/data`)).status).toBe(404);
    expect((await mate.client.get(`/api/dashboards/${shared.id}/data`)).status).toBe(200);
    // A member may change a shared dashboard's widgets, but not its sharing and not remove it.
    expect((await mate.client.patch(`/api/dashboards/${shared.id}`, { name: "Team view" })).status).toBe(200);
    expect((await mate.client.patch(`/api/dashboards/${shared.id}`, { shared: false })).status).toBe(403);
    expect((await mate.client.del(`/api/dashboards/${shared.id}`)).status).toBe(403);
    // Another workspace: 404 everywhere, and its ids are refused in widgets.
    const eve = new Client(ctx.app);
    await eve.signup("eve@other.io", "Eve", "Other");
    for (const p of [`/api/dashboards/${shared.id}`, `/api/dashboards/${shared.id}/data`]) expect((await eve.get(p)).status).toBe(404);
    expect((await eve.patch(`/api/dashboards/${shared.id}`, { name: "x" })).status).toBe(404);
    expect((await eve.del(`/api/dashboards/${shared.id}`)).status).toBe(404);
    const theirs = (await eve.post("/api/dashboards", { name: "Eve's" })).body.dashboard;
    expect((await eve.patch(`/api/dashboards/${theirs.id}`, { widgets: [{ type: "count", source: { projectId: launch } }] })).status).toBe(404);
    expect((await eve.post(`/api/dashboards/${theirs.id}/widgets`, { type: "burndown", source: { projectId: launch } })).status).toBe(404);
    expect((await eve.get("/api/dashboards")).body.dashboards.map((x: { name: string }) => x.name)).toEqual(["Eve's"]);
    // No workspace session (a project or meeting guest): 401.
    expect((await new Client(ctx.app).get("/api/dashboards")).status).toBe(401);
    expect((await new Client(ctx.app).get(`/api/dashboards/${shared.id}/data`)).status).toBe(401);
    // The owner removes it.
    expect((await c.del(`/api/dashboards/${shared.id}`)).status).toBe(200);
  });

  it("caps widgets at 24 and dashboards at 50 per workspace, and saves the whole layout in order", async () => {
    const many = Array.from({ length: MAX_WIDGETS + 1 }, () => ({ type: "count" }));
    expect((await c.post("/api/dashboards", { name: "Too many", widgets: many })).status).toBe(422);
    const d = (await c.post("/api/dashboards", { name: "Full", widgets: many.slice(0, MAX_WIDGETS) })).body.dashboard;
    expect(d.widgets).toHaveLength(MAX_WIDGETS);
    const add = await c.post(`/api/dashboards/${d.id}/widgets`, { type: "goals" });
    expect(add.status).toBe(422);
    expect(add.body.error.code).toBe("too_many_widgets");
    // Reorder: the list as sent, positions follow, ids kept.
    const ids = d.widgets.map((x: { id: string }) => x.id);
    const reordered = [...d.widgets].reverse().slice(0, 3);
    const saved = (await c.patch(`/api/dashboards/${d.id}`, { widgets: reordered, version: d.version })).body.dashboard;
    expect(saved.widgets.map((x: { id: string }) => x.id)).toEqual([ids[23], ids[22], ids[21]]);
    expect(saved.widgets.map((x: { position: number }) => x.position)).toEqual([0, 1, 2]);
    expect((await c.patch(`/api/dashboards/${d.id}`, { name: "Stale", version: d.version })).status).toBe(409);
    for (let i = 1; i < MAX_DASHBOARDS; i++) await createDashboard(ctx.deps, actor, { name: `D${i}` });
    const over = await c.post("/api/dashboards", { name: "One more" });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe("too_many_dashboards");
  });

  it("REST and MCP: read only keys read, can't create; full keys create and add widgets", async () => {
    await seed();
    const d = (await c.post("/api/dashboards", { starter: "team" })).body.dashboard;
    const priv = (await c.post("/api/dashboards", { name: "Private" })).body.dashboard;
    const ro = (await c.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret;
    const full = (await c.post("/api/developer/keys", { name: "full" })).body.secret;
    const h = (k: string) => ({ host: "localhost", authorization: `Bearer ${k}`, "content-type": "application/json" });
    const list = await (await ctx.app.request("/api/v1/dashboards", { headers: h(ro) })).json() as { dashboards: { name: string }[] };
    expect(list.dashboards.map((x) => x.name).sort()).toEqual(["Private", "Team overview"]); // the key's owner made both
    const data = await ctx.app.request(`/api/v1/dashboards/${d.id}/data?tz=UTC`, { headers: h(ro) });
    expect(data.status).toBe(200);
    expect(((await data.json()) as Data).widgets[1].data).toMatchObject({ total: 6 });
    expect((await ctx.app.request("/api/v1/dashboards", { method: "POST", headers: h(ro), body: JSON.stringify({ name: "No" }) })).status).toBe(403);
    expect((await ctx.app.request(`/api/v1/dashboards/${d.id}`, { method: "PATCH", headers: h(ro), body: JSON.stringify({ name: "No" }) })).status).toBe(403);
    expect((await ctx.app.request("/api/v1/dashboards", { headers: { host: "localhost" } })).status).toBe(401);
    const made = await ctx.app.request("/api/v1/dashboards", { method: "POST", headers: h(full), body: JSON.stringify({ name: "From the API", widgets: [{ type: "count" }] }) });
    expect(made.status).toBe(201);
    const madeId = ((await made.json()) as { dashboard: { id: string } }).dashboard.id;
    expect((await ctx.app.request(`/api/v1/dashboards/${madeId}/widgets`, { method: "POST", headers: h(full), body: JSON.stringify({ type: "breakdown", groupBy: "priority" }) })).status).toBe(201);
    expect((await ctx.app.request(`/api/v1/dashboards/${madeId}`, { method: "DELETE", headers: h(full) })).status).toBe(200);
    // Another workspace's key can't see either.
    const other = new Client(ctx.app);
    await other.signup("eve@else.io", "Eve Else", "Else");
    const evil = (await other.post("/api/developer/keys", { name: "k" })).body.secret;
    expect((await ctx.app.request(`/api/v1/dashboards/${d.id}/data`, { headers: h(evil) })).status).toBe(404);
    expect((await ctx.app.request(`/api/v1/dashboards/${priv.id}`, { headers: h(evil) })).status).toBe(404);

    const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
    const connect = async (k: string) => {
      const m = new McpClient({ name: "test", version: "1.0.0" });
      await m.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${k}` } }, fetch: fetchViaApp }));
      return m;
    };
    const text = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content)[0].text);
    const rm = await connect(ro);
    const l = await rm.callTool({ name: "list_dashboards", arguments: {} });
    expect(l.isError).toBeFalsy();
    expect(text(l).dashboards).toHaveLength(2);
    const g = await rm.callTool({ name: "get_dashboard_data", arguments: { dashboardId: d.id, tz: "UTC" } });
    expect(text(g).widgets[2].data.overdue).toBe(2);
    expect((await rm.callTool({ name: "create_dashboard", arguments: { name: "No" } })).isError).toBe(true);
    expect((await rm.callTool({ name: "add_dashboard_widget", arguments: { dashboardId: d.id, type: "goals" } })).isError).toBe(true);
    await rm.close();
    const fm = await connect(full);
    const cr = await fm.callTool({ name: "create_dashboard", arguments: { name: "Agent view", widgets: [{ type: "breakdown", groupBy: "label", chart: "donut" }] } });
    expect(cr.isError).toBeFalsy();
    const id = text(cr).dashboard.id;
    const ad = await fm.callTool({ name: "add_dashboard_widget", arguments: { dashboardId: id, type: "count", filters: { priority: "high" }, title: "High" } });
    expect(text(ad).dashboard.widgets.map((x: { title: string }) => x.title)).toEqual(["Tasks by label", "High"]);
    const gd = text(await fm.callTool({ name: "get_dashboard_data", arguments: { dashboardId: id, tz: "UTC" } }));
    expect(gd.widgets[1].data.value).toBe(2);
    await fm.close();
  });
});
