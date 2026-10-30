import { describe, it, expect, beforeAll } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { TASK_LIST_LIMIT, listIsCapped } from "../src/shared/task-list-limit";

/**
 * R45b (found on prod with the test session): the sprint backlog read took the first 500 tasks of a project and only then
 * dropped the done ones, so done tasks used up the limit and open backlog tasks went missing (450 of 894 shown).
 */
type Raw = { prepare: (sql: string) => { run: (...a: unknown[]) => unknown; get: (...a: unknown[]) => Record<string, unknown> | undefined; all: (...a: unknown[]) => Record<string, unknown>[] }; transaction: (f: () => void) => () => void };
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;
let projectId = "";

beforeAll(async () => {
  ctx = await makeTestApp();
  owner = new Client(ctx.app);
  await owner.signup("owner@cap.test", "Cara Cap");
  projectId = (await owner.post("/api/projects", { name: "Cap", key: "CAP" })).body.project.id;
  const done = (await owner.post("/api/tasks", { projectId, title: "Done template" })).body.task;
  await owner.patch(`/api/tasks/${done.id}`, { status: "done" });
  const open = (await owner.post("/api/tasks", { projectId, title: "Open template" })).body.task;
  const db = (ctx.db as unknown as { $client: Raw }).$client;
  const names = db.prepare("PRAGMA table_info(tasks)").all().map((c) => String(c.name));
  const ins = db.prepare(`INSERT INTO tasks (${names.join(",")}) VALUES (${names.map((n) => "@" + n).join(",")})`);
  const tplDone = db.prepare("SELECT * FROM tasks WHERE id = @a").get({ a: done.id })!;
  const tplOpen = db.prepare("SELECT * FROM tasks WHERE id = @a").get({ a: open.id })!;
  expect(tplDone.status).toBe("done");
  db.transaction(() => {
    // 520 done tasks first by position, then 40 open ones after them.
    for (let i = 0; i < 520; i++) ins.run({ ...tplDone, id: `tsk_capdone${i}`, number: 1000 + i, title: `Done ${i}`, position: i });
    for (let i = 0; i < 40; i++) ins.run({ ...tplOpen, id: `tsk_capopen${i}`, number: 3000 + i, title: `Open ${i}`, position: 1000 + i });
  })();
});

describe("R45b backlog read and the list limit", () => {
  it("returns every open backlog task even when done tasks come first", async () => {
    const res = await owner.get(`/api/sprints/backlog?projectId=${projectId}`);
    expect(res.status).toBe(200);
    const titles = (res.body.tasks as { title: string; status: string }[]);
    expect(titles.every((t) => t.status !== "done")).toBe(true);
    expect(titles.filter((t) => /^Open \d+$/.test(t.title)).length).toBe(40);
  });
  it("marks a full read as capped", () => {
    expect(TASK_LIST_LIMIT).toBe(500);
    expect(listIsCapped(499)).toBe(false);
    expect(listIsCapped(500)).toBe(true);
    expect(listIsCapped(501)).toBe(false);
  });
});
