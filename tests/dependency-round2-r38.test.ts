import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { addDays, countDays, findConflicts, planShift, type Cal, type SchedTask } from "@/server/services/suite/dependency-schedule-r37";
import { parseSchedule } from "@/server/services/suite/schedule-settings-r38";
import { toolScope } from "@/server/lib/api-scopes";

/** R38: dependencies round 2: lead and lag per link, working days only, strict moves. 2 Nov 2026 is a Monday. */
const T = (id: string, start: string | null, due: string | null, status = "todo"): SchedTask => ({ id, start, due, status });
const WD: Cal = { workingDaysOnly: true, daysOff: [0, 6] };
const wd = { calOf: () => WD };
const D = (s: string) => Date.parse(`${s}T00:00:00.000Z`);
const Y = (n: number) => new Date(n).toISOString().slice(0, 10);

describe("planner round 2 (pure)", () => {
  it("counts working days across a weekend", () => {
    expect(Y(addDays(D("2026-11-05"), 2, WD))).toBe("2026-11-09"); // Thu + 2 working days = Mon
    expect(Y(addDays(D("2026-11-09"), -1, WD))).toBe("2026-11-06"); // Mon - 1 = Fri
    expect(countDays(D("2026-11-06"), D("2026-11-09"), WD)).toBe(1);
    expect(countDays(D("2026-11-09"), D("2026-11-06"), WD)).toBe(-1);
  });

  it("uses a lag: the blocked task waits that many days after the blocker ends", () => {
    const list = [T("a", "2026-11-02", "2026-11-04"), T("b", "2026-11-05", "2026-11-06")];
    expect(findConflicts(list, [{ from: "a", to: "b" }])).toEqual([]);
    const c = findConflicts(list, [{ from: "a", to: "b", lag: 2 }]);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ lag: 2, overlapDays: 2, fix: { taskId: "b", start: "2026-11-07", due: "2026-11-08" } });
  });

  it("uses a lead: the blocked task may start that many days before the blocker ends", () => {
    const ok = [T("a", "2026-11-02", "2026-11-04"), T("b", "2026-11-03", "2026-11-06")];
    expect(findConflicts(ok, [{ from: "a", to: "b", lag: -2 }])).toEqual([]);
    const early = [T("a", "2026-11-02", "2026-11-04"), T("b", "2026-11-02", "2026-11-03")];
    expect(findConflicts(early, [{ from: "a", to: "b", lag: -2 }])[0]).toMatchObject({ overlapDays: 1, fix: { start: "2026-11-03", due: "2026-11-04" } });
  });

  it("with working days only, lag skips the weekend and a fixed task keeps its working length", () => {
    const list = [T("a", "2026-11-02", "2026-11-05"), T("b", "2026-11-06", "2026-11-09")]; // b: Fri and Mon, 2 working days
    const c = findConflicts(list, [{ from: "a", to: "b", lag: 1 }], wd);
    expect(c[0]).toMatchObject({ fix: { taskId: "b", start: "2026-11-09", due: "2026-11-10" }, overlapDays: 3 });
  });

  it("flexible move with working days never lands a task on a day off", () => {
    const list = [T("a", "2026-11-02", "2026-11-04"), T("b", "2026-11-05", "2026-11-05")];
    const plan = planShift(list, [{ from: "a", to: "b" }], "a", { start: "2026-11-04", due: "2026-11-06" }, wd);
    expect(plan[1]).toMatchObject({ id: "b", to: { start: "2026-11-09", due: "2026-11-09" }, days: 4 });
    const plain = planShift(list, [{ from: "a", to: "b" }], "a", { start: "2026-11-04", due: "2026-11-06" });
    expect(plain[1].to).toEqual({ start: "2026-11-07", due: "2026-11-07" });
  });

  it("strict moves every waiting task by the same days, later and earlier", () => {
    const list = [T("a", "2026-11-02", "2026-11-04"), T("b", "2026-11-10", "2026-11-12"), T("c", null, "2026-11-20"), T("d", "2026-11-11", "2026-11-11", "done")];
    const links = [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "a", to: "d" }];
    const later = planShift(list, links, "a", { start: "2026-11-05", due: "2026-11-07" }, { strict: true });
    expect(later.slice(1)).toEqual([
      { id: "b", from: { start: "2026-11-10", due: "2026-11-12" }, to: { start: "2026-11-13", due: "2026-11-15" }, days: 3 },
      { id: "c", from: { start: null, due: "2026-11-20" }, to: { start: null, due: "2026-11-23" }, days: 3 },
    ]);
    const earlier = planShift(list, links, "a", { start: "2026-10-31", due: "2026-11-02" }, { strict: true });
    expect(earlier.slice(1).map((m) => [m.id, m.days])).toEqual([["b", -2], ["c", -2]]);
    // Flexible (default) leaves them: nothing clashes.
    expect(planShift(list, links, "a", { start: "2026-11-05", due: "2026-11-07" }).slice(1)).toEqual([]);
  });

  it("strict with working days moves by the same working days", () => {
    const list = [T("a", "2026-11-02", "2026-11-02"), T("b", "2026-11-05", "2026-11-06")];
    const plan = planShift(list, [{ from: "a", to: "b" }], "a", { start: "2026-11-04", due: "2026-11-04" }, { ...wd, strict: true });
    expect(plan[1].to).toEqual({ start: "2026-11-09", due: "2026-11-10" });
  });

  it("reads stored settings safely", () => {
    expect(parseSchedule("{}")).toEqual({ workingDaysOnly: false, daysOff: [0, 6], strict: false });
    expect(parseSchedule("nope")).toEqual({ workingDaysOnly: false, daysOff: [0, 6], strict: false });
    expect(parseSchedule('{"workingDaysOnly":true,"daysOff":[5,6,9],"strict":true}')).toEqual({ workingDaysOnly: true, daysOff: [5, 6], strict: true });
  });

  it("needs tasks:write for set_project_schedule", () => {
    expect(toolScope("set_project_schedule", false)).toBe("tasks:write");
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
const day = (t: { start: string | null; due: string | null }) => [t.start?.slice(0, 10) ?? null, t.due?.slice(0, 10) ?? null];

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@plan2.test");
  project = (await c.post("/api/projects", { name: "Launch", key: "LCH" })).body.project.id;
  key = (await c.post("/api/developer/keys", { name: "rw" })).body.secret;
});

describe("dependencies round 2 (API)", () => {
  it("sets a lag on add and on an existing link, and the check and the move use it", async () => {
    const a = await mk("Pour", "2026-11-02", "2026-11-04");
    const b = await mk("Paint", "2026-11-05", "2026-11-06");
    const added = await c.post(`/api/tasks/${b.id}/dependencies`, { blockedBy: a.id, lagDays: 2 });
    expect(added.status).toBe(201);
    expect(added.body.blockedBy[0]).toMatchObject({ id: a.id, lagDays: 2 });
    let check = await c.get(`/api/tasks/dependencies/check?projectId=${project}`);
    expect(check.body.conflicts[0]).toMatchObject({ lag: 2, fix: { taskId: b.id, start: "2026-11-07", due: "2026-11-08" } });
    expect(check.body.settings).toMatchObject({ workingDaysOnly: false, strict: false });

    const patched = await c.patch(`/api/tasks/${b.id}/dependencies/${a.id}`, { lagDays: -1 });
    expect(patched.status).toBe(200);
    expect(patched.body.blockedBy[0].lagDays).toBe(-1);
    check = await c.get(`/api/tasks/dependencies/check?projectId=${project}`);
    expect(check.body.conflicts).toEqual([]);
    expect((await c.get(`/api/tasks/${b.id}`)).body.blockedBy?.[0]?.lagDays ?? -1).toBe(-1);

    expect((await c.patch(`/api/tasks/${b.id}/dependencies/${a.id}`, { lagDays: 1000 })).status).toBe(422);
    const other = await mk("Other", null, null);
    expect((await c.patch(`/api/tasks/${b.id}/dependencies/${other.id}`, { lagDays: 1 })).status).toBe(404);
  });

  it("saves working days and strict per project, and a move follows them (or the per move override)", async () => {
    const empty = await c.get(`/api/projects/${project}/schedule`);
    expect(empty.body.schedule).toEqual({ projectId: project, workingDaysOnly: false, daysOff: [0, 6], strict: false });
    const saved = await c.put(`/api/projects/${project}/schedule`, { workingDaysOnly: true, strict: true });
    expect(saved.status).toBe(200);
    expect(saved.body.schedule).toMatchObject({ workingDaysOnly: true, strict: true, daysOff: [0, 6] });
    expect((await c.put(`/api/projects/${project}/schedule`, { daysOff: [0, 1, 2, 3, 4, 5, 6] })).status).toBe(422);
    // Board settings in the same row keep their values.
    expect((await c.get(`/api/projects/${project}/board`)).body.board.swimlanes).toBe("none");

    const a = await mk("A", "2026-11-02", "2026-11-02");
    const b = await mk("B", "2026-11-05", "2026-11-06");
    await c.post(`/api/tasks/${b.id}/dependencies`, { blockedBy: a.id });
    const prev = await c.post(`/api/tasks/${a.id}/reschedule`, { start: "2026-11-04", due: "2026-11-04", preview: true });
    expect(prev.body).toMatchObject({ preview: true, mode: "strict", workingDaysOnly: true });
    expect(prev.body.moved[0].to).toEqual({ start: "2026-11-09", due: "2026-11-10" });
    const flex = await c.post(`/api/tasks/${a.id}/reschedule`, { start: "2026-11-04", due: "2026-11-04", preview: true, strict: false });
    expect(flex.body.mode).toBe("flexible");
    expect(flex.body.moved).toEqual([]);
    await c.post(`/api/tasks/${a.id}/reschedule`, { start: "2026-11-04", due: "2026-11-04" });
    expect(day((await c.get(`/api/tasks/${b.id}`)).body.task)).toEqual(["2026-11-09", "2026-11-10"]);
  });

  it("works over /api/v1: lag and schedule, and read only keys can read but not change", async () => {
    const a = await mk("A", "2026-11-02", "2026-11-03");
    const b = await mk("B", "2026-11-04", "2026-11-04");
    expect((await v1("POST", `/tasks/${b.id}/dependencies`, { blockedBy: "LCH-1", lagDays: 1 })).status).toBe(201);
    const lag = await v1("PATCH", `/tasks/LCH-2/dependencies/LCH-1`, { lagDays: 3 });
    expect(lag.status).toBe(200);
    expect(lag.body.blockedBy[0].lagDays).toBe(3);
    const check = await v1("GET", `/tasks/dependencies/check?projectId=${project}`);
    expect(check.body.conflicts[0]).toMatchObject({ lag: 3, fix: { taskId: b.id, start: "2026-11-07" } });
    expect((await v1("PUT", `/projects/${project}/schedule`, { strict: true })).body.schedule.strict).toBe(true);
    expect((await v1("GET", `/projects/${project}/schedule`)).body.schedule.strict).toBe(true);
    const ro = (await c.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret;
    expect((await v1("GET", `/projects/${project}/schedule`, undefined, ro)).status).toBe(200);
    expect((await v1("PUT", `/projects/${project}/schedule`, { strict: false }, ro)).status).toBe(403);
    expect((await v1("PATCH", `/tasks/LCH-2/dependencies/LCH-1`, { lagDays: 0 }, ro)).status).toBe(403);
    expect(a.id).toBeTruthy();
  });

  it("works over MCP: lagDays on set_task_blocked_by, set_project_schedule, strict on reschedule_task", async () => {
    const a = await mk("A", "2026-11-02", "2026-11-03");
    const b = await mk("B", "2026-11-10", "2026-11-11");
    const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
    const mcp = new McpClient({ name: "t", version: "1" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
    const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
    const set = data(await mcp.callTool({ name: "set_task_blocked_by", arguments: { taskId: "LCH-2", blockedBy: "LCH-1", lagDays: 7 } }));
    expect(set.blockedBy[0]).toMatchObject({ ref: "LCH-1", lagDays: 7 });
    const check = data(await mcp.callTool({ name: "check_task_schedule", arguments: { projectId: project } }));
    expect(check.conflicts[0]).toMatchObject({ lagDays: 7, fix: { taskId: b.id, start: "2026-11-11", due: "2026-11-12" } });
    expect(check.schedule).toMatchObject({ strict: false });
    const sched = data(await mcp.callTool({ name: "set_project_schedule", arguments: { projectId: project, strict: true } }));
    expect(sched.schedule.strict).toBe(true);
    const moved = data(await mcp.callTool({ name: "reschedule_task", arguments: { taskId: "LCH-1", start: "2026-10-30", due: "2026-10-31", preview: true } }));
    expect(moved).toMatchObject({ preview: true, mode: "strict" });
    expect(moved.moved[0]).toMatchObject({ ref: "LCH-2", days: -3 });
    expect(a.id).toBeTruthy();
  });
});
