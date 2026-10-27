import { describe, expect, it } from "vitest";
import { makeTestApp, Client } from "./helpers";

// R40 D1 reads: the top readers on production use indexes that stop at the page size, and the cached project
// counts never hide a change the person just made.
describe("D1 reads (R40)", () => {
  it("task lists, project lists and subtask counts read through the right index", async () => {
    const { db } = await makeTestApp();
    const client = (db as unknown as { $client: { prepare: (s: string) => { all: (...a: unknown[]) => { detail: string }[] } } }).$client;
    const plan = (sql: string) => client.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(" | ");
    const live = `deleted_at is null and triage_state is null`;
    const list = plan(`select id from tasks where org_id = 'o' and ${live} and parent_id is null order by position asc, created_at desc limit 50`);
    expect(list).toContain("tasks_org_live_pos_idx");
    expect(list).not.toContain("TEMP B-TREE FOR ORDER BY");
    const proj = plan(`select id from tasks where org_id = 'o' and project_id = 'p' and ${live} order by position asc, created_at desc limit 50`);
    expect(proj).toContain("tasks_org_project_live_pos_idx");
    expect(proj).not.toContain("TEMP B-TREE FOR ORDER BY");
    const subs = plan(`select parent_id, status, count(*) from tasks where +org_id = 'o' and parent_id in ('a','b') and deleted_at is null group by parent_id, status`);
    expect(subs).toContain("tasks_parent_idx");
  });

  it("project counts are cached but a new task shows at once", async () => {
    const { app } = await makeTestApp();
    const c = new Client(app);
    await c.signup();
    const p = await c.post("/api/projects", { name: "Launch", key: "LCH" });
    const projectId = p.body.project?.id ?? p.body.id;
    const count = async () => {
      const r = await c.get("/api/projects");
      const row = (r.body.projects ?? r.body).find((x: { id: string }) => x.id === projectId);
      return row.counts ?? row.taskCounts ?? row;
    };
    const before = JSON.stringify(await count());
    await c.post("/api/tasks", { projectId, title: "One" });
    const after = JSON.stringify(await count());
    expect(after).not.toBe(before);
  });
});
