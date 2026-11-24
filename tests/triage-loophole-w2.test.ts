import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { organizations, tasks } from "@/server/db/schema";

/**
 * Round 2 (PR 24 leftover, review fix 3 residual): a key could turn Triage on for its own project with Triage off
 * (allowed) and then move the tasks it had made there, which never passed Triage, into another project with Triage
 * on. The workspace now records when a key or an AI app turned Triage on for a project, and the move check counts
 * that project as Triage off for tasks made there before that moment. Tasks made after it waited, so they may move.
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
// Real clock: a few ms between steps so "made before" and "made after" Triage went on never share a millisecond.
const tick = () => new Promise((r) => setTimeout(r, 5));
const row = (id: string) => ctx.deps.db.select().from(tasks).where(eq(tasks.id, id)).get();

describe("Round 2: a key can't launder a task through Triage it turned on itself", () => {
  it("v1 PATCH and bulk refuse the move; a person may; a task made after Triage went on may move", async () => {
    const old = (await c.post("/api/projects", { name: "Old", triage: false })).body.project.id as string;
    const guarded = (await c.post("/api/projects", { name: "Payments" })).body.project.id as string;
    const k = await key();
    const t = (await api(k, "POST", "/tasks", { title: "Pay the new supplier account", projectId: old })).body.task;
    expect(t.triage).toBeNull();
    await tick();
    // The key turns Triage on for the old project (allowed), then tries to move its task onto the guarded board.
    expect((await api(k, "PATCH", `/projects/${old}`, { triage: true })).status).toBe(200);
    const meta = JSON.parse((await ctx.deps.db.select({ m: organizations.metadata }).from(organizations).get())?.m ?? "{}");
    expect(typeof meta.triageOnByMachine?.[old]).toBe("number");
    const moved = await api(k, "PATCH", `/tasks/${t.id}`, { projectId: guarded });
    expect(moved.status).toBe(403);
    expect(moved.body.error.code).toBe("person_only");
    expect((await row(t.id))?.projectId).toBe(old);
    const bulk = await api(k, "POST", "/tasks/bulk", { ids: [t.id], patch: { projectId: guarded } });
    expect(bulk.status).toBe(403);
    expect((await row(t.id))?.projectId).toBe(old);
    await tick();
    // A task the key makes there now waits, and a person accepts it; that one may move.
    const later = (await api(k, "POST", "/tasks", { title: "Later", projectId: old })).body.task;
    expect(later.triage).toMatchObject({ state: "pending" });
    expect((await c.post(`/api/triage/${later.id}/accept`, {})).status).toBe(200);
    expect((await api(k, "PATCH", `/tasks/${later.id}`, { projectId: guarded })).status).toBe(200);
    // A person may move the first one.
    expect((await c.patch(`/api/tasks/${t.id}`, { projectId: guarded })).status).toBe(200);
  });

  it("a person turning Triage on records nothing, and the key may move between the two Triage-on projects", async () => {
    const old = (await c.post("/api/projects", { name: "Old", triage: false })).body.project.id as string;
    const guarded = (await c.post("/api/projects", { name: "Payments" })).body.project.id as string;
    const k = await key();
    const t = (await api(k, "POST", "/tasks", { title: "Plain", projectId: old })).body.task;
    expect((await c.patch(`/api/projects/${old}`, { triage: true })).status).toBe(200);
    const meta = JSON.parse((await ctx.deps.db.select({ m: organizations.metadata }).from(organizations).get())?.m ?? "{}");
    expect(meta.triageOnByMachine).toBeUndefined();
    expect((await api(k, "PATCH", `/tasks/${t.id}`, { projectId: guarded })).status).toBe(200);
  });
});
