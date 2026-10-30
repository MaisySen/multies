import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { runMaintenance } from "@/server/services/maintenance";
import { enqueue } from "@/server/services/jobs";

describe("scheduled maintenance", () => {
  it("stays well under the Workers limit on calls per invocation", async () => {
    // Production hit "Too many API requests by single Worker invocation" (Sentry MYMAIL-API-9
    // to G) when a demo seed ran inside the cron run. Workers allow 1,000 calls per invocation.
    const ctx = await makeTestApp({ DEMO_MODE: "true" });
    for (let i = 0; i < 3; i++) await new Client(ctx.app).post("/api/account/demo");
    for (let i = 0; i < 25; i++) await enqueue(ctx.deps, "test.noop", { i });
    const client = (ctx.db as unknown as { $client: { prepare: (q: string) => unknown } }).$client;
    const prepare = client.prepare.bind(client);
    let queries = 0;
    client.prepare = (q: string) => { queries++; return prepare(q); };
    await runMaintenance(ctx.deps);
    client.prepare = prepare;
    expect(queries).toBeLessThan(300);
    // At most 20 jobs per run; the demo seeds wait for their own request.
    const left = await ctx.db.query.jobs.findMany();
    expect(left.filter((j) => j.type === "test.noop" && j.status === "pending")).toHaveLength(5);
    expect(left.filter((j) => j.type === "demo.seed_suite" && j.status === "pending")).toHaveLength(3);
  });
});
