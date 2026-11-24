import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { webhookDeliveries } from "@/server/db/schema";

/**
 * Round 2 (PR 24 leftover): imported tasks that wait in Triage sent no triage.created webhooks, so a tool watching
 * Triage missed them. A key's or an AI app's import now sends one triage.created per waiting task, all in one
 * write (emitEventMany), at most EMIT_MANY_MAX per step, marked import: true. A person's import sends none (its
 * tasks don't wait), and nothing is written when nobody listens.
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
const deliveries = async () => (await ctx.deps.db.select({ t: webhookDeliveries.eventType, p: webhookDeliveries.payload }).from(webhookDeliveries)).map((r) => ({ type: r.t, data: JSON.parse(r.p).data }));

describe("Round 2: imported tasks that wait send triage.created", () => {
  it("one triage.created per waiting task from a key's import, none from a person's", async () => {
    expect((await c.post("/api/developer/webhooks", { url: "https://hooks.example.com/triage", events: ["triage.created"] })).status).toBeLessThan(300);
    const p = (await c.post("/api/projects", { name: "Payments" })).body.project.id as string;
    const k = await key();
    const csv = "ID,Title,Status,Parent\n1,Pay invoice 4471,To do,\n2,Check the bank details,To do,1\n";
    const run = await api(k, "POST", "/work-imports/run", { fileName: "plan.csv", content: csv, projectId: p });
    expect(run.body.triage).toBe(true);
    const got = (await deliveries()).filter((d) => d.type === "triage.created");
    expect(got).toHaveLength(2);
    expect(got.map((d) => d.data.task.title).sort()).toEqual(["Check the bank details", "Pay invoice 4471"]);
    expect(got[0].data).toMatchObject({ source: "api", import: true, task: { projectId: p }, actor: { type: "member" } });
    expect(new Set(got.map((d) => d.data.task.id))).toEqual(new Set(run.body.createdTaskIds));
    // A person's import doesn't wait, so it sends nothing.
    await c.post("/api/work-imports/run", { fileName: "mine.csv", content: "Title,Status\nRing the landlord,To do\n", projectId: p });
    expect((await deliveries()).filter((d) => d.type === "triage.created")).toHaveLength(2);
  });

  it("writes nothing when no endpoint listens", async () => {
    const p = (await c.post("/api/projects", { name: "Payments" })).body.project.id as string;
    await api(await key(), "POST", "/work-imports/run", { fileName: "plan.csv", content: "Title,Status\nPay invoice,To do\n", projectId: p });
    expect(await deliveries()).toHaveLength(0);
  });
});
