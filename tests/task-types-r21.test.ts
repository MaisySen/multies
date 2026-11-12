import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { tasks } from "@/server/db/schema";
import { epicProgress, pointsWeight } from "@/server/services/suite/task-types";

type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
let ctx: Ctx;
let c: Client;
let projectId: string;

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
async function task(title: string, extra: Record<string, unknown> = {}) {
  const r = await c.post("/api/tasks", { title, projectId, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.task as { id: string; ref: string; type: string; parentId: string | null; version: number };
}

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io");
  // AIS1: new projects start with Triage on; off here so the key's tasks go straight to the lists read below.
  projectId = (await c.post("/api/projects", { name: "Launch", key: "LAU", triage: false })).body.project.id;
});

describe("task types", () => {
  it("defaults to task, and type can be set on create and changed on update", async () => {
    const t = await task("Write copy");
    expect(t.type).toBe("task");
    const b = await task("Login fails on Safari", { type: "bug" });
    expect(b.type).toBe("bug");
    const r = await c.patch(`/api/tasks/${t.id}`, { type: "story" });
    expect(r.status).toBe(200);
    expect(r.body.task.type).toBe("story");
    expect(r.body.task.version).toBe(t.version + 1);
    expect((await c.patch(`/api/tasks/${t.id}`, { type: "nope" })).status).toBe(422);
    const detail = (await c.get(`/api/tasks/${t.ref}`)).body;
    expect(detail.task.type).toBe("story");
    expect(detail.activity.some((a: { data: { type?: string } }) => a.data.type === "story")).toBe(true);
  });

  it("filters the list by type", async () => {
    await task("A"); await task("B", { type: "bug" }); await task("C", { type: "bug" }); await task("D", { type: "epic" });
    const bugs = (await c.get(`/api/tasks?projectId=${projectId}&type=bug`)).body.tasks;
    expect(bugs.map((x: { title: string }) => x.title).sort()).toEqual(["B", "C"]);
    expect((await c.get(`/api/tasks?projectId=${projectId}&type=epic`)).body.tasks).toHaveLength(1);
    expect((await c.get(`/api/tasks?projectId=${projectId}`)).body.tasks).toHaveLength(4);
  });

  it("a repeating bug repeats as a bug", async () => {
    const b = await task("Weekly crash triage", { type: "bug", due: "2026-11-02", repeat: { freq: "weekly", interval: 1 } });
    await c.patch(`/api/tasks/${b.id}`, { status: "done" });
    const open = (await c.get(`/api/tasks?projectId=${projectId}&status=todo`)).body.tasks;
    expect(open).toHaveLength(1);
    expect(open[0].type).toBe("bug");
  });
});

describe("epic rules", () => {
  it("an epic can't go in an epic or under a task, and an item with a parent can't become an epic", async () => {
    const e1 = await task("Checkout", { type: "epic" });
    const e2 = await task("Onboarding", { type: "epic" });
    const t = await task("Card form");
    expect((await c.post("/api/tasks", { title: "Inner", type: "epic", parentId: e1.id })).body.error.code).toBe("epic_in_epic");
    expect((await c.patch(`/api/tasks/${e2.id}`, { parentId: e1.id })).body.error.code).toBe("epic_in_epic");
    expect((await c.patch(`/api/tasks/${e2.id}`, { parentId: t.id })).status).toBe(422);
    expect((await c.post(`/api/epics/${e1.id}/items`, { ids: [e2.id] })).body.error.code).toBe("epic_in_epic");
    expect((await c.post(`/api/epics/${e1.id}/items`, { ids: [e1.id] })).status).toBe(422);
    // A subtask can't become an epic while it has a parent.
    const sub = await task("Validate card", { parentId: t.id });
    const r = await c.patch(`/api/tasks/${sub.id}`, { type: "epic" });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("epic_has_parent");
    // An epic with items keeps its type until they are moved out.
    await c.post(`/api/epics/${e1.id}/items`, { ids: [t.id] });
    expect((await c.patch(`/api/tasks/${e1.id}`, { type: "story" })).body.error.code).toBe("epic_has_items");
    await c.call("DELETE", `/api/epics/${e1.id}/items`, { ids: [t.id] });
    expect((await c.patch(`/api/tasks/${e1.id}`, { type: "story" })).body.task.type).toBe("story");
    // A top level task with subtasks can become an epic: its subtasks are now its items.
    expect((await c.patch(`/api/tasks/${t.id}`, { type: "epic" })).body.task.type).toBe("epic");
    expect((await c.get(`/api/epics/${t.id}`)).body.epic.progress).toMatchObject({ items: 1, total: 1 });
  });

  it("an item is in at most one epic: adding it to another moves it; subtasks of a story stay subtasks", async () => {
    const e1 = await task("Checkout", { type: "epic" });
    const e2 = await task("Payments", { type: "epic" });
    const s = await task("Pay by card", { type: "story" });
    const sub = await task("Card form", { parentId: s.id });
    await c.post(`/api/epics/${e1.id}/items`, { ids: [s.ref] });
    const moved = await c.post(`/api/epics/${e2.id}/items`, { ids: [s.id] });
    expect(moved.body.moved).toBe(1);
    expect((await c.get(`/api/epics/${e1.id}`)).body.items).toHaveLength(0);
    expect((await c.get(`/api/epics/${e2.id}`)).body.items.map((x: { id: string }) => x.id)).toEqual([s.id]);
    expect((await c.get(`/api/tasks/${sub.id}`)).body.task.parentId).toBe(s.id);
    // The board shows epics' items (top level), but not subtasks of a story.
    const board = (await c.get(`/api/tasks?projectId=${projectId}`)).body.tasks.map((x: { title: string }) => x.title).sort();
    expect(board).toEqual(["Checkout", "Pay by card", "Payments"]);
    // Setting parentId to an epic in a normal update also puts it in that epic.
    const t = await task("Receipts");
    await c.patch(`/api/tasks/${t.id}`, { parentId: e1.id });
    expect((await c.get(`/api/epics/${e1.id}`)).body.items.map((x: { id: string }) => x.id)).toEqual([t.id]);
    // Adding again is a no op; removing an item from the wrong epic leaves it alone.
    expect((await c.post(`/api/epics/${e1.id}/items`, { ids: [t.id] })).body.moved).toBe(0);
    expect((await c.call("DELETE", `/api/epics/${e2.id}/items`, { ids: [t.id] })).body.moved).toBe(0);
    expect((await c.get(`/api/tasks/${t.id}`)).body.task.parentId).toBe(e1.id);
  });

  it("refuses a task id that is not an epic, and unknown ids", async () => {
    const t = await task("Plain");
    expect((await c.get(`/api/epics/${t.id}`)).status).toBe(404);
    expect((await c.post(`/api/epics/${t.id}/items`, { ids: [t.id] })).status).toBe(404);
    const e = await task("Epic", { type: "epic" });
    expect((await c.post(`/api/epics/${e.id}/items`, { ids: ["tsk_missing"] })).status).toBe(404);
    expect((await c.post(`/api/epics/${e.id}/items`, { ids: [] })).status).toBe(422);
  });
});

describe("epic progress", () => {
  it("counts items and their subtasks, done of total, with percent and date span", async () => {
    const e = await task("Checkout", { type: "epic" });
    const a = await task("Cart", { start: "2026-11-01", due: "2026-11-05" });
    const b = await task("Pay", { type: "story", due: "2026-11-20" });
    const bug = await task("Rounding", { type: "bug", start: "2026-10-28" });
    await c.post(`/api/epics/${e.id}/items`, { ids: [a.id, b.id, bug.id] });
    await task("Card form", { parentId: b.id, status: "done" });
    await task("Wallets", { parentId: b.id });
    await c.patch(`/api/tasks/${a.id}`, { status: "done" });
    const list = (await c.get(`/api/epics?project=${projectId}`)).body.epics;
    expect(list).toHaveLength(1);
    expect(list[0].progress).toMatchObject({ done: 2, total: 5, percent: 40, items: 3, subtasks: 2, points: null, start: "2026-10-28T00:00:00.000Z", end: "2026-11-20T00:00:00.000Z" });
    const one = (await c.get(`/api/epics/${e.ref}`)).body;
    expect(one.epic.progress.percent).toBe(40);
    expect(one.items.find((x: { id: string }) => x.id === b.id).subtasks).toEqual({ total: 2, done: 1 });
    // Deleted items drop out.
    await c.del(`/api/tasks/${bug.id}`);
    expect((await c.get(`/api/epics/${e.id}`)).body.epic.progress).toMatchObject({ done: 2, total: 4, percent: 50 });
  });

  it("is a pure function with optional points (a weight getter), falling back to counts", () => {
    const rows = [
      { id: "a", parentId: "E", status: "done", points: 3 },
      { id: "b", parentId: "E", status: "todo", points: 5 },
      { id: "c", parentId: "b", status: "done", points: 2 },
      { id: "d", parentId: "b", status: "doing" },
      { id: "x", parentId: "other", status: "done", points: 99 },
      { id: "y", parentId: "x", status: "done", points: 99 },
    ];
    const byCount = epicProgress("E", rows);
    expect(byCount).toMatchObject({ done: 2, total: 4, percent: 50, items: 2, subtasks: 2, points: null });
    const byPoints = epicProgress("E", rows, pointsWeight);
    expect(byPoints.points).toEqual({ done: 5, total: 10, percent: 50 });
    // Any weight getter works, for example a custom field.
    expect(epicProgress("E", rows, (r) => (r.id === "a" ? 1 : r.id === "b" ? 3 : null)).points).toEqual({ done: 1, total: 4, percent: 25 });
    // No weights at all: points stays null; an empty epic is 0 of 0.
    expect(epicProgress("E", rows.map(({ points: _p, ...r }) => r), pointsWeight).points).toBeNull();
    expect(epicProgress("none", rows)).toMatchObject({ done: 0, total: 0, percent: 0, start: null, end: null });
  });
});

describe("REST v1 and permissions", () => {
  it("a workspace key creates typed tasks, filters by type, lists epics and adds items; a read only key can only read", async () => {
    const ws = (await c.post("/api/developer/keys", { name: "ws" })).body.secret;
    const ro = (await c.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret;
    const k = new Client(ctx.app);
    const mk = async (body: Record<string, unknown>) => (await k.call("POST", "/api/v1/tasks", { projectId, ...body }, bearer(ws))).body;
    const e = await mk({ title: "Mobile app", type: "epic" });
    expect(e.task?.type ?? e.type).toBe("epic");
    const epicId = e.task?.id ?? e.id;
    const b = await mk({ title: "Crash on launch", type: "bug" });
    const t = await mk({ title: "App icon" });
    const bugId = b.task?.id ?? b.id, tId = t.task?.id ?? t.id;
    const bugs = (await k.call("GET", "/api/v1/tasks?type=bug", undefined, bearer(ws))).body.tasks;
    expect(bugs.map((x: { id: string }) => x.id)).toEqual([bugId]);
    const added = await k.call("POST", `/api/v1/epics/${epicId}/items`, { ids: [bugId, tId] }, bearer(ws));
    expect(added.status).toBe(200);
    expect(added.body.moved).toBe(2);
    await k.call("PATCH", `/api/v1/tasks/${tId}`, { status: "done" }, bearer(ws));
    const listed = await k.call("GET", `/api/v1/epics?project=${projectId}`, undefined, bearer(ro));
    expect(listed.status).toBe(200);
    expect(listed.body.epics[0].progress).toMatchObject({ done: 1, total: 2, percent: 50 });
    expect((await k.call("GET", `/api/v1/epics/${epicId}`, undefined, bearer(ro))).body.items).toHaveLength(2);
    // Read only: no adding, no removing, no type change.
    expect((await k.call("POST", `/api/v1/epics/${epicId}/items`, { ids: [tId] }, bearer(ro))).status).toBe(403);
    expect((await k.call("DELETE", `/api/v1/epics/${epicId}/items`, { ids: [tId] }, bearer(ro))).status).toBe(403);
    expect((await k.call("PATCH", `/api/v1/tasks/${tId}`, { type: "bug" }, bearer(ro))).status).toBe(403);
    expect((await k.call("DELETE", `/api/v1/epics/${epicId}/items`, { ids: [tId] }, bearer(ws))).body.moved).toBe(1);
    // No key: refused.
    expect((await k.call("GET", "/api/v1/epics", undefined, {})).status).toBe(401);
  });

  it("another workspace can't see or change this workspace's epics or put its tasks in them", async () => {
    const e = await task("Ours", { type: "epic" });
    const mine = await task("Our task");
    const other = new Client(ctx.app);
    await other.signup("eve@evil.io", "Eve", "Evil");
    const p2 = (await other.post("/api/projects", { name: "Theirs" })).body.project.id;
    const theirs = (await other.post("/api/tasks", { title: "Their task", projectId: p2 })).body.task;
    const theirEpic = (await other.post("/api/tasks", { title: "Their epic", projectId: p2, type: "epic" })).body.task;
    expect((await other.get(`/api/epics/${e.id}`)).status).toBe(404);
    expect((await other.get("/api/epics")).body.epics.map((x: { id: string }) => x.id)).toEqual([theirEpic.id]);
    expect((await other.post(`/api/epics/${e.id}/items`, { ids: [theirs.id] })).status).toBe(404);
    // Their epic, our task: our task is not found for them.
    expect((await other.post(`/api/epics/${theirEpic.id}/items`, { ids: [mine.id] })).status).toBe(404);
    expect((await c.post(`/api/epics/${e.id}/items`, { ids: [theirs.id] })).status).toBe(404);
    expect((await c.patch(`/api/tasks/${mine.id}`, { parentId: theirEpic.id })).status).toBe(404);
    const row = (await ctx.db.select().from(tasks).where(eq(tasks.id, mine.id)).get())!;
    expect(row.parentId).toBeNull();
    // A signed out caller gets nothing.
    expect((await new Client(ctx.app).get("/api/epics")).status).toBe(401);
    const otherKey = (await other.post("/api/developer/keys", { name: "theirs" })).body.secret;
    expect((await other.call("GET", `/api/v1/epics/${e.id}`, undefined, bearer(otherKey))).status).toBe(404);
  });

  it("an invited member can use epics like tasks", async () => {
    const e = await task("Team epic", { type: "epic" });
    const inv = await c.post("/api/team/invites", { email: "mate@acme.io", role: "member" });
    const m = new Client(ctx.app);
    await m.signup("mate@acme.io", "Mate", "");
    expect((await m.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
    const t = (await m.post("/api/tasks", { title: "Member task", projectId, type: "story" })).body.task;
    expect((await m.post(`/api/epics/${e.id}/items`, { ids: [t.id] })).body.moved).toBe(1);
    expect((await c.get(`/api/epics/${e.id}`)).body.items.map((x: { type: string }) => x.type)).toEqual(["story"]);
  });
});

describe("MCP: list_epics, get_epic, add_to_epic and typed tasks", () => {
  async function connect(key: string) {
    const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
    const client = new McpClient({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
    return client;
  }
  const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);

  it("creates an epic and a bug, adds the bug, reads progress; a read only key can't add", async () => {
    const ws = (await c.post("/api/developer/keys", { name: "ws" })).body.secret;
    const mcp = await connect(ws);
    const epic = data(await mcp.callTool({ name: "create_task", arguments: { title: "Billing", projectId, type: "epic" } })).task;
    expect(epic.type).toBe("epic");
    const bug = data(await mcp.callTool({ name: "create_task", arguments: { title: "Tax rounding", projectId, type: "bug" } })).task;
    const story = data(await mcp.callTool({ name: "create_task", arguments: { title: "Invoices", projectId, parentId: epic.id, type: "story" } })).task;
    expect(story.parentId).toBe(epic.id);
    const added = data(await mcp.callTool({ name: "add_to_epic", arguments: { epicId: epic.ref, ids: [bug.ref] } }));
    expect(added.moved).toBe(1);
    expect(added.epic.progress).toMatchObject({ total: 2, done: 0 });
    const upd = data(await mcp.callTool({ name: "update_task", arguments: { id: bug.id, status: "done", type: "bug" } })).task;
    expect(upd.type).toBe("bug");
    const listed = data(await mcp.callTool({ name: "list_epics", arguments: { projectId } })).epics;
    expect(listed).toHaveLength(1);
    expect(listed[0].progress).toMatchObject({ done: 1, total: 2, percent: 50 });
    const one = data(await mcp.callTool({ name: "get_epic", arguments: { id: epic.id } }));
    expect(one.items.map((x: { type: string }) => x.type).sort()).toEqual(["bug", "story"]);
    const bugs = data(await mcp.callTool({ name: "list_tasks", arguments: { type: "bug" } })).tasks;
    expect(bugs.map((x: { id: string; type: string }) => [x.id, x.type])).toEqual([[bug.id, "bug"]]);
    const inner = await mcp.callTool({ name: "update_task", arguments: { id: story.id, type: "epic" } });
    expect(inner.isError).toBe(true);
    const removed = data(await mcp.callTool({ name: "add_to_epic", arguments: { epicId: epic.id, ids: [bug.id], remove: true } }));
    expect(removed.moved).toBe(1);
    await mcp.close();

    const ro = (await c.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret;
    const r = await connect(ro);
    const refused = await r.callTool({ name: "add_to_epic", arguments: { epicId: epic.id, ids: [bug.id] } });
    expect(refused.isError).toBe(true);
    expect((refused.content as { text: string }[])[0].text).toContain("read_only_key");
    expect(data(await r.callTool({ name: "list_epics", arguments: {} })).epics).toHaveLength(1);
    const notEpic = await r.callTool({ name: "get_epic", arguments: { id: bug.id } });
    expect(notEpic.isError).toBe(true);
    await r.close();
  });
});
