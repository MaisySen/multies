import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { notifications, taskWatchers } from "@/server/db/schema";
import { cleanViewFilters } from "@/server/services/suite/tasks";
import { cleanTagName } from "@/server/services/suite/tags-r84";

/** R84: saved views with sort, group and pins; several assignees; workspace tags; workspace fields; bulk for these. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let ownerId: string;
let projectId: string;

async function teammate(email: string, name: string) {
  const invite = await c.post("/api/team/invites", { email, role: "member" });
  const m = new Client(ctx.app);
  await m.signup(email, name, "");
  expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  return { client: m, id: (await m.get("/api/account/me")).body.user.id as string };
}
const newTask = async (title: string, extra: Record<string, unknown> = {}, pid = projectId) => (await c.post("/api/tasks", { title, projectId: pid, ...extra })).body.task as { id: string; ref: string; version: number };
const notesFor = async (userId: string) => (await ctx.db.select().from(notifications).where(eq(notifications.userId, userId)).all()).filter((n) => n.type === "task.assigned");

beforeEach(async () => {
  ctx = await makeTestApp();
  let clock = Date.parse("2026-10-31T08:00:00Z");
  ctx.deps.now = () => new Date((clock += 1000));
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  ownerId = (await c.get("/api/account/me")).body.user.id;
  projectId = (await c.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id;
});

describe("saved views", () => {
  it("keeps sort, direction and grouping, drops what a list can't use, and pins as a tab", async () => {
    expect(cleanViewFilters("list", { sort: "due", dir: "desc", group: "assignee", status: "doing", junk: "" })).toEqual({ sort: "due", dir: "desc", group: "assignee", status: "doing" });
    expect(cleanViewFilters("list", { sort: "drop table", group: "colour" })).toEqual({});
    expect(cleanViewFilters("list", { group: "field:fld_123" })).toEqual({ group: "field:fld_123" });
    // A board keeps its own group (a select field or epic) as before.
    expect(cleanViewFilters("board", { group: "epic" })).toEqual({ group: "epic" });

    const made = await c.post("/api/tasks/views", { name: "My due soon", view: "list", filters: { sort: "due", group: "priority" }, pinned: true });
    expect(made.status).toBe(201);
    expect(made.body.view).toMatchObject({ name: "My due soon", shared: false, pinned: true, canEdit: true, filters: { sort: "due", group: "priority" } });
    const id = made.body.view.id as string;
    const patched = await c.patch(`/api/tasks/views/${id}`, { name: "Due soon", shared: true, pinned: false, filters: { sort: "priority", dir: "desc", group: "tag" } });
    expect(patched.status).toBe(200);
    expect(patched.body.view).toMatchObject({ name: "Due soon", shared: true, pinned: false, filters: { sort: "priority", dir: "desc", group: "tag" } });
  });

  it("a private view is only its owner's; a shared one is changed by its maker or an admin", async () => {
    const mia = await teammate("mia@acme.io", "Mia Member");
    const mine = (await c.post("/api/tasks/views", { name: "Private", view: "list", filters: {} })).body.view;
    const shared = (await c.post("/api/tasks/views", { name: "Team", view: "board", filters: {}, shared: true, pinned: true })).body.view;
    const seen = (await mia.client.get("/api/tasks/views")).body.views as { id: string; canEdit: boolean; pinned: boolean }[];
    expect(seen.map((v) => v.id)).toEqual([shared.id]);
    expect(seen[0]).toMatchObject({ canEdit: false, pinned: true });
    expect((await mia.client.patch(`/api/tasks/views/${mine.id}`, { name: "Took it" })).status).toBe(404);
    expect((await mia.client.patch(`/api/tasks/views/${shared.id}`, { name: "Renamed" })).status).toBe(403);
    expect((await mia.client.del(`/api/tasks/views/${shared.id}`)).status).toBe(403);
    // Her own shared view is hers to change, and the owner (admin) can change it too.
    const hers = (await mia.client.post("/api/tasks/views", { name: "Mia's", view: "list", filters: {}, shared: true })).body.view;
    expect((await mia.client.patch(`/api/tasks/views/${hers.id}`, { pinned: true })).status).toBe(200);
    expect((await c.patch(`/api/tasks/views/${hers.id}`, { name: "Checked" })).status).toBe(200);
  });
});

describe("several assignees", () => {
  it("sets everyone on a task, main first; lists and filters find each one; only newly added people hear it", async () => {
    const mia = await teammate("mia@acme.io", "Mia Member");
    const sam = await teammate("sam@acme.io", "Sam Smith");
    const t = await newTask("Launch post");
    const r = await c.patch(`/api/tasks/${t.id}`, { assignees: [`member:${mia.id}`, `member:${sam.id}`, `member:${mia.id}`] });
    expect(r.status).toBe(200);
    expect(r.body.task.assignee).toMatchObject({ id: mia.id, name: "Mia Member" });
    expect(r.body.task.assignees.map((a: { name: string }) => a.name)).toEqual(["Mia Member", "Sam Smith"]);
    expect(await notesFor(mia.id)).toHaveLength(1);
    expect(await notesFor(sam.id)).toHaveLength(1);
    // Both now watch it.
    expect((await ctx.db.select().from(taskWatchers).where(eq(taskWatchers.taskId, t.id)).all()).map((w) => w.userId).sort()).toEqual(expect.arrayContaining([mia.id, sam.id]));

    // The co assignee's filter finds the task; so does "me" for her.
    const bySam = (await c.get(`/api/tasks?assignee=member:${sam.id}`)).body.tasks as { id: string }[];
    expect(bySam.map((x) => x.id)).toContain(t.id);
    expect(((await sam.client.get("/api/tasks?assignee=me")).body.tasks as { id: string }[]).map((x) => x.id)).toContain(t.id);

    // Adding the owner hears nobody new except... the owner did it, so nobody.
    await c.patch(`/api/tasks/${t.id}`, { assignees: [`member:${mia.id}`, `member:${sam.id}`, `member:${ownerId}`] });
    expect(await notesFor(mia.id)).toHaveLength(1);
    expect(await notesFor(ownerId)).toHaveLength(0);

    // The old single assignee field keeps the others and never lists one twice; unassigning clears everyone.
    const swap = await c.patch(`/api/tasks/${t.id}`, { assignee: `member:${sam.id}` });
    expect(swap.body.task.assignees.map((a: { id: string }) => a.id)).toEqual([sam.id, ownerId]);
    const none = await c.patch(`/api/tasks/${t.id}`, { assignee: null });
    expect(none.body.task.assignees).toEqual([]);
    expect((await c.patch(`/api/tasks/${t.id}`, { assignees: ["member:usr_nobody"] })).status).toBe(422);
    expect((await c.patch(`/api/tasks/${t.id}`, { assignees: ["boss"] })).status).toBe(422);
  });

  it("bulk adds people: the first becomes main where there is none; each person hears once", async () => {
    const mia = await teammate("mia@acme.io", "Mia Member");
    const sam = await teammate("sam@acme.io", "Sam Smith");
    const a = await newTask("A");
    const b = await newTask("B", { assignee: `member:${sam.id}` });
    const r = await c.post("/api/tasks/bulk", { ids: [a.id, b.id], patch: { addAssignees: [`member:${mia.id}`] } });
    expect(r.status).toBe(200);
    const byId = new Map((r.body.tasks as { id: string; assignees: { id: string }[] }[]).map((x) => [x.id, x.assignees.map((p) => p.id)]));
    expect(byId.get(a.id)).toEqual([mia.id]);
    expect(byId.get(b.id)).toEqual([sam.id, mia.id]);
    expect(await notesFor(mia.id)).toHaveLength(1);
    expect((await notesFor(mia.id))[0].title).toBe("2 tasks assigned to you");
  });
});

describe("workspace tags", () => {
  it("makes, colours, renames (rewriting tasks) and removes tags", async () => {
    expect(cleanTagName("  big   launch ")).toBe("big launch");
    const t1 = await newTask("One", { labels: ["urgent", "web"] });
    await newTask("Two", { labels: ["Urgent"] });
    const tag = (await c.post("/api/tasks/tags", { name: "urgent", color: "#dc2626" })).body.tag;
    expect(tag).toMatchObject({ name: "urgent", color: "#dc2626" });
    // Same name again hands the same tag back.
    expect((await c.post("/api/tasks/tags", { name: "URGENT" })).body.tag.id).toBe(tag.id);
    const second = (await c.post("/api/tasks/tags", { name: "web" })).body.tag;
    expect(second.color).toMatch(/^#[0-9a-f]{6}$/);
    const listed = (await c.get("/api/tasks/tags?counts=1")).body.tags as { name: string; count: number }[];
    expect(listed.find((x) => x.name === "urgent")?.count).toBe(2);

    expect((await c.patch(`/api/tasks/tags/${second.id}`, { name: "Urgent" })).status).toBe(409);
    expect((await c.patch(`/api/tasks/tags/${tag.id}`, { color: "red" })).status).toBe(422);
    const renamed = await c.patch(`/api/tasks/tags/${tag.id}`, { name: "now" });
    expect(renamed.body).toMatchObject({ tag: { name: "now" }, tasksChanged: 2 });
    expect((await c.get(`/api/tasks/${t1.id}`)).body.task.labels).toEqual(["now", "web"]);
    const gone = await c.del(`/api/tasks/tags/${second.id}`);
    expect(gone.body).toMatchObject({ ok: true, tasksChanged: 1 });
    expect((await c.get(`/api/tasks/${t1.id}`)).body.task.labels).toEqual(["now"]);
  });
});

describe("workspace fields", () => {
  it("one definition shows in every project (new ones too), filters and sorts across projects, and bulk sets values", async () => {
    const other = (await c.post("/api/projects", { name: "Ops", key: "OPS" })).body.project.id as string;
    const made = await c.post("/api/fields/workspace", { name: "Stage", type: "select", options: [{ label: "Idea" }, { label: "Live" }] });
    expect(made.status).toBe(201);
    const key = made.body.field.key as string;
    expect(made.body.field).toMatchObject({ name: "Stage", projects: 2 });
    const live = (made.body.field.options as { id: string; label: string }[]).find((o) => o.label === "Live")!;
    const later = (await c.post("/api/projects", { name: "Later", key: "LTR" })).body.project.id as string;
    const inLater = (await c.get(`/api/fields?projectId=${later}`)).body.fields as { workspaceKey: string; options: { id: string }[] }[];
    expect(inLater[0]).toMatchObject({ workspaceKey: key });
    expect(inLater[0].options.map((o) => o.id)).toContain(live.id);
    expect((await c.post("/api/fields/workspace", { name: "stage", type: "text" })).status).toBe(409);
    expect((await c.post("/api/fields/workspace", { name: "Calc", type: "formula" })).status).toBe(422);

    const a = await newTask("A");
    const b = await newTask("B", {}, other);
    const bulk = await c.post("/api/tasks/bulk", { ids: [a.id, b.id], patch: { fields: { [key]: live.id } } });
    expect(bulk.status).toBe(200);
    const all = (await c.get(`/api/tasks?field.${key}=${live.id}`)).body.tasks as { id: string; fields: Record<string, unknown> }[];
    expect(all.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(all[0].fields[key]).toBe(live.id);
    expect((await c.get(`/api/tasks?sort=field:${key}`)).status).toBe(200);

    const renamed = await c.patch(`/api/fields/workspace/${key}`, { name: "Phase" });
    expect(renamed.body.field).toMatchObject({ name: "Phase", projects: 3 });
    expect(((await c.get(`/api/fields?projectId=${other}`)).body.fields as { name: string }[])[0].name).toBe("Phase");
    expect((await c.del(`/api/fields/workspace/${key}`)).status).toBe(200);
    expect((await c.get("/api/fields/workspace")).body.fields).toEqual([]);
    expect((await c.get(`/api/tasks/${a.id}`)).body.task.fields).toEqual({});
  });
});
