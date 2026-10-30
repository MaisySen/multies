import { describe, expect, it } from "vitest";
import { Client, makeTestApp } from "./helpers";

/*
 * R41 (MB-199 CPU): each D1 query costs the Worker 1 to 2 ms of the free plan's 10 ms, so the hot read routes are
 * held to a query budget. These count the statements each route prepares on a warm second read.
 */
async function setup() {
  const ctx = await makeTestApp({});
  const c = new Client(ctx.app);
  await c.signup();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = (ctx.db as any).$client;
  let n = 0;
  const orig = client.prepare.bind(client);
  client.prepare = (s: string) => { n++; return orig(s); };
  const count = async (path: string) => { await c.get(path); n = 0; const r = await c.get(path); expect(r.status).toBe(200); return { n, body: r.body }; };
  return { ctx, c, count };
}

describe("R41 query budget on hot read routes", () => {
  it("counts is one statement and keeps its shape", async () => {
    const { count } = await setup();
    const { n, body } = await count("/api/counts");
    expect(n).toBeLessThanOrEqual(1);
    expect(body).toMatchObject({ mail: { inbox: 0, important: 0, other: 0 }, chat: { unread: 0, mentions: 0 }, notifications: { unread: 0 }, triage: 0, tasks: { dueToday: 0, overdue: 0 } });
  });

  it("dashboard reads at most 6 statements", async () => {
    const { count } = await setup();
    const { n, body } = await count("/api/dashboard");
    expect(n).toBeLessThanOrEqual(6);
    expect(body.team.members).toBe(1);
    expect(typeof body.storageBytes).toBe("number");
  });

  it("/me answers hasPassword and shows a preference change at once", async () => {
    const { c } = await setup();
    const a = await c.get("/api/account/me");
    expect(a.body.hasPassword).toBe(true);
    await c.patch("/api/account/preferences", { timezone: "Asia/Kathmandu" });
    const b = await c.get("/api/account/me");
    expect(b.body.user.timezone).toBe("Asia/Kathmandu");
  });
});
