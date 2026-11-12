import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { tasks } from "@/server/db/schema";

/**
 * AIS1 second review (rows 35 and 66): three ways a key's work still got past the person who decides Triage, or a
 * Triage decision hurt work that was not part of the item.
 * 1. A key finished its own waiting repeating task, and the next one in the series landed on the board unchecked.
 * 2. A key put a person's board task under its own waiting item; declining that item then deleted the person's task.
 * 3. Accepting an item into another project moved the item but left its subtasks behind in the old project.
 */

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io");
});

async function api(key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", "content-type": "application/json" }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const key = async () => (await c.post("/api/developer/keys", { name: "Bot" })).body.secret as string;
const row = (id: string) => ctx.deps.db.select().from(tasks).where(eq(tasks.id, id)).get();
const byTitle = (title: string) => ctx.deps.db.select().from(tasks).where(eq(tasks.title, title)).all();
const count = async () => (await c.get("/api/triage/count")).body.count as number;

describe("AIS1 second review: Triage holds", () => {
  it("a key finishing its own waiting repeating task: the next one waits in Triage too", async () => {
    const p = (await c.post("/api/projects", { name: "Payments" })).body.project.id as string;
    const k = await key();
    const t = (await api(k, "POST", "/tasks", { title: "Send the weekly payout", projectId: p, due: "2026-11-16", repeat: { freq: "weekly" } })).body.task;
    expect(t.triage).toMatchObject({ state: "pending" });
    expect((await api(k, "PATCH", `/tasks/${t.id}`, { status: "done" })).status).toBe(200);
    const rows = (await byTitle("Send the weekly payout")).filter((r) => r.id !== t.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].triageState).toBe("pending");
    expect(rows[0].triageSource).toBe("api");
    // A person's own repeating task still repeats straight onto the board.
    const mine = (await c.post("/api/tasks", { title: "Water the plants", projectId: p, due: "2026-11-16", repeat: { freq: "weekly" } })).body.task;
    expect((await c.patch(`/api/tasks/${mine.id}`, { status: "done" })).status).toBe(200);
    expect((await byTitle("Water the plants")).filter((r) => r.id !== mine.id).map((r) => r.triageState)).toEqual([null]);
  });

  it("a key can't put a task that isn't waiting under a waiting item, so a decline can't take a person's task", async () => {
    const p = (await c.post("/api/projects", { name: "Ops", triage: false })).body.project.id as string;
    const guarded = (await c.post("/api/projects", { name: "Inbox work" })).body.project.id as string;
    const real = (await c.post("/api/tasks", { title: "Renew the lease", projectId: p })).body.task;
    const k = await key();
    const spam = (await api(k, "POST", "/tasks", { title: "Click here", projectId: guarded })).body.task;
    expect(spam.triage).toMatchObject({ state: "pending" });
    const moved = await api(k, "PATCH", `/tasks/${real.id}`, { parentId: spam.id });
    expect(moved.status).toBe(403);
    expect(moved.body.error.code).toBe("person_only");
    expect((await row(real.id))?.parentId).toBeNull();
    // Even if a person put it there, declining the item leaves a task that never came through Triage alone.
    expect((await c.patch(`/api/tasks/${real.id}`, { parentId: spam.id })).status).toBe(200);
    expect((await c.post(`/api/triage/${spam.id}/decline`, {})).status).toBe(200);
    const after = await row(real.id);
    expect(after?.deletedAt).toBeNull();
    expect(after?.parentId).toBeNull();
  });

  it("accepting an item into another project takes its waiting subtasks there too", async () => {
    const inbox = (await c.post("/api/projects", { name: "Intake" })).body.project.id as string;
    const team = (await c.post("/api/projects", { name: "Team", triage: false })).body.project.id as string;
    const k = await key();
    const parent = (await api(k, "POST", "/tasks", { title: "Onboard Acme", projectId: inbox })).body.task;
    const sub = (await api(k, "POST", "/tasks", { title: "Send the contract", parentId: parent.id })).body.task;
    expect(sub.triage).toMatchObject({ state: "pending" });
    expect(await count()).toBe(2);
    expect((await c.post(`/api/triage/${parent.id}/accept`, { projectId: team })).status).toBe(200);
    expect(await count()).toBe(0);
    expect((await row(parent.id))?.projectId).toBe(team);
    const s = await row(sub.id);
    expect([s?.projectId, s?.triageState, s?.parentId]).toEqual([team, null, parent.id]);
  });
});
