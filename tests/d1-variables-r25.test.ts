import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client, D1_MAX_VARIABLES } from "./helpers";
import { inChunks, SQL_IN_CHUNK } from "@/server/services/suite/tasks";

/**
 * Round 25, Sentry MYMAIL-API-V: GET /api/tasks failed on prod with "too many SQL variables" once a list held more
 * than 100 tasks (the subtask and comment counts sent every task id in one IN list; D1 allows 100 variables).
 * The test database now refuses the same statements (tests/helpers.ts), so these walk the real routes.
 */
type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
let ctx: Ctx;
let owner: Client;
let projectId: string;

beforeEach(async () => {
  ctx = await makeTestApp();
  owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
  projectId = (await owner.post("/api/projects", { name: "Big", key: "BIG" })).body.project.id;
});

describe("D1 variable limit", () => {
  it("the test database refuses a statement with more than 100 variables, like D1", async () => {
    const ids = Array.from({ length: D1_MAX_VARIABLES + 5 }, (_, i) => `x${i}`);
    const client = (ctx.db as unknown as { $client: { prepare: (sql: string) => unknown } }).$client;
    expect(() => client.prepare(`select 1 where 'a' in (${ids.map(() => "?").join(",")})`)).toThrow(/too many SQL variables/);
  });

  it("inChunks splits an id list into chunks under the limit and joins the rows", async () => {
    const seen: number[] = [];
    const rows = await inChunks(Array.from({ length: 200 }, (_, i) => String(i)), async (c) => { seen.push(c.length); return c; });
    expect(rows).toHaveLength(200);
    expect(Math.max(...seen)).toBeLessThanOrEqual(SQL_IN_CHUNK);
    expect(await inChunks([], async () => { throw new Error("no query for no ids"); })).toEqual([]);
  });

  it("lists 150 tasks with subtask and comment counts (app API and REST)", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 150; i++) ids.push((await owner.post("/api/tasks", { projectId, title: `Task ${i}` })).body.task.id);
    await owner.post("/api/tasks", { projectId, title: "Child of the last one", parentId: ids[149] });
    await owner.post(`/api/tasks/${ids[149]}/comments`, { body: "first" });
    const res = await owner.get(`/api/tasks?projectId=${projectId}&limit=500`);
    expect(res.status).toBe(200);
    const last = res.body.tasks.find((t: { id: string }) => t.id === ids[149]);
    expect(last.subtasks).toMatchObject({ total: 1, done: 0 });
    expect(last.commentCount).toBe(1);
    const key = (await owner.post("/api/developer/keys", { name: "rw" })).body.secret;
    const v1 = await ctx.app.request(`/api/v1/tasks?projectId=${projectId}&limit=200`, { headers: { host: "localhost", authorization: `Bearer ${key}` } });
    expect(v1.status).toBe(200);
  }, 60_000);
});
