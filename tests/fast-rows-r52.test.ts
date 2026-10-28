import { describe, it, expect, beforeAll } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { tasks, projects } from "../src/server/db/schema";
import { rowMapper, selectMapped } from "../src/server/db/fast-rows";

/**
 * R52: the task list reads raw rows and maps them with a mapper built once per table (db/fast-rows.ts). The result
 * must equal drizzle's own select, value for value (timestamps as Date, nulls as null, numbers as numbers).
 */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;

beforeAll(async () => {
  ctx = await makeTestApp();
  owner = new Client(ctx.app);
  await owner.signup("owner@rows.test", "Rowan Rows");
  const projectId = (await owner.post("/api/projects", { name: "Rows", key: "ROW" })).body.project.id;
  await owner.post("/api/tasks", { projectId, title: "Plain" });
  await owner.post("/api/tasks", { projectId, title: "Dated", due: "2026-11-02T09:30:00.000Z", start: "2026-10-30T00:00:00.000Z", labels: ["a", "b"], priority: "high" });
  const parent = (await owner.post("/api/tasks", { projectId, title: "Parent" })).body.task;
  await owner.post("/api/tasks", { projectId, title: "Child", parentId: parent.id });
});

describe("R52 fast row mapper", () => {
  it("maps the task rows exactly like drizzle's select", async () => {
    const db = ctx.db as unknown as Parameters<typeof selectMapped>[0] & typeof ctx.db;
    const m = rowMapper(tasks);
    const viaDrizzle = await ctx.db.select().from(tasks).orderBy(asc(tasks.number));
    const viaMapper = await selectMapped(db, m, ctx.db.select(m.columns).from(tasks).orderBy(asc(tasks.number)));
    expect(viaDrizzle.length).toBeGreaterThanOrEqual(4);
    expect(viaMapper).toEqual(viaDrizzle);
    const dated = viaMapper.find((t) => t.title === "Dated")!;
    expect(dated.dueAt).toBeInstanceOf(Date);
    expect(dated.createdAt).toBeInstanceOf(Date);
    expect(viaMapper.find((t) => t.title === "Plain")!.dueAt).toBeNull();
  });

  it("the prebuilt select list reads the same columns in the same order", async () => {
    const db = ctx.db as unknown as Parameters<typeof selectMapped>[0];
    const m = rowMapper(tasks);
    const viaDrizzle = await ctx.db.select().from(tasks).orderBy(asc(tasks.number));
    const viaList = await selectMapped(db, m, sql`select ${m.selectList} from ${tasks} order by ${tasks.number} asc`);
    expect(viaList).toEqual(viaDrizzle);
  });

  it("works for another table too", async () => {
    const db = ctx.db as unknown as Parameters<typeof selectMapped>[0];
    const m = rowMapper(projects);
    const one = (await ctx.db.select().from(projects).limit(1))[0];
    const mapped = await selectMapped(db, m, ctx.db.select(m.columns).from(projects).where(eq(projects.id, one.id)));
    expect(mapped).toEqual([one]);
  });
});
