import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";

/**
 * MPT-11 (NAV1 slice 2): GET /api/triage/count takes an optional projectId. With it, the count covers the
 * pending items of that project only, without snoozed items. Without it, the answer is the same as before
 * (the whole workspace), so the nav badge, the public API and MCP do not change.
 */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io");
});

async function triageProject(name: string) {
  const project = (await c.post("/api/projects", { name, triage: true })).body.project;
  expect(project.triage).toBe(true);
  return project as { id: string };
}
async function waiting(projectId: string, title: string) {
  const r = await c.post("/api/triage", { title, projectId });
  expect(r.status).toBe(201);
  return r.body.item.id as string;
}

describe("triage count for one project (MPT-11)", () => {
  it("counts only the items of the named project; without projectId it counts the whole workspace", async () => {
    const a = await triageProject("Support");
    const b = await triageProject("Sales");
    await waiting(a.id, "Quote for 6 mailboxes");
    await waiting(a.id, "Invoice 2041 looks doubled");
    await waiting(b.id, "New lead from the form");
    expect((await c.get(`/api/triage/count?projectId=${a.id}`)).body.count).toBe(2);
    expect((await c.get(`/api/triage/count?projectId=${b.id}`)).body.count).toBe(1);
    expect((await c.get("/api/triage/count")).body.count).toBe(3);
    expect((await c.get(`/api/triage?projectId=${a.id}`)).body.items).toHaveLength(2);
  });

  it("leaves snoozed items out, the same as the pending view of the Triage page", async () => {
    const a = await triageProject("Support");
    await waiting(a.id, "Stays in the queue");
    const later = await waiting(a.id, "Comes back next week");
    const until = new Date(Date.now() + 3 * 86_400_000).toISOString();
    expect((await c.post(`/api/triage/${later}/action`, { action: "snooze", until })).status).toBe(200);
    expect((await c.get(`/api/triage/count?projectId=${a.id}`)).body.count).toBe(1);
    expect((await c.get(`/api/triage?projectId=${a.id}`)).body.items).toHaveLength(1);
  });

  it("goes down when an item is accepted", async () => {
    const a = await triageProject("Support");
    const id = await waiting(a.id, "Accept me");
    expect((await c.get(`/api/triage/count?projectId=${a.id}`)).body.count).toBe(1);
    expect((await c.post(`/api/triage/${id}/accept`, {})).status).toBe(200);
    expect((await c.get(`/api/triage/count?projectId=${a.id}`)).body.count).toBe(0);
  });

  it("goes down when an item is declined", async () => {
    const a = await triageProject("Support");
    const id = await waiting(a.id, "Decline me");
    await waiting(a.id, "Keep me");
    expect((await c.get(`/api/triage/count?projectId=${a.id}`)).body.count).toBe(2);
    expect((await c.post(`/api/triage/${id}/decline`, {})).status).toBe(200);
    expect((await c.get(`/api/triage/count?projectId=${a.id}`)).body.count).toBe(1);
  });

  it("gives 0 for a project of another workspace, and 422 for a projectId that is too long (like every query check)", async () => {
    const a = await triageProject("Support");
    await waiting(a.id, "Private to acme");
    const other = new Client(ctx.app);
    await other.signup("owner@globex.io");
    expect((await other.get(`/api/triage/count?projectId=${a.id}`)).body.count).toBe(0);
    expect((await c.get(`/api/triage/count?projectId=${"x".repeat(65)}`)).status).toBe(422);
    expect((await c.get(`/api/triage?projectId=${"x".repeat(65)}`)).status).toBe(422);
  });

  it("needs a workspace session", async () => {
    const anon = new Client(ctx.app);
    expect((await anon.get("/api/triage/count?projectId=prj_x")).status).toBe(401);
  });
});
