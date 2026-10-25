import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { aggregate } from "@/server/services/suite/computed";

type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
let ctx: Ctx;
let c: Client;
let pid: string;

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  pid = (await c.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id;
  ctx.deps.now = () => new Date("2026-11-04T02:00:00Z");
});

const field = async (name: string, type: string, config?: Record<string, unknown>) => {
  const r = await c.post("/api/fields", { projectId: pid, name, type, ...(config ? { config } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.field as { id: string; type: string; config?: Record<string, unknown> };
};
const task = async (title: string, extra: Record<string, unknown> = {}) => {
  const r = await c.post("/api/tasks", { title, projectId: pid, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.task as { id: string; ref: string };
};
const listed = async (q = "") => (await c.get(`/api/tasks?projectId=${pid}${q}`)).body.tasks as { id: string; title: string; fields: Record<string, unknown>; fieldErrors?: Record<string, string> }[];
const byTitle = async (title: string, q = "&includeSubtasks=true") => (await listed(q)).find((t) => t.title === title)!;

describe("formula fields", () => {
  it("computes formula values on list, table and task reads, from custom fields and built ins", async () => {
    const budget = await field("Budget", "currency");
    const stage = await field("Stage", "select");
    const total = await field("With tax", "formula", { expression: "{Budget} * 1.1" });
    const double = await field("Double", "formula", { expression: "points * 2" });
    const label = await field("Label", "formula", { expression: `upper({title}) + " / " + {status} + " / " + {With tax}` });
    const late = await field("Days left", "formula", { expression: "days_between(today(), {due})" });
    expect(total.type).toBe("formula");
    expect(total.config).toEqual({ expression: "{Budget} * 1.1" });
    void stage;
    const t = await task("Ship", { points: 4, due: "2026-11-10T00:00:00Z" });
    expect((await c.patch(`/api/tasks/${t.id}`, { fields: { [budget.id]: 200 } })).status).toBe(200);
    const row = await byTitle("Ship");
    expect(row.fields[total.id]).toBe(220);
    expect(row.fields[double.id]).toBe(8);
    expect(row.fields[label.id]).toBe("SHIP / To do / 220");
    expect(row.fields[late.id]).toBe(6);
    const one = (await c.get(`/api/tasks/${t.id}`)).body.task;
    expect(one.fields[total.id]).toBe(220);
    // A computed value can't be set, filtered or sorted on.
    expect((await c.patch(`/api/tasks/${t.id}`, { fields: { [total.id]: 5 } })).status).toBe(422);
    expect((await c.get(`/api/tasks?projectId=${pid}&field.${total.id}=gt:1`)).status).toBe(422);
    expect((await c.get(`/api/tasks?projectId=${pid}&sort=field:${total.id}`)).status).toBe(422);
  });

  it("shows #ERROR with a message per cell, never a 500", async () => {
    const budget = await field("Budget", "number");
    const ratio = await field("Ratio", "formula", { expression: "100 / {Budget}" });
    const t = await task("Zero");
    await c.patch(`/api/tasks/${t.id}`, { fields: { [budget.id]: 0 } });
    const ok = await task("Fine");
    await c.patch(`/api/tasks/${ok.id}`, { fields: { [budget.id]: 4 } });
    const rows = await listed();
    const zero = rows.find((r) => r.title === "Zero")!;
    expect(zero.fields[ratio.id]).toBe("#ERROR");
    expect(zero.fieldErrors?.[ratio.id]).toMatch(/Division by zero/);
    expect(rows.find((r) => r.title === "Fine")!.fields[ratio.id]).toBe(25);
    expect(rows.find((r) => r.title === "Fine")!.fieldErrors).toBeUndefined();
    // R24 polish: a rename rewrites the formula, so it keeps working.
    await c.patch(`/api/fields/${budget.id}`, { name: "Spend" });
    expect((await byTitle("Fine")).fields[ratio.id]).toBe(25);
    expect((await byTitle("Fine")).fieldErrors).toBeUndefined();
    // A removed field breaks the formula into a readable error, not a crash.
    await c.del(`/api/fields/${budget.id}`);
    expect((await byTitle("Fine")).fieldErrors?.[ratio.id]).toMatch(/no field called \{Spend\}/);
  });

  it("refuses bad formulas and loops when defining, and catches loops that appear later", async () => {
    const r1 = await c.post("/api/fields", { projectId: pid, name: "Bad", type: "formula", config: { expression: "1 +" } });
    expect(r1.status).toBe(422);
    expect(r1.body.error.message).toMatch(/ends too early/);
    expect((await c.post("/api/fields", { projectId: pid, name: "X", type: "formula", config: { expression: "{Nope}" } })).status).toBe(422);
    expect((await c.post("/api/fields", { projectId: pid, name: "X", type: "formula" })).status).toBe(422);
    const a = await field("A", "formula", { expression: "points + 1" });
    const b = await field("B", "formula", { expression: "{A} * 2" });
    const loop = await c.patch(`/api/fields/${a.id}`, { config: { expression: "{B} + 1" } });
    expect(loop.status).toBe(422);
    expect(loop.body.error.message).toMatch(/loop/);
    // A loop made by renaming (B's name now matches what a third formula reads) still ends in #ERROR.
    const cField = await field("C", "formula", { expression: "{A} + 1" });
    await c.patch(`/api/fields/${a.id}`, { config: { expression: "{C} + 1" } }).then((r) => expect(r.status).toBe(422));
    void b;
    // A loop that slipped in anyway (here written straight to the table) ends in #ERROR per cell.
    const { customFields } = await import("@/server/db/schema");
    const { eq } = await import("drizzle-orm");
    await ctx.db.update(customFields).set({ config: JSON.stringify({ expression: "{C} + 1" }) }).where(eq(customFields.id, a.id));
    await task("Loopy", { points: 1 });
    const row = await byTitle("Loopy");
    expect(row.fields[a.id]).toBe("#ERROR");
    expect(row.fields[cField.id]).toBe("#ERROR");
    expect(row.fieldErrors?.[a.id]).toMatch(/loop/);
  });

  it("previews a formula against the first task, saving nothing", async () => {
    const budget = await field("Budget", "number");
    const t = await task("First", { points: 2 });
    await c.patch(`/api/tasks/${t.id}`, { fields: { [budget.id]: 50 } });
    const p = await c.get(`/api/computed/preview?projectId=${pid}&expression=${encodeURIComponent("{Budget} + points")}`);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ value: 52, task: { title: "First" } });
    const bad = await c.get(`/api/computed/preview?projectId=${pid}&expression=${encodeURIComponent("{Budget} +")}`);
    expect(bad.body.error).toMatch(/ends too early/);
    expect((await c.get(`/api/computed/preview?projectId=${pid}&expression=${encodeURIComponent("x".repeat(501))}`)).status).toBe(422);
  });
});

describe("rollup fields", () => {
  it("adds up subtasks: sum, average, count, count_done, percent_done, min, max, with empty sets and nulls", async () => {
    const est = await field("Estimate", "number");
    const cost = await field("Cost", "formula", { expression: "{Estimate} * 10" });
    const sum = await field("Sub points", "rollup", { source: "subtasks", fn: "sum", field: "points" });
    const avg = await field("Avg estimate", "rollup", { source: "subtasks", fn: "average", field: est.id });
    const cnt = await field("Count", "rollup", { source: "subtasks", fn: "count" });
    const done = await field("Done", "rollup", { source: "subtasks", fn: "count_done" });
    const pct = await field("Progress", "rollup", { source: "subtasks", fn: "percent_done" });
    const mn = await field("Min", "rollup", { source: "subtasks", fn: "min", field: "points" });
    const mx = await field("Max cost", "rollup", { source: "subtasks", fn: "max", field: "Cost" });
    const parent = await task("Parent");
    const a = await task("A", { parentId: parent.id, points: 3 });
    const b = await task("B", { parentId: parent.id, points: 5 });
    await task("C", { parentId: parent.id }); // no points, no estimate
    await c.patch(`/api/tasks/${a.id}`, { fields: { [est.id]: 2 }, status: "done" });
    await c.patch(`/api/tasks/${b.id}`, { fields: { [est.id]: 4 } });
    const lonely = await task("Lonely");
    const rows = await listed();
    const p = rows.find((r) => r.title === "Parent")!;
    expect(p.fields[sum.id]).toBe(8);
    expect(p.fields[avg.id]).toBe(3);
    expect(p.fields[cnt.id]).toBe(3);
    expect(p.fields[done.id]).toBe(1);
    expect(p.fields[pct.id]).toBe(33);
    expect(p.fields[mn.id]).toBe(3);
    expect(p.fields[mx.id]).toBe(40);
    void cost;
    const l = rows.find((r) => r.id === lonely.id)!;
    expect(l.fields[sum.id]).toBe(0);
    expect(l.fields[avg.id]).toBe(null);
    expect(l.fields[cnt.id]).toBe(0);
    expect(l.fields[pct.id]).toBe(null);
    expect(l.fields[mn.id]).toBe(null);
    // GET /api/computed/tasks/:id lists each computed field with its value.
    const comp = (await c.get(`/api/computed/tasks/${parent.id}`)).body;
    expect(comp.computed.find((x: { name: string }) => x.name === "Sub points").value).toBe(8);
    expect(comp.computed.find((x: { name: string }) => x.name === "Cost").value).toBe(null);
  });

  it("rolls up an epic's items and their subtasks, and a formula can read a rollup", async () => {
    const all = await field("Epic points", "rollup", { source: "epic_children", fn: "sum", field: "points" });
    const pct = await field("Epic done", "rollup", { source: "epic_children", fn: "percent_done" });
    const direct = await field("Direct", "rollup", { source: "subtasks", fn: "count" });
    const f = await field("Points left", "formula", { expression: `{Epic points} - 1` });
    const epic = await task("Epic", { type: "epic" });
    const s1 = await task("Story 1", { parentId: epic.id, points: 5, type: "story" });
    await task("Story 2", { parentId: epic.id, points: 3, type: "story" });
    await task("Sub of story", { parentId: s1.id, points: 2 });
    await c.patch(`/api/tasks/${s1.id}`, { status: "done" });
    const e = await byTitle("Epic");
    expect(e.fields[all.id]).toBe(10);
    expect(e.fields[pct.id]).toBe(33);
    expect(e.fields[direct.id]).toBe(2);
    expect(e.fields[f.id]).toBe(9);
    // On a task that is not an epic, epic_children is an empty set.
    const s = await byTitle("Story 1");
    expect(s.fields[all.id]).toBe(0);
    expect(s.fields[direct.id]).toBe(1);
  });

  it("aggregates in plain functions", () => {
    const rows = [{ status: "done", points: 2 }, { status: "todo", points: null }, { status: "doing", points: 4 }] as never[];
    const val = (r: { points: number | null }) => r.points;
    expect(aggregate({ source: "subtasks", fn: "sum", field: "points" }, rows, val as never)).toBe(6);
    expect(aggregate({ source: "subtasks", fn: "average", field: "points" }, rows, val as never)).toBe(3);
    expect(aggregate({ source: "subtasks", fn: "percent_done", field: null }, rows, val as never)).toBe(33);
    expect(aggregate({ source: "subtasks", fn: "count_done", field: null }, [], val as never)).toBe(0);
    expect(aggregate({ source: "subtasks", fn: "max", field: "points" }, [], val as never)).toBe(null);
  });

  it("shows project rollups over the project's tasks and keeps them out of task columns", async () => {
    const budget = await field("Budget", "currency");
    const total = await field("Total budget", "rollup", { source: "project", fn: "sum", field: budget.id });
    const progress = await field("Project progress", "rollup", { source: "project", fn: "percent_done" });
    const pts = await field("Total points", "rollup", { source: "project", fn: "sum", field: "points" });
    const a = await task("A", { points: 2 });
    const b = await task("B", { points: 3 });
    await task("Epic", { type: "epic", points: 100 });
    await c.patch(`/api/tasks/${a.id}`, { fields: { [budget.id]: 1000.5 }, status: "done" });
    await c.patch(`/api/tasks/${b.id}`, { fields: { [budget.id]: 499.5 } });
    const r = await c.get(`/api/computed/projects/${pid}/rollups`);
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.rollups.map((x: { id: string; value: unknown }) => [x.id, x.value]));
    expect(by[total.id]).toBe(1500);
    expect(by[progress.id]).toBe(50);
    expect(by[pts.id]).toBe(5);
    expect(r.body.taskCount).toBe(2);
    const row = await byTitle("A");
    expect(row.fields[total.id]).toBeUndefined();
    // An empty project: rollups with nothing to add up.
    const empty = (await c.post("/api/projects", { name: "Empty", key: "EMP" })).body.project.id;
    expect((await c.get(`/api/computed/projects/${empty}/rollups`)).body.rollups).toEqual([]);
  });
});

describe("templates", () => {
  it("leaves formula and rollup fields out of a project template, so using it still works", async () => {
    await field("Budget", "number");
    await field("Twice", "formula", { expression: "{Budget} * 2" });
    await field("Sum", "rollup", { source: "subtasks", fn: "sum", field: "points" });
    const saved = await c.post("/api/templates", { kind: "project", fromProjectId: pid, name: "With formulas" });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    const used = await c.post(`/api/templates/${saved.body.template.id}/use`, { name: "Copy" });
    expect(used.status, JSON.stringify(used.body)).toBe(201);
  });
});

describe("permissions", () => {
  it("refuses another workspace's ids, signed out and guest sessions", async () => {
    const budget = await field("Budget", "number");
    const f = await field("Twice", "formula", { expression: "{Budget} * 2" });
    await field("Sum", "rollup", { source: "project", fn: "count" });
    const t = await task("Ours");
    const other = new Client(ctx.app);
    await other.signup("eve@else.io", "Eve Else", "Else");
    expect((await other.get(`/api/computed/projects/${pid}/rollups`)).status).toBe(404);
    expect((await other.get(`/api/computed/tasks/${t.id}`)).status).toBe(404);
    expect((await other.get(`/api/computed/preview?projectId=${pid}&expression=${encodeURIComponent("1")}`)).status).toBe(404);
    expect((await other.post("/api/fields", { projectId: pid, name: "Hack", type: "formula", config: { expression: "1" } })).status).toBe(404);
    expect((await other.patch(`/api/fields/${f.id}`, { config: { expression: "2" } })).status).toBe(404);
    // A formula can only name fields on its own project.
    const theirs = (await other.post("/api/projects", { name: "Theirs", key: "THR" })).body.project.id;
    const theirField = (await other.post("/api/fields", { projectId: theirs, name: "Secret", type: "number" })).body.field;
    expect((await c.post("/api/fields", { projectId: pid, name: "Peek", type: "formula", config: { expression: "{Secret}" } })).status).toBe(422);
    expect((await c.post("/api/fields", { projectId: pid, name: "Peek", type: "rollup", config: { source: "subtasks", fn: "sum", field: theirField.id } })).status).toBe(422);
    expect((await new Client(ctx.app).get(`/api/computed/tasks/${t.id}`)).status).toBe(401);
    void budget;
  });

  it("serves REST and MCP; read only keys read and can't define fields; other workspaces are refused", async () => {
    const budget = await field("Budget", "number");
    const f = await field("Twice", "formula", { expression: "{Budget} * 2" });
    await field("Count", "rollup", { source: "project", fn: "count" });
    const t = await task("Ours");
    await c.patch(`/api/tasks/${t.id}`, { fields: { [budget.id]: 21 } });
    const ro = (await c.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret;
    const rw = (await c.post("/api/developer/keys", { name: "rw" })).body.secret;
    const h = (k: string) => ({ host: "localhost", authorization: `Bearer ${k}` });
    const comp = await ctx.app.request(`/api/v1/tasks/${t.ref}/computed`, { headers: h(ro) });
    expect(comp.status).toBe(200);
    const cj = await comp.json() as { computed: { fieldId: string; value: unknown }[] };
    expect(cj.computed.find((x) => x.fieldId === f.id)!.value).toBe(42);
    const roll = await ctx.app.request(`/api/v1/projects/${pid}/rollups`, { headers: h(ro) });
    expect(roll.status).toBe(200);
    expect(((await roll.json()) as { rollups: { value: unknown }[] }).rollups[0].value).toBe(1);
    // Field endpoints take the new types.
    const created = await ctx.app.request(`/api/v1/projects/${pid}/fields`, { method: "POST", headers: { ...h(rw), "content-type": "application/json" }, body: JSON.stringify({ name: "Plus one", type: "formula", config: { expression: "{Budget} + 1" } }) });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { field: { config: unknown } }).field.config).toEqual({ expression: "{Budget} + 1" });
    const refused = await ctx.app.request(`/api/v1/projects/${pid}/fields`, { method: "POST", headers: { ...h(ro), "content-type": "application/json" }, body: JSON.stringify({ name: "No", type: "formula", config: { expression: "1" } }) });
    expect(refused.status).toBe(403);
    expect((await ctx.app.request(`/api/v1/projects/${pid}/rollups`, { headers: { host: "localhost" } })).status).toBe(401);
    const other = new Client(ctx.app);
    await other.signup("eve@else.io", "Eve Else", "Else");
    const evil = (await other.post("/api/developer/keys", { name: "k" })).body.secret;
    expect((await ctx.app.request(`/api/v1/projects/${pid}/rollups`, { headers: h(evil) })).status).toBe(404);
    expect((await ctx.app.request(`/api/v1/tasks/${t.id}/computed`, { headers: h(evil) })).status).toBe(404);

    const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
    const connect = async (key: string) => {
      const m = new McpClient({ name: "test", version: "1.0.0" });
      await m.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
      return m;
    };
    const text = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content)[0].text);
    const mro = await connect(ro);
    const got = await mro.callTool({ name: "get_computed_fields", arguments: { taskId: t.ref } });
    expect(got.isError).toBeFalsy();
    expect(text(got).computed.find((x: { fieldId: string }) => x.fieldId === f.id).value).toBe(42);
    const proj = await mro.callTool({ name: "get_computed_fields", arguments: { projectId: pid } });
    expect(text(proj).rollups[0].value).toBe(1);
    const no = await mro.callTool({ name: "create_formula_field", arguments: { projectId: pid, name: "Nope", expression: "1" } });
    expect(no.isError).toBe(true);
    const no2 = await mro.callTool({ name: "create_rollup_field", arguments: { projectId: pid, name: "Nope", source: "subtasks", fn: "count" } });
    expect(no2.isError).toBe(true);
    await mro.close();
    const mrw = await connect(rw);
    const made = await mrw.callTool({ name: "create_formula_field", arguments: { projectId: pid, name: "Triple", expression: "{Budget} * 3" } });
    expect(made.isError).toBeFalsy();
    expect(text(made).field.type).toBe("formula");
    const rolled = await mrw.callTool({ name: "create_rollup_field", arguments: { projectId: pid, name: "Sub sum", source: "subtasks", fn: "sum", field: "points" } });
    expect(text(rolled).field.config).toEqual({ source: "subtasks", fn: "sum", field: "points" });
    const badF = await mrw.callTool({ name: "create_formula_field", arguments: { projectId: pid, name: "Bad", expression: "process.exit()" } });
    expect(badF.isError).toBe(true);
    await mrw.close();
    expect((await byTitle("Ours")).fields[text(made).field.id]).toBe(63);
  });
});
