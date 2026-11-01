import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let clock = 0;
let me: { userId: string; orgId: string };
let projectId = "";

async function setup(env: Record<string, string> = { TASKS_PLUS_R95: "on" }) {
  ctx = await makeTestApp(env);
  clock = new Date("2026-11-02T23:00:00.000Z").getTime(); // Tue 3 Nov 2026, 10:00 Sydney
  ctx.deps.now = () => new Date((clock += 1000));
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  const body = (await c.get("/api/account/me")).body;
  me = { userId: body.user.id, orgId: body.organization.id };
  projectId = (await c.post("/api/projects", { name: "Ops" })).body.project.id;
}
async function teammate(email = "mate@acme.io", name = "Sam Mate") {
  const invite = await c.post("/api/team/invites", { email, role: "member" });
  const m = new Client(ctx.app);
  await m.signup(email, name, "");
  expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  return { client: m, id: (await m.get("/api/account/me")).body.user.id as string };
}
const task = async (title: string, extra: Record<string, unknown> = {}, who = c) => (await who.post("/api/tasks", { projectId, title, ...extra })).body.task;

describe("R95 flag", () => {
  it("everything new is hidden while the flag is off", async () => {
    await setup({});
    expect((await c.get("/api/my-day?day=2026-11-03")).status).toBe(404);
    expect((await c.get("/api/timesheets/week?week=2026-11-02")).status).toBe(404);
    expect((await c.get("/api/time/export.csv")).status).toBe(404);
    expect((await c.get("/api/config")).body.tasksPlus).toBe(false);
  });
});

describe("R95 My Day", () => {
  beforeEach(() => setup());

  it("suggests my tasks due today, blocks time and refuses overlaps", async () => {
    expect((await c.get("/api/config")).body.tasksPlus).toBe(true);
    const a = await task("Write brief", { assignee: `member:${me.userId}`, due: "2026-11-03T05:00:00.000Z" });
    const b = await task("Call supplier");
    const day = (await c.get("/api/my-day?day=2026-11-03&tz=Australia/Sydney")).body;
    expect(day.items).toEqual([]);
    expect(day.suggestions.map((s: { id: string }) => s.id)).toContain(a.id);
    const first = await c.post("/api/my-day", { day: "2026-11-03", taskId: a.id, start: 547, minutes: 50 });
    expect(first.status).toBe(201);
    expect(first.body.item).toMatchObject({ start: 540, minutes: 45, task: { title: "Write brief" } });
    const clash = await c.post("/api/my-day", { day: "2026-11-03", taskId: b.id, start: 570, minutes: 30 });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe("time_taken");
    const ok = await c.post("/api/my-day", { day: "2026-11-03", taskId: b.id, start: 585, minutes: 30 });
    expect(ok.status).toBe(201);
    // Moving a block onto itself is fine; resizing into the next one is not.
    expect((await c.patch(`/api/my-day/${first.body.item.id}`, { start: 540, minutes: 30 })).status).toBe(200);
    expect((await c.patch(`/api/my-day/${first.body.item.id}`, { minutes: 90 })).status).toBe(409);
    const after = (await c.get("/api/my-day?day=2026-11-03&tz=Australia/Sydney")).body;
    expect(after.items).toHaveLength(2);
    expect(after.suggestions.map((s: { id: string }) => s.id)).not.toContain(a.id);
  });

  it("plan tomorrow moves unfinished items, keeps free times, and undo puts them back", async () => {
    const a = await task("A"), b = await task("B"), d = await task("Done one");
    const x = (await c.post("/api/my-day", { day: "2026-11-03", taskId: a.id, start: 540, minutes: 60 })).body.item;
    const y = (await c.post("/api/my-day", { day: "2026-11-03", taskId: b.id })).body.item;
    await c.post("/api/my-day", { day: "2026-11-03", taskId: d.id, start: 700 });
    await c.patch(`/api/tasks/${d.id}`, { status: "done" });
    const r = (await c.post("/api/my-day/plan-tomorrow", { day: "2026-11-03" })).body;
    expect(r).toMatchObject({ next: "2026-11-04", moved: 2, kept: 1 });
    const tomorrow = (await c.get("/api/my-day?day=2026-11-04")).body.items;
    expect(tomorrow.map((i: { taskId: string; start: number | null }) => [i.taskId, i.start])).toEqual(expect.arrayContaining([[a.id, 540], [b.id, null]]));
    expect((await c.get("/api/my-day?day=2026-11-03")).body.items.map((i: { taskId: string }) => i.taskId)).toEqual([d.id]);
    expect((await c.post("/api/my-day/restore", { items: r.undo })).body.restored).toBe(2);
    const back = (await c.get("/api/my-day?day=2026-11-03")).body.items;
    expect(back.find((i: { id: string }) => i.id === x.id)?.start).toBe(540);
    expect(back.find((i: { id: string }) => i.id === y.id)).toBeTruthy();
  });

  it("a teammate never sees or changes my plan", async () => {
    const a = await task("Mine");
    const item = (await c.post("/api/my-day", { day: "2026-11-03", taskId: a.id, start: 600 })).body.item;
    const m = await teammate();
    expect((await m.client.get("/api/my-day?day=2026-11-03")).body.items).toEqual([]);
    expect((await m.client.patch(`/api/my-day/${item.id}`, { start: 0 })).status).toBe(404);
    expect((await m.client.del(`/api/my-day/${item.id}`)).status).toBe(404);
    expect((await m.client.post("/api/my-day/restore", { items: [{ id: item.id, taskId: a.id, day: "2026-11-09", start: 0, minutes: 30 }] })).body.restored).toBe(0);
    expect((await c.get("/api/my-day?day=2026-11-03")).body.items[0].start).toBe(600);
  });

  it("signed out and guest visitors get nothing", async () => {
    const anon = new Client(ctx.app);
    expect((await anon.get("/api/my-day?day=2026-11-03")).status).toBe(401);
    expect((await anon.get("/api/timesheets/week?week=2026-11-02")).status).toBe(401);
    expect((await anon.get("/api/time/export.csv")).status).toBe(401);
  });
});

describe("R95 smart repeat", () => {
  beforeEach(() => setup());

  it("rotates the chore between members and counts after done", async () => {
    const m = await teammate();
    const rotate = [`member:${me.userId}`, `member:${m.id}`];
    const t = await task("Take out bins", { assignee: `member:${me.userId}`, due: "2026-11-01T22:00:00.000Z",
      repeat: { freq: "daily", interval: 2, basis: "done", tz: "Australia/Sydney", rotate } });
    expect(t.repeat.text).toBe("Every 2 days after done");
    await c.patch(`/api/tasks/${t.id}`, { status: "done" });
    const list = (await c.get(`/api/tasks?projectId=${projectId}`)).body.tasks as { id: string; title: string; status: string; due: string; assignee: { id: string } | null }[];
    const next = list.find((x) => x.title === "Take out bins" && x.status !== "done")!;
    expect(JSON.stringify(next)).toContain(m.id);
    // Finished Tue 3 Nov (Sydney) + 2 days, at the old 9 am Sydney time.
    expect(next.due).toBe("2026-11-04T22:00:00.000Z");
  });

  it("nth weekday and checks", async () => {
    const t = await task("Board pack", { due: "2026-11-10T03:00:00.000Z", repeat: { freq: "monthly", nth: 2, nthWeekday: 2 } });
    expect(t.repeat.text).toBe("Every month on the 2nd Tue");
    expect((await c.post("/api/tasks", { projectId, title: "x", repeat: { freq: "daily", tz: "Nowhere/Land" } })).status).toBe(422);
    expect((await c.post("/api/tasks", { projectId, title: "x", repeat: { freq: "weekly", nth: 1, nthWeekday: 1 } })).status).toBe(422);
  });

  it("a task can't go under its own subtask", async () => {
    const a = await task("Parent");
    const b = await task("Child", { parentId: a.id });
    const cc = await task("Grandchild", { parentId: b.id });
    const r = await c.patch(`/api/tasks/${a.id}`, { parentId: cc.id });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("parent_cycle");
    expect((await c.patch(`/api/tasks/${cc.id}`, { parentId: a.id })).status).toBe(200);
  });
});

describe("R95 time and timesheets", () => {
  beforeEach(() => setup());

  it("tags, tag filter, stop at and CSV with defused cells", async () => {
    const t = await task("Design");
    await c.post("/api/time", { taskId: t.id, minutes: 90, date: "2026-11-02", note: "=cmd", tags: ["Client A", "design"], billable: false });
    await c.post("/api/time", { taskId: t.id, minutes: 30, date: "2026-11-02" });
    const tagged = (await c.get("/api/time?from=2026-11-01&to=2026-11-08&tag=client%20a")).body.entries;
    expect(tagged).toHaveLength(1);
    expect(tagged[0].tags).toEqual(["client a", "design"]);
    const csv = await c.get("/api/time/export.csv?from=2026-11-01&to=2026-11-08");
    expect(csv.status).toBe(200);
    const text = String(csv.body);
    expect(text.split("\r\n")[0]).toBe("Date,Person,Project,Task,Note,Tags,Billable,Start,End,Hours");
    expect(text).toContain("'=cmd");
    expect(text).toContain("client a; design,no");
    expect(text).toContain("1.50");
    // Drop the away time: stop at a moment before now.
    const started = (await c.post("/api/time/start", { taskId: t.id })).body.entry;
    clock += 20 * 60_000;
    const stopped = (await c.post("/api/time/stop", { at: new Date(Date.parse(started.startedAt) + 5 * 60_000).toISOString() })).body.entry;
    expect(stopped.seconds).toBe(300);
  });

  it("member submits; the week locks; admin approves or returns; members can't approve", async () => {
    const m = await teammate();
    const t = await task("Build");
    const e = (await m.client.post("/api/time", { taskId: t.id, minutes: 60, date: "2026-11-03" })).body.entry;
    expect((await m.client.get("/api/timesheets/week?week=2026-11-04")).body.sheet).toMatchObject({ week: "2026-11-02", status: "open" });
    const sub = await m.client.post("/api/timesheets/submit", { week: "2026-11-04", note: "All done" });
    expect(sub.body.sheet).toMatchObject({ status: "submitted", week: "2026-11-02" });
    // Locked for the member: add, change, delete and start a timer.
    for (const r of [
      await m.client.post("/api/time", { taskId: t.id, minutes: 15, date: "2026-11-05" }),
      await m.client.patch(`/api/time/${e.id}`, { minutes: 30 }),
      await m.client.del(`/api/time/${e.id}`),
      await m.client.post("/api/time/start", { taskId: t.id }),
    ]) { expect(r.status).toBe(409); expect(r.body.error.code).toBe("timesheet_locked"); }
    // Another week is open.
    expect((await m.client.post("/api/time", { taskId: t.id, minutes: 15, date: "2026-11-10" })).status).toBe(201);
    // A member can't approve, list or return.
    expect((await m.client.post("/api/timesheets/approve", { week: "2026-11-02", person: `member:${m.id}` })).status).toBe(403);
    expect((await m.client.get("/api/timesheets")).status).toBe(403);
    // Admin sees it waiting and approves.
    const waiting = (await c.get("/api/timesheets")).body.sheets;
    expect(waiting).toEqual([expect.objectContaining({ week: "2026-11-02", person: expect.objectContaining({ id: m.id }), status: "submitted", note: "All done" })]);
    const ap = await c.post("/api/timesheets/approve", { week: "2026-11-02", person: `member:${m.id}` });
    expect(ap.body.sheet).toMatchObject({ status: "approved", decidedBy: "Olive Owner" });
    expect((await m.client.post("/api/timesheets/withdraw", { week: "2026-11-02" })).status).toBe(409);
    // Admin can still fix time in a locked week.
    expect((await c.patch(`/api/time/${e.id}`, { minutes: 45 })).status).toBe(200);
    const ret = await c.post("/api/timesheets/return", { week: "2026-11-02", person: `member:${m.id}`, note: "Split the Tuesday" });
    expect(ret.body.sheet).toMatchObject({ status: "returned", note: "Split the Tuesday" });
    expect((await m.client.patch(`/api/time/${e.id}`, { minutes: 30 })).status).toBe(200);
    expect((await m.client.post("/api/timesheets/submit", { week: "2026-11-02" })).body.sheet.status).toBe("submitted");
    // Nobody submits for someone else.
    expect((await c.post("/api/timesheets/submit", { week: "2026-11-09", person: `member:${m.id}` })).body.sheet.person.id).toBe(me.userId);
  });
});
