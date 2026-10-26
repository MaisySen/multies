import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { notifications, taskWatchers } from "@/server/db/schema";
import { notifyWatchersBulk } from "@/server/services/suite/task-watchers-bulk-r28";

/** R28: watchers hear about bulk status changes like single ones (web bulk bar, v1 bulk), batched within D1's limit. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let orgId: string;
let ownerId: string;
let projectId: string;

async function teammate(email: string, name: string) {
  const invite = await c.post("/api/team/invites", { email, role: "member" });
  const m = new Client(ctx.app);
  await m.signup(email, name, "");
  expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  return { client: m, id: (await m.get("/api/account/me")).body.user.id as string };
}
async function api(key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", "content-type": "application/json" }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}
const watchStatus = (userId: string) => ctx.db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.type, "task.watch_status"))).all();
async function watchAll(userId: string, taskIds: string[]) {
  for (const taskId of taskIds) await ctx.db.insert(taskWatchers).values({ taskId, userId, orgId, source: "manual", createdAt: new Date() });
}
async function makeTasks(n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await c.post("/api/tasks", { title: `Task ${i + 1}`, projectId })).body.task.id);
  return ids;
}

beforeEach(async () => {
  ctx = await makeTestApp();
  let clock = Date.parse("2026-10-26T02:00:00Z");
  ctx.deps.now = () => new Date((clock += 1000));
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  const me = (await c.get("/api/account/me")).body;
  ownerId = me.user.id;
  orgId = me.organization.id;
  projectId = (await c.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id;
});

describe("bulk status changes notify watchers", () => {
  it("a bulk move of 130 tasks tells each watcher once per task, never the actor, under their settings", async () => {
    const sam = await teammate("sam@acme.io", "Sam Mate");
    const kim = await teammate("kim@acme.io", "Kim Lee");
    const ids = await makeTasks(130);
    await watchAll(sam.id, ids); // the owner watches all 130 as creator
    await watchAll(kim.id, ids.slice(0, 60));

    const r = await c.post("/api/tasks/bulk", { ids, patch: { status: "done" } });
    expect(r.status).toBe(200);
    expect(r.body.updated).toBe(130);

    const samN = await watchStatus(sam.id);
    expect(samN).toHaveLength(130);
    expect(new Set(samN.map((n) => n.entityId))).toEqual(new Set(ids));
    const first = samN.find((n) => n.entityId === ids[0])!;
    expect(first).toMatchObject({ entityType: "task", actorName: "Olive Owner", orgId });
    expect(first.title).toMatch(/^LAU-1 moved to .+: Task 1$/);
    const kimN = await watchStatus(kim.id);
    expect(kimN).toHaveLength(60);
    expect(new Set(kimN.map((n) => n.entityId))).toEqual(new Set(ids.slice(0, 60)));
    expect(await watchStatus(ownerId)).toHaveLength(0); // the actor
    // Kim turns status notifications off: the next bulk move tells Sam only.
    expect((await kim.client.put("/api/notifications/settings", { settings: { status: { inApp: false } } })).status).toBe(200);
    await c.post("/api/tasks/bulk", { ids: ids.slice(0, 60), patch: { status: "todo" } });
    expect(await watchStatus(kim.id)).toHaveLength(60);
    expect(await watchStatus(sam.id)).toHaveLength(190);
    await c.post("/api/tasks/bulk", { ids: ids.slice(0, 60), patch: { status: "done" } });
    // The inbox shows them like a single move's.
    const inbox = (await sam.client.get("/api/notifications?limit=200")).body.notifications as { type: string }[];
    expect(inbox.filter((n) => n.type === "task.watch_status")).toHaveLength(200);

    // Same title as a single move.
    const one = (await c.post("/api/tasks", { title: "Solo", projectId })).body.task.id;
    await watchAll(sam.id, [one]);
    await c.patch(`/api/tasks/${one}`, { status: "doing" });
    const single = (await watchStatus(sam.id)).find((n) => n.entityId === one)!;
    await c.patch(`/api/tasks/${one}`, { status: "todo" });
    await c.post("/api/tasks/bulk", { ids: [one], patch: { status: "doing" } });
    const bulkOne = (await watchStatus(sam.id)).filter((n) => n.entityId === one);
    expect(bulkOne).toHaveLength(3);
    expect(bulkOne.filter((n) => n.title === single.title)).toHaveLength(2);

    // A bulk call that moves nothing tells nobody.
    const before = (await watchStatus(sam.id)).length;
    await c.post("/api/tasks/bulk", { ids, patch: { status: "done" } });
    await c.post("/api/tasks/bulk", { ids, patch: { priority: "high" } });
    expect(await watchStatus(sam.id)).toHaveLength(before);
  });

  it("works from the v1 bulk route, skips people who left and only tells about tasks that moved", async () => {
    const sam = await teammate("sam@acme.io", "Sam Mate");
    const kim = await teammate("kim@acme.io", "Kim Lee");
    const ids = await makeTasks(125);
    await watchAll(sam.id, ids);
    await watchAll(kim.id, ids);
    await c.patch(`/api/tasks/${ids[0]}`, { status: "done" }); // already done: not moved by the bulk call
    const samBefore = (await watchStatus(sam.id)).length;
    const kimBefore = (await watchStatus(kim.id)).length; // the single move above
    // Kim leaves the workspace: her watch rows stay, but she hears nothing.
    expect((await c.del(`/api/team/members/${kim.id}`)).status).toBeLessThan(300);
    const key = (await c.post("/api/developer/keys", { name: "Ops" })).body.secret;
    const r = await api(key, "POST", "/tasks/bulk", { ids, patch: { status: "done" } });
    expect(r.status).toBe(200);
    const samN = await watchStatus(sam.id);
    expect(samN.length - samBefore).toBe(124);
    expect(await watchStatus(kim.id)).toHaveLength(kimBefore);
    // A workspace key counts as its creator, as for a single move: the owner made the change and hears nothing.
    expect(await watchStatus(ownerId)).toHaveLength(0);
  });

  it("past the row cap each watcher gets one summary row instead", async () => {
    const sam = await teammate("sam@acme.io", "Sam Mate");
    const kim = await teammate("kim@acme.io", "Kim Lee");
    const ids = await makeTasks(12);
    await watchAll(sam.id, ids);
    await watchAll(kim.id, ids.slice(0, 1));
    const out = await notifyWatchersBulk(ctx.deps, orgId, ids.map((id, i) => ({ taskId: id, title: `LAU-${i + 1} moved to Done: Task ${i + 1}` })), { actorName: "Olive Owner", statusName: "Done" }, [ownerId], { max: 10 });
    expect(out).toEqual({ rows: 2, summary: true });
    const samN = await watchStatus(sam.id);
    expect(samN).toHaveLength(1);
    expect(samN[0]).toMatchObject({ title: "12 tasks you watch moved to Done", entityId: ids[0] });
    const kimN = await watchStatus(kim.id);
    expect(kimN).toHaveLength(1);
    expect(kimN[0].title).toBe("LAU-1 moved to Done: Task 1");
    expect(await notifyWatchersBulk(ctx.deps, orgId, [], {}, [])).toEqual({ rows: 0, summary: false });
  });
});
