import { describe, expect, it } from "vitest";
import { Client, makeTestApp } from "./helpers";
import { probeWaiting, runMaintenance } from "../src/server/services/maintenance";
import { enqueue } from "../src/server/services/jobs";
import { agentTriggers, organizations } from "../src/server/db/schema";

/*
 * R51 (CPU): the 15 minute cron pass was still 31 ms after R50. Most passes find nothing to do, so one probe statement
 * now asks which steps have anything waiting and the idle ones are skipped. Counted on a warm second call.
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
  return { ctx, count: () => n, reset: () => { n = 0; } };
}
const at = (minute: number) => { const d = new Date(); d.setUTCMinutes(minute, 5, 0); return d; };

describe("R51 cron probe", () => {
  it("an idle probed pass runs far fewer statements than an unprobed one, in every quarter", async () => {
    const { ctx, count, reset } = await setup();
    await runMaintenance(ctx.deps);
    const per: { plain: number; probed: number }[] = [];
    for (const minute of [0, 15, 30, 45]) {
      const deps = { ...ctx.deps, now: () => at(minute) };
      reset(); await runMaintenance(deps, { rotate: true, probe: false }); const plain = count();
      reset(); await runMaintenance(deps, { rotate: true }); const probed = count();
      per.push({ plain, probed });
    }
    console.log("R51 cron statements", JSON.stringify(per));
    for (const p of per) expect(p.probed).toBeLessThanOrEqual(p.plain - 7);
  });

  it("the probe says idle on an empty database and sees a due job and a due schedule trigger", async () => {
    const { ctx } = await setup();
    const idle = await probeWaiting(ctx.deps);
    expect(idle.jobs).toBe(false);
    expect(idle.agentTriggers).toBe(false);
    expect(idle.webhooks).toBe(false);
    expect(idle.mailSchedules).toBe(false);
    await enqueue(ctx.deps, "demo.seed_suite" as never, {});
    expect((await probeWaiting(ctx.deps)).jobs).toBe(false); // the cron never runs this type
    await enqueue(ctx.deps, "system-mail.send" as never, {});
    expect((await probeWaiting(ctx.deps)).jobs).toBe(true);
    const [org] = await ctx.db.select({ id: organizations.id }).from(organizations).limit(1);
    await ctx.db.insert(agentTriggers).values({ id: "trg_r51probe0001", orgId: org.id, agentUserId: "u", name: "r51", kind: "schedule", enabled: true, timezone: "UTC", nextRunAt: new Date(Date.now() - 60_000) });
    expect((await probeWaiting(ctx.deps)).agentTriggers).toBe(true);
  });

  it("a probed pass still runs a due job", async () => {
    const { ctx } = await setup();
    await enqueue(ctx.deps, "system-mail.send" as never, { to: "nobody@example.com", subject: "x", text: "x" });
    const r = await runMaintenance(ctx.deps, { rotate: true });
    expect((r.jobs as { ran: number; failed: number }).ran + (r.jobs as { ran: number; failed: number }).failed).toBeGreaterThanOrEqual(1);
  });

  it("if the probe fails every step runs", async () => {
    const { ctx } = await setup();
    const db = Object.create(ctx.deps.db as object) as typeof ctx.deps.db;
    (db as unknown as { all: () => Promise<never> }).all = async () => { throw new Error("boom"); };
    const broken = { ...ctx.deps, db };
    const w = await probeWaiting(broken);
    expect(Object.values(w).every(Boolean)).toBe(true);
  });
});
