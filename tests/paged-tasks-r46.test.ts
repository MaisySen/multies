import { describe, it, expect, beforeAll } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { mergeChanged, readAllPages, refreshList, FULL_READ_EVERY_MS } from "../src/web/pages/app/work/paged-tasks-r46";

/**
 * R46 (MB-234): board, list and backlog read every page of a big project (keyset pages in the default order), then
 * refresh from the change feed and ask only for the tasks it names.
 */
type Raw = { prepare: (sql: string) => { run: (...a: unknown[]) => unknown; get: (...a: unknown[]) => Record<string, unknown> | undefined; all: (...a: unknown[]) => Record<string, unknown>[] }; transaction: (f: () => void) => () => void };
type T = { id: string; title: string; status: string; position: number; createdAt: string; sprintId: string | null };
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;
let projectId = "";
const get = <X,>(url: string) => owner.get(`/api${url}`).then((r) => { if (r.status !== 200) throw new Error(`${url} ${r.status} ${JSON.stringify(r.body)}`); return r.body as X; });

beforeAll(async () => {
  ctx = await makeTestApp();
  owner = new Client(ctx.app);
  await owner.signup("owner@page.test", "Paige Page");
  projectId = (await owner.post("/api/projects", { name: "Paged", key: "PGD" })).body.project.id;
  const tpl = (await owner.post("/api/tasks", { projectId, title: "Template" })).body.task;
  const db = (ctx.db as unknown as { $client: Raw }).$client;
  const names = db.prepare("PRAGMA table_info(tasks)").all().map((c) => String(c.name));
  const ins = db.prepare(`INSERT INTO tasks (${names.join(",")}) VALUES (${names.map((n) => "@" + n).join(",")})`);
  const row = db.prepare("SELECT * FROM tasks WHERE id = @a").get({ a: tpl.id })!;
  db.transaction(() => {
    // 1,150 tasks; every tenth shares a position with its neighbour so the keyset has ties to walk.
    for (let i = 0; i < 1150; i++) ins.run({ ...row, id: `tsk_pg${String(i).padStart(5, "0")}`, number: 10 + i, title: `Paged ${i}`, position: i % 10 === 0 ? i + 1 : i, status: i % 7 === 0 ? "done" : "todo" });
  })();
});

describe("R46 paged task lists", () => {
  it("walks every page of a project past one read, with no task twice", async () => {
    const all = await readAllPages("/tasks", `projectId=${projectId}`, get);
    const ids = all.tasks.map((t) => t.id);
    expect(ids.length).toBe(1151);
    expect(new Set(ids).size).toBe(1151);
    expect(all.changeCursor).toBeGreaterThan(0);
    const first = await get<{ tasks: T[]; next: string | null }>(`/tasks?projectId=${projectId}&paged=1`);
    expect(first.tasks.length).toBe(500);
    expect(first.next).toBeTruthy();
    // pages keep the board's order: position, then newest first
    const pos = all.tasks.map((t) => t.position);
    expect(pos.every((p, i) => i === 0 || pos[i - 1] <= p)).toBe(true);
  });
  it("pages a sorted list by offset", async () => {
    const a = await readAllPages("/tasks", `projectId=${projectId}&sort=title`, get);
    expect(new Set(a.tasks.map((t) => t.id)).size).toBe(1151);
  });
  it("the backlog pages too and leaves done tasks out", async () => {
    const all = await readAllPages("/sprints/backlog", `projectId=${projectId}`, get);
    const open = 1150 - Math.ceil(1150 / 7) + 1; // 1150 seeded minus the done ones, plus the template
    expect(all.tasks.length).toBe(open);
    expect(all.tasks.every((t) => t.status !== "done")).toBe(true);
  });
  it("a bad cursor is a 400, and ids asks for at most 100", async () => {
    expect((await owner.get(`/api/tasks?projectId=${projectId}&paged=1&cursor=nonsense`)).status).toBe(400);
    const many = Array.from({ length: 101 }, (_, i) => `tsk_pg${String(i).padStart(5, "0")}`).join(",");
    expect((await owner.get(`/api/tasks?ids=${many}`)).status).toBe(400);
  });
  it("refreshes from the change feed: an edit is replaced, a delete leaves, a new task joins", async () => {
    const qs = `projectId=${projectId}`;
    const first = await refreshList({ path: "/tasks", qs, old: undefined, track: undefined, now: 1000, resort: true, get });
    expect(first.full).toBe(true);
    expect(first.tasks.length).toBe(1151);
    await owner.patch("/api/tasks/tsk_pg00003", { title: "Renamed three" });
    await owner.call("DELETE", "/api/tasks/tsk_pg00004");
    const made = (await owner.post("/api/tasks", { projectId, title: "Brand new" })).body.task;
    const next = await refreshList({ path: "/tasks", qs, old: first.tasks, track: first.track, now: 2000, resort: true, get });
    expect(next.full).toBe(false);
    expect(next.tasks.length).toBe(1151);
    expect(next.tasks.find((t) => t.id === "tsk_pg00003")?.title).toBe("Renamed three");
    expect(next.tasks.some((t) => t.id === "tsk_pg00004")).toBe(false);
    expect(next.tasks.some((t) => t.id === made.id)).toBe(true);
    // nothing new: the same list comes back without a task read
    const quiet = await refreshList({ path: "/tasks", qs, old: next.tasks, track: next.track, now: 3000, resort: true, get });
    expect(quiet.full).toBe(false);
    expect(quiet.tasks).toBe(next.tasks);
    // ten minutes after the last full read, every page is read again
    const later = await refreshList({ path: "/tasks", qs, old: next.tasks, track: next.track, now: 1000 + FULL_READ_EVERY_MS, resort: true, get });
    expect(later.full).toBe(true);
  });
  it("a sprint move reaches the change feed, so an open backlog drops the moved task", async () => {
    const qs = `projectId=${projectId}`;
    const first = await refreshList({ path: "/sprints/backlog", qs, old: undefined, track: undefined, now: 1000, resort: true, get });
    const sprint = (await owner.post("/api/sprints", { projectId, name: "S1" })).body.sprint;
    const mover = first.tasks[0].id;
    expect((await owner.post(`/api/sprints/${sprint.id}/tasks`, { taskIds: [mover] })).status).toBe(200);
    const next = await refreshList({ path: "/sprints/backlog", qs, old: first.tasks, track: first.track, now: 2000, resort: true, get });
    expect(next.full).toBe(false);
    expect(next.tasks.some((t) => t.id === mover)).toBe(false);
    expect(next.tasks.length).toBe(first.tasks.length - 1);
  });
});

describe("mergeChanged", () => {
  const t = (id: string, position: number, createdAt = "2026-10-27T00:00:00.000Z") => ({ id, position, createdAt }) as unknown as Parameters<typeof mergeChanged>[0][number];
  it("replaces, removes and places in the board order", () => {
    const out = mergeChanged([t("a", 1), t("b", 2), t("c", 3)], ["b", "c", "d"], [t("c", 0.5), t("d", 2.5)], true);
    expect(out.map((x) => x.id)).toEqual(["c", "a", "d"]);
  });
});
