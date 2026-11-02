/** POL1 (MB-313): tables and courses to the trash with restore, behind POLISH_POL1. Roles: owner and admin always, a
 * table's maker for their own table, members never for a course, read only keys never. Flag off keeps today's rules. */
import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { canTrash } from "../src/server/services/trash-rules-pol1";
import { titleText } from "../src/web/lib/page-title-pol1";

const ON = { TABLES_R125: "on", COURSES_R129: "on", POLISH_POL1: "on" };
async function setup(env: Record<string, string> = ON) {
  const ctx = await makeTestApp(env);
  const c = new Client(ctx.app);
  await c.signup("ada@acme.io", "Ada Lovelace", "Acme");
  return { ...ctx, c };
}
async function mate(t: Awaited<ReturnType<typeof setup>>, email = "mate-pol1@example.com", role = "member") {
  const invite = await t.c.post("/api/team/invites", { email, role });
  const m = new Client(t.app);
  await m.signup(email, "Mate", "");
  expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  return m;
}
const table = async (c: Client, title = "Jobs") => { const r = await c.post("/api/tables", { title }); expect(r.status).toBe(201); return r.body.table.id as string; };
const course = async (c: Client, title = "Safety") => { const r = await c.post("/api/courses", { title }); expect(r.status).toBe(201); return r.body.course.id as string; };

describe("POL1 trash rules", () => {
  it("canTrash per role and kind", () => {
    expect(canTrash({ role: "owner", userId: "u1" }, "course", "x")).toBe(true);
    expect(canTrash({ role: "admin", userId: "u1" }, "table", "x")).toBe(true);
    expect(canTrash({ role: "member", userId: "u1" }, "table", "u1")).toBe(true);
    expect(canTrash({ role: "member", userId: "u1" }, "table", "u2")).toBe(false);
    expect(canTrash({ role: "member", userId: "u1" }, "course", "u1")).toBe(false);
    expect(canTrash({ role: "owner", userId: "u1", scope: "read" }, "table", "u1")).toBe(false);
    expect(canTrash({ role: "member", userId: null } as unknown as Parameters<typeof canTrash>[0], "table", null)).toBe(false);
  });
  it("titles name the page", () => {
    expect(titleText(["Jobs board", "Docs"])).toBe("Jobs board · Docs · Multies");
    expect(titleText(["  My   learning ", null, "Docs"])).toBe("My learning · Docs · Multies");
    expect(titleText(["x".repeat(100)]).length).toBeLessThan(100);
  });
});

describe("POL1 trash API", () => {
  it("is off without the flag: no trash routes, the docs delete works as before", async () => {
    const t = await setup({ TABLES_R125: "on", COURSES_R129: "on" });
    const id = await table(t.c);
    expect((await t.c.del(`/api/tables/${id}`)).status).toBe(404);
    expect((await t.c.get("/api/docs/trash")).status).toBe(404);
    expect((await t.c.get(`/api/tables/${id}`)).body.table.canDelete).toBe(false);
    const m = await mate(t);
    expect((await m.del(`/api/docs/${id}`)).status).toBe(200); // today's behaviour, unchanged with the flag off
    expect((await t.c.get("/api/config")).body.polishPol1).toBeFalsy();
  });

  it("an owner trashes a table and a course, sees them in the trash and restores them with their contents", async () => {
    const t = await setup();
    expect((await t.c.get("/api/config")).body.polishPol1).toBe(true);
    const tid = await table(t.c);
    expect((await t.c.post(`/api/tables/${tid}/rows`, { rows: [{}, {}] })).status).toBe(201);
    const cid = await course(t.c);
    expect((await t.c.post(`/api/courses/${cid}/lessons`, { type: "text", title: "Exits", body: "Two exits." })).status).toBe(201);
    expect((await t.c.get(`/api/tables/${tid}`)).body.table.canDelete).toBe(true);
    expect((await t.c.get(`/api/courses/${cid}`)).body.course.canDelete).toBe(true);
    expect((await t.c.del(`/api/tables/${tid}`)).status).toBe(200);
    expect((await t.c.del(`/api/courses/${cid}`)).status).toBe(200);
    expect((await t.c.get(`/api/tables/${tid}`)).status).toBe(404);
    expect((await t.c.get(`/api/courses/${cid}`)).status).toBe(404);
    expect((await t.c.del(`/api/tables/${tid}`)).status).toBe(404); // already in the trash
    const trash = (await t.c.get("/api/docs/trash")).body;
    expect(trash.items.map((i: { id: string }) => i.id).sort()).toEqual([tid, cid].sort());
    expect(trash.days).toBe(30);
    expect((await t.c.post(`/api/docs/${tid}/restore`, {})).status).toBe(200);
    expect((await t.c.post(`/api/docs/${cid}/restore`, {})).status).toBe(200);
    expect((await t.c.get(`/api/tables/${tid}`)).body.table.rowCount).toBe(2);
    expect((await t.c.get(`/api/courses/${cid}`)).body.lessons.length).toBe(1);
    expect((await t.c.get("/api/docs/trash")).body.items).toEqual([]);
    expect((await t.c.post(`/api/docs/${tid}/restore`, {})).status).toBe(404); // not in the trash any more
  });

  it("a member may trash their own table, not someone else's, and never a course; the docs delete follows the same rules", async () => {
    const t = await setup();
    const m = await mate(t);
    const ownersTable = await table(t.c, "Owner's");
    const mine = await table(m, "Mine");
    const cid = await course(t.c);
    expect((await m.get(`/api/tables/${ownersTable}`)).body.table.canDelete).toBe(false);
    expect((await m.get(`/api/tables/${mine}`)).body.table.canDelete).toBe(true);
    expect((await m.del(`/api/tables/${ownersTable}`)).status).toBe(403);
    expect((await m.del(`/api/docs/${ownersTable}`)).status).toBe(403);
    expect((await m.del(`/api/courses/${cid}`)).status).toBe(403);
    expect((await m.del(`/api/docs/${cid}`)).status).toBe(403);
    expect((await m.del(`/api/tables/${mine}`)).status).toBe(200);
    const list = (await m.get("/api/docs/trash")).body.items.map((i: { id: string }) => i.id);
    expect(list).toEqual([mine]);
    expect((await t.c.del(`/api/tables/${ownersTable}`)).status).toBe(200);
    expect((await m.post(`/api/docs/${ownersTable}/restore`, {})).status).toBe(403);
    expect((await m.post(`/api/docs/${mine}/restore`, {})).status).toBe(200);
  });

  it("an admin can trash a course; learners lose it from My learning and get it back with their progress on restore", async () => {
    const t = await setup();
    const admin = await mate(t, "admin-pol1@example.com", "admin");
    const learner = await mate(t, "learner-pol1@example.com");
    const cid = await course(t.c);
    expect((await t.c.post(`/api/courses/${cid}/lessons`, { type: "text", title: "Exits", body: "Two exits." })).status).toBe(201);
    expect((await t.c.patch(`/api/courses/${cid}`, { status: "published" })).status).toBe(200);
    expect((await t.c.post(`/api/courses/${cid}/assign`, { everyone: true })).status).toBeLessThan(300);
    expect((await learner.get("/api/courses/learning")).body.items.length).toBe(1);
    expect((await admin.del(`/api/courses/${cid}`)).status).toBe(200);
    expect((await learner.get("/api/courses/learning")).body.items.length).toBe(0);
    expect((await admin.post(`/api/docs/${cid}/restore`, {})).status).toBe(200);
    expect((await learner.get("/api/courses/learning")).body.items.length).toBe(1);
  });

  it("a plain doc is not affected: restore refuses it and the docs delete is unchanged", async () => {
    const t = await setup();
    const m = await mate(t);
    const d = await t.c.post("/api/docs", { title: "Plan" });
    expect((await m.del(`/api/docs/${d.body.doc.id}`)).status).toBe(200);
    expect((await t.c.post(`/api/docs/${d.body.doc.id}/restore`, {})).status).toBe(404);
  });
});
