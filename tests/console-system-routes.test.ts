/**
 * OPS1: /api/console/system. The snapshot (no secrets), the lockouts list (paging, filter, bad sort), clearing a
 * lockout and the Sentry test (reason, permission, platform audit row).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { signUpAs, type Ctx } from "./console-kit";
import { loginThrottle, platformAuditLogs } from "@/server/db/schema";

const SENTRY_SECRET = "sentry-sentinel-key-7f3c9b2e41d84a6f";
const H = 3600_000;

let ctx: Ctx;
let owner: Client, opsAdmin: Client, support: Client, readonly: Client, billing: Client, customer: Client;
let custId: string;
const sent: unknown[] = [];

const auditRows = (action: string) => ctx.db.select().from(platformAuditLogs).where(eq(platformAuditLogs.action, action)).all();

beforeAll(async () => {
  ctx = await makeTestApp({ SENTRY_DSN_API: `https://${SENTRY_SECRET}@sentry.example/1` });
  ctx.deps.reportError = (err) => { sent.push(err); return "evt_test_1"; };
  ({ c: owner } = await signUpAs(ctx, "owner@ops.test", "admin"));
  ({ c: opsAdmin } = await signUpAs(ctx, "opsadmin@ops.test", "ops_admin"));
  ({ c: support } = await signUpAs(ctx, "support@ops.test", "ops_support"));
  ({ c: readonly } = await signUpAs(ctx, "readonly@ops.test", "ops_readonly"));
  ({ c: billing } = await signUpAs(ctx, "billing@ops.test", "ops_billing"));
  ({ c: customer, id: custId } = await signUpAs(ctx, "locked@customer.test", null, "Locked Co"));
}, 120_000);

describe("snapshot", () => {
  it("answers every operator and never returns a key", async () => {
    const r = await readonly.get("/api/console/system/snapshot");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ release: ctx.deps.config.release, integrations: { sentryApi: true }, circuitBreakers: { scope: "this_isolate" } });
    expect(r.body.rateLimits.perMinute.auth).toBeGreaterThan(0);
    expect(JSON.stringify(r.body)).not.toContain(SENTRY_SECRET);
    expect((await customer.get("/api/console/system/snapshot")).status).toBe(403);
    expect((await new Client(ctx.app).get("/api/console/system/snapshot")).status).toBe(401);
  });
});

describe("lockouts", () => {
  it("lists locked accounts by default with paging, all with a filter, and refuses a bad sort", async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await ctx.db.insert(loginThrottle).values({ email: `locked${i}@x.test`, failures: 10 + i, windowStart: new Date(now - H), lockedUntil: new Date(now + (i + 1) * 60_000) });
    }
    await ctx.db.insert(loginThrottle).values({ email: "few@x.test", failures: 2, windowStart: new Date(now - 60_000), lockedUntil: null });
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const r = await readonly.get(`/api/console/system/lockouts?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      ids.push(...r.body.items.map((x: { email: string }) => x.email));
      cursor = r.body.nextCursor;
      if (!cursor) break;
    }
    expect(ids).toEqual(["locked4@x.test", "locked3@x.test", "locked2@x.test", "locked1@x.test", "locked0@x.test"]);
    const all = await readonly.get("/api/console/system/lockouts?status=all");
    expect(all.body.items.map((x: { email: string }) => x.email)).toContain("few@x.test");
    const byFailures = await readonly.get("/api/console/system/lockouts?sort=failures:desc");
    expect(byFailures.body.items[0]).toMatchObject({ email: "locked4@x.test", failures: 14, locked: true });
    expect(byFailures.body.items[0].unlocksInMs).toBeGreaterThan(0);
    expect((await readonly.get("/api/console/system/lockouts?sort=email:asc")).status).toBe(422);
    expect((await readonly.get("/api/console/system/lockouts?status=bogus")).status).toBe(422);
  });

  it("clearing a lockout needs a reason and users.unlock, and is audited", async () => {
    await ctx.db.insert(loginThrottle).values({ email: "locked@customer.test", failures: 10, windowStart: new Date(Date.now() - H), lockedUntil: new Date(Date.now() + 10 * 60_000) });
    const path = "/api/console/system/lockouts/clear";
    expect((await support.post(path, { email: "locked@customer.test" })).status).toBe(422);
    const ro = await readonly.post(path, { email: "locked@customer.test", reason: "Customer called in" });
    expect(ro.status).toBe(403);
    expect(ro.body.error.code).toBe("forbidden");
    expect((await customer.post(path, { email: "locked@customer.test", reason: "Customer called in" })).status).toBe(403);
    expect((await new Client(ctx.app).post(path, { email: "locked@customer.test", reason: "Customer called in" })).status).toBe(401);
    const ok = await billing.post(path, { email: "Locked@Customer.test", reason: "Customer called in" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ email: "locked@customer.test", wasLocked: true });
    expect(await ctx.db.select().from(loginThrottle).where(eq(loginThrottle.email, "locked@customer.test")).get()).toBeUndefined();
    const row = (await auditRows("user.lockout_cleared"))[0];
    expect(row).toMatchObject({ targetType: "user", targetId: custId, reason: "Customer called in", actorEmail: "billing@ops.test" });
    expect(JSON.parse(row.before!)).toEqual({ failures: 10, locked: true });
    expect((await support.post(path, { email: "nobody@x.test", reason: "Customer called in" })).status).toBe(404);
  });
});

describe("sentry test", () => {
  it("needs a reason and system.manage, sends one event and is audited", async () => {
    const path = "/api/console/system/sentry-test";
    expect((await opsAdmin.post(path, {})).status).toBe(422);
    const sup = await support.post(path, { reason: "Checking error tracking" });
    expect(sup.status).toBe(403);
    expect(sup.body.error.code).toBe("forbidden");
    expect((await readonly.post(path, { reason: "Checking error tracking" })).status).toBe(403);
    const ok = await opsAdmin.post(path, { reason: "Checking error tracking" });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ configured: true, eventId: "evt_test_1" });
    expect(sent).toHaveLength(1);
    const row = (await auditRows("system.sentry_test"))[0];
    expect(row).toMatchObject({ reason: "Checking error tracking", actorEmail: "opsadmin@ops.test" });
    expect(JSON.parse(row.after!)).toEqual({ eventId: "evt_test_1" });
    expect((await owner.post(path, { reason: "Checking error tracking" })).status).toBe(200);
  });
});
