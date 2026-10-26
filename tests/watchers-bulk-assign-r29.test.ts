import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { taskWatchers } from "@/server/db/schema";
import { autoWatchBulk, WATCH_ROWS_PER_INSERT } from "@/server/services/suite/task-watchers-bulk-assign-r29";
import { WATCHERS_MAX } from "@/server/services/suite/task-watchers-r27";

/** R29: a bulk reassign makes the new member assignee a watcher, like a single reassign, batched within D1's limit. */
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
const watching = async (userId: string) => (await ctx.db.select().from(taskWatchers).where(eq(taskWatchers.userId, userId)).all()).map((w) => w.taskId);
async function makeTasks(n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await c.post("/api/tasks", { title: `Task ${i + 1}`, projectId })).body.task.id);
  return ids;
}

beforeEach(async () => {
  ctx = await makeTestApp();
  let clock = Date.parse("2026-10-26T03:30:00Z");
  ctx.deps.now = () => new Date((clock += 1000));
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  const me = (await c.get("/api/account/me")).body;
  ownerId = me.user.id;
  orgId = me.organization.id;
  projectId = (await c.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id;
});

describe("bulk reassign adds the new assignee as a watcher", () => {
  it("a bulk reassign of 130 tasks makes the new assignee watch all of them, as a single reassign does", async () => {
    const sam = await teammate("sam@acme.io", "Sam Mate");
    const ids = await makeTasks(130);
    // Sam already watches a few by hand: those rows stay manual, no duplicates.
    for (const taskId of ids.slice(0, 3)) await ctx.db.insert(taskWatchers).values({ taskId, userId: sam.id, orgId, source: "manual", createdAt: new Date() });

    const r = await c.post("/api/tasks/bulk", { ids, patch: { assignee: `member:${sam.id}` } });
    expect(r.status).toBe(200);
    expect(r.body.updated).toBe(130);
    const rows = await ctx.db.select().from(taskWatchers).where(eq(taskWatchers.userId, sam.id)).all();
    expect(rows).toHaveLength(130);
    expect(new Set(rows.map((w) => w.taskId))).toEqual(new Set(ids));
    expect(rows.filter((w) => w.source === "manual").map((w) => w.taskId).sort()).toEqual(ids.slice(0, 3).sort());
    expect(rows.every((w) => w.orgId === orgId)).toBe(true);

    // Same result as the single path.
    const one = (await c.post("/api/tasks", { title: "Solo", projectId })).body.task.id;
    await c.patch(`/api/tasks/${one}`, { assignee: `member:${sam.id}` });
    expect(await watching(sam.id)).toContain(one);
  });

  it("unassign and agent assignees add nobody", async () => {
    const sam = await teammate("sam@acme.io", "Sam Mate");
    const ids = await makeTasks(4);
    expect((await c.post("/api/tasks/bulk", { ids, patch: { assignee: null } })).status).toBe(200);
    expect(await watching(sam.id)).toHaveLength(0);
    expect((await c.post("/api/tasks/bulk", { ids: ids.slice(0, 2), patch: { assignee: `member:${sam.id}` } })).status).toBe(200);
    expect((await watching(sam.id)).sort()).toEqual(ids.slice(0, 2).sort());
    // Reassigning to the person who already has them changes nothing and writes nothing new.
    expect((await c.post("/api/tasks/bulk", { ids: ids.slice(0, 2), patch: { assignee: `member:${sam.id}` } })).status).toBe(200);
    expect(await watching(sam.id)).toHaveLength(2);
    // The actor reassigning to themselves also starts watching (the single path does the same).
    expect((await c.post("/api/tasks/bulk", { ids: ids.slice(2), patch: { assignee: `member:${ownerId}` } })).status).toBe(200);
    for (const id of ids.slice(2)) expect(await watching(ownerId)).toContain(id);
  });

  it("skips tasks already at the watcher cap and stays under 100 bound variables per statement", async () => {
    const ids = await makeTasks(2);
    const full = ids[0];
    for (let i = 0; i < WATCHERS_MAX; i++) await ctx.db.insert(taskWatchers).values({ taskId: full, userId: `usr_fake${i}`, orgId, source: "manual", createdAt: new Date() });
    const r = await autoWatchBulk(ctx.deps, orgId, [full, ids[1], ids[1]], "usr_new");
    expect(r.added).toBe(1);
    const rows = await ctx.db.select().from(taskWatchers).where(and(eq(taskWatchers.userId, "usr_new"))).all();
    expect(rows.map((w) => w.taskId)).toEqual([ids[1]]);
    expect(WATCH_ROWS_PER_INSERT * 5).toBeLessThan(100);
    expect(await autoWatchBulk(ctx.deps, orgId, [], "usr_new")).toEqual({ added: 0 });
    expect(await autoWatchBulk(ctx.deps, orgId, ids, null)).toEqual({ added: 0 });
  });
});
