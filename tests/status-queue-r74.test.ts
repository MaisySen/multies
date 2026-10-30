/**
 * R74: a demo's sample data job that waits because its visitor left is not a stuck queue, so the public status page
 * stays "operational"; real background work waiting over 30 minutes still shows degraded.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { makeTestApp } from "./helpers";
import { resetStatusCache } from "@/server/services/status";
import { jobs } from "@/server/db/schema";
import { newId } from "@/server/lib/crypto";

const old = () => new Date(Date.now() - 3 * 3600_000);

describe("status queue (R74)", () => {
  beforeEach(() => resetStatusCache());
  it("an old demo seed job does not make the queue degraded", async () => {
    const ctx = await makeTestApp();
    await ctx.db.insert(jobs).values({ id: newId("job"), type: "demo.seed_suite", payload: "{}", status: "pending", runAt: old(), maxAttempts: 3 });
    const body = await (await ctx.app.request("/api/status")).json();
    expect(body.components.find((c: { id: string }) => c.id === "queue").state).toBe("operational");
    expect(body.overall).toBe("operational");
  });
  it("other work waiting over 30 minutes still does", async () => {
    const ctx = await makeTestApp();
    await ctx.db.insert(jobs).values({ id: newId("job"), type: "push.send", payload: "{}", status: "pending", runAt: old(), maxAttempts: 3 });
    const body = await (await ctx.app.request("/api/status")).json();
    expect(body.components.find((c: { id: string }) => c.id === "queue").state).toBe("degraded");
  });
});
