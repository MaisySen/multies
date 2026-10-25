import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { createTask, updateTask } from "@/server/services/suite/tasks";
import { getWorkload, localDate, mondayOf, weekOf, zonedMidnight } from "@/server/services/suite/workload";
import type { SuiteActor } from "@/server/services/suite/common";

type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
let ctx: Ctx;
let c: Client;
let actor: SuiteActor;
let me: { id: string };
let mate: { id: string; client: Client };
let pts: string; // a points project
let hrs: string; // an hours project

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  const body = (await c.get("/api/account/me")).body;
  actor = { orgId: body.organization.id, userId: body.user.id, email: body.user.email, name: body.user.name, role: "owner" };
  me = { id: body.user.id };
  const invite = await c.post("/api/team/invites", { email: "max@acme.io", role: "member" });
  const m = new Client(ctx.app);
  await m.signup("max@acme.io", "Max Member", "");
  expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  mate = { id: (await m.get("/api/account/me")).body.user.id, client: m };
  pts = (await c.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id;
  hrs = (await c.post("/api/projects", { name: "Support", key: "SUP" })).body.project.id;
  expect((await c.put("/api/sprints/estimate-unit", { projectId: hrs, unit: "hours" })).status).toBe(200);
  ctx.deps.now = () => new Date("2026-11-04T02:00:00Z"); // a Wednesday
});

const mine = { type: "member" as const, id: "" };
const task = (title: string, extra: Record<string, unknown> = {}) => createTask(ctx.deps, actor, { title, projectId: pts, ...extra });
const row = (w: Awaited<ReturnType<typeof getWorkload>>, name: string) => w.people.find((p) => p.name === name)!;

describe("workload: week bucketing", () => {
  it("starts weeks on Monday in the zone, across DST in Sydney and Los Angeles", () => {
    expect(mondayOf("2026-11-08")).toBe("2026-11-02"); // a Sunday
    expect(mondayOf("2026-11-02")).toBe("2026-11-02");
    // Sydney moves to daylight time on Sunday 4 October 2026 (+10 to +11).
    expect(new Date(zonedMidnight("2026-10-04", "Australia/Sydney")).toISOString()).toBe("2026-10-03T14:00:00.000Z");
    expect(new Date(zonedMidnight("2026-10-05", "Australia/Sydney")).toISOString()).toBe("2026-10-04T13:00:00.000Z");
    expect(weekOf(Date.parse("2026-10-04T13:30:00Z"), "Australia/Sydney")).toBe("2026-10-05");
    expect(weekOf(Date.parse("2026-10-04T12:30:00Z"), "Australia/Sydney")).toBe("2026-09-28");
    // Los Angeles leaves daylight time on Sunday 1 November 2026 (-7 to -8).
    expect(new Date(zonedMidnight("2026-10-26", "America/Los_Angeles")).toISOString()).toBe("2026-10-26T07:00:00.000Z");
    expect(new Date(zonedMidnight("2026-11-02", "America/Los_Angeles")).toISOString()).toBe("2026-11-02T08:00:00.000Z");
    expect(weekOf(Date.parse("2026-11-02T07:30:00Z"), "America/Los_Angeles")).toBe("2026-10-26");
    expect(weekOf(Date.parse("2026-11-02T08:30:00Z"), "America/Los_Angeles")).toBe("2026-11-02");
    expect(localDate(Date.parse("2026-11-01T23:30:00Z"), "Australia/Sydney")).toBe("2026-11-02");
  });

  it("puts the same task in different weeks for viewers in different zones", async () => {
    await task("Ship", { due: "2026-11-01T23:30:00Z", points: 3, assignee: { ...mine, id: me.id } });
    const syd = await getWorkload(ctx.deps, actor, { from: "2026-10-26", weeks: 2, tz: "Australia/Sydney" });
    const la = await getWorkload(ctx.deps, actor, { from: "2026-10-26", weeks: 2, tz: "America/Los_Angeles" });
    expect(syd.range.weeks.map((w) => w.start)).toEqual(["2026-10-26", "2026-11-02"]);
    expect(row(syd, "Olive Owner").weeks.map((w) => w.count)).toEqual([0, 1]);
    expect(row(la, "Olive Owner").weeks.map((w) => w.count)).toEqual([1, 0]);
    expect(syd.timeZone).toBe("Australia/Sydney");
  });

  it("uses the due date, else the start date, and puts open tasks due before the range in Overdue", async () => {
    const tz = "UTC";
    await task("Due this week", { due: "2026-11-05T10:00:00Z", points: 2, assignee: { ...mine, id: me.id } });
    await task("Starts next week", { start: "2026-11-10T09:00:00Z", points: 1, assignee: { ...mine, id: me.id } });
    await task("Start and due", { start: "2026-11-03T09:00:00Z", due: "2026-11-17T09:00:00Z", assignee: { ...mine, id: me.id } });
    await task("Late", { due: "2026-10-20T09:00:00Z", points: 5, assignee: { ...mine, id: me.id } });
    await task("Old start only", { start: "2026-10-20T09:00:00Z", assignee: { ...mine, id: me.id } });
    await task("Far away", { due: "2027-03-01T09:00:00Z", assignee: { ...mine, id: me.id } });
    await task("No dates", { assignee: { ...mine, id: me.id } });
    const done = await task("Finished", { due: "2026-11-05T10:00:00Z", assignee: { ...mine, id: me.id } });
    await updateTask(ctx.deps, actor, done.id, { status: "done" });
    const gone = await task("Deleted", { due: "2026-11-05T10:00:00Z", assignee: { ...mine, id: me.id } });
    await c.del(`/api/tasks/${gone.id}`);
    await createTask(ctx.deps, actor, { title: "In triage", projectId: pts, due: "2026-11-05T10:00:00Z", triage: { source: "api", when: "always" } });
    await task("An epic", { type: "epic", due: "2026-11-05T10:00:00Z", assignee: { ...mine, id: me.id } });
    const w = await getWorkload(ctx.deps, actor, { tz }); // default: this week and the next 3
    expect(w.range.weeks.map((x) => x.start)).toEqual(["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23"]);
    const o = row(w, "Olive Owner");
    expect(o.weeks[0].tasks.map((t) => t.title)).toEqual(["Due this week"]);
    expect(o.weeks[1].tasks.map((t) => t.title)).toEqual(["Starts next week"]);
    expect(o.weeks[2].tasks.map((t) => t.title)).toEqual(["Start and due"]);
    expect(o.overdue.tasks.map((t) => t.title)).toEqual(["Late"]);
    expect(o.overdue.points).toBe(5);
    expect(o.weeks[0].tasks[0]).toMatchObject({ ref: "LAU-1", project: "Launch", points: 2, unit: "points", status: "todo" });
    expect(w.taskCount).toBe(4);
    expect(w.truncated).toBe(false);
  });
});

describe("workload: rows, sums and capacity", () => {
  it("sums points and hours by each project's unit, counts tasks with no estimate and keeps an Unassigned row", async () => {
    const tz = "UTC";
    await task("A", { due: "2026-11-03T10:00:00Z", points: 8, assignee: { ...mine, id: me.id } });
    await task("B", { due: "2026-11-04T10:00:00Z", points: 5, assignee: { ...mine, id: me.id } });
    await createTask(ctx.deps, actor, { title: "C", projectId: hrs, due: "2026-11-04T10:00:00Z", points: 6, assignee: { ...mine, id: me.id } });
    await task("D", { due: "2026-11-05T10:00:00Z", assignee: { ...mine, id: me.id } });
    await task("E", { due: "2026-11-05T10:00:00Z", points: 21, assignee: { ...mine, id: mate.id } });
    await task("F", { due: "2026-11-12T10:00:00Z", points: 2 });
    const w = await getWorkload(ctx.deps, actor, { tz, weeks: 2 });
    expect(w.people.map((p) => p.name)).toEqual(["Max Member", "Olive Owner", "Unassigned"]);
    const o = row(w, "Olive Owner").weeks[0];
    expect(o).toMatchObject({ count: 4, points: 13, hours: 6, noEstimate: 1, load: 13, over: false, near: false });
    const m = row(w, "Max Member").weeks[0];
    expect(m).toMatchObject({ count: 1, points: 21, load: 21, over: true });
    expect(w.overloaded).toEqual([{ person: "Max Member", id: `member:${mate.id}`, week: "2026-11-02", load: 21, capacity: 20 }]);
    const u = row(w, "Unassigned");
    expect(u.id).toBeNull();
    expect(u.weeks[1]).toMatchObject({ count: 1, points: 2 });
    expect(row(w, "Olive Owner").total).toMatchObject({ count: 4, points: 13, hours: 6, noEstimate: 1 });
    // Hours, and a capacity set by the request.
    const h = await getWorkload(ctx.deps, actor, { tz, weeks: 1, unit: "hours", capacity: 7 });
    expect(h.capacity).toBe(7);
    expect(row(h, "Olive Owner").weeks[0]).toMatchObject({ load: 6, over: false, near: true });
    expect(row(h, "Max Member").weeks[0]).toMatchObject({ load: 0, over: false });
    expect((await getWorkload(ctx.deps, actor, { tz, unit: "hours" })).capacity).toBe(40);
  });

  it("filters by project, sprint and person", async () => {
    const tz = "UTC";
    const sprint = (await c.post("/api/sprints", { projectId: pts })).body.sprint;
    await task("In sprint", { due: "2026-11-03T10:00:00Z", points: 3, sprintId: sprint.id, assignee: { ...mine, id: me.id } });
    await task("Backlog", { due: "2026-11-03T10:00:00Z", points: 1, assignee: { ...mine, id: mate.id } });
    await createTask(ctx.deps, actor, { title: "Support ticket", projectId: hrs, due: "2026-11-03T10:00:00Z", points: 2, assignee: { ...mine, id: mate.id } });
    const titles = (w: Awaited<ReturnType<typeof getWorkload>>) => w.people.flatMap((p) => p.weeks.flatMap((x) => x.tasks.map((t) => t.title))).sort();
    expect(titles(await getWorkload(ctx.deps, actor, { tz, projectIds: [hrs] }))).toEqual(["Support ticket"]);
    expect(titles(await getWorkload(ctx.deps, actor, { tz, sprintId: sprint.id }))).toEqual(["In sprint"]);
    expect(titles(await getWorkload(ctx.deps, actor, { tz, people: [`member:${mate.id}`] }))).toEqual(["Backlog", "Support ticket"]);
    const viaApi = await c.get(`/api/workload?tz=UTC&projectId=${pts}&person=member:${me.id}`);
    expect(viaApi.status).toBe(200);
    expect(titles(viaApi.body)).toEqual(["In sprint"]);
    expect((await c.get(`/api/workload?projectId[]=${pts}&projectId[]=${hrs}&tz=UTC`)).body.taskCount).toBe(3);
    expect((await c.get("/api/workload?weeks=13")).status).toBe(422);
    expect((await c.get("/api/workload?unit=days")).status).toBe(422);
  });
});

describe("workload: permissions and writes", () => {
  it("refuses another workspace's project or sprint, never shows its tasks, and refuses guests and signed out callers", async () => {
    await task("Ours", { due: "2026-11-03T10:00:00Z", points: 1, assignee: { ...mine, id: me.id } });
    const other = new Client(ctx.app);
    await other.signup("eve@else.io", "Eve Else", "Else");
    const theirProject = (await other.post("/api/projects", { name: "Secret", key: "SEC" })).body.project.id;
    await other.post("/api/tasks", { title: "Their secret", projectId: theirProject, due: "2026-11-03T10:00:00Z" });
    const theirSprint = (await other.post("/api/sprints", { projectId: theirProject })).body.sprint.id;
    expect((await c.get(`/api/workload?projectId=${theirProject}`)).status).toBe(404);
    expect((await c.get(`/api/workload?sprintId=${theirSprint}`)).status).toBe(404);
    const ours = (await c.get("/api/workload?tz=UTC")).body;
    expect(JSON.stringify(ours)).not.toContain("Their secret");
    expect(JSON.stringify((await other.get("/api/workload?tz=UTC")).body)).not.toContain("Ours");
    // A member reads the same workspace view as list views give them.
    expect(JSON.stringify((await mate.client.get("/api/workload?tz=UTC")).body)).toContain("Ours");
    // Signed out and guest sessions are refused.
    expect((await new Client(ctx.app).get("/api/workload")).status).toBe(401);
    const inv = await c.post("/api/guests", { projectId: pts, email: "mia@client.io", name: "Mia" });
    const sent = (ctx.outbound as unknown as { sent?: { text: string }[] }).sent ?? [];
    const token = (sent.map((m) => m.text).reverse().find((t) => t.includes("/g/")) ?? "").match(/\/g\/([A-Za-z0-9_-]+)/)?.[1] ?? (inv.body.inviteUrl as string | undefined)?.split("/g/")[1];
    const g = new Client(ctx.app);
    expect((await g.post("/api/guest/accept", { token })).status).toBe(200);
    expect((await g.get("/api/guest/me")).status).toBe(200);
    expect((await g.get("/api/workload")).status).toBe(401);
  });

  it("serves REST and MCP to read only keys, and a key can't read another workspace", async () => {
    await task("Ours", { due: "2026-11-03T10:00:00Z", points: 21, assignee: { ...mine, id: me.id } });
    const ro = (await c.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret;
    const res = await ctx.app.request("/api/v1/workload?tz=UTC&weeks=1", { headers: { host: "localhost", authorization: `Bearer ${ro}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { overloaded: { person: string }[]; people: { name: string }[] };
    expect(body.overloaded.map((o) => o.person)).toEqual(["Olive Owner"]);
    expect((await ctx.app.request("/api/v1/workload", { headers: { host: "localhost" } })).status).toBe(401);
    const other = new Client(ctx.app);
    await other.signup("eve@else.io", "Eve Else", "Else");
    const evilKey = (await other.post("/api/developer/keys", { name: "k" })).body.secret;
    expect((await ctx.app.request(`/api/v1/workload?projectId=${pts}`, { headers: { host: "localhost", authorization: `Bearer ${evilKey}` } })).status).toBe(404);
    const theirs = await (await ctx.app.request("/api/v1/workload?tz=UTC", { headers: { host: "localhost", authorization: `Bearer ${evilKey}` } })).json();
    expect(JSON.stringify(theirs)).not.toContain("Ours");

    const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
    const mcp = new McpClient({ name: "test", version: "1.0.0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${ro}` } }, fetch: fetchViaApp }));
    const r = await mcp.callTool({ name: "get_workload", arguments: { from: "2026-11-02", weeks: 1, tz: "UTC" } });
    expect(r.isError).toBeFalsy();
    const out = JSON.parse((r.content as { text: string }[])[0].text);
    expect(out.overloaded).toEqual([{ person: "Olive Owner", id: `member:${me.id}`, week: "2026-11-02", load: 21, capacity: 20 }]);
    expect(out.people[0].weeks[0].tasks).toBeUndefined();
    const full = JSON.parse(((await mcp.callTool({ name: "get_workload", arguments: { weeks: 1, tz: "UTC", includeTasks: true } })).content as { text: string }[])[0].text);
    expect(full.people[0].weeks[0].tasks[0].title).toBe("Ours");
    await mcp.close();
  });
});
