import { describe, expect, it } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { MIGRATIONS } from "@/server/db/migrations.generated";

/**
 * R48 (0087, 0088): the counts the task lists show live on the task row, and the per project status counts live in a
 * summary table; triggers keep both. Every write path below is driven through the API, then the stored values are
 * compared with a fresh recount from the source rows for every task and project.
 */
type Raw = { prepare: (q: string) => { all: (...a: unknown[]) => Record<string, unknown>[]; run: (...a: unknown[]) => unknown } };
const raw = (db: unknown) => (db as { $client: Raw }).$client;

const RECOUNT = `select t.id,
  t.comment_count - (select count(*) from task_comments c where c.task_id = t.id and c.deleted_at is null) dc,
  t.checklist_total - (select count(*) from task_checklist_items i where i.task_id = t.id) dct,
  t.checklist_done - (select count(*) from task_checklist_items i where i.task_id = t.id and i.done = 1) dcd,
  t.subtask_total - (select count(*) from tasks s where s.parent_id = t.id and s.deleted_at is null) dst,
  t.subtask_done - (select count(*) from tasks s where s.parent_id = t.id and s.deleted_at is null and s.status = 'done') dsd,
  t.field_count - (select count(*) from task_field_values v where v.task_id = t.id) df
  from tasks t`;
const SUMMARY = `select org_id, project_id, status, n from project_status_counts where n > 0 order by 1, 2, 3`;
const GROUPED = `select org_id, project_id, status, count(*) n from tasks where deleted_at is null and triage_state is null group by 1, 2, 3 order by 1, 2, 3`;

function expectConsistent(db: unknown) {
  const c = raw(db);
  const off = c.prepare(RECOUNT).all().filter((r) => Object.entries(r).some(([k, v]) => k !== "id" && v !== 0));
  expect(off).toEqual([]);
  expect(c.prepare(SUMMARY).all()).toEqual(c.prepare(GROUPED).all());
}

async function seed() {
  const ctx = await makeTestApp();
  const c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  const p = (await c.post("/api/projects", { name: "Launch", key: "LAU" })).body.project;
  const q = (await c.post("/api/projects", { name: "Other", key: "OTH" })).body.project;
  const done = p.statuses.find((s: { category: string }) => s.category === "done").id as string;
  const todo = p.statuses.find((s: { category: string }) => s.category === "todo").id as string;
  const task = async (body: Record<string, unknown>) => { const r = await c.post("/api/tasks", { projectId: p.id, ...body }); expect(r.status).toBe(201); return r.body.task; };
  return { ...ctx, c, p, q, done, todo, task };
}

describe("task row counts and project status counts (R48)", () => {
  it("stay equal to a fresh recount through every write path", async () => {
    const { db, app, c, p, q, done, todo, task } = await seed();
    const a = await task({ title: "Parent" });
    const b = await task({ title: "Checklist" });
    // subtasks: create, finish, move to another parent, delete
    const s1 = await task({ title: "Sub one", parentId: a.id });
    const s2 = await task({ title: "Sub two", parentId: a.id });
    const s3 = await task({ title: "Sub three", parentId: a.id });
    expect((await c.patch(`/api/tasks/${s1.id}`, { statusId: done })).status).toBe(200);
    expectConsistent(db);
    expect((await c.patch(`/api/tasks/${s2.id}`, { parentId: b.id })).status).toBe(200);
    expect((await c.del(`/api/tasks/${s3.id}`)).status).toBe(200);
    expectConsistent(db);
    // comments: app, then v1 delete (soft delete)
    const k = (await c.post("/api/developer/keys", { name: "API" })).body.secret as string;
    const v1 = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${k}`, host: "localhost", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const c1 = await c.post(`/api/tasks/${a.id}/comments`, { body: "First" });
    expect(c1.status).toBe(201);
    await c.post(`/api/tasks/${a.id}/comments`, { body: "Second" });
    await v1("POST", `/tasks/${a.id}/comments`, { body: "From the API" });
    const cid = (c1.body.comment?.id ?? c1.body.id) as string;
    expect((await v1("DELETE", `/comments/${cid}`)).status).toBe(200);
    expectConsistent(db);
    // checklist: add, tick, untick, delete, turn into a subtask
    const items = (await c.post(`/api/tasks/${b.id}/checklist`, { items: [{ title: "One" }, { title: "Two" }, { title: "Three" }, { title: "Four" }] })).body.items as { id: string }[];
    expect((await c.patch(`/api/checklist-items/${items[0].id}`, { done: true })).status).toBe(200);
    expect((await c.patch(`/api/checklist-items/${items[1].id}`, { done: true })).status).toBe(200);
    expect((await c.patch(`/api/checklist-items/${items[1].id}`, { done: false })).status).toBe(200);
    expect((await c.del(`/api/checklist-items/${items[2].id}`)).status).toBe(200);
    expect([200, 201]).toContain((await c.post(`/api/checklist-items/${items[3].id}/to-subtask`, {})).status);
    expectConsistent(db);
    // fields: set, clear, delete the field
    const f = (await c.post("/api/fields", { projectId: p.id, name: "Hours", type: "number" })).body.field;
    expect((await c.patch(`/api/tasks/${a.id}`, { fields: { [f.id]: 3 } })).status).toBe(200);
    expect((await c.patch(`/api/tasks/${b.id}`, { fields: { [f.id]: 5 } })).status).toBe(200);
    expectConsistent(db);
    expect((await c.patch(`/api/tasks/${b.id}`, { fields: { [f.id]: null } })).status).toBe(200);
    expectConsistent(db);
    // bulk: status, project move, delete
    const x = await task({ title: "Bulk one" });
    const y = await task({ title: "Bulk two", parentId: a.id });
    expect((await c.post("/api/tasks/bulk", { ids: [x.id, y.id], patch: { statusId: done } })).status).toBe(200);
    expectConsistent(db);
    expect((await c.post("/api/tasks/bulk", { ids: [x.id], patch: { projectId: q.id } })).status).toBe(200);
    expectConsistent(db);
    expect((await c.patch(`/api/tasks/${x.id}`, { statusId: todo })).status).toBeLessThan(500);
    expect((await c.post("/api/tasks/bulk-delete", { ids: [y.id] })).status).toBe(200);
    expectConsistent(db);
    // parent delete takes its subtasks with it; project delete takes every task
    expect((await c.del(`/api/tasks/${a.id}`)).status).toBe(200);
    expectConsistent(db);
    expect((await c.del(`/api/projects/${q.id}`)).status).toBe(200);
    expectConsistent(db);

    // the list shows the row's counts
    const list = (await c.get(`/api/tasks?projectId=${p.id}`)).body.tasks as { id: string; checklist: unknown; subtasks: unknown; commentCount: number }[];
    const row = list.find((t) => t.id === b.id)!;
    expect(row.checklist).toEqual({ total: 2, done: 1 }); // the fourth item became a subtask
    expect(row.subtasks).toEqual({ total: 2, done: 0 });
    const counts = (await c.get("/api/projects")).body.projects.find((x: { id: string }) => x.id === p.id).counts;
    expect(counts).toEqual({ todo: 3, doing: 0, done: 0 }); // the checklist task and its two subtasks (the list hides subtasks)
  });

  it("counts raw writes too (imports and data moves write rows directly)", async () => {
    const { db, task, p } = await seed();
    const a = await task({ title: "Imported parent" });
    const c = raw(db);
    const org = (c.prepare("select org_id from tasks where id = ?").all(a.id)[0] as { org_id: string }).org_id;
    c.prepare("insert into task_comments (id, org_id, task_id, author_name, body, created_by_type, created_by_id, created_at, updated_at, version) values ('cm1', ?, ?, 'X', 'hi', 'member', 'u', 0, 0, 1)").run(org, a.id);
    c.prepare("insert into task_checklist_items (id, org_id, task_id, title, done, position, created_at, updated_at) values ('ci1', ?, ?, 'x', 1, 0, 0, 0)").run(org, a.id);
    c.prepare("update tasks set triage_state = 'pending' where id = ?").run(a.id);
    expectConsistent(db);
    c.prepare("update tasks set triage_state = null, project_id = ? where id = ?").run(p.id, a.id);
    c.prepare("delete from task_checklist_items where id = 'ci1'").run();
    c.prepare("delete from tasks where id = ?").run(a.id);
    expectConsistent(db);
  });

  it("the migration backfill gives old rows the right counts", async () => {
    const { db, c, p, done, task } = await seed();
    const a = await task({ title: "Old parent" });
    const s = await task({ title: "Old sub", parentId: a.id });
    await c.patch(`/api/tasks/${s.id}`, { statusId: done });
    await c.post(`/api/tasks/${a.id}/comments`, { body: "Old comment" });
    await c.post(`/api/tasks/${a.id}/checklist`, { items: [{ title: "Old item" }] });
    const r = raw(db);
    // as before 0087 and 0088: zero counts, empty summary
    r.prepare("update tasks set comment_count = 0, checklist_total = 0, checklist_done = 0, subtask_total = 0, subtask_done = 0, field_count = 0").run();
    r.prepare("delete from project_status_counts").run();
    const backfill = MIGRATIONS.filter((m) => /^0087|^0088/.test(m.name)).flatMap((m) => m.statements)
      .map((st) => st.replace(/^(--[^\n]*\n)+/, "")).filter((st) => /^(UPDATE|INSERT)/.test(st));
    expect(backfill.length).toBe(5);
    for (const st of backfill) r.prepare(st).run();
    expectConsistent(db);
    expect(r.prepare("select comment_count, checklist_total, subtask_total, subtask_done from tasks where id = ?").all(a.id)[0]).toEqual({ comment_count: 1, checklist_total: 1, subtask_total: 1, subtask_done: 1 });
    expect(p.id).toBeTruthy();
  });
});
