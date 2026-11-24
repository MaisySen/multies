import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";

/**
 * Round 2 (PR 24 leftover): in an existing workspace a key's or an AI app's task with no projectId lands in the
 * oldest project, whose Triage setting was never changed (often off), so it went straight onto that board. Now a
 * machine's task that names no project and no parent always waits in Triage there. A person's task does not.
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

describe("Round 2: a machine's task with no project waits", () => {
  it("v1 POST /tasks with no projectId waits in the oldest project even with Triage off there", async () => {
    const first = (await c.post("/api/projects", { name: "Old", triage: false })).body.project.id as string;
    const k = await key();
    const t = (await api(k, "POST", "/tasks", { title: "Wire the deposit" })).body.task;
    expect(t.projectId).toBe(first);
    expect(t.triage).toMatchObject({ state: "pending", source: "api" });
    // Naming the project keeps the project's own setting.
    expect((await api(k, "POST", "/tasks", { title: "Named", projectId: first })).body.task.triage).toBeNull();
    // A person's task with no project goes to the board.
    expect((await c.post("/api/tasks", { title: "Mine" })).body.task.triage).toBeNull();
  });
});
