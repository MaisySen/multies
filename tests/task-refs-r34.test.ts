import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";

/** R34: old project keys (after a key edit) and refs a task had before it moved keep working everywhere. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let ops: { id: string }, mb: { id: string };
let t1: { id: string; ref: string }, t2: { id: string; ref: string };

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  ops = (await c.post("/api/projects", { name: "Ops", key: "OPS" })).body.project;
  mb = (await c.post("/api/projects", { name: "Build", key: "MB" })).body.project;
  t1 = (await c.post("/api/tasks", { title: "Rotate keys", projectId: ops.id })).body.task;
  t2 = (await c.post("/api/tasks", { title: "Renew cert", projectId: ops.id })).body.task;
  expect([t1.ref, t2.ref]).toEqual(["OPS-1", "OPS-2"]);
});

const titles = async (q: string) => {
  const r = await c.get(`/api/tasks?q=${encodeURIComponent(q)}&limit=200`);
  expect(r.status).toBe(200);
  return (r.body.tasks as { title: string }[]).map((t) => t.title).sort();
};
const searchTasks = async (q: string) => ((await c.get(`/api/search?q=${encodeURIComponent(q)}`)).body.groups as { type: string; items: { id: string }[] }[]).find((g) => g.type === "tasks")?.items.map((i) => i.id) ?? [];

describe("after a key edit (OPS to PLAT)", () => {
  beforeEach(async () => {
    expect((await c.patch(`/api/projects/${ops.id}`, { key: "PLAT" })).status).toBe(200);
  });
  it("opens, bulk edits, searches and queries by the old key", async () => {
    expect((await c.get("/api/tasks/OPS-1")).body.task.id).toBe(t1.id);
    const bulk = await c.post("/api/tasks/bulk", { ids: ["OPS-1", "ops-2"], patch: { priority: "high" } });
    expect(bulk.status).toBe(200);
    expect((await c.get(`/api/tasks/${t2.id}`)).body.task.priority).toBe("high");
    expect(await searchTasks("OPS-2")).toEqual([t2.id]);
    expect(await titles("project:OPS")).toEqual(["Renew cert", "Rotate keys"]);
    expect(await titles("OPS-1")).toEqual(["Rotate keys"]);
    expect(await titles("OPS-1 OR OPS-2")).toEqual([]); // plain words without a key: one phrase
    expect(await titles("project:OPS priority:high")).toEqual(["Renew cert", "Rotate keys"]);
  });
  it("links an old ref typed in chat to the task, with its ref now", async () => {
    const general = ((await c.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((x) => x.name === "general")!;
    const m = (await c.post(`/api/chat/channels/${general.id}/messages`, { body: "see <#task:OPS-1>" })).body.message;
    expect(m.links).toEqual([expect.objectContaining({ type: "task", id: t1.id, ref: "PLAT-1" })]);
  });
  it("still refuses a ref that is nowhere", async () => {
    const r = await c.post("/api/tasks/bulk", { ids: ["OPS-1", "OPS-99"], patch: { priority: "high" } });
    expect(r.status).toBe(404);
    expect(r.body.error.details.missing).toEqual(["OPS-99"]);
  });
});

describe("after a task moves to another project", () => {
  it("keeps the old ref working for the moved task (single move)", async () => {
    const moved = (await c.patch(`/api/tasks/${t1.id}`, { projectId: mb.id })).body.task;
    expect(moved.ref).toBe("MB-1");
    expect((await c.get("/api/tasks/OPS-1")).body.task.id).toBe(t1.id);
    expect(await searchTasks("OPS-1")).toEqual([t1.id]);
    expect(await titles("OPS-1")).toEqual(["Rotate keys"]);
    expect((await c.post("/api/tasks/bulk", { ids: ["OPS-1"], patch: { priority: "low" } })).status).toBe(200);
    expect((await c.get(`/api/tasks/${t1.id}`)).body.task.priority).toBe("low");
    // A new task in OPS never takes the old number, so OPS-1 can't mean two tasks.
    const t3 = (await c.post("/api/tasks", { title: "New one", projectId: ops.id })).body.task;
    expect(t3.ref).not.toBe("OPS-1");
  });
  it("keeps old refs for a bulk move, and for an old key of the old project", async () => {
    expect((await c.post("/api/tasks/bulk", { ids: ["OPS-1", "OPS-2"], patch: { projectId: mb.id } })).status).toBe(200);
    expect((await c.get("/api/tasks/OPS-2")).body.task.id).toBe(t2.id);
    expect((await c.patch(`/api/projects/${ops.id}`, { key: "PLAT" })).status).toBe(200);
    const again = (await c.patch(`/api/tasks/${t2.id}`, { projectId: ops.id })).body.task;
    expect(again.ref.startsWith("PLAT-")).toBe(true);
    expect((await c.get("/api/tasks/OPS-1")).body.task.id).toBe(t1.id);
    expect((await c.get("/api/tasks/MB-2")).body.task.id).toBe(t2.id); // the ref it had in MB, after it moved back
  });
});
