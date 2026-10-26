import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";

/** R28 (api): the v1 Task schema carries checklist { total, done }, and every v1 task answer fills it with live counts. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let key: string;
let projectId: string;

async function api(method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
type Spec = { components: { schemas: Record<string, { required?: string[]; properties: Record<string, { type?: string; required?: string[]; properties?: Record<string, { type?: string }> }> }> } };
let spec: Spec;
/** Every required key of the spec's Task is on the answer, and checklist has integer counts. */
function matchesSpec(t: Record<string, unknown>) {
  const s = spec.components.schemas.Task;
  for (const k of s.required ?? []) expect(t, `Task.${k}`).toHaveProperty(k);
  const chk = t.checklist as { total: number; done: number };
  expect(Number.isInteger(chk.total) && Number.isInteger(chk.done)).toBe(true);
  expect(chk.done).toBeLessThanOrEqual(chk.total);
}

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  key = (await c.post("/api/developer/keys", { name: "Mobile" })).body.secret;
  projectId = (await c.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id;
  const res = await ctx.app.request("/api/v1/openapi.json", { headers: { host: "localhost" } });
  spec = (await res.json()) as Spec;
});

describe("v1 Task checklist", () => {
  it("is in the OpenAPI Task schema as a required object of two integers", () => {
    const task = spec.components.schemas.Task;
    expect(task.required).toContain("checklist");
    const chk = task.properties.checklist;
    expect(chk.type).toBe("object");
    expect(chk.required?.sort()).toEqual(["done", "total"]);
    expect(chk.properties?.total.type).toBe("integer");
    expect(chk.properties?.done.type).toBe("integer");
  });

  it("is 0 and 0 with no checklist, and follows items added and ticked on list, get, create, update and bulk", async () => {
    const created = await api("POST", "/tasks", { title: "Ship the beta", projectId });
    expect(created.status).toBe(201);
    matchesSpec(created.body.task);
    expect(created.body.task.checklist).toEqual({ total: 0, done: 0 });
    const id = created.body.task.id as string;
    const other = (await api("POST", "/tasks", { title: "Write the FAQ", projectId })).body.task.id as string;

    const added = await api("POST", `/tasks/${id}/checklist`, { items: [{ title: "Tag the build" }, { title: "Release notes" }, { title: "Tell support" }] });
    expect(added.status).toBeLessThan(300);
    const items = added.body.items as { id: string }[];
    expect((await api("PATCH", `/checklist-items/${items[0].id}`, { done: true })).status).toBe(200);
    expect((await api("PATCH", `/checklist-items/${items[2].id}`, { done: true })).status).toBe(200);
    const want = { total: 3, done: 2 };

    const list = (await api("GET", `/tasks?projectId=${projectId}`)).body.tasks as Record<string, unknown>[];
    for (const t of list) matchesSpec(t);
    expect(list.find((t) => t.id === id)!.checklist).toEqual(want);
    expect(list.find((t) => t.id === other)!.checklist).toEqual({ total: 0, done: 0 });
    const inProject = (await api("GET", `/projects/${projectId}/tasks`)).body.tasks as Record<string, unknown>[];
    expect(inProject.find((t) => t.id === id)!.checklist).toEqual(want);

    const got = (await api("GET", `/tasks/${id}`)).body;
    matchesSpec(got.task);
    expect(got.task.checklist).toEqual(want);
    const byRef = (await api("GET", "/tasks/LAU-1")).body;
    expect(byRef.task.checklist).toEqual(want);

    const patched = (await api("PATCH", `/tasks/${id}`, { title: "Ship the beta build" })).body;
    matchesSpec(patched.task);
    expect(patched.task.checklist).toEqual(want);

    const bulk = (await api("POST", "/tasks/bulk", { ids: [id, other], patch: { priority: "high" } })).body;
    for (const t of bulk.tasks) matchesSpec(t);
    expect(bulk.tasks.find((t: { id: string }) => t.id === id).checklist).toEqual(want);
    expect(bulk.tasks.find((t: { id: string }) => t.id === other).checklist).toEqual({ total: 0, done: 0 });

    // Unticking and deleting move the counts.
    await api("PATCH", `/checklist-items/${items[0].id}`, { done: false });
    await api("DELETE", `/checklist-items/${items[1].id}`);
    expect((await api("GET", `/tasks/${id}`)).body.task.checklist).toEqual({ total: 2, done: 1 });
  });

  it("counts checklists on a list of more than 100 tasks in one answer (D1 variable limit)", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 130; i++) ids.push((await c.post("/api/tasks", { title: `Task ${i}`, projectId })).body.task.id);
    for (const id of [ids[0], ids[64], ids[129]]) await api("POST", `/tasks/${id}/checklist`, { items: [{ title: "One", done: true }, { title: "Two" }] });
    const list = (await api("GET", `/tasks?projectId=${projectId}&limit=200`)).body.tasks as { id: string; checklist: { total: number; done: number } }[];
    expect(list.length).toBe(130);
    const withItems = list.filter((t) => t.checklist.total > 0);
    expect(withItems.map((t) => t.id).sort()).toEqual([ids[0], ids[64], ids[129]].sort());
    for (const t of withItems) expect(t.checklist).toEqual({ total: 2, done: 1 });
  });
});
