import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";

/** R29: the workspace's agent runs over the cookie session (GET /api/agent-runs), for the mobile Runs screen. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;

async function v1(key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

beforeEach(async () => {
  ctx = await makeTestApp();
  let clock = Date.parse("2026-10-26T03:40:00Z");
  ctx.deps.now = () => new Date((clock += 1000));
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
});

describe("GET /api/agent-runs", () => {
  it("lists the workspace's runs newest first, filters by agent and status, caps the limit, and is scoped to the workspace", async () => {
    const projectId = (await c.post("/api/projects", { name: "Build", key: "MB" })).body.project.id;
    const made = async (name: string) => { const m = (await c.post("/api/team/agents", { name })).body; return { id: m.member.userId as string, key: m.secret as string }; };
    const builder = await made("Builder");
    const qa = await made("QA");
    const t1 = (await c.post("/api/tasks", { title: "One", projectId, assignee: `member:${builder.id}` })).body.task;
    const t2 = (await c.post("/api/tasks", { title: "Two", projectId, assignee: `member:${qa.id}` })).body.task;
    const r1 = (await v1(builder.key, "POST", `/tasks/${t1.id}/runs`, {})).body.run;
    await v1(builder.key, "POST", `/runs/${r1.id}/finish`, { status: "succeeded", result: "ok" });
    const r2 = (await v1(qa.key, "POST", `/tasks/${t2.id}/runs`, {})).body.run;

    const all = await c.get("/api/agent-runs");
    expect(all.status).toBe(200);
    expect(all.body.runs.map((r: { id: string }) => r.id)).toEqual([r2.id, r1.id]);
    expect(all.body.runs[0]).toMatchObject({ status: "running", agent: { name: "QA" }, task: { ref: t2.ref } });
    expect((await c.get(`/api/agent-runs?agentUserId=${builder.id}`)).body.runs.map((r: { id: string }) => r.id)).toEqual([r1.id]);
    expect((await c.get("/api/agent-runs?status=succeeded")).body.runs.map((r: { id: string }) => r.id)).toEqual([r1.id]);
    expect((await c.get("/api/agent-runs?limit=1")).body.runs).toHaveLength(1);
    expect((await c.get("/api/agent-runs?status=nope")).status).toBe(422);
    // The one-run route still answers (not shadowed by the list).
    expect((await c.get(`/api/agent-runs/${r1.id}`)).body.run.id).toBe(r1.id);

    // Another workspace sees none of them; signed out is refused.
    const other = new Client(ctx.app);
    await other.signup("else@other.io", "Else Where");
    expect((await other.get("/api/agent-runs")).body.runs).toEqual([]);
    expect((await new Client(ctx.app).get("/api/agent-runs")).status).toBe(401);
  });
});
