/** R126 People: staff directory rules, onboarding templates to tasks (dates, idempotency), away, assets with history,
 * CSV, permissions per role (owner, admin, member, signed out, other workspace), flag off and the vv8k exclusion. */
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { addDays, csvCell, isYmd, makesLoop, nextAssetTag, orgTree, planRunTasks, toCsv, warrantySoon, cleanTags } from "@/shared/people-r126";
import { isPeopleExcluded } from "@/server/services/people-r126";

type P = { userId: string; email: string; name: string; managerUserId: string | null };

async function setup(env: Record<string, string> = { PEOPLE_R126: "on" }) {
  const ctx = await makeTestApp(env);
  const admin = new Client(ctx.app);
  await admin.signup("ada@acme.io", "Ada Lovelace", "Acme");
  const join = async (email: string, name: string, role: "member" | "admin" = "member") => {
    const inv = await admin.post("/api/team/invites", { email, role });
    const m = new Client(ctx.app);
    await m.signup(email, name, `${name} Co`);
    expect((await m.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
    return m;
  };
  const ids = async () => {
    const r = await admin.get("/api/people/staff");
    return Object.fromEntries((r.body.people as P[]).map((p) => [p.email, p.userId])) as Record<string, string>;
  };
  const tasksFor = async (label: string) => ctx.deps.db.all<{ id: string; title: string; due_at: number; assignee_id: string; status: string }>(
    sql`select id, title, due_at, assignee_id, status from tasks where labels like ${`%"${label}"%`} and deleted_at is null order by title`);
  return { ctx, admin, join, ids, tasksFor };
}

describe("R126 pure rules", () => {
  it("dates, plans, tags, tags list, csv guard, warranty soon, tree and loops", () => {
    expect(isYmd("2026-02-29")).toBe(false);
    expect(isYmd("2028-02-29")).toBe(true);
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    const plan = planRunTasks([{ id: "a", title: "Laptop", offsetDays: -3, owner: "assigner" }, { id: "b", title: "Meet team", offsetDays: 0, owner: "manager" },
      { id: "c", title: "Read handbook", offsetDays: 7, owner: "person" }], "2026-11-09", { person: "p", manager: null, assigner: "admin" });
    expect(plan.map((x) => [x.due, x.assigneeUserId])).toEqual([["2026-11-06", "admin"], ["2026-11-09", "admin"], ["2026-11-16", "p"]]);
    expect(planRunTasks([{ id: "b", title: "x", offsetDays: 1, owner: "manager" }], "2026-11-09", { person: "p", manager: "m", assigner: "a" })[0].assigneeUserId).toBe("m");
    expect(cleanTags([" React ", "react", "", 5, "Design"])).toEqual(["React", "Design"]);
    expect(csvCell("=HYPERLINK(1)")).toBe(`"'=HYPERLINK(1)"`);
    expect(csvCell('say "hi"')).toBe(`"say ""hi"""`);
    expect(toCsv([["a", "-1"]])).toBe(`"a","'-1"\r\n`);
    expect(nextAssetTag(["A-0001", "A-0009", "X-5"])).toBe("A-0010");
    const soon = warrantySoon([{ id: 1, warrantyEnd: "2026-12-01", status: "in_use" }, { id: 2, warrantyEnd: "2027-06-01", status: "in_use" },
      { id: 3, warrantyEnd: "2026-10-01", status: "in_stock" }, { id: 4, warrantyEnd: "2026-11-05", status: "retired" }, { id: 5, warrantyEnd: null, status: "in_use" }], "2026-11-02");
    expect(soon.map((x) => x.id)).toEqual([3, 1]);
    const people = [{ userId: "a", managerUserId: null }, { userId: "b", managerUserId: "a" }, { userId: "c", managerUserId: "b" }, { userId: "x", managerUserId: "y" }, { userId: "y", managerUserId: "x" }];
    expect(orgTree(people).map((n) => `${n.person.userId}${n.depth}`)).toEqual(["a0", "b1", "c2", "x0", "y1"]);
    expect(makesLoop(people, "a", "c")).toBe(true);
    expect(makesLoop(people, "c", "a")).toBe(false);
    expect(makesLoop(people, "a", "a")).toBe(true);
    expect(isPeopleExcluded({ id: "org_1", slug: "vv8k-clients" })).toBe(true);
    expect(isPeopleExcluded({ id: "org_1", slug: "acme" }, "other")).toBe(false);
  });
});

describe("R126 people API", () => {
  it("flag off: every People route answers 404 and config says off", async () => {
    const { admin } = await setup({});
    expect((await admin.get("/api/people/staff")).status).toBe(404);
    expect((await admin.get("/api/people/assets")).status).toBe(404);
    expect((await admin.get("/api/config")).body.peopleR126).toBeFalsy();
  });

  it("signed out gets 401; another workspace gets 404 for an asset (the QR link opens only for members)", async () => {
    const { ctx, admin } = await setup();
    const a = await admin.post("/api/people/assets", { name: "MacBook Air", kind: "laptop", serial: "C02X" });
    expect(a.status).toBe(201);
    expect(a.body.asset.tag).toBe("A-0001");
    const anon = new Client(ctx.app);
    expect((await anon.get(`/api/people/assets/${a.body.asset.id}`)).status).toBe(401);
    expect((await anon.get("/api/people/staff")).status).toBe(401);
    const other = new Client(ctx.app);
    await other.signup("eve@other.io", "Eve", "Other");
    expect((await other.get(`/api/people/assets/${a.body.asset.id}`)).status).toBe(404);
    expect((await other.get("/api/people/staff")).body.people.map((p: P) => p.email)).toEqual(["eve@other.io"]);
  });

  it("directory: members read and edit only their own profile; admins set manager and start date; loops refused", async () => {
    const { admin, join, ids } = await setup();
    const bob = await join("bob@acme.io", "Bob Smith");
    await join("cat@acme.io", "Cat Jones");
    const id = await ids();
    const list = await bob.get("/api/people/staff");
    expect(list.status).toBe(200);
    expect(list.body.people).toHaveLength(3);
    expect(list.body.isAdmin).toBe(false);
    // Own profile: allowed fields only.
    const ok = await bob.patch(`/api/people/staff/${id["bob@acme.io"]}`, { title: "Designer", team: "Product", skills: ["Figma", "figma", "Research"], location: "Sydney", phone: "+61 400 000 000", daysOff: [0, 6, 5] });
    expect(ok.status).toBe(200);
    expect(ok.body.person).toMatchObject({ title: "Designer", team: "Product", skills: ["Figma", "Research"], daysOff: [0, 5, 6] });
    expect((await bob.patch(`/api/people/staff/${id["bob@acme.io"]}`, { managerUserId: id["ada@acme.io"] })).status).toBe(403);
    expect((await bob.patch(`/api/people/staff/${id["cat@acme.io"]}`, { title: "Boss" })).status).toBe(403);
    expect((await bob.patch(`/api/people/staff/${id["bob@acme.io"]}`, { phone: "call me <script>" })).status).toBe(400);
    expect((await bob.patch(`/api/people/staff/${id["bob@acme.io"]}`, { daysOff: [0, 1, 2, 3, 4, 5, 6] })).status).toBe(400);
    // Fields outside the allow list are ignored (no salary or ID numbers can be stored).
    await bob.patch(`/api/people/staff/${id["bob@acme.io"]}`, { salary: 100000, taxFileNumber: "123" });
    expect(JSON.stringify((await bob.get(`/api/people/staff/${id["bob@acme.io"]}`)).body)).not.toMatch(/100000|taxFile/);
    // Admin edits anyone, sets manager and start date; a loop is refused.
    expect((await admin.patch(`/api/people/staff/${id["bob@acme.io"]}`, { managerUserId: id["ada@acme.io"], startDate: "2026-11-09" })).status).toBe(200);
    expect((await admin.patch(`/api/people/staff/${id["cat@acme.io"]}`, { managerUserId: id["bob@acme.io"] })).status).toBe(200);
    expect((await admin.patch(`/api/people/staff/${id["ada@acme.io"]}`, { managerUserId: id["cat@acme.io"] })).status).toBe(400);
    expect((await admin.patch(`/api/people/staff/${id["bob@acme.io"]}`, { startDate: "2026-02-30" })).status).toBe(400);
    const prof = await bob.get(`/api/people/staff/${id["bob@acme.io"]}`);
    expect(prof.body).toMatchObject({ canEdit: true, canAdmin: false, manager: { name: "Ada Lovelace" }, reports: [{ name: "Cat Jones" }] });
    expect((await bob.get(`/api/people/staff/${id["cat@acme.io"]}`)).body.canEdit).toBe(false);
    expect((await bob.get("/api/people/staff/nobody")).status).toBe(404);
  });

  it("away: members add and remove their own; admins anyone; ranges validated; listed by window", async () => {
    const { admin, join, ids } = await setup();
    const bob = await join("bob@acme.io", "Bob Smith");
    const id = await ids();
    const r = await bob.post(`/api/people/staff/${id["bob@acme.io"]}/away`, { startDate: "2026-12-22", endDate: "2027-01-02", note: "Holiday" });
    expect(r.status).toBe(201);
    expect((await bob.post(`/api/people/staff/${id["ada@acme.io"]}/away`, { startDate: "2026-12-22" })).status).toBe(403);
    expect((await bob.post(`/api/people/staff/${id["bob@acme.io"]}/away`, { startDate: "2026-12-22", endDate: "2026-12-01" })).status).toBe(400);
    expect((await admin.post(`/api/people/staff/${id["bob@acme.io"]}/away`, { startDate: "2026-11-20" })).status).toBe(201);
    expect((await bob.get("/api/people/away?from=2026-12-01&to=2026-12-31")).body.away).toHaveLength(1);
    expect((await bob.get("/api/people/away?from=2026-11-01&to=2026-12-31")).body.away).toHaveLength(2);
    const adminOwn = await admin.post(`/api/people/staff/${id["ada@acme.io"]}/away`, { startDate: "2026-11-21" });
    expect((await bob.del(`/api/people/away/${adminOwn.body.away.id}`)).status).toBe(403);
    expect((await bob.del(`/api/people/away/${r.body.away.id}`)).status).toBe(200);
  });

  it("onboarding: admin templates become tasks with the right owners and dates; reassign never duplicates", async () => {
    const { admin, join, ids, tasksFor } = await setup();
    const bob = await join("bob@acme.io", "Bob Smith");
    const id = await ids();
    expect((await bob.post("/api/people/templates", { name: "Starter", items: [{ title: "x" }] })).status).toBe(403);
    expect((await admin.post("/api/people/templates", { name: "Starter", items: [] })).status).toBe(400);
    expect((await admin.post("/api/people/templates", { name: "Starter", items: [{ title: "x", offsetDays: 999 }] })).status).toBe(400);
    const t = await admin.post("/api/people/templates", { name: "New starter", kind: "onboarding", items: [
      { title: "Order laptop", offsetDays: -5, owner: "assigner" }, { title: "Welcome lunch", offsetDays: 0, owner: "manager" }, { title: "Read handbook", offsetDays: 3, owner: "person" }] });
    expect(t.status).toBe(201);
    expect((await bob.get("/api/people/templates")).status).toBe(200); // members may read, not change
    await admin.patch(`/api/people/staff/${id["bob@acme.io"]}`, { startDate: "2026-11-09" });
    expect((await bob.post(`/api/people/staff/${id["bob@acme.io"]}/runs`, { templateId: t.body.template.id })).status).toBe(403);
    const r1 = await admin.post(`/api/people/staff/${id["bob@acme.io"]}/runs`, { templateId: t.body.template.id });
    expect(r1.status).toBe(200);
    expect(r1.body.created).toBe(3);
    let rows = await tasksFor("onboarding");
    expect(rows.map((x) => [x.title, new Date(x.due_at).toISOString().slice(0, 10), x.assignee_id])).toEqual([
      ["Order laptop", "2026-11-04", id["ada@acme.io"]], ["Read handbook", "2026-11-12", id["bob@acme.io"]], ["Welcome lunch", "2026-11-09", id["ada@acme.io"]]]);
    // Same assign again: nothing new.
    const r2 = await admin.post(`/api/people/staff/${id["bob@acme.io"]}/runs`, { templateId: t.body.template.id });
    expect(r2.body.created).toBe(0);
    expect(await tasksFor("onboarding")).toHaveLength(3);
    // New start date moves open tasks; a new item adds exactly one task.
    const items = [...t.body.template.items, { title: "Set up payroll access", offsetDays: 1, owner: "assigner" }];
    await admin.put(`/api/people/templates/${t.body.template.id}`, { name: "New starter", kind: "onboarding", items });
    const r3 = await admin.post(`/api/people/staff/${id["bob@acme.io"]}/runs`, { templateId: t.body.template.id, startDate: "2026-11-16" });
    expect(r3.body).toMatchObject({ created: 1, moved: 3 });
    rows = await tasksFor("onboarding");
    expect(rows).toHaveLength(4);
    expect(new Date(rows.find((x) => x.title === "Read handbook")!.due_at).toISOString().slice(0, 10)).toBe("2026-11-19");
    // Progress shows on the profile, and finishing a task counts.
    const prof = await bob.get(`/api/people/staff/${id["bob@acme.io"]}`);
    expect(prof.body.runs[0]).toMatchObject({ name: "New starter", startDate: "2026-11-16", done: 0, total: 4 });
    // Offboarding is its own checklist on the same person.
    const off = await admin.post("/api/people/templates", { name: "Leaver", kind: "offboarding", items: [{ title: "Access review", offsetDays: 0, owner: "assigner" }, { title: "Return laptop", offsetDays: 0, owner: "person" }] });
    expect((await admin.post(`/api/people/staff/${id["bob@acme.io"]}/runs`, { templateId: off.body.template.id, startDate: "2027-03-01" })).body.created).toBe(2);
    expect(await tasksFor("offboarding")).toHaveLength(2);
    // Removing a run keeps its tasks.
    expect((await admin.del(`/api/people/runs/${r1.body.runs[0].id}`)).status).toBe(200);
    expect(await tasksFor("onboarding")).toHaveLength(4);
  });

  it("assets: admins create, edit, assign and return with history; members read only; CSV is admin only and safe", async () => {
    const { admin, join, ids } = await setup();
    const bob = await join("bob@acme.io", "Bob Smith");
    const id = await ids();
    expect((await bob.post("/api/people/assets", { name: "Phone" })).status).toBe(403);
    expect((await admin.post("/api/people/assets", { name: "" })).status).toBe(400);
    expect((await admin.post("/api/people/assets", { name: "X", purchaseDate: "2026-05-01", warrantyEnd: "2026-01-01" })).status).toBe(400);
    const a = (await admin.post("/api/people/assets", { name: "=cmd|calc", kind: "phone", valueCents: 129900, purchaseDate: "2026-01-10", warrantyEnd: "2026-12-10" })).body.asset;
    const b = (await admin.post("/api/people/assets", { name: "Drill", kind: "tool" })).body.asset;
    expect(b.tag).toBe("A-0002");
    expect((await admin.post(`/api/people/assets/${a.id}/assign`, { userId: id["bob@acme.io"] })).body.asset).toMatchObject({ status: "in_use", assignedName: "Bob Smith" });
    expect((await bob.post(`/api/people/assets/${a.id}/assign`, { userId: null })).status).toBe(403);
    expect((await admin.post(`/api/people/assets/${a.id}/assign`, { userId: id["ada@acme.io"] })).status).toBe(200);
    expect((await admin.post(`/api/people/assets/${a.id}/assign`, { userId: null })).body.asset).toMatchObject({ status: "in_stock", assignedUserId: null });
    expect((await admin.post(`/api/people/assets/${a.id}/assign`, { userId: "user_nope" })).status).toBe(404);
    const view = await bob.get(`/api/people/assets/${a.id}`);
    expect(view.status).toBe(200);
    expect(view.body.canEdit).toBe(false);
    expect(view.body.history.map((h: { action: string }) => h.action)).toEqual(["returned", "assigned", "returned", "assigned", "created"]);
    await admin.patch(`/api/people/assets/${b.id}`, { status: "retired" });
    expect((await admin.post(`/api/people/assets/${b.id}/assign`, { userId: id["bob@acme.io"] })).status).toBe(400);
    expect((await bob.get("/api/people/assets.csv")).status).toBe(403);
    const csv = await admin.get("/api/people/assets.csv");
    expect(csv.status).toBe(200);
    expect(String(csv.body)).toContain(`"'=cmd|calc"`);
    expect(String(csv.body)).toContain(`"A-0001","'=cmd|calc","Phone"`);
    // Profile lists what the person holds.
    await admin.post(`/api/people/assets/${a.id}/assign`, { userId: id["bob@acme.io"] });
    expect((await bob.get(`/api/people/staff/${id["bob@acme.io"]}`)).body.assets.map((x: { tag: string }) => x.tag)).toEqual(["A-0001"]);
    expect((await bob.del(`/api/people/assets/${a.id}`)).status).toBe(403);
    expect((await admin.del(`/api/people/assets/${a.id}`)).status).toBe(200);
  });

  it("vv8k workspaces never see People", async () => {
    const ctx = await makeTestApp({ PEOPLE_R126: "on" });
    const c = new Client(ctx.app);
    await c.signup("x@vv8k.io", "X", "vv8k");
    expect((await c.get("/api/people/staff")).status).toBe(404);
  });
});
