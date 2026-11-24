import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { tasks } from "@/server/db/schema";

/**
 * Round 2 (PR 24 leftover, row 35 option): the workspace setting "AI and API tasks always wait in Triage", off by
 * default. When an admin turns it on, a key's or an AI app's task waits in Triage in a project with Triage off too:
 * made there, imported there, and a move into such a project counts as a move into Triage. Only an admin signed in to
 * Multies changes it.
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

describe("Round 2: AI and API tasks always wait in Triage", () => {
  it("is off by default, and only an admin signed in to Multies turns it on", async () => {
    expect((await c.get("/api/triage/settings")).body).toEqual({ machineTasksAlwaysWait: false });
    const inv = await c.post("/api/team/invites", { email: "member@acme.io", role: "member" });
    const member = new Client(ctx.app);
    await member.signup("member@acme.io", "Mo", "Mo Co");
    expect((await member.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
    expect((await member.put("/api/triage/settings", { machineTasksAlwaysWait: true })).status).toBe(403);
    expect((await c.put("/api/triage/settings", { machineTasksAlwaysWait: true })).body).toEqual({ machineTasksAlwaysWait: true });
    expect((await c.get("/api/triage/settings")).body).toEqual({ machineTasksAlwaysWait: true });
    expect((await c.put("/api/triage/settings", { machineTasksAlwaysWait: false })).body).toEqual({ machineTasksAlwaysWait: false });
  });

  it("a key's task in a project with Triage off goes to the board when off, and waits when on", async () => {
    const off = (await c.post("/api/projects", { name: "Old", triage: false })).body.project.id as string;
    const k = await key();
    expect((await api(k, "POST", "/tasks", { title: "Before", projectId: off })).body.task.triage).toBeNull();
    await c.put("/api/triage/settings", { machineTasksAlwaysWait: true });
    const after = (await api(k, "POST", "/tasks", { title: "After", projectId: off })).body.task;
    expect(after.triage).toMatchObject({ state: "pending", source: "api" });
    // A person's own task still goes straight to the board.
    expect((await c.post("/api/tasks", { title: "Mine", projectId: off })).body.task.triage).toBeNull();
  });

  it("a key's import into a project with Triage off waits when the setting is on", async () => {
    const off = (await c.post("/api/projects", { name: "Old", triage: false })).body.project.id as string;
    await c.put("/api/triage/settings", { machineTasksAlwaysWait: true });
    const run = await api(await key(), "POST", "/work-imports/run", { fileName: "old.csv", content: "Title,Status\nOrder paper,To do\n", projectId: off });
    expect(run.status).toBe(200);
    expect(run.body.triage).toBe(true);
    const rows = await ctx.deps.db.select().from(tasks).where(eq(tasks.projectId, off)).all();
    expect(rows.map((r) => [r.title, r.triageState])).toEqual([["Order paper", "pending"]]);
  });

  it("a key's move between two projects with Triage off counts as a move into Triage when the setting is on", async () => {
    const a = (await c.post("/api/projects", { name: "A", triage: false })).body.project.id as string;
    const b = (await c.post("/api/projects", { name: "B", triage: false })).body.project.id as string;
    const k = await key();
    const t = (await api(k, "POST", "/tasks", { title: "Plain", projectId: a })).body.task;
    await c.put("/api/triage/settings", { machineTasksAlwaysWait: true });
    const moved = await api(k, "PATCH", `/tasks/${t.id}`, { projectId: b });
    expect(moved.status).toBe(403);
    expect(moved.body.error.code).toBe("person_only");
    expect((await row(t.id))?.projectId).toBe(a);
    const bulk = await api(k, "POST", "/tasks/bulk", { ids: [t.id], patch: { projectId: b } });
    expect(bulk.status).toBe(403);
    expect((await row(t.id))?.projectId).toBe(a);
    // A person may, and with the setting off the key may again.
    await c.put("/api/triage/settings", { machineTasksAlwaysWait: false });
    expect((await api(k, "PATCH", `/tasks/${t.id}`, { projectId: b })).status).toBe(200);
  });

  it("a key can't change the setting", async () => {
    const k = await key();
    const res = await ctx.app.request("/api/triage/settings", { method: "PUT", headers: { authorization: `Bearer ${k}`, host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ machineTasksAlwaysWait: true }) });
    expect([401, 403]).toContain(res.status);
    expect((await c.get("/api/triage/settings")).body).toEqual({ machineTasksAlwaysWait: false });
  });
});
