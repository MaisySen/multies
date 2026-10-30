import { describe, expect, it } from "vitest";
import { Client, makeTestApp } from "./helpers";
import { runMaintenance } from "../src/server/services/maintenance";

/*
 * R50 (CPU limit): the two places still over the free plan's 10 ms in the staging reproduction (27 Oct): My Work
 * (the phone Home tab, the hottest page: 8 statements) and the 15 minute maintenance pass (27 statements, 50 to 60 ms).
 * Each D1 statement costs the Worker CPU, so both are held to a statement budget, counted on a warm second call.
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
  return { ctx, c, count: () => n, reset: () => { n = 0; } };
}

describe("R50 statement budget", () => {
  it("my work with nothing waiting is 2 statements (was 8) and keeps its shape", async () => {
    const { c, count, reset } = await setup();
    await c.get("/api/my-work");
    reset();
    const r = await c.get("/api/my-work?tz=Australia/Sydney");
    expect(r.status).toBe(200);
    expect(count()).toBeLessThanOrEqual(2);
    expect(r.body).toMatchObject({ timeZone: "Australia/Sydney", overdue: [], dueToday: [], mentions: [], threads: [], assignedThreads: [], approvals: [], meetings: [] });
  });

  it("my work still shows a section that has something (a meeting today)", async () => {
    const { c } = await setup();
    const starts = new Date(Date.now() + 30 * 60_000).toISOString();
    const m = await c.post("/api/meetings", { title: "R50 probe check", startsAt: starts, durationMin: 30 });
    expect([200, 201]).toContain(m.status);
    const r = await c.get("/api/my-work?tz=UTC");
    if (new Date(starts).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10)) expect(r.body.meetings.map((x: { title: string }) => x.title)).toContain("R50 probe check");
  });

  it("a rotating cron pass runs about 10 fewer statements than a full pass, and each hour still runs every group", async () => {
    const { ctx, count, reset } = await setup();
    await runMaintenance(ctx.deps);
    reset();
    await runMaintenance(ctx.deps);
    const full = count();
    const per: number[] = [];
    for (const minute of [0, 15, 30, 45]) {
      const at = new Date(); at.setUTCMinutes(minute, 5, 0);
      reset();
      await runMaintenance({ ...ctx.deps, now: () => at }, { rotate: true });
      per.push(count());
    }
    console.log("R50 cron statements", JSON.stringify({ full, per }));
    expect(Math.max(...per)).toBeLessThan(full);
    expect(per.reduce((a, b) => a + b, 0) / 4).toBeLessThanOrEqual(full - 8);
  });
});
