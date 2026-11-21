/**
 * OPS1 Trends: /api/console/metrics. Reads (range and metric validation, gaps as null, today live), the workspace
 * trends read (404, AI history note), and the two audited writes (backfill and the daily rollup by hand): reason
 * required, role checks, platform audit rows, and the writes-paused refusal. Plus the web page's pure helpers.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "./helpers";
import { signUpAs, type Ctx } from "./console-kit";
import { makeTestApp } from "./helpers";
import { deliveries, organizations, platformAuditLogs, platformMetricsDaily, usageCounters } from "@/server/db/schema";
import { resetWriteBudgetCache } from "@/server/services/write-budget";
import { lastOf, noStoredDays, parseRange, pointsOf, previousRange, sinceOf, sumOf, counterLabel, type MetricsRead } from "@/web/pages/console/trends-data";

const NOW = new Date("2026-11-21T10:00:00Z");
const TODAY = "2026-11-21";
const REASON = "Checking the trends block for the weekly review";

let ctx: Ctx;
const as = {} as Record<"owner" | "opsAdmin" | "support" | "billing" | "readonly" | "customer", Client>;
let orgId = "";

beforeAll(async () => {
  resetWriteBudgetCache();
  ctx = await makeTestApp();
  as.owner = (await signUpAs(ctx, "owner@trends.test", "admin")).c;
  as.opsAdmin = (await signUpAs(ctx, "opsadmin@trends.test", "ops_admin")).c;
  as.support = (await signUpAs(ctx, "support@trends.test", "ops_support")).c;
  as.billing = (await signUpAs(ctx, "billing@trends.test", "ops_billing")).c;
  as.readonly = (await signUpAs(ctx, "readonly@trends.test", "ops_readonly")).c;
  as.customer = (await signUpAs(ctx, "customer@else.test", null, "Customer Co")).c;
  ctx.deps.now = () => NOW;
  orgId = (await ctx.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Customer Co")).get())!.id;
  await ctx.db.insert(platformMetricsDaily).values([
    { day: "2026-11-17", metric: "signups", value: 4, updatedAt: NOW },
    { day: "2026-11-19", metric: "signups", value: 6, updatedAt: NOW },
    { day: "2026-11-20", metric: "workspaces_paid", value: 12, updatedAt: NOW },
  ]);
  await ctx.db.insert(deliveries).values([
    { id: "dlv_trends_route_000001", orgId, direction: "outbound", fromAddress: "a@x.io", toAddress: "b@y.io", status: "delivered", provider: "log", createdAt: new Date("2026-11-20T08:00:00Z") },
    { id: "dlv_trends_route_000002", orgId, direction: "outbound", fromAddress: "a@x.io", toAddress: "b@y.io", status: "bounced", provider: "log", createdAt: new Date("2026-11-20T09:00:00Z") },
    { id: "dlv_trends_route_000003", orgId, direction: "inbound", fromAddress: "b@y.io", toAddress: "a@x.io", status: "received", provider: "log", createdAt: new Date("2026-11-21T01:00:00Z") },
  ]);
  await ctx.db.insert(usageCounters).values({ orgId, period: "2026-11-19", metric: "chat_in", count: 7 }).onConflictDoNothing();
}, 120_000);

afterAll(() => resetWriteBudgetCache());

const auditRows = (action: string) => ctx.db.select().from(platformAuditLogs).where(eq(platformAuditLogs.action, action));

describe("GET /api/console/metrics", () => {
  it("reads stored days, gaps as null and today live, for every operator role", async () => {
    for (const c of [as.owner, as.support, as.billing, as.readonly]) {
      const r = await c.get("/api/console/metrics?metrics=signups,workspaces_paid&days=7");
      expect(r.status).toBe(200);
      expect(r.body.from).toBe("2026-11-15");
      expect(r.body.to).toBe(TODAY);
      expect(r.body.liveDay).toBe(TODAY);
      expect(r.body.days).toHaveLength(7);
      const signups = r.body.series.signups as (number | null)[];
      expect(signups.slice(0, 6)).toEqual([null, null, 4, null, 6, null]);
      expect(typeof signups[6]).toBe("number"); // today, counted live
      expect(r.body.series.workspaces_paid[5]).toBe(12);
      expect(r.body.firstDay).toEqual({ signups: "2026-11-17", workspaces_paid: "2026-11-20" });
    }
  }, 60_000);

  it("takes an explicit from and to (a past range has no live day)", async () => {
    const r = await as.readonly.get("/api/console/metrics?metrics=signups&from=2026-11-16&to=2026-11-18");
    expect(r.status).toBe(200);
    expect(r.body.days).toEqual(["2026-11-16", "2026-11-17", "2026-11-18"]);
    expect(r.body.series.signups).toEqual([null, 4, null]);
    expect(r.body.liveDay).toBeNull();
  });

  it("defaults to 30 days", async () => {
    const r = await as.readonly.get("/api/console/metrics?metrics=signups");
    expect(r.status).toBe(200);
    expect(r.body.days).toHaveLength(30);
  });

  it("refuses unknown metrics, no metrics, and bad ranges with a plain message", async () => {
    const bad = async (q: string) => {
      const r = await as.owner.get(`/api/console/metrics${q}`);
      expect([400, 422], `${q}: ${r.status}`).toContain(r.status);
      expect(typeof r.body.error.message).toBe("string");
      return r;
    };
    expect((await bad("?metrics=signups,not_a_metric&days=7")).body.error.message).toContain("not_a_metric");
    await bad("?days=7");
    await bad("?metrics=signups&days=5");
    await bad("?metrics=signups&from=2026-11-10");
    await bad("?metrics=signups&from=2026-11-10&to=nope");
    await bad("?metrics=signups&from=2026-11-20&to=2026-11-10");
    await bad("?metrics=signups&from=2024-01-01&to=2026-11-10");
    await bad("?metrics=signups&days=7&from=2026-11-10&to=2026-11-12");
  });

  it("is for operators only", async () => {
    expect((await new Client(ctx.app).get("/api/console/metrics?metrics=signups&days=7")).status).toBe(401);
    const r = await as.customer.get("/api/console/metrics?metrics=signups&days=7");
    expect(r.status).toBe(403);
  });
});

describe("GET /api/console/metrics/registry", () => {
  it("lists every metric with its label, kind and unit", async () => {
    const r = await as.readonly.get("/api/console/metrics/registry");
    expect(r.status).toBe(200);
    expect(r.body.ranges).toEqual([7, 30, 90]);
    expect(r.body.maxBackfillDays).toBe(90);
    expect(r.body.metrics.find((m: { key: string }) => m.key === "signups")).toMatchObject({ label: "Sign ups", kind: "flow", unit: "count", retentionDays: null });
    expect(r.body.metrics.find((m: { key: string }) => m.key === "ai_calls")).toMatchObject({ kind: "flow", retentionDays: 2 });
    expect(r.body.metrics.find((m: { key: string }) => m.key === "uptime_pct")).toMatchObject({ kind: "stock", unit: "percent" });
    expect((await as.customer.get("/api/console/metrics/registry")).status).toBe(403);
  });
});

describe("GET /api/console/metrics/workspaces/:id", () => {
  it("reads one workspace's mail, AI and daily counters", async () => {
    const r = await as.support.get(`/api/console/metrics/workspaces/${orgId}?days=7`);
    expect(r.status).toBe(200);
    expect(r.body.days).toHaveLength(7);
    // A bounce was sent first, so it counts as sent and as failed (services/console/metrics.ts).
    expect(r.body.series.deliveries_sent[5]).toBe(2);
    expect(r.body.series.deliveries_failed[5]).toBe(1);
    expect(r.body.series.deliveries_received[6]).toBe(1);
    expect(r.body.series["usage:chat_in"][4]).toBe(7);
    // AI history is kept 2 days: older days are null (no data), not zero, and the response says so.
    expect(r.body.ai).toEqual({ historyDays: 2, from: "2026-11-19", partial: true });
    expect(r.body.series.ai_calls.slice(0, 4)).toEqual([null, null, null, null]);
    expect(r.body.series.ai_calls[4]).toBe(0);
  });

  it("404s an unknown workspace and refuses a bad range", async () => {
    expect((await as.owner.get("/api/console/metrics/workspaces/org_does_not_exist?days=7")).status).toBe(404);
    expect([400, 422]).toContain((await as.owner.get(`/api/console/metrics/workspaces/${orgId}?days=12`)).status);
  });

  it("is for operators only", async () => {
    expect((await new Client(ctx.app).get(`/api/console/metrics/workspaces/${orgId}`)).status).toBe(401);
    expect((await as.customer.get(`/api/console/metrics/workspaces/${orgId}`)).status).toBe(403);
  });
});

describe("POST /api/console/metrics/backfill", () => {
  it("needs a reason and 1 to 90 days", async () => {
    for (const body of [{ days: 7 }, { days: 7, reason: "x" }, { reason: REASON }, { days: 0, reason: REASON }, { days: 91, reason: REASON }, { days: 2.5, reason: REASON }]) {
      const r = await as.owner.post("/api/console/metrics/backfill", body);
      expect([400, 422], JSON.stringify(body)).toContain(r.status);
    }
    expect(await auditRows("metrics.backfilled")).toEqual([]);
  });

  it("is refused for roles without system.manage, and for non operators", async () => {
    for (const c of [as.support, as.billing, as.readonly, as.customer]) {
      const r = await c.post("/api/console/metrics/backfill", { days: 7, reason: REASON });
      expect(r.status).toBe(403);
    }
    expect((await new Client(ctx.app).post("/api/console/metrics/backfill", { days: 7, reason: REASON })).status).toBe(401);
    expect(await auditRows("metrics.backfilled")).toEqual([]);
  });

  it("fills in flow metrics for past days and writes a platform audit row", async () => {
    const r = await as.opsAdmin.post("/api/console/metrics/backfill", { days: 3, reason: REASON });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, skipped: null, days: 3, from: "2026-11-18", to: "2026-11-20" });
    expect(r.body.rows).toBeGreaterThan(0);
    const sent = await ctx.db.select().from(platformMetricsDaily).where(and(eq(platformMetricsDaily.metric, "deliveries_sent"), eq(platformMetricsDaily.day, "2026-11-20"))).get();
    expect(sent?.value).toBe(2);
    // Stock metrics are never backfilled.
    expect(await ctx.db.select().from(platformMetricsDaily).where(eq(platformMetricsDaily.metric, "users_total"))).toEqual([]);
    const rows = await auditRows("metrics.backfilled");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorEmail: "opsadmin@trends.test", actorRole: "ops_admin", targetType: "platform_metrics", targetId: "2026-11-18", reason: REASON, orgId: null });
    expect(JSON.parse(rows[0].after!)).toMatchObject({ days: 3, from: "2026-11-18", to: "2026-11-20" });
  });
});

describe("POST /api/console/metrics/roll", () => {
  it("needs a reason and system.manage", async () => {
    expect([400, 422]).toContain((await as.owner.post("/api/console/metrics/roll", {})).status);
    for (const c of [as.support, as.billing, as.readonly, as.customer]) expect((await c.post("/api/console/metrics/roll", { reason: REASON })).status).toBe(403);
    expect(await auditRows("metrics.rolled")).toEqual([]);
  });

  it("rolls the missing days by hand, then reports it is up to date; both audited", async () => {
    const r = await as.owner.post("/api/console/metrics/roll", { reason: REASON });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, skipped: null, to: "2026-11-20" });
    expect(r.body.days).toBeGreaterThan(0);
    const marker = await ctx.db.select().from(platformMetricsDaily).where(and(eq(platformMetricsDaily.metric, "users_total"), eq(platformMetricsDaily.day, "2026-11-20"))).get();
    expect(marker?.value).toBeGreaterThan(0);
    const again = await as.owner.post("/api/console/metrics/roll", { reason: REASON });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ skipped: "up_to_date", days: 0, rows: 0 });
    const rows = await auditRows("metrics.rolled");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ actorEmail: "owner@trends.test", actorRole: "admin", targetType: "platform_metrics", targetId: "2026-11-20", reason: REASON });
  });
});

describe("writes paused", () => {
  it("answers 409 writes_paused and audits nothing", async () => {
    const shed = await makeTestApp();
    const owner = (await signUpAs(shed, "owner@paused.test", "admin")).c;
    resetWriteBudgetCache();
    const analytics = (async () => new Response(JSON.stringify({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [{ sum: { rowsWritten: 90_000 }, dimensions: { databaseId: "prod" } }] }] } }, errors: null }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const wb = shed.deps.config.writeBudget as { token?: string; accountId?: string };
    wb.token = "tok";
    wb.accountId = "acc";
    shed.deps.fetch = analytics;
    try {
      const b = await owner.post("/api/console/metrics/backfill", { days: 3, reason: REASON });
      expect(b.status).toBe(409);
      expect(b.body.error.code).toBe("writes_paused");
      const r = await owner.post("/api/console/metrics/roll", { reason: REASON });
      expect(r.status).toBe(409);
      expect(await shed.db.select().from(platformAuditLogs).where(eq(platformAuditLogs.targetType, "platform_metrics"))).toEqual([]);
      expect(await shed.db.select().from(platformMetricsDaily)).toEqual([]);
    } finally {
      resetWriteBudgetCache();
    }
  }, 60_000);
});

describe("the trends page helpers", () => {
  const read: MetricsRead = {
    from: "2026-11-15", to: TODAY, liveDay: TODAY,
    days: ["2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", TODAY],
    series: { signups: [null, 2, 0, null, 3, null, 1], workspaces_paid: [null, null, null, null, null, 12, 13], ai_calls: [null, null, null, null, null, null, null] },
    firstDay: { signups: "2026-10-01", workspaces_paid: "2026-11-20", ai_calls: null },
  };
  it("sums flows, takes the latest stock, and keeps no data as null", () => {
    expect(sumOf(pointsOf(read, "signups"))).toBe(6);
    expect(lastOf(pointsOf(read, "workspaces_paid"))).toBe(13);
    expect(sumOf(pointsOf(read, "ai_calls"))).toBeNull();
    expect(lastOf(pointsOf(read, "ai_calls"))).toBeNull();
    expect(pointsOf(read, "missing").every((p) => p.value === null)).toBe(true);
    expect(pointsOf(undefined, "signups")).toEqual([]);
  });
  it("finds the previous period of the same length", () => {
    expect(previousRange("2026-11-15", 7)).toEqual({ from: "2026-11-08", to: "2026-11-14" });
    expect(previousRange("2026-10-23", 30)).toEqual({ from: "2026-09-23", to: "2026-10-22" });
  });
  it("says since when a stock metric is recorded, and when nothing is stored", () => {
    expect(sinceOf(read, ["workspaces_paid"])).toBe("2026-11-20");
    expect(sinceOf(read, ["signups"])).toBeNull();
    expect(sinceOf({ ...read, firstDay: { workspaces_paid: null } }, ["workspaces_paid"])).toBe(TODAY);
    expect(sinceOf({ ...read, firstDay: { ai_calls: null } }, ["ai_calls"])).toBeNull();
    expect(noStoredDays(read, ["ai_calls"])).toBe(true);
    expect(noStoredDays(read, ["ai_calls", "signups"])).toBe(false);
    expect(noStoredDays(undefined, ["signups"])).toBe(false);
  });
  it("reads the range from the address and names counters plainly", () => {
    expect(parseRange("7")).toBe(7);
    expect(parseRange("90")).toBe(90);
    expect(parseRange("12")).toBe(30);
    expect(parseRange(null)).toBe(30);
    expect(counterLabel("d1_rows")).toBe("Rows written");
    expect(counterLabel("some_new_counter")).toBe("Some new counter");
  });
});
