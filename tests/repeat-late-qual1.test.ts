import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";

/**
 * QUAL1 (CI green): a repeating task finished late gets its next one on the first date of the rule that is not
 * already past, whether it is finished on its own or in bulk. Every test pins the clock (ctx.deps.now), so none of
 * them depends on the day the suite runs. tests/table-r21.test.ts expected a fixed next date on the real clock and
 * started failing on 10 November 2026, once that date was in the past.
 */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let projectId = "";

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  projectId = (await c.post("/api/projects", { name: "Ops" })).body.project.id;
});

const at = (iso: string) => { ctx.deps.now = () => new Date(iso); };
const weekly = async (title: string) => (await c.post("/api/tasks", { projectId, title, due: "2026-11-02", repeat: { freq: "weekly" } })).body.task as { id: string };
const openDue = async (title: string) => {
  const list = (await c.get(`/api/tasks?projectId=${projectId}&status=todo`)).body.tasks as { title: string; due: string }[];
  return list.filter((t) => t.title === title).map((t) => t.due);
};

describe("repeating task finished late", () => {
  it("finished three days late on its own: the next one is a week after the old due date", async () => {
    const t = await weekly("Weekly report");
    at("2026-11-05T09:00:00.000Z");
    expect((await c.patch(`/api/tasks/${t.id}`, { status: "done" })).status).toBe(200);
    expect(await openDue("Weekly report")).toEqual(["2026-11-09T00:00:00.000Z"]);
  });

  it("finished eighteen days late on its own: the past weeks are skipped", async () => {
    const t = await weekly("Weekly report");
    at("2026-11-20T09:00:00.000Z");
    expect((await c.patch(`/api/tasks/${t.id}`, { status: "done" })).status).toBe(200);
    expect(await openDue("Weekly report")).toEqual(["2026-11-23T00:00:00.000Z"]);
  });

  it("finished late in bulk: the same rule, so bulk and single finishes agree", async () => {
    const t = await weekly("Weekly report");
    at("2026-11-20T09:00:00.000Z");
    const out = await c.post("/api/tasks/bulk", { ids: [t.id], patch: { status: "done" } });
    expect(out.status).toBe(200);
    expect(out.body.updated).toBe(1);
    expect(await openDue("Weekly report")).toEqual(["2026-11-23T00:00:00.000Z"]);
  });

  it("finished late on the day of the next date: that date is kept, not skipped (a day of grace)", async () => {
    const t = await weekly("Weekly report");
    at("2026-11-09T20:00:00.000Z");
    expect((await c.patch(`/api/tasks/${t.id}`, { status: "done" })).status).toBe(200);
    expect(await openDue("Weekly report")).toEqual(["2026-11-09T00:00:00.000Z"]);
  });
});
